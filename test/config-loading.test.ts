/**
 * Contract tests for loading Runpod OMP profile layers and resolving their
 * API keys.
 *
 * These tests define the observable behavior of the approved plan for two
 * config-layer entry points planned in src/config.ts:
 *
 * - `loadRunpodProfiles({ agentDir, cwd })` loads the global profile document
 *   from `<agentDir>/runpod.yml` (the injected equivalent of
 *   `~/.omp/agent/runpod.yml` — the real home directory is never consulted)
 *   and the project document from `<cwd>/.omp/runpod.yml`, parses both with
 *   `parseProfileDocument`, and merges them with `mergeProfileDocuments`:
 *     - a missing file is a valid empty layer: no profiles, no errors;
 *     - project profiles replace same-named global profiles, global-only
 *       profiles keep their positions, and project-only profiles append;
 *     - a malformed file contributes no profiles while its validation errors
 *       are retained with the exact source path, and the other layer stays
 *       active — so a malformed project file leaves the global profiles
 *       usable;
 *     - apiKey values pass through as unresolved secret references; the
 *       loader resolves nothing and emits no credential bytes.
 * - `resolveProfileApiKey(profile, { ompApiKey, env, runCommand })` resolves
 *   one profile's API key:
 *     - precedence: the profile's own `apiKey` reference first, then the
 *       OMP-provided key, then `RUNPOD_API_KEY` from the injected `env`
 *       record. When `env` is provided it is authoritative — `process.env`
 *       is never consulted;
 *     - reference forms (on `profile.apiKey.ref`):
 *       `env:NAME` looks up NAME in env (an unset or empty value falls
 *       through to the OMP key and then `RUNPOD_API_KEY`; an empty NAME is
 *       an explicit error), a leading `!` runs the rest as a command through
 *       `runCommand` and returns its trimmed stdout (failure or empty output
 *       is an explicit error, never a fallback), and any other ref resolves
 *       environment-first then as a literal, OMP-custom-provider style;
 *     - errors are explicit and redacted: a thrown error never contains the
 *       resolved credential value, the command output, or a literal secret.
 *
 * These tests intentionally fail until src/config.ts exports
 * `loadRunpodProfiles` and `resolveProfileApiKey`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as toYaml } from "yaml";

import { loadRunpodProfiles, resolveProfileApiKey } from "../src/config.js";
import type { MergedProfiles } from "../src/config.js";
import type { Profile, SecretReference } from "../src/profile-schema.js";

/** Full model metadata block; the plan defines no model-level defaults. */
const MODEL = {
	id: "meta-llama/llama-3.3-70b-instruct",
	name: "Llama 3.3 70B Instruct",
	contextWindow: 131_072,
	maxTokens: 8_192,
	reasoning: false,
	input: ["text"],
	supportsTools: true,
	supportsVision: false,
};

/**
 * Build a minimal valid profile-map entry for YAML fixtures: required fields
 * only (endpointType, invokeUrl, model) plus an explicit request mode so the
 * fixture is valid whether or not `request` itself is optional. Overrides
 * replace whole fields.
 */
function profileFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		endpointType: "queue",
		invokeUrl: "https://api.runpod.ai/v2/ep-1",
		model: MODEL,
		request: { mode: "sync" },
		...overrides,
	};
}

/** A parsed Profile with the standard defaults, used by the resolver tests. */
function profileWithApiKey(apiKey: SecretReference | undefined): Profile {
	return {
		endpointType: "queue",
		invokeUrl: "https://api.runpod.ai/v2/ep-resolve",
		model: MODEL,
		apiKey,
		request: {
			mode: "sync",
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" },
			loadBalancedPath: "/v1/chat/completions",
		},
		policy: { maxAttempts: 1, fallbackProfiles: [] },
	};
}

/** The normalized secret-reference form every profile carries. */
function secretRef(ref: string): SecretReference {
	return { kind: "secret-reference", ref, redacted: "[redacted]" };
}

/** Global-layer YAML fixture: one shared profile plus a global-only profile. */
const GLOBAL_DOC = {
	version: 1,
	profiles: {
		shared: profileFixture({
			invokeUrl: "https://global.example/shared",
			apiKey: { ref: "env:RUNPOD_API_KEY" },
		}),
		"global-only": profileFixture({ invokeUrl: "https://global.example/only" }),
	},
};

/** Project-layer YAML fixture: overrides `shared` and adds a project-only profile. */
const PROJECT_DOC = {
	version: 1,
	profiles: {
		shared: profileFixture({
			endpointType: "load-balanced",
			invokeUrl: "https://project.example/shared",
			request: { mode: "stream" },
		}),
		"project-only": profileFixture({
			request: { mode: "async" },
			invokeUrl: "https://project.example/only",
		}),
	},
};

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "runpod-omp-loading-"));
});

afterEach(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

/** The injected global agent dir and project cwd, both under the temp root. */
function layout(): {
	agentDir: string;
	cwd: string;
	globalFile: string;
	projectFile: string;
} {
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "project");
	return {
		agentDir,
		cwd,
		globalFile: join(agentDir, "runpod.yml"),
		projectFile: join(cwd, ".omp", "runpod.yml"),
	};
}

/** Write a YAML document to `file`, creating parent directories. */
async function writeYaml(file: string, document: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, toYaml(document), "utf8");
}

/** Write raw text to `file`, creating parent directories. */
async function writeText(file: string, text: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, text, "utf8");
}

describe("loadRunpodProfiles", () => {
	test("returns an empty merged profile set when both files are missing", async () => {
		const { agentDir, cwd } = layout();
		const result: MergedProfiles = await loadRunpodProfiles({ agentDir, cwd });
		expect(result).toEqual({ profiles: {}, errors: [] });
	});

	test("loads the global document when the project has no .omp directory", async () => {
		const { agentDir, cwd } = layout();
		await writeYaml(join(agentDir, "runpod.yml"), GLOBAL_DOC);

		const result: MergedProfiles = await loadRunpodProfiles({ agentDir, cwd });

		expect(result.errors).toEqual([]);
		expect(Object.keys(result.profiles)).toEqual(["shared", "global-only"]);
		expect(result.profiles["shared"]!.invokeUrl).toBe("https://global.example/shared");
		// apiKey stays an unresolved secret reference; nothing is resolved.
		expect(result.profiles["shared"]!.apiKey).toEqual({
			kind: "secret-reference",
			ref: "env:RUNPOD_API_KEY",
			redacted: "[redacted]",
		});
	});

	test("loads the project document when the global file is missing", async () => {
		const { agentDir, cwd } = layout();
		await writeYaml(join(cwd, ".omp", "runpod.yml"), PROJECT_DOC);

		const result: MergedProfiles = await loadRunpodProfiles({ agentDir, cwd });

		expect(result.errors).toEqual([]);
		expect(Object.keys(result.profiles)).toEqual(["shared", "project-only"]);
		expect(result.profiles["shared"]!.invokeUrl).toBe("https://project.example/shared");
		expect(result.profiles["shared"]!.endpointType).toBe("load-balanced");
		expect(result.profiles["project-only"]!.request.mode).toBe("async");
	});

	test("merges both layers: project same-name replacement, global-only kept, project-only appended", async () => {
		const { agentDir, cwd } = layout();
		await writeYaml(join(agentDir, "runpod.yml"), GLOBAL_DOC);
		await writeYaml(join(cwd, ".omp", "runpod.yml"), PROJECT_DOC);

		const result: MergedProfiles = await loadRunpodProfiles({ agentDir, cwd });

		expect(result.errors).toEqual([]);
		// Global order first; same-named entries replaced by the project version;
		// project-only entries appended after the global order.
		expect(Object.keys(result.profiles)).toEqual(["shared", "global-only", "project-only"]);
		expect(result.profiles["shared"]!.invokeUrl).toBe("https://project.example/shared");
		expect(result.profiles["shared"]!.endpointType).toBe("load-balanced");
		expect(result.profiles["shared"]!.request.mode).toBe("stream");
		expect(result.profiles["global-only"]!.invokeUrl).toBe("https://global.example/only");
		expect(result.profiles["project-only"]!.invokeUrl).toBe("https://project.example/only");
		expect(result.profiles["project-only"]!.request.mode).toBe("async");
	});

	test("keeps global profiles active and retains errors when the project file is malformed", async () => {
		const { agentDir, cwd, projectFile } = layout();
		await writeYaml(join(agentDir, "runpod.yml"), GLOBAL_DOC);
		await writeText(projectFile, "version: 1\nprofiles: {\n");

		const result: MergedProfiles = await loadRunpodProfiles({ agentDir, cwd });

		expect(Object.keys(result.profiles)).toEqual(["shared", "global-only"]);
		expect(result.profiles["shared"]!.invokeUrl).toBe("https://global.example/shared");
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.sourcePath).toBe(projectFile);
		expect(result.errors[0]!.message).toContain("not valid YAML");
	});

	test("keeps project profiles and retains errors when the global file is malformed", async () => {
		const { agentDir, cwd, globalFile } = layout();
		await writeText(globalFile, "version: 1\nprofiles: {\n");
		await writeYaml(join(cwd, ".omp", "runpod.yml"), PROJECT_DOC);

		const result: MergedProfiles = await loadRunpodProfiles({ agentDir, cwd });

		expect(Object.keys(result.profiles)).toEqual(["shared", "project-only"]);
		expect(result.profiles["shared"]!.invokeUrl).toBe("https://project.example/shared");
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.sourcePath).toBe(globalFile);
		expect(result.errors[0]!.message).toContain("not valid YAML");
	});

	test("retains errors for a rejected project document version and keeps global profiles", async () => {
		const { agentDir, cwd, projectFile } = layout();
		await writeYaml(join(agentDir, "runpod.yml"), GLOBAL_DOC);
		await writeYaml(projectFile, { version: 9, profiles: { future: profileFixture() } });

		const result: MergedProfiles = await loadRunpodProfiles({ agentDir, cwd });

		expect(Object.keys(result.profiles)).toEqual(["shared", "global-only"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.sourcePath).toBe(projectFile);
		expect(result.errors[0]!.message).toContain("version");
	});

	test("never resolves apiKey references while loading", async () => {
		const { agentDir, cwd } = layout();
		await writeYaml(join(agentDir, "runpod.yml"), GLOBAL_DOC);
		// A literal secret ref proves the loader neither resolves nor rewrites it.
		// The literal avoids an "sk-" prefix so the JSON check below can look
		// for resolved credential bytes without tripping on the ref text.
		await writeYaml(join(cwd, ".omp", "runpod.yml"), {
			version: 1,
			profiles: { literal: profileFixture({ apiKey: "profile-literal-reference" }) },
		});

		const result: MergedProfiles = await loadRunpodProfiles({ agentDir, cwd });

		// The env reference stays verbatim with its redacted marker.
		expect(result.profiles["shared"]!.apiKey).toEqual({
			kind: "secret-reference",
			ref: "env:RUNPOD_API_KEY",
			redacted: "[redacted]",
		});
		// The literal ref stays verbatim too: the loader resolves nothing, so no
		// resolved credential bytes and no extra output forms exist.
		expect(result.profiles["literal"]!.apiKey).toEqual({
			kind: "secret-reference",
			ref: "profile-literal-reference",
			redacted: "[redacted]",
		});
		// Only the verbatim references are exposed; no resolved credential
		// bytes (the loader never resolves anything) appear anywhere.
		expect(JSON.stringify(result)).not.toContain("sk-");
	});
});

describe("resolveProfileApiKey", () => {
	test("returns a bare ref as a literal when no environment variable of that name is set", async () => {
		const key = await resolveProfileApiKey(profileWithApiKey(secretRef("sk-literal-123")), {
			ompApiKey: "sk-omp-key-111",
			env: { RUNPOD_API_KEY: "sk-runpod-key-222" },
		});
		// The profile's own reference wins over the OMP key and RUNPOD_API_KEY.
		expect(key).toBe("sk-literal-123");
	});

	test("resolves a bare ref to the environment variable it names when one is set", async () => {
		const key = await resolveProfileApiKey(profileWithApiKey(secretRef("RUNPOD_TOKEN")), {
			ompApiKey: "sk-omp-key-111",
			env: { RUNPOD_TOKEN: "sk-bare-env-456", RUNPOD_API_KEY: "sk-runpod-key-222" },
		});
		expect(key).toBe("sk-bare-env-456");
	});

	test("resolves env:NAME from the injected env, ahead of the OMP key and RUNPOD_API_KEY", async () => {
		const key = await resolveProfileApiKey(profileWithApiKey(secretRef("env:MY_RUNPOD_TOKEN")), {
			ompApiKey: "sk-omp-key-111",
			env: { MY_RUNPOD_TOKEN: "sk-env-token-789", RUNPOD_API_KEY: "sk-runpod-key-222" },
		});
		expect(key).toBe("sk-env-token-789");
	});

	test("falls back to the OMP key when the profile has no apiKey", async () => {
		const key = await resolveProfileApiKey(profileWithApiKey(undefined), {
			ompApiKey: "sk-omp-key-111",
			env: { RUNPOD_API_KEY: "sk-runpod-key-222" },
		});
		expect(key).toBe("sk-omp-key-111");
	});

	test("treats an empty OMP key as absent and falls back to RUNPOD_API_KEY", async () => {
		const key = await resolveProfileApiKey(profileWithApiKey(undefined), {
			ompApiKey: "",
			env: { RUNPOD_API_KEY: "sk-runpod-key-222" },
		});
		expect(key).toBe("sk-runpod-key-222");
	});

	test("falls back to the OMP key when an env:NAME reference is unset", async () => {
		const key = await resolveProfileApiKey(profileWithApiKey(secretRef("env:MISSING_TOKEN")), {
			ompApiKey: "sk-omp-key-111",
			env: {},
		});
		expect(key).toBe("sk-omp-key-111");
	});

	test("falls through to RUNPOD_API_KEY when an env:NAME reference is unset or empty and no OMP key is available", async () => {
		for (const missing of [{}, { MISSING_TOKEN: "" }]) {
			const key = await resolveProfileApiKey(profileWithApiKey(secretRef("env:MISSING_TOKEN")), {
				env: { ...missing, RUNPOD_API_KEY: "sk-runpod-key-222" },
			});
			expect(key).toBe("sk-runpod-key-222");
		}
	});

	test("resolves !command references via runCommand and returns trimmed stdout", async () => {
		const calls: string[] = [];
		const key = await resolveProfileApiKey(profileWithApiKey(secretRef("!printf sk-command-out-333")), {
			ompApiKey: "sk-omp-key-111",
			env: { RUNPOD_API_KEY: "sk-runpod-key-222" },
			runCommand: async (command) => {
				calls.push(command);
				return "  sk-command-out-333\n";
			},
		});
		// The command is the ref minus the leading "!", and the resolved value
		// beats the OMP key and RUNPOD_API_KEY.
		expect(calls).toEqual(["printf sk-command-out-333"]);
		expect(key).toBe("sk-command-out-333");
	});

	test("throws an explicit redacted error when the command runner fails", async () => {
		await expect(
			resolveProfileApiKey(profileWithApiKey(secretRef("!op read op://vault/runpod")), {
				env: { RUNPOD_API_KEY: "sk-runpod-key-222" },
				runCommand: async () => {
					throw new Error("boom: sk-leaked-secret-444");
				},
			}),
		).rejects.toThrow(/redacted/i);
	});

	test("throws an explicit redacted error when a command reference has no runner", async () => {
		await expect(
			resolveProfileApiKey(profileWithApiKey(secretRef("!op read op://vault/runpod")), {
				env: { RUNPOD_API_KEY: "sk-runpod-key-222" },
			}),
		).rejects.toThrow(/redacted/i);
	});

	test("throws an explicit redacted error when the command produces no output", async () => {
		for (const output of ["", "   \n"]) {
			await expect(
				resolveProfileApiKey(profileWithApiKey(secretRef("!echo nothing")), {
					env: { RUNPOD_API_KEY: "sk-runpod-key-222" },
					runCommand: async () => output,
				}),
			).rejects.toThrow(/redacted/i);
		}
	});

	test("throws a redacted error when no apiKey, OMP key, or RUNPOD_API_KEY resolves", async () => {
		await expect(resolveProfileApiKey(profileWithApiKey(undefined), { env: {} })).rejects.toThrow(
			/redacted/i,
		);
	});

	test("throws a redacted error for an env: reference with an empty variable name", async () => {
		await expect(
			resolveProfileApiKey(profileWithApiKey(secretRef("env:")), {
				env: { RUNPOD_API_KEY: "sk-runpod-key-222" },
			}),
		).rejects.toThrow(/redacted/i);
	});

	test("consults only the injected env record, never process.env", async () => {
		const previous = process.env.RUNPOD_API_KEY;
		process.env.RUNPOD_API_KEY = "sk-process-env-555";
		try {
			const error = await resolveProfileApiKey(profileWithApiKey(undefined), { env: {} }).then(
				() => null,
				(cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
			);
			expect(error).not.toBeNull();
			expect(String(error!.message)).toMatch(/redacted/i);
			expect(String(error!.message)).not.toContain("sk-process-env-555");
		} finally {
			if (previous === undefined) {
				delete process.env.RUNPOD_API_KEY;
			} else {
				process.env.RUNPOD_API_KEY = previous;
			}
		}
	});

	test("never includes resolved credential values in any thrown error", async () => {
		const scenarios: Array<{
			label: string;
			run: () => Promise<string>;
			secrets: string[];
		}> = [
			{
				label: "command failure",
				run: () =>
					resolveProfileApiKey(profileWithApiKey(secretRef("!op read secret")), {
						env: {},
						runCommand: async () => {
							throw new Error("boom: sk-leaked-secret-444");
						},
					}),
				// Neither the runner's message nor the leaked secret may surface.
				secrets: ["sk-leaked-secret-444", "boom"],
			},
			{
				label: "empty command output",
				run: () =>
					resolveProfileApiKey(profileWithApiKey(secretRef("!echo x")), {
						env: { RUNPOD_API_KEY: "sk-runpod-key-222" },
						runCommand: async () => "",
					}),
				secrets: ["sk-runpod-key-222"],
			},
			{
				label: "empty env reference name",
				run: () =>
					resolveProfileApiKey(profileWithApiKey(secretRef("env:")), {
						env: { RUNPOD_API_KEY: "sk-runpod-key-222" },
					}),
				secrets: ["sk-runpod-key-222"],
			},
			{
				label: "no key source",
				run: () => resolveProfileApiKey(profileWithApiKey(undefined), { env: {} }),
				secrets: [],
			},
		];

		for (const scenario of scenarios) {
			const error = await scenario.run().then(
				() => null,
				(cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
			);
			expect(error, scenario.label).not.toBeNull();
			const message = String(error!.message);
			expect(message, scenario.label).toMatch(/redacted/i);
			for (const secret of scenario.secrets) {
				expect(message, `${scenario.label} must not leak ${secret}`).not.toContain(secret);
			}
		}
	});
});

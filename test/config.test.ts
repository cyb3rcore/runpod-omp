/**
 * Contract tests for the Runpod OMP profile configuration layer.
 *
 * These tests define the observable behavior of the approved plan:
 *
 * - `parseProfileDocument` (src/profile-schema.ts) parses a version-1 profile
 *   document from YAML text (or an equivalent plain value) and returns a
 *   `ProfileDocumentResult` carrying the parsed document plus retained
 *   validation errors:
 *     - documents are `{ version: 1, profiles: { <name>: Profile } }` (a
 *       name-keyed map, not an array);
 *     - a minimal profile is `{ endpointType, invokeUrl, model }`; `apiKey`,
 *       `request`, and `policy` are optional;
 *     - planned defaults: `request.timeoutMs` 300000,
 *       `request.polling.{intervalMs,ttlMs,focusAware}` 1000/1800000/true,
 *       `request.queueAdapter` `{ kind: "openai-shaped" }`,
 *       `request.loadBalancedPath` "/v1/chat/completions",
 *       `policy.maxAttempts` 1 and `policy.fallbackProfiles` [];
 *       validation errors are retained in `result.errors`;
 *     - unsupported document versions and non-document roots are rejected:
 *       `document` is null and the reason is retained in `errors`.
 * - Secret API keys are never resolved by the configuration layer. They are
 *   represented as `{ kind: "secret-reference", ref, redacted }` and any
 *   exposed diagnostic/output form redacts them; no credential bytes ever
 *   appear.
 * - `mergeProfileDocuments` (src/config.ts) merges a global and a project
 *   result: project profiles replace same-named global profiles, global-only
 *   profiles are kept, project-only profiles are appended (global order first),
 *   and validation errors from both sides are retained.
 * - `writeProfileDocument` (src/config.ts) writes the document as valid YAML
 *   atomically (no partial/temp artifacts left behind) such that it round-trips
 *   through `parseProfileDocument` and never emits credential bytes.
 *
 * These tests intentionally fail until src/profile-schema.ts and src/config.ts
 * are implemented.
 */
import { describe, expect, test } from "bun:test";
import { stringify as toYaml } from "yaml";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseProfileDocument } from "../src/profile-schema.js";
import type { ModelMetadata, ProfileDocument, ProfileDocumentResult } from "../src/profile-schema.js";
import { mergeProfileDocuments, writeProfileDocument } from "../src/config.js";
import type { MergedProfiles } from "../src/config.js";

/** Full model metadata block; the plan defines no model-level defaults. */
const MODEL: ModelMetadata = {
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
 * Build a minimal valid profile-map entry: required fields only (endpointType,
 * invokeUrl, model) plus an explicit request mode so the fixture is valid
 * whether or not `request` itself is optional. Overrides replace whole fields.
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

describe("parseProfileDocument: valid version 1 documents", () => {
	test("parses a minimal profile and applies the planned defaults", () => {
		const result: ProfileDocumentResult = parseProfileDocument(
			toYaml({
				version: 1,
				profiles: {
					minimal: profileFixture(),
					explicit: profileFixture({
						endpointType: "load-balanced",
						invokeUrl: "https://api.runpod.ai/v2/ep-2/v1/chat/completions",
						apiKey: { ref: "env:RUNPOD_API_KEY" },
						request: {
							mode: "stream",
							timeoutMs: 600_000,
							polling: { intervalMs: 500, ttlMs: 900_000, focusAware: false },
							queueAdapter: { kind: "messages-text" },
							loadBalancedPath: "/v1/completions",
						},
						policy: { maxAttempts: 3, fallbackProfiles: ["minimal"] },
					}),
				},
			}),
			"runpod.yml",
		);

		expect(result.errors).toEqual([]);
		expect(result.sourcePath).toBe("runpod.yml");
		expect(result.document).not.toBeNull();

		const profiles = result.document!.profiles;
		expect(Object.keys(profiles)).toEqual(["minimal", "explicit"]);

		// Minimal profile: explicit fields preserved, optional fields defaulted.
		const minimal = profiles["minimal"]!;
		expect(minimal.endpointType).toBe("queue");
		expect(minimal.invokeUrl).toBe("https://api.runpod.ai/v2/ep-1");
		expect(minimal.model).toEqual(MODEL);
		expect(minimal.apiKey).toBeUndefined();
		expect(minimal.request).toEqual({
			mode: "sync",
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" },
			loadBalancedPath: "/v1/chat/completions",
		});
		expect(minimal.policy).toEqual({ maxAttempts: 1, fallbackProfiles: [] });

		// Explicit profile: every provided value is preserved verbatim.
		const explicit = profiles["explicit"]!;
		expect(explicit.endpointType).toBe("load-balanced");
		expect(explicit.request).toEqual({
			mode: "stream",
			timeoutMs: 600_000,
			polling: { intervalMs: 500, ttlMs: 900_000, focusAware: false },
			queueAdapter: { kind: "messages-text" },
			loadBalancedPath: "/v1/completions",
		});
		expect(explicit.policy).toEqual({ maxAttempts: 3, fallbackProfiles: ["minimal"] });
		expect(explicit.apiKey).toEqual({
			kind: "secret-reference",
			ref: "env:RUNPOD_API_KEY",
			redacted: "[redacted]",
		});
	});

	test("accepts a version 1 document with no profiles", () => {
		const result = parseProfileDocument(toYaml({ version: 1, profiles: {} }), "empty.yml");
		expect(result.errors).toEqual([]);
		expect(result.document).toEqual({ version: 1, profiles: {} });
	});
});

describe("parseProfileDocument: malformed profiles", () => {
	test("excludes malformed profiles but retains their validation errors", () => {
		const result = parseProfileDocument(
			toYaml({
				version: 1,
				profiles: {
					good: profileFixture(),
					"no-invoke-url": { endpointType: "queue", model: MODEL, request: { mode: "sync" } },
					"bad-endpoint-type": profileFixture({ endpointType: "turbo" }),
					"bad-mode": profileFixture({ request: { mode: "teleport" } }),
					"not-an-object": "nope",
				},
			}),
			"profiles.yml",
		);

		// The document still parses; only the malformed entries are excluded.
		expect(result.document).not.toBeNull();
		expect(Object.keys(result.document!.profiles)).toEqual(["good"]);

		// The retained errors carry the source path and per-field reasons.
		expect(result.errors.length).toBeGreaterThanOrEqual(4);
		for (const error of result.errors) {
			expect(error.sourcePath).toBe("profiles.yml");
			expect(error.message.length).toBeGreaterThan(0);
		}
		const messages = result.errors.map((error) => error.message).join("\n");
		expect(messages).toContain("invokeUrl");
		expect(messages).toContain("endpointType");
	});
});

describe("parseProfileDocument: rejected documents", () => {
	test("rejects an unsupported document version", () => {
		const result = parseProfileDocument(
			toYaml({ version: 2, profiles: { p: profileFixture() } }),
			"future.yml",
		);
		expect(result.document).toBeNull();
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors.map((error) => error.message).join("\n")).toContain("version");
	});

	test("rejects a document without a version field", () => {
		const result = parseProfileDocument(toYaml({ profiles: { p: profileFixture() } }), "noversion.yml");
		expect(result.document).toBeNull();
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors.map((error) => error.message).join("\n")).toContain("version");
	});

	test("rejects values that are not documents at all", () => {
		for (const value of ["not yaml", 42, null, []]) {
			const result = parseProfileDocument(toYaml(value), "bad.yml");
			expect(result.document).toBeNull();
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]!.sourcePath).toBe("bad.yml");
		}
	});
});

describe("secret references", () => {
	test("api keys are represented as unresolved references and redacted in output", () => {
		const result = parseProfileDocument(
			toYaml({
				version: 1,
				profiles: { secured: profileFixture({ apiKey: { ref: "env:RUNPOD_API_KEY" } }) },
			}),
			"secrets.yml",
		);

		expect(result.errors).toEqual([]);
		const profile = result.document!.profiles["secured"]!;
		expect(profile.apiKey).toEqual({
			kind: "secret-reference",
			ref: "env:RUNPOD_API_KEY",
			redacted: "[redacted]",
		});
		// The exposed diagnostic/output form never contains resolved credential bytes.
		expect(JSON.stringify(result)).not.toContain("sk-");
	});
});

describe("mergeProfileDocuments", () => {
	test("project profiles replace same-named global profiles; project-only profiles append", () => {
		const global = parseProfileDocument(
			toYaml({
				version: 1,
				profiles: {
					shared: profileFixture({ invokeUrl: "https://global.example/shared" }),
					"global-only": profileFixture({ invokeUrl: "https://global.example/only" }),
				},
			}),
			"global.yml",
		);
		const project = parseProfileDocument(
			toYaml({
				version: 1,
				profiles: {
					shared: profileFixture({
						endpointType: "load-balanced",
						request: { mode: "stream" },
						invokeUrl: "https://project.example/shared",
					}),
					"project-only": profileFixture({ request: { mode: "async" }, invokeUrl: "https://project.example/only" }),
				},
			}),
			"project.yml",
		);

		const merged: MergedProfiles = mergeProfileDocuments(global, project);

		// Global order first, same-named entries replaced by the project version,
		// project-only entries appended.
		expect(Object.keys(merged.profiles)).toEqual(["shared", "global-only", "project-only"]);
		expect(merged.profiles["shared"]).toEqual(project.document!.profiles["shared"]);
		expect(merged.profiles["shared"]!.request.mode).toBe("stream");
		expect(merged.profiles["shared"]!.invokeUrl).toBe("https://project.example/shared");
		expect(merged.profiles["global-only"]).toEqual(global.document!.profiles["global-only"]);
		expect(merged.profiles["project-only"]).toEqual(project.document!.profiles["project-only"]);
		expect(merged.errors).toEqual([]);
	});

	test("keeps the valid side and retains errors when a document was rejected", () => {
		const badGlobal = parseProfileDocument(toYaml({ version: 9, profiles: {} }), "bad-global.yml");
		const project = parseProfileDocument(
			toYaml({ version: 1, profiles: { p: profileFixture() } }),
			"project.yml",
		);

		const merged = mergeProfileDocuments(badGlobal, project);

		expect(Object.keys(merged.profiles)).toEqual(["p"]);
		expect(merged.errors.length).toBeGreaterThan(0);
		expect(merged.errors[0]!.sourcePath).toBe("bad-global.yml");
		expect(merged.errors[0]!.message.length).toBeGreaterThan(0);
	});
});

describe("writeProfileDocument", () => {
	test("atomically writes YAML that round-trips and never emits credential bytes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "runpod-omp-config-"));
		try {
			const target = join(dir, "runpod.yml");

			const parsed = parseProfileDocument(
				toYaml({
					version: 1,
					profiles: {
						a: profileFixture({
							apiKey: { ref: "env:RUNPOD_API_KEY" },
							request: { mode: "async", timeoutMs: 600_000 },
							policy: { maxAttempts: 2, fallbackProfiles: ["b"] },
						}),
						b: profileFixture(),
					},
				}),
				"in.yml",
			);
			expect(parsed.errors).toEqual([]);
			const doc: ProfileDocument = parsed.document!;

			await writeProfileDocument(target, doc);

			// Atomic: the write leaves no partial or temporary artifacts behind.
			expect(await readdir(dir)).toEqual(["runpod.yml"]);

			const content = await readFile(target, "utf8");
			// Secret references are written as references; no credential bytes ever appear.
			expect(content).toContain("env:RUNPOD_API_KEY");
			expect(content).not.toMatch(/sk-[A-Za-z0-9_-]+/);

			// The written YAML is a valid document and round-trips losslessly.
			const reparsed = parseProfileDocument(content, target);
			expect(reparsed.errors).toEqual([]);
			expect(reparsed.document).toEqual(doc);

			// Overwriting an existing file is atomic too: the final content
			// replaces the previous document with no leftovers.
			const second = parseProfileDocument(
				toYaml({ version: 1, profiles: { c: profileFixture() } }),
				"in.yml",
			);
			expect(second.errors).toEqual([]);
			await writeProfileDocument(target, second.document!);
			expect(await readdir(dir)).toEqual(["runpod.yml"]);
			const reparsedSecond = parseProfileDocument(await readFile(target, "utf8"), target);
			expect(reparsedSecond.errors).toEqual([]);
			expect(Object.keys(reparsedSecond.document!.profiles)).toEqual(["c"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

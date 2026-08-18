/**
 * Profile document loading, merging, atomic persistence, and API-key
 * resolution.
 *
 * Loading reads the global document from `<agentDir>/runpod.yml` and the
 * project document from `<cwd>/.omp/runpod.yml`; a missing file is a valid
 * empty layer, and `apiKey` references pass through unresolved.
 *
 * Merging follows the approved precedence: project profiles replace
 * same-named global profiles, global-only profiles are kept, project-only
 * profiles are appended after the global order, and validation errors from
 * both sides are retained.
 *
 * Writing is atomic (temp file + rename inside the target directory, with the
 * temp cleaned up on any failure) and never emits credential bytes: secret
 * references are serialized as their `ref` only, so the written YAML
 * round-trips through `parseProfileDocument` with no key material anywhere.
 *
 * Resolution never consults `process.env` — the injected `env` record is
 * authoritative — and every thrown error is redacted: it never contains a
 * resolved credential value, command output, or a runner's message.
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stringify as toYaml } from "yaml";

import { parseProfileDocument } from "./profile-schema.js";
import type {
	Profile,
	ProfileDocument,
	ProfileDocumentResult,
	ProfileValidationError,
} from "./profile-schema.js";

/** Profiles after a global + project merge, plus the retained errors. */
export interface MergedProfiles {
	profiles: Record<string, Profile>;
	errors: ProfileValidationError[];
}

/**
 * Merge a global and a project parse result. Project profiles replace
 * same-named global profiles; global-only profiles keep their positions;
 * project-only profiles append after them; validation errors from both sides
 * are retained (a rejected side contributes no profiles).
 */
export function mergeProfileDocuments(
	globalResult: ProfileDocumentResult,
	projectResult: ProfileDocumentResult,
): MergedProfiles {
	const profiles: Record<string, Profile> = {};
	for (const [name, profile] of Object.entries(globalResult.document?.profiles ?? {})) {
		profiles[name] = profile;
	}
	for (const [name, profile] of Object.entries(projectResult.document?.profiles ?? {})) {
		profiles[name] = profile;
	}
	return { profiles, errors: [...globalResult.errors, ...projectResult.errors] };
}

/** Options for loading the global and project profile layers. */
export interface LoadRunpodProfilesOptions {
	/** Injected OMP agent directory; the real home directory is never consulted. */
	agentDir: string;
	/** Project working directory whose `.omp/runpod.yml` overrides the global layer. */
	cwd: string;
}

/**
 * Load the global profile document from `<agentDir>/runpod.yml` and the
 * project document from `<cwd>/.omp/runpod.yml`, parse both, and merge them.
 *
 * A missing file is a valid empty layer (no profiles, no errors); any other
 * read failure is thrown as a redacted error that never embeds file contents
 * or the underlying cause. A malformed layer contributes no profiles while
 * its validation errors are retained with the exact source path, and the
 * other layer stays active. `apiKey` references pass through unresolved —
 * nothing is resolved here and no credential bytes are read or emitted.
 */
export async function loadRunpodProfiles({
	agentDir,
	cwd,
}: LoadRunpodProfilesOptions): Promise<MergedProfiles> {
	const [globalResult, projectResult] = await Promise.all([
		readLayer(join(agentDir, "runpod.yml")),
		readLayer(join(cwd, ".omp", "runpod.yml")),
	]);
	return mergeProfileDocuments(globalResult, projectResult);
}

/** Read and parse one layer; ENOENT is an empty layer, other IO errors throw redacted. */
async function readLayer(path: string): Promise<ProfileDocumentResult> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (cause) {
		if (
			typeof cause === "object" &&
			cause !== null &&
			"code" in cause &&
			cause.code === "ENOENT"
		) {
			return { sourcePath: path, document: null, errors: [] };
		}
		throw new Error(`failed to read profile document at ${path} (redacted)`);
	}
	return parseProfileDocument(text, path);
}

/**
 * Write a profile document to `target` as valid YAML, atomically: the content
 * is written to a temp file in the same directory and renamed over the
 * target, so no partial or temp artifacts are ever left behind. Secret
 * references are written as their `ref` only; no credential bytes are
 * emitted, and the result round-trips through `parseProfileDocument`.
 */
export async function writeProfileDocument(
	target: string,
	document: ProfileDocument,
): Promise<void> {
	const yamlText = toYaml(serializeDocument(document));
	const directory = dirname(target);
	const tempPath = join(directory, `.${basename(target)}.tmp-${randomUUID()}`);
	try {
		await writeFile(tempPath, yamlText, "utf8");
		await rename(tempPath, target);
	} finally {
		await rm(tempPath, { force: true });
	}
}

/** Map a parsed document to plain serializable data (order preserved). */
function serializeDocument(document: ProfileDocument): Record<string, unknown> {
	const profiles: Record<string, unknown> = {};
	for (const [name, profile] of Object.entries(document.profiles)) {
		profiles[name] = serializeProfile(profile);
	}
	return { version: document.version, profiles };
}

/** Map a validated profile to plain serializable data; apiKey shrinks to its ref. */
function serializeProfile(profile: Profile): Record<string, unknown> {
	const serialized: Record<string, unknown> = {
		endpointType: profile.endpointType,
		invokeUrl: profile.invokeUrl,
		model: profile.model,
		request: {
			mode: profile.request.mode,
			timeoutMs: profile.request.timeoutMs,
			polling: { ...profile.request.polling },
			queueAdapter: { ...profile.request.queueAdapter },
			loadBalancedPath: profile.request.loadBalancedPath,
		},
		policy: {
			maxAttempts: profile.policy.maxAttempts,
			fallbackProfiles: [...profile.policy.fallbackProfiles],
		},
	};
	if (profile.apiKey !== undefined) {
		serialized.apiKey = { ref: profile.apiKey.ref };
	}
	return serialized;
}

/** Dependencies for resolving one profile's API key. */
export interface ResolveProfileApiKeyOptions {
	/** Key provided by the OMP host; empty or absent is treated as no key. */
	ompApiKey?: string;
	/**
	 * Injected environment record. When provided it is authoritative —
	 * `process.env` is never consulted.
	 */
	env?: Record<string, string | undefined>;
	/** Runner for `!command` references; absent means command references are an error. */
	runCommand?: (command: string) => string | Promise<string>;
}

/** Fallback environment variable consulted after the profile ref and OMP key. */
const FALLBACK_ENV_NAME = "RUNPOD_API_KEY";

/** Suffix marking an error that must never embed credential bytes. */
const REDACTED_SUFFIX = " (redacted)";

/**
 * Resolve one profile's API key.
 *
 * Precedence: the profile's own `apiKey` reference first, then the
 * OMP-provided key, then `RUNPOD_API_KEY` from the injected `env`.
 *
 * Reference forms on `profile.apiKey.ref`:
 * - `env:NAME` looks up NAME in the injected env; an unset or empty value
 *   falls through to the OMP key and then `RUNPOD_API_KEY`, and an empty NAME
 *   is an explicit error;
 * - a leading `!` runs the rest as a command through `runCommand` and returns
 *   its trimmed stdout — failure or empty output is an explicit error and
 *   never falls back;
 * - any other ref resolves environment-first (a variable of that name) then
 *   as a literal, OMP-custom-provider style.
 *
 * Every thrown error is redacted: it never contains a resolved credential
 * value, command output, or a runner's message.
 */
export async function resolveProfileApiKey(
	profile: Profile,
	{ ompApiKey, env, runCommand }: ResolveProfileApiKeyOptions,
): Promise<string> {
	const ompKey = ompApiKey ?? "";
	const ref = profile.apiKey?.ref;

	if (ref === undefined) {
		return ompKey !== "" ? ompKey : fallbackKey(env);
	}
	if (ref.startsWith("!")) {
		return resolveCommandKey(ref.slice(1), runCommand);
	}
	if (ref.startsWith("env:")) {
		const name = ref.slice("env:".length);
		if (name === "") {
			throw new Error("apiKey env reference has an empty variable name" + REDACTED_SUFFIX);
		}
		const value = env?.[name];
		if (value !== undefined && value !== "") {
			return value;
		}
		return ompKey !== "" ? ompKey : fallbackKey(env);
	}
	const envValue = env?.[ref];
	if (envValue !== undefined && envValue !== "") {
		return envValue;
	}
	return ref;
}

/** Resolve a `!command` reference; failures are redacted and never fall back. */
async function resolveCommandKey(
	command: string,
	runCommand: ResolveProfileApiKeyOptions["runCommand"],
): Promise<string> {
	if (runCommand === undefined) {
		throw new Error("apiKey command reference has no command runner" + REDACTED_SUFFIX);
	}
	let output: string;
	try {
		output = await runCommand(command);
	} catch {
		throw new Error("apiKey command failed to run" + REDACTED_SUFFIX);
	}
	const key = output.trim();
	if (key === "") {
		throw new Error("apiKey command produced no output" + REDACTED_SUFFIX);
	}
	return key;
}

/** Return `RUNPOD_API_KEY` from the injected env, or a redacted error. */
function fallbackKey(env: Record<string, string | undefined> | undefined): string {
	const key = env?.[FALLBACK_ENV_NAME];
	if (key !== undefined && key !== "") {
		return key;
	}
	throw new Error(
		"no apiKey source: profile has no apiKey reference, OMP key, or RUNPOD_API_KEY" +
			REDACTED_SUFFIX,
	);
}

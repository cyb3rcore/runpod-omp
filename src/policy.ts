/**
 * Retry and fallback policy for provider execution.
 *
 * The policy is pure and fully injected: `executeWithPolicy` never touches
 * the network itself — it drives the caller-provided `attempt` function and
 * decides, from each outcome alone, whether to retry the primary profile,
 * whether to fall back to another profile, and which fallbacks to skip.
 *
 * The rules are deliberately conservative around visible output:
 *   - the primary profile is retried only while every failure is retryable
 *     (network, rate-limit, server) AND happened before any visible output;
 *   - once an attempt reports `visibleOutput: true` the run stops: no retry
 *     and no fallback, because repeating a request that already emitted
 *     assistant text or a tool call would duplicate output;
 *   - fallbacks are capability-matched against the request before they are
 *     attempted; mismatches are recorded with the reason they were skipped.
 */

import type { NormalizedResponse } from "./transport/types.js";

/** Classification of an attempt failure, used to decide retryability. */
export type ErrorKind =
	| "network"
	| "rate-limit"
	| "server"
	| "client"
	| "abort"
	| "timeout"
	| "unknown";

/** A failed attempt's classification and human-readable message. */
export interface AttemptError {
	kind: ErrorKind;
	message: string;
}

/** The outcome of a single provider attempt. */
export interface AttemptOutcome {
	ok: boolean;
	response?: NormalizedResponse;
	error?: AttemptError;
	/**
	 * True once assistant text or a tool call has been emitted. A successful
	 * attempt carries it too; a failure may carry it when output was produced
	 * before the error.
	 */
	visibleOutput: boolean;
}

/** Capabilities a request needs from the profile that serves it. */
export interface RequestCapabilities {
	input: string[];
	supportsTools: boolean;
	supportsVision: boolean;
}

/** Capabilities a profile offers (derived from its `model` metadata). */
export interface ProfileCapabilities {
	input: string[];
	supportsTools: boolean;
	supportsVision: boolean;
}

/** A candidate profile the policy may fall back to. */
export interface FallbackProfile {
	name: string;
	capabilities: ProfileCapabilities;
}

/** A fallback the policy declined to attempt, and why. */
export interface PolicySkippedFallback {
	profile: string;
	reason: string;
}

/** The outcome of a policy run; `attempts` counts the primary profile only. */
export interface PolicyResult {
	ok: boolean;
	response?: NormalizedResponse;
	error?: AttemptError;
	attempts: number;
	usedFallback?: string;
	skippedFallbacks: PolicySkippedFallback[];
}

/** Injected parameters for {@link executeWithPolicy}. */
export interface ExecuteWithPolicyParams {
	profile: string;
	maxAttempts: number;
	fallbackProfiles: FallbackProfile[];
	requested: RequestCapabilities;
	attempt: (profileName: string) => Promise<AttemptOutcome>;
}

/**
 * True only for failures worth retrying: network errors, rate limits
 * (HTTP 429), and server errors (HTTP 5xx). Client, abort, timeout, and
 * unknown failures are never retried.
 */
export function isRetryableError(error: AttemptError): boolean {
	return error.kind === "network" || error.kind === "rate-limit" || error.kind === "server";
}

/**
 * True when every requested input mode appears in the profile's input list
 * and the profile implies the requested supportsTools/supportsVision flags.
 */
export function capabilitiesSatisfy(
	requested: RequestCapabilities,
	profile: ProfileCapabilities,
): boolean {
	const inputOk = requested.input.every((mode) => profile.input.includes(mode));
	const toolsOk = !requested.supportsTools || profile.supportsTools;
	const visionOk = !requested.supportsVision || profile.supportsVision;
	return inputOk && toolsOk && visionOk;
}

/** Reason a fallback cannot serve the request, naming every missing aspect. */
function capabilitySkipReason(requested: RequestCapabilities, profile: ProfileCapabilities): string {
	const missing: string[] = [];
	if (requested.supportsTools && !profile.supportsTools) {
		missing.push("tools");
	}
	const missingInputs = requested.input.filter((mode) => !profile.input.includes(mode));
	if (missingInputs.length > 0) {
		missing.push(`input modes: ${missingInputs.join(", ")}`);
	}
	if (requested.supportsVision && !profile.supportsVision) {
		missing.push("vision");
	}
	return `capabilities cannot satisfy the request: missing ${missing.join(", ")}`;
}

/**
 * Attempts the primary profile up to `maxAttempts` total attempts while
 * failures are retryable and pre-output; never retries once an attempt
 * reports `visibleOutput: true`, and never falls back either (each remaining
 * fallback is recorded in `skippedFallbacks` with a visible-output reason).
 *
 * After the primary fails without visible output, capability-matched
 * fallbacks are attempted in order (one attempt each; the first ok outcome
 * wins), and every fallback whose capabilities cannot satisfy the request is
 * recorded in `skippedFallbacks` without being attempted. When nothing
 * succeeds, `ok` is false and `error` is the primary profile's last error.
 */
export async function executeWithPolicy(params: ExecuteWithPolicyParams): Promise<PolicyResult> {
	const { profile, maxAttempts, fallbackProfiles, requested, attempt } = params;
	const skippedFallbacks: PolicySkippedFallback[] = [];

	let attempts = 0;
	let lastError: AttemptError | undefined;

	// Primary attempts: retry only pre-output, retryable failures.
	while (attempts < maxAttempts) {
		attempts += 1;
		const outcome = await attempt(profile);
		if (outcome.ok) {
			return {
				ok: true,
				response: outcome.response,
				attempts,
				skippedFallbacks,
			};
		}
		if (outcome.error !== undefined) {
			lastError = outcome.error;
		}
		if (outcome.visibleOutput) {
			// Output already reached the user: no retry and no fallback.
			for (const fallback of fallbackProfiles) {
				skippedFallbacks.push({
					profile: fallback.name,
					reason: "primary produced visible output; refusing to retry or fall back after output",
				});
			}
			return {
				ok: false,
				error: lastError,
				attempts,
				skippedFallbacks,
			};
		}
		if (outcome.error === undefined || !isRetryableError(outcome.error)) {
			break;
		}
	}

	// The primary failed before any visible output: try matched fallbacks.
	for (const fallback of fallbackProfiles) {
		if (!capabilitiesSatisfy(requested, fallback.capabilities)) {
			skippedFallbacks.push({
				profile: fallback.name,
				reason: capabilitySkipReason(requested, fallback.capabilities),
			});
			continue;
		}
		const outcome = await attempt(fallback.name);
		if (outcome.ok) {
			return {
				ok: true,
				response: outcome.response,
				attempts,
				usedFallback: fallback.name,
				skippedFallbacks,
			};
		}
		// A failing fallback is attempted, not skipped; move on to the next.
	}

	return {
		ok: false,
		error: lastError,
		attempts,
		skippedFallbacks,
	};
}

/**
 * Health normalization and retry/fallback policy contract tests
 * (test-first, per the approved plan).
 *
 * These tests fail today because the modules they import do not exist yet.
 * Implement the following contract to make them pass:
 *
 * src/health.ts
 *   - `QueueWorkerCount` = number | "unknown"
 *   - `QueueWorkerSummary` = { idle: QueueWorkerCount; ready: QueueWorkerCount;
 *     running: QueueWorkerCount; initializing: QueueWorkerCount;
 *     throttled: QueueWorkerCount }
 *   - `normaliseQueueHealth(input: unknown): QueueWorkerSummary` — lenient
 *     parse of a queue `/health` body: it reads the `workers` object, whose
 *     accepted field set is the union of the current official
 *     `{idle, running}` shape and the richer SDK
 *     `{idle, ready, running, initializing, throttled}` shape. Present
 *     finite non-negative numeric counts are preserved verbatim (including an
 *     explicit 0); absent fields and non-numeric/negative values become
 *     "unknown", never 0. Extra keys are ignored. Non-object input and a
 *     missing `workers` object yield an all-"unknown" summary.
 *   - `normaliseQueueJobStatus(status: unknown): QueueJobStatus` — identity
 *     for the documented wire statuses (IN_QUEUE, IN_PROGRESS, RUNNING,
 *     COMPLETED, FAILED, CANCELLED) except TIMED_OUT, which maps to
 *     "expired"; every other value (including non-strings) maps to "unknown".
 *   - `TimedHealthCache<T>` — fixed-TTL value cache with an injectable clock:
 *     `new TimedHealthCache({ ttlMs, now? })`, `set(key, value)`, and
 *     `get(key): T | undefined`. `get` returns the value only while
 *     `now() - setAt < ttlMs`; once the TTL elapses it returns undefined and
 *     forgets the entry, so callers surface "unknown" — a stale healthy value
 *     is never handed out. `set` refreshes the expiry from the latest write;
 *     keys are independent; a missing key reads as undefined.
 *
 * src/policy.ts
 *   - `ErrorKind` = "network" | "rate-limit" | "server" | "client" |
 *     "abort" | "timeout" | "unknown"
 *   - `AttemptError` = { kind: ErrorKind; message: string }
 *   - `AttemptOutcome` = { ok: boolean; response?: NormalizedResponse;
 *     error?: AttemptError; visibleOutput: boolean } — `visibleOutput` is
 *     true once assistant text or a tool call has been emitted (a successful
 *     attempt carries it too).
 *   - `RequestCapabilities` = { input: string[]; supportsTools: boolean;
 *     supportsVision: boolean }
 *   - `ProfileCapabilities` = same shape (derived from a profile's
 *     `model` metadata)
 *   - `FallbackProfile` = { name: string; capabilities: ProfileCapabilities }
 *   - `PolicySkippedFallback` = { profile: string; reason: string }
 *   - `PolicyResult` = { ok: boolean; response?: NormalizedResponse;
 *     error?: AttemptError; attempts: number; usedFallback?: string;
 *     skippedFallbacks: PolicySkippedFallback[] } — `attempts` counts
 *     attempts on the primary profile only.
 *   - `ExecuteWithPolicyParams` = { profile: string; maxAttempts: number;
 *     fallbackProfiles: FallbackProfile[]; requested: RequestCapabilities;
 *     attempt: (profileName: string) => Promise<AttemptOutcome> }
 *   - `isRetryableError(error: AttemptError): boolean` — true only for
 *     network, rate-limit (HTTP 429), and server (HTTP 5xx) kinds.
 *   - `capabilitiesSatisfy(requested: RequestCapabilities,
 *     profile: ProfileCapabilities): boolean` — true when every requested
 *     input mode appears in profile.input and the requested
 *     supportsTools/supportsVision flags are implied by the profile's.
 *   - `executeWithPolicy(params): Promise<PolicyResult>` — attempts the
 *     primary profile up to `maxAttempts` total attempts while failures are
 *     retryable and pre-output; never retries once an attempt reports
 *     `visibleOutput: true`, and never falls back either (each remaining
 *     fallback is recorded in skippedFallbacks with a visible-output
 *     reason). After the primary fails without visible output, capability-
 *     matched fallbacks are attempted in order (one attempt each; the first
 *     ok outcome wins), and every fallback whose capabilities cannot satisfy
 *     the request is recorded in skippedFallbacks without being attempted.
 *     When nothing succeeds, `ok` is false and `error` is the primary
 *     profile's last error.
 */
import { describe, expect, test } from "bun:test";

// Named value imports pin the required entry points (link-time failure today:
// the modules do not exist yet).
import {
	normaliseQueueHealth,
	normaliseQueueJobStatus,
	TimedHealthCache,
} from "../src/health.js";
import {
	capabilitiesSatisfy,
	executeWithPolicy,
	isRetryableError,
} from "../src/policy.js";

import type { NormalizedResponse, QueueJobStatus } from "../src/transport/types.js";

// ---------------------------------------------------------------------------
// Local mirrors of the contract types declared in the header. They are the
// exact shapes the src modules must produce; the header documents them so the
// implementation can export matching types under the same names.
// ---------------------------------------------------------------------------

type QueueWorkerCount = number | "unknown";

interface QueueWorkerSummary {
	idle: QueueWorkerCount;
	ready: QueueWorkerCount;
	running: QueueWorkerCount;
	initializing: QueueWorkerCount;
	throttled: QueueWorkerCount;
}

type ErrorKind =
	| "network"
	| "rate-limit"
	| "server"
	| "client"
	| "abort"
	| "timeout"
	| "unknown";

interface AttemptError {
	kind: ErrorKind;
	message: string;
}

interface AttemptOutcome {
	ok: boolean;
	response?: NormalizedResponse;
	error?: AttemptError;
	visibleOutput: boolean;
}

interface RequestCapabilities {
	input: string[];
	supportsTools: boolean;
	supportsVision: boolean;
}

interface ProfileCapabilities {
	input: string[];
	supportsTools: boolean;
	supportsVision: boolean;
}

interface FallbackProfile {
	name: string;
	capabilities: ProfileCapabilities;
}

interface PolicySkippedFallback {
	profile: string;
	reason: string;
}

interface PolicyResult {
	ok: boolean;
	response?: NormalizedResponse;
	error?: AttemptError;
	attempts: number;
	usedFallback?: string;
	skippedFallbacks: PolicySkippedFallback[];
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_UNKNOWN: QueueWorkerSummary = {
	idle: "unknown",
	ready: "unknown",
	running: "unknown",
	initializing: "unknown",
	throttled: "unknown",
};

/** An ok attempt whose response carries visible assistant text. */
function okOutcome(text: string): AttemptOutcome {
	return { ok: true, response: { text, downgrades: [] }, visibleOutput: true };
}

/** A pre-output failure of the given kind. */
function failOutcome(kind: ErrorKind, message = `failure of kind ${kind}`): AttemptOutcome {
	return { ok: false, error: { kind, message }, visibleOutput: false };
}

/** A failure that produced visible output before erroring. */
function postOutputFailure(kind: ErrorKind, message = `post-output failure of kind ${kind}`): AttemptOutcome {
	return { ok: false, error: { kind, message }, visibleOutput: true };
}

/** A text-only request and a matching text-only profile. */
const TEXT_REQUEST: RequestCapabilities = {
	input: ["text"],
	supportsTools: false,
	supportsVision: false,
};

const TEXT_PROFILE: ProfileCapabilities = {
	input: ["text"],
	supportsTools: false,
	supportsVision: false,
};

/** A multimodal/tool-capable profile; a strict superset of TEXT_REQUEST. */
const RICH_PROFILE: ProfileCapabilities = {
	input: ["text", "image"],
	supportsTools: true,
	supportsVision: true,
};

/** One recorded attempt call: which profile, and how many times it was called. */
interface AttemptCall {
	profile: string;
	callNumber: number;
}

/**
 * Deterministic policy harness: scripts one outcome sequence per profile.
 * Outcomes are consumed in order; an unscripted call fails with an unknown
 * error so an unexpected extra attempt is visible in the result.
 */
function policyHarness(options: {
	profile: string;
	maxAttempts: number;
	fallbackProfiles: FallbackProfile[];
	requested: RequestCapabilities;
	outcomes: Record<string, AttemptOutcome[]>;
}): { run: () => Promise<PolicyResult>; calls: AttemptCall[] } {
	const calls: AttemptCall[] = [];
	const perProfileCalls: Record<string, number> = {};
	const run = () =>
		executeWithPolicy({
			profile: options.profile,
			maxAttempts: options.maxAttempts,
			fallbackProfiles: options.fallbackProfiles,
			requested: options.requested,
			attempt: async (profile: string) => {
				perProfileCalls[profile] = (perProfileCalls[profile] ?? 0) + 1;
				calls.push({ profile, callNumber: perProfileCalls[profile] });
				const sequence = options.outcomes[profile] ?? [];
				return sequence.shift() ?? failOutcome("unknown", "no scripted outcome");
			},
		});
	return { run, calls };
}

// ---------------------------------------------------------------------------
// normaliseQueueHealth
// ---------------------------------------------------------------------------

describe("normaliseQueueHealth", () => {
	test("accepts the current official workers shape {idle, running}", () => {
		expect(normaliseQueueHealth({ workers: { idle: 1, running: 2 } })).toEqual({
			idle: 1,
			ready: "unknown",
			running: 2,
			initializing: "unknown",
			throttled: "unknown",
		});
	});

	test("accepts the richer SDK workers shape with every count preserved", () => {
		expect(
			normaliseQueueHealth({
				workers: { idle: 3, ready: 1, running: 2, initializing: 0, throttled: 0 },
			}),
		).toEqual({
			idle: 3,
			ready: 1,
			running: 2,
			initializing: 0,
			throttled: 0,
		});
	});

	test("preserves an explicit zero; only absent fields become unknown", () => {
		expect(normaliseQueueHealth({ workers: { idle: 0, running: 0 } })).toEqual({
			idle: 0,
			ready: "unknown",
			running: 0,
			initializing: "unknown",
			throttled: "unknown",
		});
	});

	test("a missing workers field yields all-unknown, never zero", () => {
		expect(normaliseQueueHealth({})).toEqual(ALL_UNKNOWN);
	});

	test("an empty workers object yields all-unknown, never zero", () => {
		expect(normaliseQueueHealth({ workers: {} })).toEqual(ALL_UNKNOWN);
	});

	test("non-object input yields all-unknown, never zero", () => {
		for (const bad of [null, "payload", 42, ["workers"]]) {
			expect(normaliseQueueHealth(bad)).toEqual(ALL_UNKNOWN);
		}
	});

	test("non-numeric and negative worker values become unknown for that field", () => {
		expect(normaliseQueueHealth({ workers: { idle: "1", running: -2, initializing: 1.5 } })).toEqual({
			idle: "unknown",
			ready: "unknown",
			running: "unknown",
			initializing: 1.5,
			throttled: "unknown",
		});
	});

	test("ignores unknown extra keys in the workers object", () => {
		expect(normaliseQueueHealth({ workers: { idle: 1, running: 2, bogus: 9 } })).toEqual({
			idle: 1,
			ready: "unknown",
			running: 2,
			initializing: "unknown",
			throttled: "unknown",
		});
	});
});

// ---------------------------------------------------------------------------
// normaliseQueueJobStatus
// ---------------------------------------------------------------------------

describe("normaliseQueueJobStatus", () => {
	test("TIMED_OUT maps to the explicit expired state", () => {
		expect(normaliseQueueJobStatus("TIMED_OUT")).toBe("expired");
	});

	test("documented wire statuses pass through unchanged", () => {
		const expected: QueueJobStatus[] = [
			"IN_QUEUE",
			"IN_PROGRESS",
			"RUNNING",
			"COMPLETED",
			"FAILED",
			"CANCELLED",
		];
		for (const status of expected) {
			expect(normaliseQueueJobStatus(status)).toBe(status);
		}
	});

	test("anything else maps to unknown, never healthy or expired", () => {
		for (const bad of ["QUEUED", "pending", "TIMEOUT", 42, null, undefined, {}]) {
			expect(normaliseQueueJobStatus(bad)).toBe("unknown");
		}
	});
});

// ---------------------------------------------------------------------------
// TimedHealthCache
// ---------------------------------------------------------------------------

describe("TimedHealthCache", () => {
	test("returns the cached value while it is fresh", () => {
		let now = 0;
		const cache = new TimedHealthCache<QueueWorkerSummary>({ ttlMs: 5_000, now: () => now });
		const healthy = { idle: 1, ready: "unknown", running: 2, initializing: "unknown", throttled: "unknown" };

		cache.set("queue:ep", healthy);
		now = 4_999;

		expect(cache.get("queue:ep")).toEqual(healthy);
	});

	test("an expired entry reads as undefined: stale healthy values are never handed out", () => {
		let now = 0;
		const cache = new TimedHealthCache<QueueWorkerSummary>({ ttlMs: 5_000, now: () => now });
		const healthy = { idle: 1, ready: "unknown", running: 2, initializing: "unknown", throttled: "unknown" };

		cache.set("queue:ep", healthy);
		now = 5_000;

		// The caller has no cached health at all, so it must surface "unknown"
		// rather than the previously cached healthy state.
		expect(cache.get("queue:ep")).toBeUndefined();
	});

	test("expired entries are forgotten, not refreshed by reads", () => {
		let now = 0;
		const cache = new TimedHealthCache<QueueWorkerSummary>({ ttlMs: 5_000, now: () => now });
		const healthy = { idle: 1, ready: "unknown", running: 2, initializing: "unknown", throttled: "unknown" };

		cache.set("queue:ep", healthy);
		now = 4_999;
		expect(cache.get("queue:ep")).toEqual(healthy);
		now = 10_000;
		expect(cache.get("queue:ep")).toBeUndefined();
	});

	test("a missing key reads as undefined", () => {
		const cache = new TimedHealthCache<QueueWorkerSummary>({ ttlMs: 5_000, now: () => 0 });
		expect(cache.get("queue:never-set")).toBeUndefined();
	});

	test("keys are independent", () => {
		let now = 0;
		const cache = new TimedHealthCache<QueueWorkerSummary>({ ttlMs: 5_000, now: () => now });
		const first = { idle: 1, ready: "unknown", running: 0, initializing: "unknown", throttled: "unknown" };

		cache.set("queue:a", first);
		// b is written a second later, so its TTL starts later.
		now = 1_000;
		cache.set("queue:b", ALL_UNKNOWN);

		now = 4_999;
		expect(cache.get("queue:a")).toEqual(first);
		expect(cache.get("queue:b")).toEqual(ALL_UNKNOWN);

		now = 5_000;
		// a was written at now=0 and hits its 5s TTL exactly now.
		expect(cache.get("queue:a")).toBeUndefined();
		// b was written at now=1_000, so it stays fresh until now=6_000.
		expect(cache.get("queue:b")).toEqual(ALL_UNKNOWN);
	});

	test("a re-set refreshes the expiry from the latest write", () => {
		let now = 0;
		const cache = new TimedHealthCache<QueueWorkerSummary>({ ttlMs: 5_000, now: () => now });
		const healthy = { idle: 1, ready: "unknown", running: 2, initializing: "unknown", throttled: "unknown" };

		cache.set("queue:ep", healthy);
		now = 4_000;
		cache.set("queue:ep", healthy);
		now = 8_999;
		expect(cache.get("queue:ep")).toEqual(healthy);
		now = 9_000;
		expect(cache.get("queue:ep")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// isRetryableError
// ---------------------------------------------------------------------------

describe("isRetryableError", () => {
	test("network, rate-limit (429), and server (5xx) failures are retryable", () => {
		for (const kind of ["network", "rate-limit", "server"] as const) {
			expect(isRetryableError({ kind, message: `${kind} failure` })).toBe(true);
		}
	});

	test("client, abort, timeout, and unknown failures are never retried", () => {
		for (const kind of ["client", "abort", "timeout", "unknown"] as const) {
			expect(isRetryableError({ kind, message: `${kind} failure` })).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// capabilitiesSatisfy
// ---------------------------------------------------------------------------

describe("capabilitiesSatisfy", () => {
	test("identical capabilities satisfy the request", () => {
		expect(capabilitiesSatisfy(TEXT_REQUEST, TEXT_PROFILE)).toBe(true);
	});

	test("a superset profile satisfies the request", () => {
		expect(capabilitiesSatisfy(TEXT_REQUEST, RICH_PROFILE)).toBe(true);
	});

	test("a request for vision is not satisfied by a vision-less profile", () => {
		expect(
			capabilitiesSatisfy({ input: ["text"], supportsTools: false, supportsVision: true }, TEXT_PROFILE),
		).toBe(false);
	});

	test("a request for tools is not satisfied by a tool-less profile", () => {
		expect(
			capabilitiesSatisfy({ input: ["text"], supportsTools: true, supportsVision: false }, TEXT_PROFILE),
		).toBe(false);
	});

	test("a request for an image input mode is not satisfied by a text-only profile", () => {
		expect(
			capabilitiesSatisfy({ input: ["text", "image"], supportsTools: false, supportsVision: false }, TEXT_PROFILE),
		).toBe(false);
	});

	test("a text-only request is satisfied by a multimodal profile even with no flags requested", () => {
		expect(capabilitiesSatisfy(TEXT_REQUEST, RICH_PROFILE)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// executeWithPolicy
// ---------------------------------------------------------------------------

describe("executeWithPolicy", () => {
	test("succeeds immediately when the first attempt succeeds", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 3,
			fallbackProfiles: [],
			requested: TEXT_REQUEST,
			outcomes: { primary: [okOutcome("first try")] },
		});

		const result = await run();

		expect(result.ok).toBe(true);
		expect(result.response).toEqual({ text: "first try", downgrades: [] });
		expect(result.attempts).toBe(1);
		expect(result.usedFallback).toBeUndefined();
		expect(result.skippedFallbacks).toEqual([]);
		expect(calls).toEqual([{ profile: "primary", callNumber: 1 }]);
	});

	test("retries a pre-output retryable failure up to maxAttempts, then fails", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 3,
			fallbackProfiles: [],
			requested: TEXT_REQUEST,
			outcomes: {
				primary: [failOutcome("network"), failOutcome("network"), failOutcome("network")],
			},
		});

		const result = await run();

		expect(result.ok).toBe(false);
		expect(result.error?.kind).toBe("network");
		expect(result.attempts).toBe(3);
		expect(calls).toHaveLength(3);
	});

	test("succeeds on a later retry and returns that attempt's response", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 3,
			fallbackProfiles: [],
			requested: TEXT_REQUEST,
			outcomes: { primary: [failOutcome("server"), failOutcome("rate-limit"), okOutcome("recovered")] },
		});

		const result = await run();

		expect(result.ok).toBe(true);
		expect(result.response).toEqual({ text: "recovered", downgrades: [] });
		expect(result.attempts).toBe(3);
		expect(calls).toHaveLength(3);
	});

	test("maxAttempts bounds the total attempts", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 1,
			fallbackProfiles: [],
			requested: TEXT_REQUEST,
			outcomes: { primary: [failOutcome("network")] },
		});

		const result = await run();

		expect(result.ok).toBe(false);
		expect(result.error?.kind).toBe("network");
		expect(result.attempts).toBe(1);
		expect(calls).toHaveLength(1);
	});

	test("client failures are not retried", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 3,
			fallbackProfiles: [],
			requested: TEXT_REQUEST,
			outcomes: { primary: [failOutcome("client")] },
		});

		const result = await run();

		expect(result.ok).toBe(false);
		expect(result.error?.kind).toBe("client");
		expect(result.attempts).toBe(1);
		expect(calls).toHaveLength(1);
	});

	test("abort and timeout failures are not retried", async () => {
		for (const kind of ["abort", "timeout"] as const) {
			const { run, calls } = policyHarness({
				profile: "primary",
				maxAttempts: 3,
				fallbackProfiles: [],
				requested: TEXT_REQUEST,
				outcomes: { primary: [failOutcome(kind)] },
			});

			const result = await run();

			expect(result.ok).toBe(false);
			expect(result.error?.kind).toBe(kind);
			expect(result.attempts).toBe(1);
			expect(calls).toHaveLength(1);
		}
	});

	test("never retries once visible output was produced, even on a retryable error", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 3,
			fallbackProfiles: [],
			requested: TEXT_REQUEST,
			outcomes: { primary: [postOutputFailure("network")] },
		});

		const result = await run();

		expect(result.ok).toBe(false);
		expect(result.error?.kind).toBe("network");
		expect(result.attempts).toBe(1);
		expect(calls).toHaveLength(1);
	});

	test("falls back to a capability-matched profile after retries are exhausted", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 2,
			fallbackProfiles: [{ name: "backup", capabilities: TEXT_PROFILE }],
			requested: TEXT_REQUEST,
			outcomes: {
				primary: [failOutcome("network"), failOutcome("network")],
				backup: [okOutcome("from the fallback")],
			},
		});

		const result = await run();

		expect(result.ok).toBe(true);
		expect(result.response).toEqual({ text: "from the fallback", downgrades: [] });
		expect(result.attempts).toBe(2);
		expect(result.usedFallback).toBe("backup");
		expect(result.skippedFallbacks).toEqual([]);
		expect(calls).toEqual([
			{ profile: "primary", callNumber: 1 },
			{ profile: "primary", callNumber: 2 },
			{ profile: "backup", callNumber: 1 },
		]);
	});

	test("falls back after a non-retryable pre-output failure when capabilities match", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 2,
			fallbackProfiles: [{ name: "backup", capabilities: TEXT_PROFILE }],
			requested: TEXT_REQUEST,
			outcomes: {
				primary: [failOutcome("client")],
				backup: [okOutcome("backup answered")],
			},
		});

		const result = await run();

		expect(result.ok).toBe(true);
		expect(result.response).toEqual({ text: "backup answered", downgrades: [] });
		expect(result.attempts).toBe(1);
		expect(result.usedFallback).toBe("backup");
	});

	test("never attempts a fallback whose capabilities cannot satisfy the request, and records the reason", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 2,
			fallbackProfiles: [{ name: "backup", capabilities: TEXT_PROFILE }],
			requested: { input: ["text"], supportsTools: false, supportsVision: true },
			outcomes: { primary: [failOutcome("network"), failOutcome("network")] },
		});

		const result = await run();

		expect(result.ok).toBe(false);
		expect(result.error?.kind).toBe("network");
		expect(result.attempts).toBe(2);
		expect(result.usedFallback).toBeUndefined();
		expect(result.skippedFallbacks).toHaveLength(1);
		expect(result.skippedFallbacks[0].profile).toBe("backup");
		expect(result.skippedFallbacks[0].reason).toMatch(/vision/i);
		// The mismatched fallback is never called.
		expect(calls.every((call) => call.profile === "primary")).toBe(true);
	});

	test("skips each mismatched fallback and uses the first matching one in order", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 1,
			fallbackProfiles: [
				{ name: "no-tools", capabilities: TEXT_PROFILE },
				{ name: "rich", capabilities: RICH_PROFILE },
			],
			requested: { input: ["text"], supportsTools: true, supportsVision: false },
			outcomes: {
				primary: [failOutcome("server")],
				rich: [okOutcome("rich answered")],
			},
		});

		const result = await run();

		expect(result.ok).toBe(true);
		expect(result.usedFallback).toBe("rich");
		expect(result.skippedFallbacks).toHaveLength(1);
		expect(result.skippedFallbacks[0].profile).toBe("no-tools");
		expect(result.skippedFallbacks[0].reason).toMatch(/tool/i);
		expect(calls.map((call) => call.profile)).toEqual(["primary", "rich"]);
	});

	test("reports the original failure plus every skipped reason when no fallback matches", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 2,
			fallbackProfiles: [
				{ name: "no-tools", capabilities: TEXT_PROFILE },
				{ name: "no-image", capabilities: { input: ["text"], supportsTools: true, supportsVision: false } },
			],
			requested: { input: ["text", "image"], supportsTools: true, supportsVision: true },
			outcomes: { primary: [failOutcome("network"), failOutcome("network")] },
		});

		const result = await run();

		expect(result.ok).toBe(false);
		expect(result.error?.kind).toBe("network");
		expect(result.attempts).toBe(2);
		expect(result.usedFallback).toBeUndefined();
		expect(result.skippedFallbacks.map((skip) => skip.profile)).toEqual(["no-tools", "no-image"]);
		expect(result.skippedFallbacks[0].reason).toMatch(/tool/i);
		expect(result.skippedFallbacks[1].reason).toMatch(/input/i);
		expect(calls.every((call) => call.profile === "primary")).toBe(true);
	});

	test("visible output on the primary blocks every fallback and records the reason", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 2,
			fallbackProfiles: [{ name: "backup", capabilities: RICH_PROFILE }],
			requested: TEXT_REQUEST,
			outcomes: { primary: [postOutputFailure("rate-limit")] },
		});

		const result = await run();

		expect(result.ok).toBe(false);
		expect(result.error?.kind).toBe("rate-limit");
		expect(result.attempts).toBe(1);
		expect(result.usedFallback).toBeUndefined();
		expect(result.skippedFallbacks).toHaveLength(1);
		expect(result.skippedFallbacks[0].profile).toBe("backup");
		expect(result.skippedFallbacks[0].reason).toMatch(/visible output/i);
		// The fallback is never called once the primary produced visible output.
		expect(calls.every((call) => call.profile === "primary")).toBe(true);
	});

	test("a failing matched fallback moves on to the next fallback", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 1,
			fallbackProfiles: [
				{ name: "first-backup", capabilities: TEXT_PROFILE },
				{ name: "second-backup", capabilities: TEXT_PROFILE },
			],
			requested: TEXT_REQUEST,
			outcomes: {
				primary: [failOutcome("network")],
				"first-backup": [failOutcome("client")],
				"second-backup": [okOutcome("second backup answered")],
			},
		});

		const result = await run();

		expect(result.ok).toBe(true);
		expect(result.response).toEqual({ text: "second backup answered", downgrades: [] });
		expect(result.usedFallback).toBe("second-backup");
		expect(result.skippedFallbacks).toEqual([]);
		expect(calls.map((call) => call.profile)).toEqual(["primary", "first-backup", "second-backup"]);
	});

	test("reports the primary's last error when every matched fallback also fails", async () => {
		const { run, calls } = policyHarness({
			profile: "primary",
			maxAttempts: 2,
			fallbackProfiles: [
				{ name: "first-backup", capabilities: TEXT_PROFILE },
				{ name: "second-backup", capabilities: TEXT_PROFILE },
			],
			requested: TEXT_REQUEST,
			outcomes: {
				primary: [failOutcome("server"), failOutcome("server")],
				"first-backup": [failOutcome("network")],
				"second-backup": [failOutcome("network")],
			},
		});

		const result = await run();

		expect(result.ok).toBe(false);
		// The original (primary) failure is reported, not the fallback failures.
		expect(result.error?.kind).toBe("server");
		expect(result.attempts).toBe(2);
		expect(result.usedFallback).toBeUndefined();
		expect(result.skippedFallbacks).toEqual([]);
		expect(calls.map((call) => call.profile)).toEqual([
			"primary",
			"primary",
			"first-backup",
			"second-backup",
		]);
	});
});

// Compile-time witness: the local contract mirrors stay assignable to the
// shapes the policy consumes, and the fixture request is a valid capability
// set for the profiles above.
const _requestWitness: RequestCapabilities = TEXT_REQUEST;
const _profileWitness: ProfileCapabilities = RICH_PROFILE;
void _requestWitness;
void _profileWitness;

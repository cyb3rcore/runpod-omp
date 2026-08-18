/**
 * Health normalization and TTL caching for Runpod queue endpoints.
 *
 * Pure module: no OMP UI, no network. The queue `/health` payload is parsed
 * leniently — anything that cannot be read as a finite non-negative count
 * becomes "unknown" so callers never invent a zero where no count was
 * reported.
 */
import type { QueueJobStatus } from "./transport/types.js";

/** A worker count that could not be read from the wire payload. */
export type QueueWorkerCount = number | "unknown";

/**
 * Normalized queue worker summary. Every field is present; a field the wire
 * payload did not report (or reported unusably) is "unknown".
 */
export interface QueueWorkerSummary {
	idle: QueueWorkerCount;
	ready: QueueWorkerCount;
	running: QueueWorkerCount;
	initializing: QueueWorkerCount;
	throttled: QueueWorkerCount;
}

const ALL_UNKNOWN: QueueWorkerSummary = {
	idle: "unknown",
	ready: "unknown",
	running: "unknown",
	initializing: "unknown",
	throttled: "unknown",
};

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normaliseWorkerCount(value: unknown): QueueWorkerCount {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: "unknown";
}

/**
 * Lenient parse of a queue `/health` body.
 *
 * Reads the `workers` object, whose accepted field set is the union of the
 * current official `{idle, running}` shape and the richer SDK
 * `{idle, ready, running, initializing, throttled}` shape. Present finite
 * non-negative numeric counts are preserved verbatim (including an explicit
 * 0); absent fields and non-numeric/negative values become "unknown", never
 * 0. Extra keys are ignored. Non-object input and a missing `workers` object
 * yield an all-"unknown" summary.
 */
export function normaliseQueueHealth(input: unknown): QueueWorkerSummary {
	const workers = isObject(input) ? input["workers"] : undefined;
	if (!isObject(workers)) {
		return ALL_UNKNOWN;
	}
	return {
		idle: normaliseWorkerCount(workers["idle"]),
		ready: normaliseWorkerCount(workers["ready"]),
		running: normaliseWorkerCount(workers["running"]),
		initializing: normaliseWorkerCount(workers["initializing"]),
		throttled: normaliseWorkerCount(workers["throttled"]),
	};
}

/**
 * Normalize a queue job status string.
 *
 * Identity for the documented wire statuses (IN_QUEUE, IN_PROGRESS, RUNNING,
 * COMPLETED, FAILED, CANCELLED) except TIMED_OUT, which maps to "expired".
 * Every other value (including non-strings) maps to "unknown".
 */
export function normaliseQueueJobStatus(status: unknown): QueueJobStatus {
	switch (status) {
		case "TIMED_OUT":
			return "expired";
		case "IN_QUEUE":
		case "IN_PROGRESS":
		case "RUNNING":
		case "COMPLETED":
		case "FAILED":
		case "CANCELLED":
			return status;
		default:
			return "unknown";
	}
}

interface TimedHealthCacheOptions {
	/** Fixed lifetime of every entry, in milliseconds. */
	ttlMs: number;
	/** Injectable clock; defaults to Date.now. */
	now?: () => number;
}

interface CacheEntry<T> {
	value: T;
	setAt: number;
}

/**
 * Fixed-TTL value cache with an injectable clock.
 *
 * `get` returns the value only while `now() - setAt < ttlMs`; once the TTL
 * elapses it returns undefined and forgets the entry, so callers surface
 * "unknown" — a stale healthy value is never handed out. `set` refreshes the
 * expiry from the latest write; keys are independent; a missing key reads as
 * undefined.
 */
export class TimedHealthCache<T> {
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly entries = new Map<string, CacheEntry<T>>();

	constructor(options: TimedHealthCacheOptions) {
		this.ttlMs = options.ttlMs;
		this.now = options.now ?? Date.now;
	}

	set(key: string, value: T): void {
		this.entries.set(key, { value, setAt: this.now() });
	}

	get(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (entry === undefined) {
			return undefined;
		}
		if (this.now() - entry.setAt >= this.ttlMs) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}
}

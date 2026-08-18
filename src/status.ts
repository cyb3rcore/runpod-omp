/**
 * Adaptive status report rendering for Runpod endpoints.
 *
 * Pure module: no OMP UI, no fetch, no clock. Freshness is a caller-supplied
 * verdict (`health.fresh`, produced by src/health.ts cache/TTL logic), so the
 * module stays deterministic. Reports are reconstructed from their inputs —
 * untrusted state is never spread through — and missing worker counts render
 * as "unknown", never an invented zero.
 */
import type { EndpointType } from "./profile-schema.js";
import type { QueueJobStatus } from "./transport/types.js";

/** Most-actionable status token; highest in the precedence list wins. */
export type ActionableStatus =
	| "cold-start"
	| "queued"
	| "unhealthy"
	| "stale"
	| "healthy";

/** A worker count that could not be read from the wire payload. */
export type QueueWorkerCount = number | "unknown";

/**
 * Lenient queue worker counts. Every field is optional: a missing field means
 * "unknown", never zero. An explicit zero supplied by the API is preserved.
 */
export interface QueueWorkerCounts {
	idle?: QueueWorkerCount;
	ready?: QueueWorkerCount;
	running?: QueueWorkerCount;
	initializing?: QueueWorkerCount;
	throttled?: QueueWorkerCount;
	unhealthy?: QueueWorkerCount;
}

/** Fresh-or-stale queue health snapshot (queue endpoints only). */
export interface QueueHealthSnapshot {
	fresh: boolean;
	workers: QueueWorkerCounts;
	queueDepth?: number;
}

/** Load-balanced ping outcome from the health probe. */
export type LoadBalancedPing = "healthy" | "initializing" | "unhealthy";

/** Fresh-or-stale load-balanced health snapshot. */
export interface LoadBalancedHealthSnapshot {
	fresh: boolean;
	ping: LoadBalancedPing;
	latencyMs?: number;
}

/** A current queue job; status is a QueueJobStatus value. */
export interface CurrentJob {
	jobId: string;
	status: QueueJobStatus;
}

/** Optional recent spend summary. */
export interface SpendSummary {
	amount: number;
	currency: string;
	period: string;
}

/** Profile identity consumed by the report. */
export interface StatusProfile {
	name: string;
	endpointType: EndpointType;
}

/** Everything buildStatusReport needs; all data is caller-supplied. */
export interface StatusInput {
	profile: StatusProfile;
	health: QueueHealthSnapshot | LoadBalancedHealthSnapshot;
	currentJob?: CurrentJob;
	spend?: SpendSummary;
}

/** Rendered queue report. */
export interface QueueStatusReport {
	profile: string;
	endpointType: "queue";
	status: ActionableStatus;
	fresh: boolean;
	workers: Required<QueueWorkerCounts>;
	workerSummary: string;
	currentJob?: CurrentJob;
	spend?: SpendSummary;
	line: string;
}

/** Rendered load-balanced report; queue-only fields never appear. */
export interface LoadBalancedStatusReport {
	profile: string;
	endpointType: "load-balanced";
	status: ActionableStatus;
	fresh: boolean;
	ping: LoadBalancedPing | "unknown";
	readiness: "ready" | "initializing" | "unhealthy" | "unknown";
	latencyMs?: number;
	spend?: SpendSummary;
	line: string;
}

/** Rendered status report; the `endpointType` tag discriminates the shape. */
export type StatusReport = QueueStatusReport | LoadBalancedStatusReport;

/** Canonical worker-summary field order: idle, ready, running, ... */
const WORKER_FIELDS = [
	"idle",
	"ready",
	"running",
	"initializing",
	"throttled",
	"unhealthy",
] as const;

/** A finite non-negative numeric count (an explicit zero is preserved). */
function isKnownCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Lenient count read: only finite non-negative numbers survive. */
function toCount(value: unknown): QueueWorkerCount {
	return isKnownCount(value) ? value : "unknown";
}

/** Reconstruct every count; missing or unusable fields become "unknown". */
function toRenderedCounts(workers: QueueWorkerCounts): Required<QueueWorkerCounts> {
	return {
		idle: toCount(workers.idle),
		ready: toCount(workers.ready),
		running: toCount(workers.running),
		initializing: toCount(workers.initializing),
		throttled: toCount(workers.throttled),
		unhealthy: toCount(workers.unhealthy),
	};
}

/** Every count unknown: the only shape a stale report may present. */
const UNKNOWN_COUNTS: Required<QueueWorkerCounts> = {
	idle: "unknown",
	ready: "unknown",
	running: "unknown",
	initializing: "unknown",
	throttled: "unknown",
	unhealthy: "unknown",
};

/** "N <field>" in canonical order, joined ", "; "unknown" when none known. */
function toWorkerSummary(counts: Required<QueueWorkerCounts>): string {
	const parts: string[] = [];
	for (const field of WORKER_FIELDS) {
		const value = counts[field];
		if (typeof value === "number") {
			parts.push(`${value} ${field}`);
		}
	}
	return parts.length === 0 ? "unknown" : parts.join(", ");
}

/**
 * Most-actionable queue status: cold-start > queued > unhealthy > stale >
 * healthy. Cold-start, queued, and unhealthy only apply to fresh snapshots.
 */
function toQueueStatus(
	health: QueueHealthSnapshot,
	currentJob: CurrentJob | undefined,
): ActionableStatus {
	if (!health.fresh) {
		return "stale";
	}
	// The "unknown"/"expired" TTL sentinels: unknown never masquerades as
	// healthy, but fresh worker/job detail still renders (see the report).
	if (typeof health.workers.initializing === "number" && health.workers.initializing > 0) {
		return "cold-start";
	}
	if ((health.queueDepth ?? 0) > 0 || currentJob?.status === "IN_QUEUE") {
		return "queued";
	}
	if (typeof health.workers.unhealthy === "number" && health.workers.unhealthy > 0) {
		return "unhealthy";
	}
	if (
		currentJob !== undefined &&
		(currentJob.status === "unknown" || currentJob.status === "expired")
	) {
		return "stale";
	}
	return "healthy";
}

/** Most-actionable load-balanced status; stale beats a cached healthy ping. */
function toLoadBalancedStatus(health: LoadBalancedHealthSnapshot): ActionableStatus {
	if (!health.fresh) {
		return "stale";
	}
	if (health.ping === "initializing") {
		return "cold-start";
	}
	if (health.ping === "unhealthy") {
		return "unhealthy";
	}
	return "healthy";
}

function isQueueHealthSnapshot(
	health: QueueHealthSnapshot | LoadBalancedHealthSnapshot,
): health is QueueHealthSnapshot {
	return "workers" in health;
}

function buildQueueReport(
	profileName: string,
	health: QueueHealthSnapshot,
	currentJob: CurrentJob | undefined,
	spend: SpendSummary | undefined,
): QueueStatusReport {
	const counts: Required<QueueWorkerCounts> = health.fresh
		? toRenderedCounts(health.workers)
		: { ...UNKNOWN_COUNTS };
	const status = toQueueStatus(health, currentJob);
	const workerSummary = toWorkerSummary(counts);

	const parts = [`${profileName}: ${status}`];
	if (health.fresh) {
		parts.push(`workers: ${workerSummary}`);
	}
	if (health.fresh && currentJob !== undefined) {
		parts.push(`job ${currentJob.jobId}: ${currentJob.status}`);
	}
	if (spend !== undefined) {
		parts.push(`spent ${spend.amount} ${spend.currency} (${spend.period})`);
	}

	const report: QueueStatusReport = {
		profile: profileName,
		endpointType: "queue",
		status,
		fresh: health.fresh,
		workers: counts,
		workerSummary,
		line: parts.join(" · "),
	};
	if (health.fresh && currentJob !== undefined) {
		report.currentJob = { jobId: currentJob.jobId, status: currentJob.status };
	}
	if (spend !== undefined) {
		report.spend = {
			amount: spend.amount,
			currency: spend.currency,
			period: spend.period,
		};
	}
	return report;
}

function buildLoadBalancedReport(
	profileName: string,
	health: LoadBalancedHealthSnapshot,
	spend: SpendSummary | undefined,
): LoadBalancedStatusReport {
	const status = toLoadBalancedStatus(health);
	const ping: LoadBalancedPing | "unknown" = health.fresh ? health.ping : "unknown";
	const readiness: LoadBalancedStatusReport["readiness"] = health.fresh
		? health.ping === "healthy"
			? "ready"
			: health.ping
		: "unknown";

	const parts = [`${profileName}: ${status}`];
	if (health.fresh) {
		parts.push(`ping: ${ping}`);
		if (health.latencyMs !== undefined) {
			parts.push(`latency: ${health.latencyMs}ms`);
		}
	}
	if (spend !== undefined) {
		parts.push(`spent ${spend.amount} ${spend.currency} (${spend.period})`);
	}

	const report: LoadBalancedStatusReport = {
		profile: profileName,
		endpointType: "load-balanced",
		status,
		fresh: health.fresh,
		ping,
		readiness,
		line: parts.join(" · "),
	};
	if (health.fresh && health.latencyMs !== undefined) {
		report.latencyMs = health.latencyMs;
	}
	if (spend !== undefined) {
		report.spend = {
			amount: spend.amount,
			currency: spend.currency,
			period: spend.period,
		};
	}
	return report;
}

/**
 * Render the adaptive status report for a Runpod endpoint.
 *
 * The snapshot kind (queue vs load-balanced) is read from the health input,
 * so the report's fields always match the data actually observed; a queue
 * profile's current job never leaks into a load-balanced report. Freshness is
 * a caller-supplied verdict and the module never consults the clock or the
 * network.
 */
export function buildStatusReport(input: StatusInput): StatusReport {
	const { profile, spend } = input;
	return isQueueHealthSnapshot(input.health)
		? buildQueueReport(profile.name, input.health, input.currentJob, spend)
		: buildLoadBalancedReport(profile.name, input.health, spend);
}

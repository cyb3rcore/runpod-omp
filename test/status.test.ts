/**
 * Adaptive status report contract tests (test-first, per the approved plan).
 *
 * These tests fail today because the module they import does not exist yet.
 * Implement the following contract to make them pass:
 *
 * src/status.ts (pure helpers; no OMP runtime, fetch, or clock access)
 *   - `buildStatusReport(input: StatusInput): StatusReport` — renders the
 *     adaptive report and status line (`ctx.ui.setStatus("runpod", line)`)
 *     from plain, caller-supplied data. Freshness is a caller-supplied
 *     verdict (`health.fresh`, produced by src/health.ts cache/TTL logic), so
 *     the module stays deterministic: it never consults Date.now, timers, or
 *     the network.
 *
 * Input shapes (owned by src/status.ts; src/health.ts must produce health
 * snapshots structurally matching these):
 *   - `StatusInput.profile` — `{ name, endpointType: "queue" |
 *     "load-balanced" }` (endpoint type from src/profile-schema.ts).
 *   - `QueueHealthSnapshot` — `{ fresh, workers, queueDepth? }`; `workers`
 *     counts are the lenient `/health` union `{idle?, ready?, running?,
 *     initializing?, throttled?, unhealthy?}` plus the control-plane
 *     `unhealthy` count; a missing field is `unknown`, never zero.
 *   - `LoadBalancedHealthSnapshot` — `{ fresh, ping, latencyMs? }`; `ping`
 *     is the `probeLoadBalancedHealth` outcome ("healthy" | "initializing"
 *     | "unhealthy").
 *   - `StatusInput.currentJob?` — queue-only `{ jobId, status:
 *     QueueJobStatus }`; ignored for load-balanced profiles.
 *   - `StatusInput.spend?` — optional `{ amount, currency, period }`.
 *
 * Most-actionable status precedence (highest wins):
 *   cold-start > queued > unhealthy > stale > healthy, where
 *   - cold-start: queue `initializing > 0` (fresh); LB `ping ===
 *     "initializing"` (fresh);
 *   - queued: queue `queueDepth > 0` OR `currentJob.status === "IN_QUEUE"`
 *     (fresh); never for load-balanced;
 *   - unhealthy: queue `unhealthy > 0` (fresh); LB `ping === "unhealthy"`
 *     (fresh);
 *   - stale: `!health.fresh`, or a fresh queue report whose current job is
 *     the `"unknown"`/`"expired"` TTL sentinel — unknown never masquerades
 *     as healthy;
 *   - healthy: fresh data with none of the above.
 *
 * Report rules:
 *   - queue report: `endpointType: "queue"`, `workers` (every count
 *     `number | "unknown"`; missing or stale fields render `"unknown"`, not
 *     0), `workerSummary` ("N <field>" in canonical order idle, ready,
 *     running, initializing, throttled, unhealthy, joined ", "; `"unknown"`
 *     when no known counts), and `currentJob` only when fresh.
 *   - load-balanced report: `endpointType: "load-balanced"`, `ping` (raw
 *     outcome, `"unknown"` when stale), `readiness` (mapped label
 *     healthy→"ready", initializing→"initializing", unhealthy→"unhealthy",
 *     stale→"unknown"), `latencyMs` only when fresh and present. Queue-only
 *     fields (workers, workerSummary, currentJob, queueDepth) are omitted —
 *     never shown as zero or idle.
 *   - both reports carry `profile` (the profile name), `status`, `fresh`,
 *     and `line`; `spend` appears only when supplied.
 *
 * Status line grammar (exact):
 *   queue fresh:     `<profile>: <status> · workers: <workerSummary>` and,
 *                    when a current job is present, ` · job <jobId>:
 *                    <jobStatus>`
 *   queue stale:     `<profile>: stale`
 *   LB fresh:        `<profile>: <status> · ping: <ping>` and, when latency
 *                    is present, ` · latency: <latencyMs>ms`
 *   LB stale:        `<profile>: stale`
 *   spend (either):  appended last as ` · spent <amount> <currency>
 *                    (<period>)` only when supplied
 */
import { describe, expect, test } from "bun:test";

// Named import pins the required module entry point (link-time failure if
// the module is missing or omits the export).
import { buildStatusReport } from "../src/status.js";
import type {
	ActionableStatus,
	CurrentJob,
	LoadBalancedHealthSnapshot,
	QueueHealthSnapshot,
	QueueWorkerCounts,
	SpendSummary,
	StatusInput,
} from "../src/status.js";
import type { QueueJobStatus } from "../src/transport/types.js";

/** Profile name shared by every fixture. */
const PROFILE_NAME = "llama-3-8b";

/** Every worker count rendered as unknown (fresh-with-no-fields or stale). */
const UNKNOWN_WORKERS = {
	idle: "unknown",
	ready: "unknown",
	running: "unknown",
	initializing: "unknown",
	throttled: "unknown",
	unhealthy: "unknown",
} as const;

/** Build a fresh-or-stale queue health snapshot. */
function queueHealth(
	workers: QueueWorkerCounts,
	fresh = true,
	queueDepth?: number,
): QueueHealthSnapshot {
	return {
		fresh,
		workers,
		...(queueDepth === undefined ? {} : { queueDepth }),
	};
}

/** Build a fresh-or-stale load-balanced health snapshot. */
function lbHealth(
	ping: LoadBalancedHealthSnapshot["ping"],
	fresh = true,
	latencyMs?: number,
): LoadBalancedHealthSnapshot {
	return {
		fresh,
		ping,
		...(latencyMs === undefined ? {} : { latencyMs }),
	};
}

/** Build a queue status input; overrides replace whole fields. */
function queueInput(overrides: Partial<StatusInput> = {}): StatusInput {
	return {
		profile: { name: PROFILE_NAME, endpointType: "queue" },
		health: queueHealth({}),
		...overrides,
	};
}

/** Build a load-balanced status input; overrides replace whole fields. */
function lbInput(overrides: Partial<StatusInput> = {}): StatusInput {
	return {
		profile: { name: PROFILE_NAME, endpointType: "load-balanced" },
		health: lbHealth("healthy"),
		...overrides,
	};
}

/** A current queue job; status is one of the QueueJobStatus values. */
function currentJob(jobId: string, status: QueueJobStatus): CurrentJob {
	return { jobId, status };
}

/** Recent spend fixture. */
const SPEND: SpendSummary = { amount: 12.34, currency: "USD", period: "30d" };

describe("buildStatusReport (queue)", () => {
	test("fresh healthy report carries endpoint type, worker summary, and no optional fields", () => {
		const report = buildStatusReport(
			queueInput({ health: queueHealth({ ready: 2, running: 1 }) }),
		);

		expect(report).toEqual({
			profile: PROFILE_NAME,
			endpointType: "queue",
			status: "healthy",
			fresh: true,
			workers: { ...UNKNOWN_WORKERS, ready: 2, running: 1 },
			workerSummary: "2 ready, 1 running",
			line: "llama-3-8b: healthy · workers: 2 ready, 1 running",
		});
		// Current job and spend appear only when supplied.
		expect(report).not.toHaveProperty("currentJob");
		expect(report).not.toHaveProperty("spend");
	});

	test("worker summary uses canonical order and missing fields are unknown, not zero", () => {
		const report = buildStatusReport(
			queueInput({ health: queueHealth({ running: 2, ready: 1 }) }),
		);

		// Canonical order (idle, ready, running, ...), not input order.
		expect(report).toMatchObject({ workerSummary: "1 ready, 2 running" });
		if (report.endpointType === "queue") {
			// The two known counts are numbers; every absent field is "unknown".
			expect(report.workers).toEqual({ ...UNKNOWN_WORKERS, ready: 1, running: 2 });
		}
	});

	test("fresh snapshot with no worker fields renders unknown, not zero", () => {
		const report = buildStatusReport(queueInput({ health: queueHealth({}) }));

		expect(report).toMatchObject({ status: "healthy", workerSummary: "unknown" });
		if (report.endpointType === "queue") {
			expect(report.workers).toEqual(UNKNOWN_WORKERS);
		}
		expect(report.line).toBe("llama-3-8b: healthy · workers: unknown");
	});

	test("a zero count supplied by the API is preserved as zero", () => {
		const report = buildStatusReport(
			queueInput({ health: queueHealth({ idle: 0, ready: 3 }) }),
		);

		expect(report).toMatchObject({ workerSummary: "0 idle, 3 ready" });
		if (report.endpointType === "queue") {
			expect(report.workers.idle).toBe(0);
		}
	});

	test("current job is included when fresh and shown in the status line", () => {
		const report = buildStatusReport(
			queueInput({
				health: queueHealth({ idle: 1, running: 1 }),
				currentJob: currentJob("job_abc", "IN_PROGRESS"),
			}),
		);

		expect(report).toMatchObject({
			status: "healthy",
			currentJob: { jobId: "job_abc", status: "IN_PROGRESS" },
			line: "llama-3-8b: healthy · workers: 1 idle, 1 running · job job_abc: IN_PROGRESS",
		});
	});

	test("queued when queue depth is non-zero (fresh)", () => {
		const report = buildStatusReport(
			queueInput({ health: queueHealth({ idle: 1 }, true, 2) }),
		);

		expect(report).toMatchObject({
			status: "queued",
			line: "llama-3-8b: queued · workers: 1 idle",
		});
	});

	test("queued when the fresh current job is IN_QUEUE", () => {
		const report = buildStatusReport(
			queueInput({
				health: queueHealth({ ready: 1 }, true, 0),
				currentJob: currentJob("job_abc", "IN_QUEUE"),
			}),
		);

		expect(report).toMatchObject({
			status: "queued",
			currentJob: { jobId: "job_abc", status: "IN_QUEUE" },
			line: "llama-3-8b: queued · workers: 1 ready · job job_abc: IN_QUEUE",
		});
	});

	test("cold start when a worker is initializing (fresh)", () => {
		const report = buildStatusReport(
			queueInput({ health: queueHealth({ initializing: 1 }) }),
		);

		expect(report).toMatchObject({ status: "cold-start" });
		expect(report.line).toBe("llama-3-8b: cold-start · workers: 1 initializing");
	});

	test("unhealthy when workers report an unhealthy count (fresh)", () => {
		const report = buildStatusReport(
			queueInput({ health: queueHealth({ ready: 0, unhealthy: 1 }) }),
		);

		expect(report).toMatchObject({ status: "unhealthy" });
	});

	test("stale snapshot represents unknown, not the cached numbers or healthy", () => {
		const report = buildStatusReport(
			queueInput({
				health: queueHealth({ idle: 4, running: 1 }, false, 2),
				currentJob: currentJob("job_abc", "IN_PROGRESS"),
			}),
		);

		expect(report).toMatchObject({
			status: "stale",
			fresh: false,
			workerSummary: "unknown",
			line: "llama-3-8b: stale",
		});
		if (report.endpointType === "queue") {
			// Cached numbers are not presented as current; every count is unknown.
			expect(report.workers).toEqual(UNKNOWN_WORKERS);
		}
		// A stale report never surfaces the cached current job.
		expect(report).not.toHaveProperty("currentJob");
	});

	test("an unknown/expired current job is stale, never healthy", () => {
		const report = buildStatusReport(
			queueInput({
				health: queueHealth({ ready: 1 }),
				currentJob: currentJob("job_abc", "expired"),
			}),
		);

		expect(report).toMatchObject({ status: "stale" });
		// Fresh worker/job detail still renders; only the status downgrades.
		expect(report.line).toBe("llama-3-8b: stale · workers: 1 ready · job job_abc: expired");
	});
});

describe("buildStatusReport (load-balanced)", () => {
	test("fresh healthy report carries ping, readiness, latency, and omits queue-only fields", () => {
		const report = buildStatusReport(
			lbInput({ health: lbHealth("healthy", true, 45) }),
		);

		expect(report).toEqual({
			profile: PROFILE_NAME,
			endpointType: "load-balanced",
			status: "healthy",
			fresh: true,
			ping: "healthy",
			readiness: "ready",
			latencyMs: 45,
			line: "llama-3-8b: healthy · ping: healthy · latency: 45ms",
		});
		// Queue-only fields are deliberately absent, never zero or "idle".
		expect(report).not.toHaveProperty("workers");
		expect(report).not.toHaveProperty("workerSummary");
		expect(report).not.toHaveProperty("queueDepth");
		expect(report).not.toHaveProperty("currentJob");
	});

	test("latency is omitted when the probe did not record one", () => {
		const report = buildStatusReport(lbInput());

		expect(report).toMatchObject({ status: "healthy", ping: "healthy", readiness: "ready" });
		expect(report).not.toHaveProperty("latencyMs");
		expect(report.line).toBe("llama-3-8b: healthy · ping: healthy");
	});

	test("a queue-only current job input is ignored for load-balanced profiles", () => {
		const report = buildStatusReport(
			lbInput({ currentJob: currentJob("job_abc", "IN_QUEUE") }),
		);

		expect(report).not.toHaveProperty("currentJob");
		// The queue job never leaks into the line, and never queues an LB report.
		expect(report).toMatchObject({ status: "healthy" });
		expect(report.line).toBe("llama-3-8b: healthy · ping: healthy");
	});

	test("initializing ping maps to a cold-start report", () => {
		const report = buildStatusReport(lbInput({ health: lbHealth("initializing") }));

		expect(report).toMatchObject({
			status: "cold-start",
			ping: "initializing",
			readiness: "initializing",
			line: "llama-3-8b: cold-start · ping: initializing",
		});
	});

	test("unhealthy ping maps to an unhealthy report", () => {
		const report = buildStatusReport(lbInput({ health: lbHealth("unhealthy") }));

		expect(report).toMatchObject({
			status: "unhealthy",
			ping: "unhealthy",
			readiness: "unhealthy",
		});
	});

	test("stale snapshot renders unknown ping/readiness and omits latency", () => {
		const report = buildStatusReport(
			lbInput({ health: lbHealth("healthy", false, 45) }),
		);

		expect(report).toMatchObject({
			status: "stale",
			fresh: false,
			ping: "unknown",
			readiness: "unknown",
			line: "llama-3-8b: stale",
		});
		// The cached latency is not presented as current.
		expect(report).not.toHaveProperty("latencyMs");
	});
});

describe("most-actionable status precedence", () => {
	const fresh = true;

	test("cold-start beats queued and unhealthy", () => {
		const report = buildStatusReport(
			queueInput({
				health: queueHealth({ initializing: 1, unhealthy: 2 }, fresh, 5),
			}),
		);

		expect(report).toMatchObject({ status: "cold-start" });
	});

	test("queued beats unhealthy", () => {
		const report = buildStatusReport(
			queueInput({ health: queueHealth({ unhealthy: 2 }, fresh, 5) }),
		);

		expect(report).toMatchObject({ status: "queued" });
	});

	test("unhealthy beats healthy", () => {
		const report = buildStatusReport(
			queueInput({ health: queueHealth({ unhealthy: 2 }, fresh, 0) }),
		);

		expect(report).toMatchObject({ status: "unhealthy" });
	});

	test("stale beats healthy: unknown is never reported as healthy", () => {
		const staleQueue = buildStatusReport(
			queueInput({ health: queueHealth({ ready: 1 }, false) }),
		);
		const staleLb = buildStatusReport(lbInput({ health: lbHealth("healthy", false) }));

		expect(staleQueue).toMatchObject({ status: "stale" });
		expect(staleLb).toMatchObject({ status: "stale" });
	});

	test("healthy is the fallback when fresh data shows no issue", () => {
		const queueReport = buildStatusReport(
			queueInput({ health: queueHealth({ ready: 1 }, fresh, 0) }),
		);
		const lbReport = buildStatusReport(lbInput({ health: lbHealth("healthy", fresh) }));

		expect(queueReport).toMatchObject({ status: "healthy" });
		expect(lbReport).toMatchObject({ status: "healthy" });
	});

	test("status values are the pinned five-token set", () => {
		const statuses = new Set<ActionableStatus>();
		for (const input of [
			queueInput({ health: queueHealth({ initializing: 1 }) }),
			queueInput({ health: queueHealth({}, true, 1) }),
			queueInput({ health: queueHealth({ unhealthy: 1 }) }),
			queueInput({ health: queueHealth({ ready: 1 }, false) }),
			queueInput({ health: queueHealth({ ready: 1 }) }),
		]) {
			statuses.add(buildStatusReport(input).status);
		}
		expect([...statuses].sort()).toEqual(["cold-start", "healthy", "queued", "stale", "unhealthy"]);
	});
});

describe("recent spend", () => {
	test("supplied spend is carried into the report and appended to the status line", () => {
		const report = buildStatusReport(
			queueInput({
				health: queueHealth({ ready: 2, running: 1 }),
				spend: SPEND,
			}),
		);

		expect(report).toMatchObject({ spend: SPEND });
		expect(report.line).toBe("llama-3-8b: healthy · workers: 2 ready, 1 running · spent 12.34 USD (30d)");
	});

	test("spend appears on load-balanced lines too, appended last", () => {
		const report = buildStatusReport(
			lbInput({ health: lbHealth("healthy", true, 45), spend: SPEND }),
		);

		expect(report).toMatchObject({ spend: SPEND });
		expect(report.line).toBe("llama-3-8b: healthy · ping: healthy · latency: 45ms · spent 12.34 USD (30d)");
	});

	test("spend appears on stale lines when supplied", () => {
		const report = buildStatusReport(
			queueInput({ health: queueHealth({ ready: 1 }, false), spend: SPEND }),
		);

		expect(report).toMatchObject({ spend: SPEND });
		expect(report.line).toBe("llama-3-8b: stale · spent 12.34 USD (30d)");
	});

	test("absent spend is omitted from the report and the line", () => {
		const report = buildStatusReport(lbInput({ health: lbHealth("healthy", false) }));

		expect(report).not.toHaveProperty("spend");
		expect(report.line).not.toContain("spent");
	});
});

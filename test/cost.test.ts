/**
 * Cost service contract tests.
 *
 * The service composes injected control outcomes (workers/catalog/billing)
 * into burn-rate estimates and billed summaries. No network or key material
 * exists here: every control call is a canned outcome and call recorder.
 */
import { describe, expect, test } from "bun:test";

import { createCostService } from "../src/cost.js";
import type { BurnRateEstimate, BilledSummary, CostReport } from "../src/cost.js";
import type { ControlInput, ControlOutcome, ControlWorker } from "../src/control.js";
import type { RunpodControl } from "../src/operations.js";

const PROFILE = "prod";
const ENDPOINT_TYPE = "queue" as const;

function workersOutcome(workers: ControlWorker[]): ControlOutcome {
	return { ok: true, operation: "workers", workers };
}

function catalogOutcome(gpus: Record<string, number>): ControlOutcome {
	return { ok: true, operation: "catalog", gpus };
}

function billingOutcome(records: Array<{ totalAmount: number; gpuAmount?: number; diskAmount?: number; feeAmount?: number }>): ControlOutcome {
	return {
		ok: true,
		operation: "billing",
		records: records.map((r, index) => ({
			startTime: `2026-06-01T${String(index).padStart(2, "0")}:00:00Z`,
			endTime: `2026-06-01T${String(index).padStart(2, "0")}:59:00Z`,
			totalAmount: r.totalAmount,
			gpuAmount: r.gpuAmount ?? 0,
			cpuAmount: 0,
			diskAmount: r.diskAmount ?? 0,
			feeAmount: r.feeAmount ?? 0,
		})),
	};
}

/** Canned control dispatcher; records every call. */
function fakeControl(
	responses: { workers?: ControlOutcome; catalog?: ControlOutcome; billing?: ControlOutcome },
): { calls: Array<{ profileName: string; input: ControlInput }>; control: RunpodControl } {
	const calls: Array<{ profileName: string; input: ControlInput }> = [];
	const control: RunpodControl = async (profileName, input) => {
		calls.push({ profileName, input });
		const outcome = responses[input.operation as "workers" | "catalog" | "billing"];
		if (outcome === undefined) {
			return { ok: false, operation: input.operation, supported: false, reason: "no fixture" };
		}
		return outcome;
	};
	return { calls, control };
}

const RTX4090_WORKER: ControlWorker = {
	id: "8g3n5t6r",
	status: "RUNNING",
	gpuCount: 1,
	gpuTypeId: "NVIDIA GeForce RTX 4090",
	uptimeSeconds: 3600,
};

describe("createCostService().estimate", () => {
	test("sums placed workers × serverless price and accrues from uptime", async () => {
		const { control } = fakeControl({
			workers: workersOutcome([
				RTX4090_WORKER,
				{ id: "w2", status: "IDLE", gpuCount: 2, gpuTypeId: "NVIDIA L40", uptimeSeconds: 1800 },
			]),
			catalog: catalogOutcome({ "NVIDIA GeForce RTX 4090": 1.1, "NVIDIA L40": 2.0 }),
		});
		const service = createCostService(control);

		const result = await service.estimate(PROFILE);

		expect(result).toEqual<BurnRateEstimate>({
			ratePerHour: 5.1, // 1×1.1 + 2×2.0
			accruedUsd: 3.1, // 3600×1.1/3600 + 1800×4.0/3600
			pricedWorkers: 2,
			totalWorkers: 2,
			partial: false,
		});
	});

	test("excludes unplaced workers (null gpuTypeId) — they do not bill", async () => {
		const { control } = fakeControl({
			workers: workersOutcome([
				RTX4090_WORKER,
				{ id: "w3", status: "THROTTLED", gpuCount: 0, gpuTypeId: null, uptimeSeconds: null },
			]),
			catalog: catalogOutcome({ "NVIDIA GeForce RTX 4090": 1.1 }),
		});
		const service = createCostService(control);

		const result = await service.estimate(PROFILE);

		expect(result).toEqual<BurnRateEstimate>({
			ratePerHour: 1.1,
			accruedUsd: 1.1,
			pricedWorkers: 1,
			totalWorkers: 1,
			partial: false,
		});
	});

	test("a placed worker without a catalog price marks the estimate partial, never guessed", async () => {
		const { control } = fakeControl({
			workers: workersOutcome([
				{ id: "w1", status: "RUNNING", gpuCount: 1, gpuTypeId: "NVIDIA H100", uptimeSeconds: 600 },
			]),
			catalog: catalogOutcome({}),
		});
		const service = createCostService(control);

		const result = await service.estimate(PROFILE);

		expect(result).toEqual<BurnRateEstimate>({
			ratePerHour: 0,
			accruedUsd: 0,
			pricedWorkers: 0,
			totalWorkers: 1,
			partial: true,
		});
	});

	test("zero placed workers is zeros, not partial", async () => {
		const { control } = fakeControl({ workers: workersOutcome([]), catalog: catalogOutcome({}) });
		const service = createCostService(control);

		const result = await service.estimate(PROFILE);

		expect(result).toEqual<BurnRateEstimate>({
			ratePerHour: 0,
			accruedUsd: 0,
			pricedWorkers: 0,
			totalWorkers: 0,
			partial: false,
		});
	});

	test("a missing catalog price for a fresh GPU is never an error — just partial", async () => {
		const { control } = fakeControl({
			workers: workersOutcome([{ id: "w1", status: "IDLE", gpuCount: 1, gpuTypeId: "NVIDIA B200" }]),
			catalog: catalogOutcome({ "NVIDIA GeForce RTX 4090": 1.1 }),
		});
		const service = createCostService(control);

		const result = await service.estimate(PROFILE);

		expect(result).toMatchObject({ ratePerHour: 0, totalWorkers: 1, pricedWorkers: 0, partial: true });
	});

	test("a failing workers call returns the redacted error", async () => {
		const { control } = fakeControl({
			workers: { ok: false, operation: "workers", supported: true, detail: "control-plane access denied (key lacks required scope)" },
			catalog: catalogOutcome({}),
		});
		const service = createCostService(control);

		const result = await service.estimate(PROFILE);

		expect(result).toEqual({ error: "control-plane access denied (key lacks required scope)" });
	});

	test("a failing catalog call returns the redacted error", async () => {
		const { control } = fakeControl({
			workers: workersOutcome([RTX4090_WORKER]),
			catalog: { ok: false, operation: "catalog", supported: false, reason: "No control route is configured for this operation." },
		});
		const service = createCostService(control);

		const result = await service.estimate(PROFILE);

		expect(result).toEqual({ error: "No control route is configured for this operation." });
	});
});

describe("createCostService().estimate caching", () => {
	test("catalog and workers are cached per profile until TTL or fresh", async () => {
		const { calls, control } = fakeControl({
			workers: workersOutcome([RTX4090_WORKER]),
			catalog: catalogOutcome({ "NVIDIA GeForce RTX 4090": 1.1 }),
		});
		const service = createCostService(control);

		await service.estimate(PROFILE);
		expect(calls).toHaveLength(2); // catalog + workers

		await service.estimate(PROFILE);
		expect(calls).toHaveLength(2); // both cached

		await service.estimate(PROFILE, { fresh: true });
		expect(calls).toHaveLength(4); // both refetched

		await service.estimate(PROFILE, { fresh: true });
		expect(calls).toHaveLength(6);
	});

	test("workers cache expires after its 15s TTL; catalog survives", async () => {
		let now = 1_000_000;
		const { calls, control } = fakeControl({
			workers: workersOutcome([RTX4090_WORKER]),
			catalog: catalogOutcome({ "NVIDIA GeForce RTX 4090": 1.1 }),
		});
		const service = createCostService(control, { now: () => now });

		await service.estimate(PROFILE);
		expect(calls).toHaveLength(2);

		now += 14_000;
		await service.estimate(PROFILE);
		expect(calls).toHaveLength(2); // workers still fresh

		now += 2_000; // 16s since first fetch
		await service.estimate(PROFILE);
		expect(calls).toHaveLength(3); // workers refetched, catalog cached

		now += 3_599_000; // past the 1h catalog TTL
		await service.estimate(PROFILE);
		expect(calls).toHaveLength(5); // catalog and workers both refetched
	});

	test("cache is per profile: estimating another profile refetches workers", async () => {
		const { calls, control } = fakeControl({
			workers: workersOutcome([RTX4090_WORKER]),
			catalog: catalogOutcome({ "NVIDIA GeForce RTX 4090": 1.1 }),
		});
		const service = createCostService(control);

		await service.estimate("prod-a");
		await service.estimate("prod-b");
		expect(calls).toHaveLength(3); // catalog shared, workers per profile
	});
});

describe("createCostService().billed", () => {
	test("aggregates records into totals with today = last record", async () => {
		const { control } = fakeControl({
			billing: billingOutcome([
				{ totalAmount: 8.9, gpuAmount: 7.5, diskAmount: 0.4, feeAmount: 1.0 },
				{ totalAmount: 3.2, gpuAmount: 2.0, diskAmount: 0.1, feeAmount: 1.1 },
			]),
		});
		const service = createCostService(control);

		const result = await service.billed(PROFILE);

		expect(result).toMatchObject<BilledSummary>({
			hours: 24,
			totalUsd: expect.closeTo(12.1, 10) as unknown as number,
			gpuUsd: expect.closeTo(9.5, 10) as unknown as number,
			diskUsd: expect.closeTo(0.5, 10) as unknown as number,
			feeUsd: expect.closeTo(2.1, 10) as unknown as number,
			todayUsd: expect.closeTo(3.2, 10) as unknown as number,
			recordCount: 2,
		});
	});

	test("no records is a zero summary, not an error", async () => {
		const { control } = fakeControl({ billing: billingOutcome([]) });
		const service = createCostService(control);

		const result = await service.billed(PROFILE);

		expect(result).toEqual<BilledSummary>({
			hours: 24,
			totalUsd: 0,
			gpuUsd: 0,
			diskUsd: 0,
			feeUsd: 0,
			todayUsd: 0,
			recordCount: 0,
		});
	});

	test("a failing billing call returns the redacted error", async () => {
		const { control } = fakeControl({
			billing: { ok: false, operation: "billing", supported: true, detail: "control-plane access denied (key lacks required scope)" },
		});
		const service = createCostService(control);

		const result = await service.billed(PROFILE);

		expect(result).toEqual({ error: "control-plane access denied (key lacks required scope)" });
	});
});

describe("createCostService().report", () => {
	test("carries both sections on success", async () => {
		const { control } = fakeControl({
			workers: workersOutcome([RTX4090_WORKER]),
			catalog: catalogOutcome({ "NVIDIA GeForce RTX 4090": 1.1 }),
			billing: billingOutcome([{ totalAmount: 8.9, gpuAmount: 7.5, diskAmount: 0.4, feeAmount: 1.0 }]),
		});
		const service = createCostService(control);

		const report = await service.report(PROFILE, ENDPOINT_TYPE);

		expect(report).toEqual<CostReport>({
			profile: PROFILE,
			endpointType: ENDPOINT_TYPE,
			estimate: { ratePerHour: 1.1, accruedUsd: 1.1, pricedWorkers: 1, totalWorkers: 1, partial: false },
			billed: { hours: 24, totalUsd: 8.9, gpuUsd: 7.5, diskUsd: 0.4, feeUsd: 1.0, todayUsd: 8.9, recordCount: 1 },
		});
	});

	test("a failing workers op sets estimateError while billed stays populated", async () => {
		const { control } = fakeControl({
			workers: { ok: false, operation: "workers", supported: true, detail: "control-plane access denied (key lacks required scope)" },
			catalog: catalogOutcome({}),
			billing: billingOutcome([{ totalAmount: 4.2 }]),
		});
		const service = createCostService(control);

		const report = await service.report(PROFILE, ENDPOINT_TYPE);

		expect(report.estimate).toBeUndefined();
		expect(report.estimateError).toBe("control-plane access denied (key lacks required scope)");
		expect(report.billed).toMatchObject({ totalUsd: 4.2, todayUsd: 4.2 });
		expect(report.billedError).toBeUndefined();
	});

	test("a failing billing op sets billedError while estimate stays populated", async () => {
		const { control } = fakeControl({
			workers: workersOutcome([RTX4090_WORKER]),
			catalog: catalogOutcome({ "NVIDIA GeForce RTX 4090": 1.1 }),
			billing: { ok: false, operation: "billing", supported: true, detail: "cannot derive endpoint id from invokeUrl" },
		});
		const service = createCostService(control);

		const report = await service.report(PROFILE, ENDPOINT_TYPE);

		expect(report.billed).toBeUndefined();
		expect(report.billedError).toBe("cannot derive endpoint id from invokeUrl");
		expect(report.estimate).toMatchObject({ ratePerHour: 1.1 });
		expect(report.estimateError).toBeUndefined();
	});
});

/**
 * Runpod cost estimation service.
 *
 * Composes control-plane outcomes (workers, catalog, billing) into burn-rate
 * estimates and billed summaries. Performs no network I/O and resolves no
 * keys itself — every control behavior is injected via the `RunpodControl`
 * dispatcher. Estimates are honest: a worker counts only when placed
 * (`gpuTypeId` non-null — THROTTLED/unplaced workers do not bill), a missing
 * catalog price marks the estimate `partial` (never guessed), and the command
 * path can force a fresh fetch so the result is as up to date as the platform
 * allows (the billing API itself lags ~5 minutes; the worker-uptime accrued
 * estimate covers that gap).
 */
import { TimedHealthCache } from "./health.js";
import type { ControlOutcome, ControlWorker } from "./control.js";
import type { RunpodControl } from "./operations.js";
import type { EndpointType } from "./profile-schema.js";

/** Instantaneous spend-rate and accrued estimate from live workers. */
export interface BurnRateEstimate {
	/** Σ gpuCount × price.serverless[id] over placed workers, USD/hour. */
	ratePerHour: number;
	/** Σ uptimeSeconds × rate / 3600 over placed workers, USD. */
	accruedUsd: number;
	/** Placed workers with a catalog price. */
	pricedWorkers: number;
	/** Placed workers (gpuTypeId non-null). */
	totalWorkers: number;
	/** True when some placed worker lacks a catalog price. */
	partial: boolean;
}

/** Actual billed amounts from the serverless billing history API. */
export interface BilledSummary {
	hours: number;
	totalUsd: number;
	gpuUsd: number;
	diskUsd: number;
	feeUsd: number;
	/** Last record's totalAmount (the current hour bucket). */
	todayUsd: number;
	recordCount: number;
}

/** Combined cost report for one profile; each section carries its own error. */
export interface CostReport {
	profile: string;
	endpointType: EndpointType;
	estimate?: BurnRateEstimate;
	estimateError?: string;
	billed?: BilledSummary;
	billedError?: string;
}

/** The injected, testable clock/cache options for the service. */
export interface CostServiceOptions {
	/** Injectable clock for cache TTLs; defaults to Date.now. */
	now?: () => number;
}

/** The cost service surface. */
export interface CostService {
	estimate(
		profileName: string,
		opts?: { fresh?: boolean },
	): Promise<BurnRateEstimate | { error: string }>;
	billed(profileName: string): Promise<BilledSummary | { error: string }>;
	report(
		profileName: string,
		endpointType: EndpointType,
		opts?: { fresh?: boolean },
	): Promise<CostReport>;
}

/** Extract a redacted reason from a failed control outcome. */
function failureReason(outcome: { ok: false; supported: boolean; detail?: string; reason?: string }): string {
	return outcome.supported && outcome.detail !== undefined ? outcome.detail : (outcome.reason ?? "unknown control failure");
}

/** Narrow a successful outcome to the workers variant. */
function isWorkersOutcome(
	outcome: ControlOutcome,
): outcome is Extract<ControlOutcome, { ok: true; operation: "workers" }> {
	return outcome.ok && outcome.operation === "workers";
}

/** Narrow a successful outcome to the catalog variant. */
function isCatalogOutcome(
	outcome: ControlOutcome,
): outcome is Extract<ControlOutcome, { ok: true; operation: "catalog" }> {
	return outcome.ok && outcome.operation === "catalog";
}

/** Narrow a successful outcome to the billing variant. */
function isBillingOutcome(
	outcome: ControlOutcome,
): outcome is Extract<ControlOutcome, { ok: true; operation: "billing" }> {
	return outcome.ok && outcome.operation === "billing";
}

/**
 * Create the cost service over an injected control dispatcher.
 *
 * Caches: catalog prices are account-wide and stable (TTL 1 hour, key
 * "serverless-prices"); workers change with scaling (TTL 15 seconds, keyed
 * per profile). Both are bypassed when `fresh: true` so `/runpod cost` always
 * re-reads the platform.
 */
export function createCostService(
	control: RunpodControl,
	options: CostServiceOptions = {},
): CostService {
	const catalogCache = new TimedHealthCache<Record<string, number>>({
		ttlMs: 3_600_000,
		now: options.now,
	});
	const workersCache = new TimedHealthCache<ControlWorker[]>({
		ttlMs: 15_000,
		now: options.now,
	});

	async function fetchWorkers(
		profileName: string,
	): Promise<ControlWorker[] | { error: string }> {
		const outcome = await control(profileName, { operation: "workers" });
		if (!outcome.ok) {
			return { error: failureReason(outcome) };
		}
		if (!isWorkersOutcome(outcome)) {
			return { error: "unexpected control outcome" };
		}
		return outcome.workers;
	}

	async function estimate(
		profileName: string,
		opts?: { fresh?: boolean },
	): Promise<BurnRateEstimate | { error: string }> {
		// Catalog prices: cached unless a fresh read is requested.
		let gpus: Record<string, number>;
		if (opts?.fresh !== true) {
			const cached = catalogCache.get("serverless-prices");
			if (cached !== undefined) {
				gpus = cached;
			} else {
				const outcome = await control(profileName, { operation: "catalog" });
				if (!outcome.ok) {
					return { error: failureReason(outcome) };
				}
				if (!isCatalogOutcome(outcome)) {
					return { error: "unexpected control outcome" };
				}
				gpus = outcome.gpus;
				catalogCache.set("serverless-prices", gpus);
			}
		} else {
			const outcome = await control(profileName, { operation: "catalog" });
			if (!outcome.ok) {
				return { error: failureReason(outcome) };
			}
			if (!isCatalogOutcome(outcome)) {
				return { error: "unexpected control outcome" };
			}
			gpus = outcome.gpus;
			catalogCache.set("serverless-prices", gpus);
		}

		// Workers: cached unless a fresh read is requested.
		let workers: ControlWorker[];
		if (opts?.fresh !== true) {
			const cached = workersCache.get(`workers:${profileName}`);
			if (cached !== undefined) {
				workers = cached;
			} else {
				const fetched = await fetchWorkers(profileName);
				if ("error" in fetched) {
					return fetched;
				}
				workers = fetched;
				workersCache.set(`workers:${profileName}`, workers);
			}
		} else {
			const fetched = await fetchWorkers(profileName);
			if ("error" in fetched) {
				return fetched;
			}
			workers = fetched;
			workersCache.set(`workers:${profileName}`, workers);
		}

		let ratePerHour = 0;
		let accruedUsd = 0;
		let pricedWorkers = 0;
		let totalWorkers = 0;
		let partial = false;
		for (const worker of workers) {
			if (worker.gpuTypeId == null) {
				// Unplaced (e.g. THROTTLED): no GPU allocated, no billing.
				continue;
			}
			totalWorkers += 1;
			const price = gpus[worker.gpuTypeId];
			if (typeof price !== "number") {
				partial = true;
				continue;
			}
			pricedWorkers += 1;
			const rate = worker.gpuCount * price;
			ratePerHour += rate;
			if (typeof worker.uptimeSeconds === "number" && worker.uptimeSeconds > 0) {
				accruedUsd += (worker.uptimeSeconds * rate) / 3600;
			}
		}
		if (totalWorkers === 0) {
			return { ratePerHour: 0, accruedUsd: 0, pricedWorkers: 0, totalWorkers: 0, partial: false };
		}
		return { ratePerHour, accruedUsd, pricedWorkers, totalWorkers, partial };
	}

	async function billed(profileName: string): Promise<BilledSummary | { error: string }> {
		// Always fresh: the billing API itself lags, so our fetch adds nothing.
		const outcome = await control(profileName, { operation: "billing" });
		if (!outcome.ok) {
			return { error: failureReason(outcome) };
		}
		if (!isBillingOutcome(outcome)) {
			return { error: "unexpected control outcome" };
		}
		const records = outcome.records;
		let totalUsd = 0;
		let gpuUsd = 0;
		let diskUsd = 0;
		let feeUsd = 0;
		for (const record of records) {
			totalUsd += record.totalAmount;
			gpuUsd += record.gpuAmount;
			diskUsd += record.diskAmount;
			feeUsd += record.feeAmount;
		}
		const todayUsd = records.length > 0 ? records[records.length - 1]!.totalAmount : 0;
		return {
			hours: 24,
			totalUsd,
			gpuUsd,
			diskUsd,
			feeUsd,
			todayUsd,
			recordCount: outcome.records.length,
		};
	}

	async function report(
		profileName: string,
		endpointType: EndpointType,
		opts?: { fresh?: boolean },
	): Promise<CostReport> {
		const [estimateResult, billedResult] = await Promise.all([
			estimate(profileName, opts),
			billed(profileName),
		]);
		const report: CostReport = { profile: profileName, endpointType };
		if ("error" in estimateResult) {
			report.estimateError = estimateResult.error;
		} else {
			report.estimate = estimateResult;
		}
		if ("error" in billedResult) {
			report.billedError = billedResult.error;
		} else {
			report.billed = billedResult;
		}
		return report;
	}

	return { estimate, billed, report };
}

/**
 * Direct, capability-safe Runpod control-plane operations.
 *
 * Runs a small set of authenticated control operations against an endpoint
 * profile's invoke URL. Capability is enforced before any key resolution or
 * network: an operation the endpoint family cannot serve (or for which no
 * control route is exposed) returns `supported: false` with zero fetch.
 * Authenticated/probe executions that fail return `supported: true` with a
 * redacted `detail` — resolved keys, URL hosts, refs, request bodies, and
 * response bytes never appear in error output.
 */
import type { EndpointType, SecretReference } from "./profile-schema.js";
import {
	normaliseQueueHealth,
	normaliseQueueJobStatus,
	type QueueWorkerSummary,
} from "./health.js";
import type { QueueJobStatus } from "./transport/types.js";

/** Host of the Runpod REST v2 control plane; routes append `/v2/...`. */
export const RUNPOD_CONTROL_BASE = "https://api.runpod.io";

/** Control-plane operations an endpoint family may serve. */
export type ControlOperation =
	| "health"
	| "ping"
	| "status"
	| "cancel"
	| "retry"
	| "purge"
	| "workers"
	| "catalog"
	| "billing"
	| "logs"
	| "warm"
	| "cool"
	| "close";

/** The slice of a profile a control operation needs. */
export interface ControlProfile {
	endpointType: EndpointType;
	invokeUrl: string;
	apiKey?: SecretReference;
	/** Base URL for REST v2 control-plane routes; defaults to RUNPOD_CONTROL_BASE. */
	controlBaseUrl?: string;
}

/** What to do, plus any job-scoped id. */
export interface ControlInput {
	operation: ControlOperation;
	jobId?: string;
}

/** Injectable runtime dependencies for control operations. */
export interface ControlDeps {
	fetch: typeof fetch;
	resolveKey: (ref: SecretReference) => string | undefined;
}

/** Load-balanced ping result; encodes readiness, not process success. */
export type PingState = "healthy" | "initializing" | "unhealthy";

/** Queue-only operations; "ping" is the load-balanced check. */
const QUEUE_OPERATIONS: Partial<Record<ControlOperation, true>> = {
	health: true,
	status: true,
	cancel: true,
	retry: true,
	purge: true,
};

/** Operations with no exposed control route; always unsupported. */
const UNSUPPORTED_OPERATIONS: Partial<Record<ControlOperation, true>> = {
	logs: true,
	warm: true,
	cool: true,
	close: true,
};

/**
 * Normalized control outcome, discriminated on `operation` and `ok`.
 *
 * `ok: true` variants carry the operation's result. `ok: false` failures carry
 * `supported`: `false` means the operation was never attempted (capability or
 * route mismatch, zero fetch); `true` means a supported execution failed and
 * `detail` is a redacted, generic reason.
 */
export type ControlOutcome =
	| ({ ok: true; operation: "health" } & QueueWorkerSummary)
	| { ok: true; operation: "ping"; ping: PingState }
	| { ok: true; operation: "status"; jobStatus: QueueJobStatus }
	| { ok: true; operation: "cancel" | "retry" | "purge" }
	| { ok: true; operation: "workers"; workers: ControlWorker[] }
	| { ok: true; operation: "catalog"; gpus: Record<string, number> }
	| { ok: true; operation: "billing"; records: ServerlessBillingRecord[] }
	| { ok: false; operation: ControlOperation; supported: false; reason: string }
	| { ok: false; operation: ControlOperation; supported: true; detail: string };

/** One active serverless worker, as reported by the REST v2 control plane. */
export interface ControlWorker {
	id: string;
	status: string;
	gpuCount: number;
	/** Exact catalog GPU type id; null/undefined until the worker is placed. */
	gpuTypeId?: string | null;
	/** Seconds the worker has been running; absent until placed and running. */
	uptimeSeconds?: number | null;
}

/** One hourly billing record for a serverless endpoint. */
export interface ServerlessBillingRecord {
	startTime: string;
	endTime: string;
	totalAmount: number;
	gpuAmount: number;
	cpuAmount: number;
	diskAmount: number;
	feeAmount: number;
}

/**
 * Derive the Runpod endpoint id from a profile's invokeUrl.
 *
 * queue endpoints use `https://api.runpod.ai/v2/<id>` (id = last path
 * segment); load-balanced endpoints use `https://<id>.api.runpod.ai` (id =
 * first hostname label). Anything else is not derivable and returns null.
 */
export function deriveEndpointId(
	profile: Pick<ControlProfile, "endpointType" | "invokeUrl">,
): string | null {
	let url: URL;
	try {
		url = new URL(profile.invokeUrl);
	} catch {
		return null;
	}
	if (profile.endpointType === "queue") {
		const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
		const id = segments.length > 0 ? (segments[segments.length - 1] ?? "") : "";
		return id.length > 0 ? id : null;
	}
	const host = url.hostname;
	if (!host.endsWith(".api.runpod.ai")) {
		return null;
	}
	const firstDot = host.indexOf(".");
	const id = firstDot > 0 ? host.slice(0, firstDot) : "";
	return id.length > 0 ? id : null;
}

/** Lenient finite-number read; a non-finite value falls back. */
function finiteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Lenient parse of a workers response; missing arrays never throw. */
function parseWorkers(input: unknown): ControlWorker[] {
	if (!isObject(input)) return [];
	const list = input["workers"];
	if (!Array.isArray(list)) return [];
	return list.map((item) => {
		const worker = isObject(item) ? item : {};
		return {
			id: typeof worker["id"] === "string" ? worker["id"] : "",
			status: typeof worker["status"] === "string" ? worker["status"] : "",
			gpuCount: finiteNumber(worker["gpuCount"], 0),
			gpuTypeId: typeof worker["gpuTypeId"] === "string" ? worker["gpuTypeId"] : undefined,
			uptimeSeconds:
				typeof worker["uptimeSeconds"] === "number" && Number.isFinite(worker["uptimeSeconds"])
					? worker["uptimeSeconds"]
					: undefined,
		};
	});
}

/**
 * Lenient parse of a catalog response into GPU type id → serverless USD/hour.
 * Entries without a finite serverless price are dropped (never guessed).
 */
function parseCatalog(input: unknown): Record<string, number> {
	const gpus: Record<string, number> = {};
	if (!isObject(input)) return gpus;
	const list = input["gpus"];
	if (!Array.isArray(list)) return gpus;
	for (const item of list) {
		if (!isObject(item) || typeof item["id"] !== "string") continue;
		const price = isObject(item["price"]) ? item["price"] : {};
		const serverless = price["serverless"];
		if (typeof serverless === "number" && Number.isFinite(serverless)) {
			gpus[item["id"]] = serverless;
		}
	}
	return gpus;
}

/** Lenient parse of a serverless billing response; absent amounts become 0. */
function parseBillingRecords(input: unknown): ServerlessBillingRecord[] {
	if (!isObject(input)) return [];
	const list = input["records"];
	if (!Array.isArray(list)) return [];
	return list.map((item) => {
		const record = isObject(item) ? item : {};
		return {
			startTime: typeof record["startTime"] === "string" ? record["startTime"] : "",
			endTime: typeof record["endTime"] === "string" ? record["endTime"] : "",
			totalAmount: finiteNumber(record["totalAmount"], 0),
			gpuAmount: finiteNumber(record["gpuAmount"], 0),
			cpuAmount: finiteNumber(record["cpuAmount"], 0),
			diskAmount: finiteNumber(record["diskAmount"], 0),
			feeAmount: finiteNumber(record["feeAmount"], 0),
		};
	});
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Lenient JSON body read: an unparseable body is undefined, never thrown. */
async function readJsonBody(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return undefined;
	}
}

/** Build an unsupported (capability/route) outcome; never a fetch. */
function unsupported(operation: ControlOperation, reason: string): ControlOutcome {
	return { ok: false, operation, supported: false, reason };
}

/** Build a redacted recoverable-failure outcome. */
function failure(operation: ControlOperation, detail: string): ControlOutcome {
	return { ok: false, operation, supported: true, detail };
}

/**
 * Run a load-balanced `/ping` probe. HTTP 200 = healthy, 204 = initializing,
 * any other status = unhealthy. No queue-only fields ever appear.
 */
async function runPing(profile: ControlProfile, deps: ControlDeps): Promise<ControlOutcome> {
	const { fetch } = deps;
	try {
		const res = await fetch(`${profile.invokeUrl}/ping`, { method: "GET" });
		const ping: PingState =
			res.status === 200 ? "healthy" : res.status === 204 ? "initializing" : "unhealthy";
		return { ok: true, operation: "ping", ping };
	} catch {
		return failure("ping", "The load-balanced ping could not be completed.");
	}
}

/** Run a queue control operation: auth, then the endpoint route. */
async function runQueueOperation(
	profile: ControlProfile,
	input: ControlInput,
	deps: ControlDeps,
): Promise<ControlOutcome> {
	const { operation } = input;
	const needsJobId = operation === "status" || operation === "cancel" || operation === "retry";
	const jobId = needsJobId ? input.jobId : undefined;

	if (needsJobId && jobId === undefined) {
		return failure(operation, "The operation requires a job id, which was not supplied.");
	}

	const key = profile.apiKey === undefined ? undefined : deps.resolveKey(profile.apiKey);
	if (key === undefined) {
		return failure(operation, "Queue control requires an API key that could not be resolved.");
	}
	const headers = { authorization: `Bearer ${key}` };
	const { fetch } = deps;

	try {
		switch (operation) {
			case "health": {
				const res = await fetch(`${profile.invokeUrl}/health`, { method: "GET", headers });
				return {
					ok: true,
					operation: "health",
					...normaliseQueueHealth(await readJsonBody(res)),
				};
			}
			case "status": {
				const res = await fetch(`${profile.invokeUrl}/status/${jobId}`, { method: "GET", headers });
				const body = await readJsonBody(res);
				const statusValue = isObject(body) ? body["status"] : undefined;
				return {
					ok: true,
					operation: "status",
					jobStatus: normaliseQueueJobStatus(statusValue),
				};
			}
			case "cancel":
			case "retry": {
				await fetch(`${profile.invokeUrl}/${operation}/${jobId}`, { method: "POST", headers });
				return { ok: true, operation };
			}
			case "purge": {
				await fetch(`${profile.invokeUrl}/purge-queue`, { method: "POST", headers });
				return { ok: true, operation: "purge" };
			}
		}
	} catch {
		return failure(operation, "The control operation could not be completed.");
	}

	// Unreachable once the switch is exhaustive over the queue op set.
	return failure(operation, "The control operation could not be completed.");
}

/**
 * Run a REST v2 control-plane operation (workers/catalog/billing): auth, then
 * the route. Available on both endpoint families; requires a derivable
 * endpoint id. Non-2xx responses map to a redacted failure (403 names the
 * scope requirement); response bodies are parsed leniently.
 */
async function runControlPlaneOperation(
	profile: ControlProfile,
	input: ControlInput,
	deps: ControlDeps,
): Promise<ControlOutcome> {
	const { operation } = input;
	const id = deriveEndpointId(profile);
	if (id === null) {
		return failure(operation, "cannot derive endpoint id from invokeUrl");
	}

	const key = profile.apiKey === undefined ? undefined : deps.resolveKey(profile.apiKey);
	if (key === undefined) {
		return failure(operation, "Control-plane access requires an API key that could not be resolved.");
	}
	const headers = { authorization: `Bearer ${key}` };
	const base = profile.controlBaseUrl ?? RUNPOD_CONTROL_BASE;
	const { fetch } = deps;

	try {
		switch (operation) {
			case "workers": {
				const res = await fetch(`${base}/v2/serverless/${id}/workers`, { method: "GET", headers });
				if (res.status === 403) {
					return failure(operation, "control-plane access denied (key lacks required scope)");
				}
				if (!res.ok) {
					return failure(operation, "The control-plane operation could not be completed.");
				}
				return { ok: true, operation: "workers", workers: parseWorkers(await readJsonBody(res)) };
			}
			case "catalog": {
				const res = await fetch(`${base}/v2/catalog/gpus`, { method: "GET", headers });
				if (res.status === 403) {
					return failure(operation, "control-plane access denied (key lacks required scope)");
				}
				if (!res.ok) {
					return failure(operation, "The control-plane operation could not be completed.");
				}
				return { ok: true, operation: "catalog", gpus: parseCatalog(await readJsonBody(res)) };
			}
			case "billing": {
				const res = await fetch(
					`${base}/v2/billing/serverless?serverlessId=${encodeURIComponent(id)}&bucketSize=hour&lastN=24`,
					{ method: "GET", headers },
				);
				if (res.status === 403) {
					return failure(operation, "control-plane access denied (key lacks required scope)");
				}
				if (!res.ok) {
					return failure(operation, "The control-plane operation could not be completed.");
				}
				return {
					ok: true,
					operation: "billing",
					records: parseBillingRecords(await readJsonBody(res)),
				};
			}
		}
	} catch {
		return failure(operation, "The control-plane operation could not be completed.");
	}

	// Unreachable once the switch is exhaustive over the control-plane set.
	return failure(operation, "The control-plane operation could not be completed.");
}

/**
 * Execute a capability-safe control operation against a Runpod endpoint.
 *
 * Enforces endpoint-family capability (queue-only ops require a queue
 * endpoint; ping requires a load-balanced one) and the unsupported-operation
 * set before any key resolution or network. Always resolves to a normalized
 * outcome; never throws.
 */
export async function executeControl(
	profile: ControlProfile,
	input: ControlInput,
	deps: ControlDeps,
): Promise<ControlOutcome> {
	const { operation } = input;

	if (UNSUPPORTED_OPERATIONS[operation] === true) {
		return unsupported(operation, "No control route is configured for this operation.");
	}

	if (operation === "ping") {
		return profile.endpointType === "load-balanced"
			? runPing(profile, deps)
			: unsupported(operation, "Ping is only available on load-balanced endpoints.");
	}

	if (operation === "workers" || operation === "catalog" || operation === "billing") {
		return runControlPlaneOperation(profile, input, deps);
	}

	if (QUEUE_OPERATIONS[operation] !== true) {
		return unsupported(operation, "This operation is not supported.");
	}
	if (profile.endpointType !== "queue") {
		return unsupported(operation, "This operation is only available on queue endpoints.");
	}

	return runQueueOperation(profile, input, deps);
}

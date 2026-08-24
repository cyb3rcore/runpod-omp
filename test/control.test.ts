/**
 * Direct, capability-safe Runpod control-plane operation contract tests
 * (test-first, per the approved plan).
 *
 * These tests fail today because src/control.ts does not exist yet. Implement
 * the following contract to make them pass:
 *
 * src/control.ts
 *   - `ControlOperation` = "health" | "ping" | "status" | "cancel" | "retry"
 *     | "purge" | "workers" | "catalog" | "billing" | "logs" | "warm"
 *     | "cool" | "close"
 *   - `ControlProfile` = { endpointType: EndpointType; invokeUrl: string;
 *     apiKey?: SecretReference; controlBaseUrl?: string } (structural; a full
 *     Profile is assignable)
 *   - `ControlInput` = { operation: ControlOperation; jobId?: string }
 *   - `ControlDeps` = { fetch: typeof fetch;
 *     resolveKey: (ref: SecretReference) => string | undefined }
 *   - `executeControl(profile, input, deps): Promise<ControlOutcome>`
 *   - `ControlOutcome` is a discriminated union on `operation`, with
 *     `ok: boolean` and, for failures, `supported: boolean`:
 *       - health (queue): `{ ok: true, operation: "health",
 *         workers: QueueWorkerSummary }` — GET `<invokeUrl>/health` with
 *         `Authorization: Bearer <resolved key>`; the body's `workers`
 *         normalises leniently (missing/unusable counts become "unknown",
 *         never 0); a malformed/non-object body still resolves to an
 *         all-"unknown" summary (structured unknown, not healthy/zero).
 *       - ping (load-balanced): `{ ok: true, operation: "ping",
 *         ping: "healthy" | "initializing" | "unhealthy" }` — GET
 *         `<invokeUrl>/ping`; HTTP 200 = healthy, 204 = initializing, any
 *         other status = unhealthy. Never carries queue-only fields
 *         (`workers`, `jobId`).
 *       - status (queue): `{ ok: true, operation: "status",
 *         jobStatus: QueueJobStatus }` — GET `<invokeUrl>/status/<jobId>`;
 *         the body's `status` normalises via `normaliseQueueJobStatus`
 *         (malformed → "unknown").
 *       - cancel / retry (queue): `{ ok: true, operation: "cancel" | "retry" }`
 *         — POST `<invokeUrl>/cancel/<jobId>` / `<invokeUrl>/retry/<jobId>`.
 *       - purge (queue): `{ ok: true, operation: "purge" }` — POST
 *         `<invokeUrl>/purge-queue`.
 *       - unsupported on the profile's endpoint type (queue-only ops on a
 *         load-balanced profile, or the cross-typed "health"/"ping"): `{
 *         ok: false, supported: false, operation, reason: string }` with ZERO
 *         fetch calls — never guessed.
 *       - workers / catalog / billing (either family): GET
 *         `<controlBaseUrl>/v2/serverless/<id>/workers`,
 *         `<controlBaseUrl>/v2/catalog/gpus`, and
 *         `<controlBaseUrl>/v2/billing/serverless?serverlessId=<id>&bucketSize=hour&lastN=24`
 *         with `Authorization: Bearer <resolved key>`, where `<id>` comes from
 *         `deriveEndpointId` and `controlBaseUrl` defaults to
 *         `RUNPOD_CONTROL_BASE`. Responses parse leniently (missing arrays →
 *         empty; absent amounts → 0; catalog entries without a finite
 *         `price.serverless` are dropped). A profile with no derivable
 *         endpoint id fails `supported: true` with detail
 *         "cannot derive endpoint id from invokeUrl" and zero fetch. HTTP 403
 *         maps to detail "control-plane access denied (key lacks required
 *         scope)"; other non-2xx maps to the generic redacted detail.
 *       - `deriveEndpointId(profile)`: queue → last non-empty path segment of
 *         the URL pathname; load-balanced → first hostname label when the
 *         host ends with ".api.runpod.ai"; unparseable or unknown shape →
 *         null.
 *       - logs / warm / cool / close: always `{ ok: false,
 *         supported: false, operation, reason: string }` with ZERO fetch
 *         calls unless an explicitly configured control route exists (none
 *         do) — never an attempted endpoint.
 *       - a failed authenticated/probe/parse execution: `{ ok: false,
 *         supported: true, operation, detail: string }` where `detail` is a
 *         redacted, generic string — it MUST NOT contain the resolved key,
 *         any request body, or any response bytes.
 *   - Authentication: queue operations resolve the profile's `apiKey` via
 *     `deps.resolveKey` and send `Authorization: Bearer <key>`. When the
 *     resolver returns undefined the operation fails with a redacted detail
 *     and performs ZERO fetch calls. Load-balanced ping needs no key.
 *
 * No real Runpod credentials or network are used: fetch and key resolution
 * are injected doubles per test.
 */
import { describe, expect, test } from "bun:test";

// Named import pins the required module entry point (link-time failure today:
// src/control.ts does not exist).
import { executeControl, deriveEndpointId, RUNPOD_CONTROL_BASE } from "../src/control.js";
import type {
	ControlInput,
	ControlOperation,
	ControlOutcome,
	ControlProfile,
	ControlWorker,
	ServerlessBillingRecord,
} from "../src/control.js";
import type { SecretReference } from "../src/profile-schema.js";
import type { QueueWorkerSummary } from "../src/health.js";
import type { QueueJobStatus } from "../src/transport/types.js";

/** Deterministic resolved bearer token injected via deps.resolveKey. */
const API_TOKEN = "test-control-key-9f2c";

/** The queue fixture's apiKey reference (resolved by the injectable resolver). */
const API_KEY_REF: SecretReference = {
	kind: "secret-reference",
	ref: "env:RUNPOD_API_KEY",
	redacted: "[redacted]",
};

const PROFILE_NAME = "llama-3-8b";

/** A queue profile; overrides replace whole fields. */
function queueProfile(overrides: { invokeUrl?: string } = {}): ControlProfile {
	return {
		endpointType: "queue",
		invokeUrl: overrides.invokeUrl ?? "https://api.runpod.ai/v2/ep",
		apiKey: API_KEY_REF,
	};
}

/** A load-balanced profile; overrides replace whole fields. */
function lbProfile(overrides: { invokeUrl?: string } = {}): ControlProfile {
	return {
		endpointType: "load-balanced",
		invokeUrl: overrides.invokeUrl ?? "https://ep-lb.api.runpod.ai",
		apiKey: API_KEY_REF,
	};
}

/** Resolver that always yields the deterministic token. */
function resolveKey(_ref: SecretReference): string {
	return API_TOKEN;
}

/** A recorded fetch invocation. */
interface FetchCall {
	url: string;
	init: RequestInit | undefined;
}

/** Deterministic fetch double: records every call and hands the response to the test. */
function recordingFetch(
	respond: (call: FetchCall) => Response | Promise<Response>,
): { calls: FetchCall[]; fetchMock: typeof fetch } {
	const calls: FetchCall[] = [];
	const fetchMock: typeof fetch = async (input, init) => {
		const call: FetchCall = { url: String(input), init };
		calls.push(call);
		return respond(call);
	};
	return { calls, fetchMock };
}

/** JSON-body response helper. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A fetch double that always rejects (network failure). */
function rejectingFetch(message: string): { calls: FetchCall[]; fetchMock: typeof fetch } {
	const calls: FetchCall[] = [];
	const fetchMock: typeof fetch = async (input, init) => {
		const call: FetchCall = { url: String(input), init };
		calls.push(call);
		throw new Error(message);
	};
	return { calls, fetchMock };
}

/** Assert one fetch call plus its method/URL; returns the call for extra checks. */
function expectCall(calls: FetchCall[], index: number, method: string, url: string): FetchCall {
	expect(calls).toHaveLength(index + 1);
	const call = calls[index]!;
	expect(call.url).toBe(url);
	expect(call.init?.method ?? "GET").toBe(method);
	return call;
}

describe("executeControl (queue health)", () => {
	const input: ControlInput = { operation: "health" };

	test("GETs <invokeUrl>/health with bearer auth and normalises workers leniently", async () => {
		const { calls, fetchMock } = recordingFetch(() =>
			jsonResponse({ workers: { idle: 2, running: 1 } }),
		);

		const outcome = await executeControl(queueProfile(), input, { fetch: fetchMock, resolveKey });

		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe("https://api.runpod.ai/v2/ep/health");
		expect(call.init?.method ?? "GET").toBe("GET");
		expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${API_TOKEN}`);

		expect(outcome).toMatchObject({ ok: true, operation: "health" });
		expect(outcome).toMatchObject<Pick<QueueWorkerSummary, "idle" | "running">>({
			idle: 2,
			running: 1,
		});
	});

	test("keeps the richer worker field set: missing fields are unknown, never zero", async () => {
		const { calls, fetchMock } = recordingFetch(() =>
			jsonResponse({ workers: { idle: 3, ready: 1, running: 2, initializing: 0, throttled: 0 } }),
		);

		const outcome = await executeControl(queueProfile(), input, { fetch: fetchMock, resolveKey });

		expect(calls).toHaveLength(1);
		expect(outcome).toMatchObject<QueueWorkerSummary>({
			idle: 3,
			ready: 1,
			running: 2,
			initializing: 0,
			throttled: 0,
		});
	});

	test("a sparse workers body yields unknown for every unreported field", async () => {
		const { fetchMock } = recordingFetch(() => jsonResponse({ workers: { idle: 1 } }));

		const outcome = await executeControl(queueProfile(), input, { fetch: fetchMock, resolveKey });

		expect(outcome).toMatchObject<QueueWorkerSummary>({
			idle: 1,
			ready: "unknown",
			running: "unknown",
			initializing: "unknown",
			throttled: "unknown",
		});
	});

	test("a malformed or non-object body resolves to an all-unknown summary (structured unknown)", async () => {
		const { fetchMock } = recordingFetch(() => jsonResponse("not an object"));

		const outcome = await executeControl(queueProfile(), input, { fetch: fetchMock, resolveKey });

		expect(outcome).toMatchObject<QueueWorkerSummary>({
			idle: "unknown",
			ready: "unknown",
			running: "unknown",
			initializing: "unknown",
			throttled: "unknown",
		});
	});

	test("a rejected fetch becomes a redacted failure that never leaks the key", async () => {
		const { calls, fetchMock } = rejectingFetch("connection refused to api.runpod.ai");
		const expectedSecret = "secret-payload-should-never-survive";

		const outcome = await executeControl(
			queueProfile(),
			input,
			{ fetch: fetchMock, resolveKey: () => expectedSecret },
		);

		expect(calls).toHaveLength(1);
		expect(outcome).toMatchObject({ ok: false, supported: true, operation: "health" });
		assertRedacted(outcome, [
			expectedSecret,
			API_KEY_REF.ref,
			"api.runpod.ai",
		]);
	});
});

describe("executeControl (load-balanced ping)", () => {
	const input: ControlInput = { operation: "ping" };

	test("GETs <invokeUrl>/ping and maps HTTP 200 to healthy", async () => {
		const { calls, fetchMock } = recordingFetch(() => new Response("ok", { status: 200 }));

		const outcome = await executeControl(lbProfile(), input, { fetch: fetchMock, resolveKey });

		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe("https://ep-lb.api.runpod.ai/ping");
		expect(call.init?.method ?? "GET").toBe("GET");

		expect(outcome).toMatchObject({ ok: true, operation: "ping", ping: "healthy" });
	});

	test("maps HTTP 204 to initializing", async () => {
		const { fetchMock } = recordingFetch(() => new Response(null, { status: 204 }));

		const outcome = await executeControl(lbProfile(), input, { fetch: fetchMock, resolveKey });

		expect(outcome).toMatchObject({ ok: true, operation: "ping", ping: "initializing" });
	});

	test("maps any other status to unhealthy", async () => {
		const { fetchMock } = recordingFetch(() => new Response("boom", { status: 503 }));

		const outcome = await executeControl(lbProfile(), input, { fetch: fetchMock, resolveKey });

		expect(outcome).toMatchObject({ ok: true, operation: "ping", ping: "unhealthy" });
	});

	test("never carries queue-only fields on any ping outcome", async () => {
		for (const status of [200, 204, 503]) {
			const { fetchMock } = recordingFetch(() =>
				new Response(status === 200 ? "ok" : "nope", { status }),
			);
			const outcome = await executeControl(lbProfile(), input, { fetch: fetchMock, resolveKey });
			expect(outcome.operation).toBe("ping");
			expect(outcome).not.toHaveProperty("workers");
			expect(outcome).not.toHaveProperty("jobId");
			expect(outcome).not.toHaveProperty("jobStatus");
		}
	});

	test("ping on a queue profile is unsupported with zero fetch calls", async () => {
		const { calls, fetchMock } = recordingFetch(() => new Response("ok", { status: 200 }));

		const outcome = await executeControl(queueProfile(), { operation: "ping" }, { fetch: fetchMock, resolveKey });

		expect(calls).toHaveLength(0);
		expect(outcome).toMatchObject({ ok: false, supported: false, operation: "ping" });
		expect(outcome.reason).toBeTruthy();
	});
});

describe("executeControl (queue job routes)", () => {
	test("status is GET <invokeUrl>/status/<jobId> with auth and normalises the job status", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse({ id: "job-abc", status: "COMPLETED" }));

		const outcome = await executeControl(
			queueProfile(),
			{ operation: "status", jobId: "job-abc" },
			{ fetch: fetchMock, resolveKey },
		);

		const call = expectCall(calls, 0, "GET", "https://api.runpod.ai/v2/ep/status/job-abc");
		expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${API_TOKEN}`);
		expect(outcome).toMatchObject({
			ok: true,
			operation: "status",
			jobStatus: "COMPLETED" satisfies QueueJobStatus,
		});
	});

	test("status with a malformed body resolves the job status to unknown, not a fake value", async () => {
		const { calls, fetchMock } = recordingFetch(() =>
			new Response("no json here", { status: 200, headers: { "content-type": "application/json" } }),
		);

		const outcome = await executeControl(
			queueProfile(),
			{ operation: "status", jobId: "job-abc" },
			{ fetch: fetchMock, resolveKey },
		);

		expectCall(calls, 0, "GET", "https://api.runpod.ai/v2/ep/status/job-abc");
		expect(outcome).toMatchObject({ ok: true, operation: "status", jobStatus: "unknown" });
	});

	test("cancel is POST <invokeUrl>/cancel/<jobId> with auth", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse({ id: "job-abc", status: "CANCELLED" }));

		const outcome = await executeControl(
			queueProfile(),
			{ operation: "cancel", jobId: "job-abc" },
			{ fetch: fetchMock, resolveKey },
		);

		const call = expectCall(calls, 0, "POST", "https://api.runpod.ai/v2/ep/cancel/job-abc");
		expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${API_TOKEN}`);
		expect(outcome).toMatchObject({ ok: true, operation: "cancel" });
	});

	test("retry is POST <invokeUrl>/retry/<jobId> with auth", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse({ id: "job-abc", status: "IN_QUEUE" }));

		const outcome = await executeControl(
			queueProfile(),
			{ operation: "retry", jobId: "job-abc" },
			{ fetch: fetchMock, resolveKey },
		);

		expectCall(calls, 0, "POST", "https://api.runpod.ai/v2/ep/retry/job-abc");
		expect(outcome).toMatchObject({ ok: true, operation: "retry" });
	});

	test("purge is POST <invokeUrl>/purge-queue with auth and no job id", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse({ purged: true }));

		const outcome = await executeControl(
			queueProfile(),
			{ operation: "purge" },
			{ fetch: fetchMock, resolveKey },
		);

		const call = expectCall(calls, 0, "POST", "https://api.runpod.ai/v2/ep/purge-queue");
		expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${API_TOKEN}`);
		expect(outcome).toMatchObject({ ok: true, operation: "purge" });
	});

	test("a rejected fetch on a job route becomes a redacted failure that never leaks the key or body", async () => {
		const { calls, fetchMock } = rejectingFetch("ECONNRESET reading status job-abc");
		const expectedSecret = "ultra-secret-token-777";

		const outcome = await executeControl(
			queueProfile(),
			{ operation: "status", jobId: "job-abc" },
			{ fetch: fetchMock, resolveKey: () => expectedSecret },
		);

		expect(calls).toHaveLength(1);
		expect(outcome).toMatchObject({ ok: false, supported: true, operation: "status" });
		assertRedacted(outcome, [expectedSecret, API_KEY_REF.ref, "job-abc"]);
	});
});

describe("executeControl (unsupported operations)", () => {
	test("every queue-only job operation is unsupported on a load-balanced profile with zero fetch", async () => {
		const queueOps: ControlOperation[] = ["status", "cancel", "retry", "purge"];

		for (const operation of queueOps) {
			const { calls, fetchMock } = recordingFetch(() => jsonResponse({}));
			const input: ControlInput =
				operation === "purge" ? { operation } : { operation, jobId: "job-abc" };

			const outcome = await executeControl(lbProfile(), input, { fetch: fetchMock, resolveKey });

			expect(calls).toHaveLength(0);
			expect(outcome).toMatchObject({ ok: false, supported: false, operation });
			expect(outcome.reason).toBeTruthy();
		}
	});

	test("health on a load-balanced profile is unsupported with zero fetch (ping is its check)", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse({}));

		const outcome = await executeControl(lbProfile(), { operation: "health" }, { fetch: fetchMock, resolveKey });

		expect(calls).toHaveLength(0);
		expect(outcome).toMatchObject({ ok: false, supported: false, operation: "health" });
		expect(outcome.reason).toBeTruthy();
	});

	test("logs/warm/cool/close are explicitly unsupported with zero fetch", async () => {
		const unsupportedOps: ControlOperation[] = ["logs", "warm", "cool", "close"];

		for (const operation of unsupportedOps) {
			const { calls, fetchMock } = recordingFetch(() => jsonResponse({}));

			const outcome = await executeControl(queueProfile(), { operation }, { fetch: fetchMock, resolveKey });

			expect(calls).toHaveLength(0);
			expect(outcome).toMatchObject({ ok: false, supported: false, operation });
			expect(outcome.reason).toBeTruthy();
		}
	});

	test("unsupported outcomes are reported for load-balanced profiles too", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse({}));

		const outcome = await executeControl(lbProfile(), { operation: "warm" }, { fetch: fetchMock, resolveKey });

		expect(calls).toHaveLength(0);
		expect(outcome).toMatchObject({ ok: false, supported: false, operation: "warm" });
		expect(outcome.reason).toBeTruthy();
	});
});

describe("deriveEndpointId", () => {
	test("queue: last non-empty path segment", () => {
		expect(deriveEndpointId({ endpointType: "queue", invokeUrl: "https://api.runpod.ai/v2/4m7x2k9q" })).toBe("4m7x2k9q");
	});

	test("queue: trailing slash tolerated", () => {
		expect(deriveEndpointId({ endpointType: "queue", invokeUrl: "https://api.runpod.ai/v2/4m7x2k9q/" })).toBe("4m7x2k9q");
	});

	test("load-balanced: first hostname label of *.api.runpod.ai", () => {
		expect(deriveEndpointId({ endpointType: "load-balanced", invokeUrl: "https://4m7x2k9q.api.runpod.ai" })).toBe("4m7x2k9q");
	});

	test("load-balanced: path is ignored", () => {
		expect(deriveEndpointId({ endpointType: "load-balanced", invokeUrl: "https://4m7x2k9q.api.runpod.ai/v1/chat/completions" })).toBe("4m7x2k9q");
	});

	test("load-balanced: custom host is not derivable", () => {
		expect(deriveEndpointId({ endpointType: "load-balanced", invokeUrl: "https://xyz123.proxy.runpod.net" })).toBeNull();
	});

	test("queue: bare origin is not derivable", () => {
		expect(deriveEndpointId({ endpointType: "queue", invokeUrl: "https://api.runpod.ai" })).toBeNull();
	});

	test("unparseable URL is not derivable", () => {
		expect(deriveEndpointId({ endpointType: "queue", invokeUrl: "not a url" })).toBeNull();
	});
});

describe("RUNPOD_CONTROL_BASE", () => {
	test("is the host only, so route composition appends exactly one /v2 prefix", () => {
		const workersUrl = `${RUNPOD_CONTROL_BASE}/v2/serverless/4m7x2k9q/workers`;
		expect(workersUrl).toBe("https://api.runpod.io/v2/serverless/4m7x2k9q/workers");
		expect(workersUrl).not.toContain("/v2/v2");
		const billingUrl = `${RUNPOD_CONTROL_BASE}/v2/billing/serverless?serverlessId=4m7x2k9q&bucketSize=hour&lastN=24`;
		expect(billingUrl).toBe(
			"https://api.runpod.io/v2/billing/serverless?serverlessId=4m7x2k9q&bucketSize=hour&lastN=24",
		);
	});
});

describe("executeControl (control-plane operations)", () => {
	const CONTROL_BASE = "https://control.test";

	function controlProfile(
		overrides: { endpointType?: "queue" | "load-balanced"; invokeUrl?: string } = {},
	): ControlProfile {
		return {
			endpointType: overrides.endpointType ?? "queue",
			invokeUrl:
				overrides.invokeUrl ??
				(overrides.endpointType === "load-balanced"
					? "https://4m7x2k9q.api.runpod.ai"
					: "https://api.runpod.ai/v2/4m7x2k9q"),
			apiKey: API_KEY_REF,
			controlBaseUrl: CONTROL_BASE,
		};
	}

	const WORKER_FIXTURE: ControlWorker = {
		id: "8g3n5t6r",
		status: "RUNNING",
		gpuCount: 1,
		gpuTypeId: "NVIDIA GeForce RTX 4090",
		uptimeSeconds: 3600,
	};

	test("workers: GET /v2/serverless/<id>/workers with bearer auth and lenient parse", async () => {
		const { calls, fetchMock } = recordingFetch(() =>
			jsonResponse({ summary: { running: 1, total: 1 }, workers: [WORKER_FIXTURE] }),
		);

		const outcome = await executeControl(controlProfile(), { operation: "workers" }, { fetch: fetchMock, resolveKey });

		const call = expectCall(calls, 0, "GET", `${CONTROL_BASE}/v2/serverless/4m7x2k9q/workers`);
		expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${API_TOKEN}`);
		expect(outcome).toMatchObject({ ok: true, operation: "workers" });
		expect(outcome).toMatchObject<{ workers: ControlWorker[] }>({ workers: [WORKER_FIXTURE] });
	});

	test("workers: works on a load-balanced profile (id derived from hostname)", async () => {
		const { calls, fetchMock } = recordingFetch(() =>
			jsonResponse({ workers: [{ id: "w1", status: "IDLE", gpuCount: 1 }] }),
		);

		const outcome = await executeControl(
			controlProfile({ endpointType: "load-balanced" }),
			{ operation: "workers" },
			{ fetch: fetchMock, resolveKey },
		);

		expectCall(calls, 0, "GET", `${CONTROL_BASE}/v2/serverless/4m7x2k9q/workers`);
		expect(outcome).toMatchObject({ ok: true, operation: "workers" });
		expect(outcome).toMatchObject<{ workers: ControlWorker[] }>({
			workers: [{ id: "w1", status: "IDLE", gpuCount: 1, gpuTypeId: undefined, uptimeSeconds: undefined }],
		});
	});

	test("workers: a missing workers array resolves to an empty list", async () => {
		const { fetchMock } = recordingFetch(() => jsonResponse({ summary: { total: 0 } }));

		const outcome = await executeControl(controlProfile(), { operation: "workers" }, { fetch: fetchMock, resolveKey });

		expect(outcome).toMatchObject({ ok: true, operation: "workers", workers: [] });
	});

	test("catalog: GET /v2/catalog/gpus and keeps only finite serverless prices", async () => {
		const { calls, fetchMock } = recordingFetch(() =>
			jsonResponse({
				gpus: [
					{ id: "NVIDIA GeForce RTX 4090", price: { secure: 0.44, community: 0.31, serverless: 1.1 } },
					{ id: "NVIDIA L40", price: { serverless: 2.0 } },
					{ id: "NVIDIA H100", price: { serverless: null } },
					{ id: "BROKEN", price: { serverless: "1.1" } },
					{ id: "NOPRICE" },
				],
			}),
		);

		const outcome = await executeControl(controlProfile(), { operation: "catalog" }, { fetch: fetchMock, resolveKey });

		const call = expectCall(calls, 0, "GET", `${CONTROL_BASE}/v2/catalog/gpus`);
		expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${API_TOKEN}`);
		expect(outcome).toMatchObject({ ok: true, operation: "catalog" });
		expect(outcome).toMatchObject<{ gpus: Record<string, number> }>({
			gpus: { "NVIDIA GeForce RTX 4090": 1.1, "NVIDIA L40": 2.0 },
		});
	});

	test("catalog: a missing gpus array resolves to an empty map", async () => {
		const { fetchMock } = recordingFetch(() => jsonResponse({}));

		const outcome = await executeControl(controlProfile(), { operation: "catalog" }, { fetch: fetchMock, resolveKey });

		expect(outcome).toMatchObject({ ok: true, operation: "catalog", gpus: {} });
	});

	test("billing: GET /v2/billing/serverless with serverlessId, hour buckets, lastN=24", async () => {
		const record: ServerlessBillingRecord = {
			startTime: "2026-06-01T00:00:00Z",
			endTime: "2026-06-02T00:00:00Z",
			totalAmount: 8.9,
			gpuAmount: 7.5,
			cpuAmount: 0,
			diskAmount: 0.4,
			feeAmount: 1.0,
		};
		const { calls, fetchMock } = recordingFetch(() =>
			jsonResponse({ records: [record], metadata: { totals: { totalAmount: 8.9 } } }),
		);

		const outcome = await executeControl(controlProfile(), { operation: "billing" }, { fetch: fetchMock, resolveKey });

		const call = expectCall(
			calls,
			0,
			"GET",
			`${CONTROL_BASE}/v2/billing/serverless?serverlessId=4m7x2k9q&bucketSize=hour&lastN=24`,
		);
		expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${API_TOKEN}`);
		expect(outcome).toMatchObject({ ok: true, operation: "billing" });
		expect(outcome).toMatchObject<{ records: ServerlessBillingRecord[] }>({ records: [record] });
	});

	test("billing: absent amount fields become zero", async () => {
		const { fetchMock } = recordingFetch(() =>
			jsonResponse({ records: [{ startTime: "t", endTime: "t2", totalAmount: 3.0 }] }),
		);

		const outcome = await executeControl(controlProfile(), { operation: "billing" }, { fetch: fetchMock, resolveKey });

		expect(outcome).toMatchObject({ ok: true, operation: "billing" });
		expect(outcome).toMatchObject<{ records: ServerlessBillingRecord[] }>({
			records: [
				{ startTime: "t", endTime: "t2", totalAmount: 3.0, gpuAmount: 0, cpuAmount: 0, diskAmount: 0, feeAmount: 0 },
			],
		});
	});

	test("billing: a missing records array resolves to an empty list", async () => {
		const { fetchMock } = recordingFetch(() => jsonResponse({ metadata: { recordCount: 0 } }));

		const outcome = await executeControl(controlProfile(), { operation: "billing" }, { fetch: fetchMock, resolveKey });

		expect(outcome).toMatchObject({ ok: true, operation: "billing", records: [] });
	});

	test("an underivable endpoint id fails supported with zero fetch and an explicit reason", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse({}));

		const outcome = await executeControl(
			controlProfile({ endpointType: "load-balanced", invokeUrl: "https://custom.example.com" }),
			{ operation: "workers" },
			{ fetch: fetchMock, resolveKey },
		);

		expect(calls).toHaveLength(0);
		expect(outcome).toMatchObject({
			ok: false,
			supported: true,
			operation: "workers",
			detail: "cannot derive endpoint id from invokeUrl",
		});
	});

	test("HTTP 403 maps to the scope-denied detail", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse({}, 403));

		const outcome = await executeControl(controlProfile(), { operation: "billing" }, { fetch: fetchMock, resolveKey });

		expect(calls).toHaveLength(1);
		expect(outcome).toMatchObject({
			ok: false,
			supported: true,
			operation: "billing",
			detail: "control-plane access denied (key lacks required scope)",
		});
	});

	test("other non-2xx responses map to the generic redacted detail", async () => {
		const { fetchMock } = recordingFetch(() => jsonResponse({ detail: "no such endpoint" }, 404));

		const outcome = await executeControl(controlProfile(), { operation: "workers" }, { fetch: fetchMock, resolveKey });

		expect(outcome).toMatchObject({ ok: false, supported: true, operation: "workers" });
		assertRedacted(outcome, ["no such endpoint", API_KEY_REF.ref]);
	});

	test("a failing key resolution fails with a redacted detail and zero fetch calls", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse({}));

		const outcome = await executeControl(
			controlProfile(),
			{ operation: "workers" },
			{ fetch: fetchMock, resolveKey: () => undefined },
		);

		expect(calls).toHaveLength(0);
		expect(outcome).toMatchObject({ ok: false, supported: true, operation: "workers" });
		assertRedacted(outcome, [API_KEY_REF.ref]);
	});
});

describe("executeControl (authentication & redaction)", () => {
	test("a failing key resolution fails with a redacted detail and zero fetch calls", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse({}));

		const outcome = await executeControl(
			queueProfile(),
			{ operation: "status", jobId: "job-abc" },
			{ fetch: fetchMock, resolveKey: () => undefined },
		);

		expect(calls).toHaveLength(0);
		expect(outcome).toMatchObject({ ok: false, supported: true, operation: "status" });
		assertRedacted(outcome, [API_KEY_REF.ref, "job-abc"]);
	});

	test("load-balanced ping does not require key resolution", async () => {
		const { fetchMock } = recordingFetch(() => new Response("ok", { status: 200 }));

		const outcome = await executeControl(
			lbProfile(),
			{ operation: "ping" },
			{ fetch: fetchMock, resolveKey: () => undefined },
		);

		expect(outcome).toMatchObject({ ok: true, operation: "ping", ping: "healthy" });
	});
});

/**
 * Assert a failed outcome's `detail` is a generic redacted string that leaks
 * none of the given sensitive fragments (key, secret, ref, request body).
 */
function assertRedacted(outcome: ControlOutcome, sensitive: readonly string[]): void {
	if (!("detail" in outcome)) {
		throw new Error("expected a failed outcome with a redacted detail");
	}
	expect(typeof outcome.detail).toBe("string");
	expect(outcome.detail.length).toBeGreaterThan(0);
	for (const fragment of sensitive) {
		expect(outcome.detail).not.toContain(fragment);
	}
}

describe("executeControl (pod operations)", () => {
	const CONTROL_BASE = "https://control.test";

	function podProfile(overrides: { podId?: string; endpointType?: "pod" | "queue" } = {}): ControlProfile {
		return {
			endpointType: overrides.endpointType ?? "pod",
			invokeUrl: "",
			apiKey: API_KEY_REF,
			controlBaseUrl: CONTROL_BASE,
			podId: overrides.podId ?? "pod_abc123",
		};
	}

	const POD_BODY = {
		id: "pod_abc123",
		name: "qwen-subs",
		status: "RUNNING",
		cost: 1.19,
		dataCenterId: "US-TX-1",
		runtime: { uptime: 7_200, ports: [{ private: 8000, public: 43210, type: "tcp", ip: "45.23.12.1" }] },
	};

	test("pod-status: GET /v2/pods/<podId> and normalizes the bare Pod", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse(POD_BODY));

		const outcome = await executeControl(podProfile(), { operation: "pod-status" }, { fetch: fetchMock, resolveKey });

		const call = expectCall(calls, 0, "GET", `${CONTROL_BASE}/v2/pods/pod_abc123`);
		expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${API_TOKEN}`);
		expect(outcome).toMatchObject({
			ok: true,
			operation: "pod-status",
			pod: {
				id: "pod_abc123",
				name: "qwen-subs",
				status: "RUNNING",
				costPerHour: 1.19,
				uptimeSeconds: 7_200,
				dataCenterId: "US-TX-1",
			},
		});
	});

	test("pod-start: POST /v2/pods/<podId>/action with the action body and returns the updated pod", async () => {
		const { calls, fetchMock } = recordingFetch(() =>
			jsonResponse({ ...POD_BODY, status: "STARTING", cost: 0, runtime: null }),
		);

		const outcome = await executeControl(podProfile(), { operation: "pod-start" }, { fetch: fetchMock, resolveKey });

		const call = expectCall(calls, 0, "POST", `${CONTROL_BASE}/v2/pods/pod_abc123/action`);
		const headers = new Headers(call.init?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${API_TOKEN}`);
		expect(headers.get("content-type")).toContain("application/json");
		expect(JSON.parse(String(call.init?.body))).toEqual({ action: "start" });
		expect(outcome).toMatchObject({
			ok: true,
			operation: "pod-start",
			pod: { status: "STARTING", costPerHour: 0, uptimeSeconds: null },
		});
	});

	test("pod-stop and pod-restart post their own actions", async () => {
		const { fetchMock } = recordingFetch((call) => {
			const body = JSON.parse(String(call.init?.body)) as { action: string };
			return jsonResponse({ ...POD_BODY, status: body.action === "stop" ? "EXITED" : "RUNNING" });
		});
		const stop = await executeControl(podProfile(), { operation: "pod-stop" }, { fetch: fetchMock, resolveKey });
		expect(stop).toMatchObject({ ok: true, operation: "pod-stop", pod: { status: "EXITED" } });
		const restart = await executeControl(podProfile(), { operation: "pod-restart" }, { fetch: fetchMock, resolveKey });
		expect(restart).toMatchObject({ ok: true, operation: "pod-restart", pod: { status: "RUNNING" } });
	});

	test("a lenient pod body defaults missing fields without throwing", async () => {
		const { fetchMock } = recordingFetch(() => jsonResponse({ id: "pod_abc123" }));

		const outcome = await executeControl(podProfile(), { operation: "pod-status" }, { fetch: fetchMock, resolveKey });

		expect(outcome).toMatchObject({
			ok: true,
			operation: "pod-status",
			pod: { id: "pod_abc123", name: "", status: "ERROR", costPerHour: 0, uptimeSeconds: null, dataCenterId: null },
		});
	});

	test("pod operations are unsupported on non-pod profiles with zero fetch", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse({}));

		const outcome = await executeControl(
			podProfile({ endpointType: "queue" }),
			{ operation: "pod-status" },
			{ fetch: fetchMock, resolveKey },
		);

		expect(outcome).toMatchObject({
			ok: false,
			operation: "pod-status",
			supported: false,
			reason: "This operation is only available on pod profiles.",
		});
		expect(calls).toEqual([]);
	});

	test("pod billing uses /v2/billing/pods with podId instead of the serverless route", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse({ records: [] }));

		const outcome = await executeControl(podProfile(), { operation: "billing" }, { fetch: fetchMock, resolveKey });

		const call = expectCall(
			calls,
			0,
			"GET",
			`${CONTROL_BASE}/v2/billing/pods?podId=pod_abc123&bucketSize=hour&lastN=24`,
		);
		expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${API_TOKEN}`);
		expect(outcome).toMatchObject({ ok: true, operation: "billing", records: [] });
	});
});

/**
 * Queue transport contract tests (test-first, per the approved plan).
 *
 * These tests fail today because the module they import does not exist yet.
 * Implement the following contract to make them pass:
 *
 * src/transport/queue.ts
 *   - `executeQueueTransport(profile: Profile, request: NormalizedRequest,
 *     deps?: TransportDeps): Promise<QueueTransportResult>` where
 *     `TransportDeps = { fetch, sleep, now }` and the result is
 *     `{ response?, events, details }`; `details` carries `requestedMode`,
 *     `actualMode`, `downgrades` and may carry `jobId`, `status`, `expired`.
 *
 * Wire behavior (managed-queue endpoints under `profile.invokeUrl`):
 *   - every call sends `Authorization: Bearer <resolved api key>`; the tests
 *     resolve the profile's `env:RUNPOD_API_KEY` reference from the
 *     environment, pinned to a fixed token below;
 *   - `sync` POSTs `{ input: request }` to `/runsync?wait=300000` (the
 *     profile's timeout, clamped to the 300 s maximum) and decodes the
 *     COMPLETED job's `output` as an OpenAI-shaped completion;
 *   - `async` POSTs `{ input: request }` to `/run` (response `{ id,
 *     status: "IN_QUEUE" }`), then polls `/status/<id>` until a terminal
 *     status, sleeping `polling.intervalMs` between polls via `deps.sleep`
 *     (injected, no-op here);
 *   - `stream` POSTs `{ input: request }` to `/run`, then reads
 *     `/stream/<id>`; each array item's `output` is decoded and preserved as
 *     events or as a response — never dropped or guessed;
 *   - polling that exhausts `polling.ttlMs` while the job is non-terminal
 *     returns an explicit unknown/expired state — never a healthy result
 *     derived from a non-terminal job.
 *
 * No real Runpod credentials are used: fetch is a recording mock per test.
 */
import { afterAll, describe, expect, test } from "bun:test";

// Named import pins the required transport entry point (link-time failure if
// the module omits it).
import { executeQueueTransport } from "../src/transport/queue.js";
import type { Profile } from "../src/profile-schema.js";
import type { NormalizedRequest, NormalizedResponse, RequestMode } from "../src/transport/types.js";

// The queue transport resolves the profile's `env:RUNPOD_API_KEY` reference
// itself; pin the variable so the Authorization header is deterministic.
const API_TOKEN = "test-runpod-key-123";
const PREV_RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
process.env.RUNPOD_API_KEY = API_TOKEN;
afterAll(() => {
	if (PREV_RUNPOD_API_KEY === undefined) {
		delete process.env.RUNPOD_API_KEY;
	} else {
		process.env.RUNPOD_API_KEY = PREV_RUNPOD_API_KEY;
	}
});

/** Model metadata block, matching the approved profile schema. */
const MODEL = {
	id: "meta-llama/llama-3.3-70b-instruct",
	name: "Llama 3.3 70B Instruct",
	contextWindow: 131_072,
	maxTokens: 8_192,
	reasoning: false,
	input: ["text"],
	supportsTools: true,
	supportsVision: false,
};

/** Build a queue profile; overrides replace whole fields. */
function queueProfile(overrides: { mode?: RequestMode; ttlMs?: number } = {}): Profile {
	return {
		endpointType: "queue",
		invokeUrl: "https://api.runpod.ai/v2/ep",
		model: MODEL,
		apiKey: { kind: "secret-reference", ref: "env:RUNPOD_API_KEY", redacted: "[redacted]" },
		request: {
			mode: overrides.mode ?? "sync",
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: overrides.ttlMs ?? 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" },
			loadBalancedPath: "/v1/chat/completions",
		},
		policy: { maxAttempts: 1, fallbackProfiles: [] },
	};
}

/** Build a normalized request; overrides replace whole fields. */
function requestFixture(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
	return {
		model: "runpod/llama-3-8b",
		messages: [
			{ role: "system", content: "You are terse." },
			{ role: "user", content: "Explain queue endpoints." },
		],
		stream: false,
		temperature: 0.2,
		maxTokens: 256,
		...overrides,
	};
}

/** OpenAI-shaped completion the worker returns for every completed job. */
const COMPLETION = {
	id: "chatcmpl-1",
	model: "runpod/llama-3-8b",
	choices: [
		{ index: 0, message: { role: "assistant", content: "Hello from Runpod" }, finish_reason: "stop" },
	],
	usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
};

/** The normalized decoding of COMPLETION (no guessing at the output shape). */
const DECODED: NormalizedResponse = {
	text: "Hello from Runpod",
	usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
	downgrades: [],
};

/** A recorded fetch invocation. */
interface FetchCall {
	url: string;
	init: RequestInit | undefined;
}

/** Deterministic fetch double: records every call and hands the response to the test. */
function recordingFetch(
	respond: (call: FetchCall) => Response,
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

/** Every queue call authenticates with the resolved bearer token. */
function expectBearerAuth(calls: FetchCall[], token = API_TOKEN): void {
	for (const call of calls) {
		expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${token}`);
	}
}

/** Injected no-op time controls: polling never actually waits. */
const noopSleep = async (): Promise<void> => {};
const zeroNow = (): number => 0;

const BASE = "https://api.runpod.ai/v2/ep";

describe("executeQueueTransport", () => {
	test("sync mode posts {input} to /runsync?wait=300000 and decodes the completed output", async () => {
		const { calls, fetchMock } = recordingFetch(() =>
			jsonResponse({ id: "job-1", status: "COMPLETED", output: COMPLETION }),
		);

		const request = requestFixture();
		const result = await executeQueueTransport(queueProfile({ mode: "sync" }), request, {
			fetch: fetchMock,
			sleep: noopSleep,
			now: zeroNow,
		});

		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe(`${BASE}/runsync?wait=300000`);
		expect(call.init?.method).toBe("POST");
		expect(new Headers(call.init?.headers).get("content-type")).toContain("application/json");
		// The body is the adapter envelope: the normalized request under `input`.
		expect(JSON.parse(call.init!.body as string)).toEqual({ input: request });
		expectBearerAuth(calls);

		expect(result.response).toEqual(DECODED);
		expect(result.events).toEqual([]);
		expect(result.details).toMatchObject({ requestedMode: "sync", actualMode: "sync", downgrades: [] });
	});

	test("async mode posts to /run then polls /status once to completion", async () => {
		const { calls, fetchMock } = recordingFetch((call) =>
			call.url.endsWith("/run")
				? jsonResponse({ id: "job-2", status: "IN_QUEUE" })
				: jsonResponse({ id: "job-2", status: "COMPLETED", output: COMPLETION }),
		);

		const result = await executeQueueTransport(queueProfile({ mode: "async" }), requestFixture(), {
			fetch: fetchMock,
			sleep: noopSleep,
			now: zeroNow,
		});

		expect(calls).toHaveLength(2);
		const [runCall, statusCall] = calls;
		expect(runCall!.url).toBe(`${BASE}/run`);
		expect(runCall!.init?.method).toBe("POST");
		expect(new Headers(runCall!.init?.headers).get("content-type")).toContain("application/json");
		expect(JSON.parse(runCall!.init!.body as string)).toEqual({ input: requestFixture() });
		expect(statusCall!.url).toBe(`${BASE}/status/job-2`);
		expect(statusCall!.init?.method ?? "GET").toBe("GET");
		expectBearerAuth(calls);

		expect(result.response).toEqual(DECODED);
		expect(result.details).toMatchObject({
			requestedMode: "async",
			actualMode: "async",
			downgrades: [],
			jobId: "job-2",
			status: "COMPLETED",
		});
	});

	test("async polling tolerates RUNNING before COMPLETED", async () => {
		let statusPolls = 0;
		const { calls, fetchMock } = recordingFetch((call) => {
			if (call.url.endsWith("/run")) {
				return jsonResponse({ id: "job-3", status: "IN_QUEUE" });
			}
			statusPolls += 1;
			return statusPolls === 1
				? jsonResponse({ id: "job-3", status: "RUNNING" })
				: jsonResponse({ id: "job-3", status: "COMPLETED", output: COMPLETION });
		});
		const sleepCalls: number[] = [];
		const sleep = async (ms: number): Promise<void> => {
			sleepCalls.push(ms);
		};

		const result = await executeQueueTransport(queueProfile({ mode: "async" }), requestFixture(), {
			fetch: fetchMock,
			sleep,
			now: zeroNow,
		});

		expect(calls).toHaveLength(3);
		expect(calls.map((call) => call.url)).toEqual([
			`${BASE}/run`,
			`${BASE}/status/job-3`,
			`${BASE}/status/job-3`,
		]);
		expectBearerAuth(calls);
		// Polling honors the profile interval between status checks.
		expect(sleepCalls).toContain(1_000);

		expect(result.response).toEqual(DECODED);
		expect(result.details).toMatchObject({
			requestedMode: "async",
			actualMode: "async",
			downgrades: [],
			jobId: "job-3",
			status: "COMPLETED",
		});
	});

	test("stream mode posts to /run and consumes /stream chunk outputs", async () => {
		const streamBody = [
			{ metrics: {}, output: { choices: [{ index: 0, message: { role: "assistant", content: "Hello" } }] } },
			{ metrics: {}, output: { choices: [{ index: 0, message: { role: "assistant", content: " from" } }] } },
			{ metrics: {}, output: { choices: [{ index: 0, message: { role: "assistant", content: " Runpod" } }] } },
		];
		const { calls, fetchMock } = recordingFetch((call) =>
			call.url.endsWith("/run")
				? jsonResponse({ id: "job-4", status: "IN_QUEUE" })
				: jsonResponse(streamBody),
		);

		const streamRequest = requestFixture({ stream: true });
		const result = await executeQueueTransport(queueProfile({ mode: "stream" }), streamRequest, {
			fetch: fetchMock,
			sleep: noopSleep,
			now: zeroNow,
		});

		expect(calls).toHaveLength(2);
		expect(calls.map((call) => call.url)).toEqual([`${BASE}/run`, `${BASE}/stream/job-4`]);
		expect(new Headers(calls[0]!.init?.headers).get("content-type")).toContain("application/json");
		expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ input: streamRequest });
		expectBearerAuth(calls);

		expect(result.details).toMatchObject({ requestedMode: "stream", actualMode: "stream", downgrades: [] });

		// Every chunk output is preserved, as events or as a response — never lost.
		const streamedText =
			result.events.length > 0
				? result.events.map((event) => (event.type === "text" ? event.text : "")).join("")
				: (result.response?.text ?? "");
		expect(streamedText).toBe("Hello from Runpod");
	});

	test("async polling expires to an explicit unknown state when the TTL runs out while IN_QUEUE", async () => {
		let clock = 0;
		const { calls, fetchMock } = recordingFetch((call) => {
			if (call.url.endsWith("/run")) {
				return jsonResponse({ id: "job-5", status: "IN_QUEUE" });
			}
			// The job is still queued; time runs out the moment this poll lands.
			clock = 6_000;
			return jsonResponse({ id: "job-5", status: "IN_QUEUE" });
		});

		const result = await executeQueueTransport(queueProfile({ mode: "async", ttlMs: 5_000 }), requestFixture(), {
			fetch: fetchMock,
			sleep: noopSleep,
			now: () => clock,
		});

		expect(calls).toHaveLength(2);
		expect(calls.map((call) => call.url)).toEqual([`${BASE}/run`, `${BASE}/status/job-5`]);
		expectBearerAuth(calls);

		// Expiry is explicit — never a healthy/current result guessed from a stale job.
		expect(result.response).toBeUndefined();
		expect(result.details.expired).toBe(true);
		const expiredStatus = result.details.status;
		const downgradeReason = result.details.downgrades[0]?.reason ?? "";
		expect(
			expiredStatus === "unknown" || expiredStatus === "expired" || /unknown|expired|ttl/i.test(downgradeReason),
		).toBe(true);
		expect(result.details).toMatchObject({ requestedMode: "async", actualMode: "async" });
	});
});

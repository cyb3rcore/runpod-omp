/**
 * Load-balanced transport contract tests (test-first, per the approved plan).
 *
 * These tests fail today because the module they import does not exist yet.
 * Implement the following contract to make them pass:
 *
 * src/transport/load-balanced.ts
 *   - `executeLoadBalancedTransport(profile: RunpodProfile, request:
 *     NormalizedRequest, deps?: TransportDeps): Promise<TransportExecutionResult>`
 *     — posts directly to the worker path; never touches the queue endpoints.
 *   - `probeLoadBalancedHealth(profile: RunpodProfile, deps?: TransportDeps):
 *     Promise<"healthy" | "initializing" | "unhealthy">` — optional export;
 *     the health tests below are skipped when it is absent.
 *
 * Wire behavior (load-balanced endpoints only):
 *   - POST the normalized request itself (OpenAI-shaped JSON, NO `input`
 *     envelope — that is the queue wire format) directly to
 *     `profile.invokeUrl + profile.request.loadBalancedPath`;
 *   - stream responses are Server-Sent Events whose `data:` payloads are
 *     OpenAI chat-completion chunks; the text of each `choices[0].delta.content`
 *     is preserved as a `{ type: "text" }` event;
 *   - never call the queue-only endpoints (/run, /runsync, /status, /stream);
 *   - health probe: GET `invokeUrl + "/ping"`; 200 → "healthy",
 *     204 → "initializing", any other status → "unhealthy";
 *   - result details carry requestedMode/actualMode/downgrades and never the
 *     queue-only jobId, status, or depth fields.
 *
 * No real Runpod credentials are used: fetch is a recording mock per test.
 */
import { describe, expect, test } from "bun:test";

// Named import pins the required transport entry point (link-time failure if
// the module omits it). The namespace import exists solely so the optional
// health probe can be read as `undefined` and its tests skipped — a named
// import of a possibly-absent export would fail at load instead of skipping.
import { executeLoadBalancedTransport } from "../src/transport/load-balanced.js";
import * as lbTransport from "../src/transport/load-balanced.js";
import { isRetryableError } from "../src/transport/types.js";
import type { NormalizedRequest, RequestMode } from "../src/transport/types.js";

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
} as const;

/** Approved load-balanced profile shape (full schema with defaults applied). */
interface RunpodProfileFixture {
	endpointType: "load-balanced";
	invokeUrl: string;
	model: typeof MODEL;
	request: {
		mode: RequestMode;
		timeoutMs: number;
		polling: { intervalMs: number; ttlMs: number; focusAware: boolean };
		queueAdapter: { kind: "openai-shaped" | "messages-text" };
		loadBalancedPath: string;
	};
	policy: { maxAttempts: number; fallbackProfiles: string[] };
}

/** Build a load-balanced profile; overrides replace whole fields. */
function lbProfile(overrides: { mode?: RequestMode; loadBalancedPath?: string } = {}): RunpodProfileFixture {
	return {
		endpointType: "load-balanced",
		invokeUrl: "https://ep-lb.api.runpod.ai",
		model: MODEL,
		request: {
			mode: overrides.mode ?? "sync",
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" },
			loadBalancedPath: overrides.loadBalancedPath ?? "/v1/chat/completions",
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
			{ role: "user", content: "Explain load-balanced endpoints." },
		],
		stream: false,
		temperature: 0.2,
		maxTokens: 256,
		...overrides,
	};
}

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

describe("executeLoadBalancedTransport", () => {
	const LB_URL = "https://ep-lb.api.runpod.ai/v1/chat/completions";

	test("posts the normalized OpenAI JSON directly to invokeUrl + loadBalancedPath", async () => {
		const completion = {
			id: "chatcmpl-1",
			model: "runpod/llama-3-8b",
			choices: [
				{ index: 0, message: { role: "assistant", content: "Hello from Runpod" }, finish_reason: "stop" },
			],
			usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
		};
		const { calls, fetchMock } = recordingFetch(() => jsonResponse(completion));

		const request = requestFixture();
		const result = await executeLoadBalancedTransport(lbProfile(), request, { fetch: fetchMock });

		// Exactly one call, straight to the load-balanced path — no queue URLs.
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe(LB_URL);
		// The queue-only routes (/run, /runsync, /status, /stream) are never used.
		expect(call.url).not.toMatch(/\/(run|runsync|status|stream)(\?|$)/);
		expect(call.init?.method).toBe("POST");
		expect(new Headers(call.init?.headers).get("content-type")).toContain("application/json");

		// The body IS the normalized OpenAI JSON — no `input` envelope (queue-only).
		expect(JSON.parse(call.init!.body as string)).toEqual(request);

		expect(result.response).toEqual({
			text: "Hello from Runpod",
			usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
			downgrades: [],
		});
		expect(result.events).toEqual([]);
	});

	test("uses the profile's configured loadBalancedPath", async () => {
		const { calls, fetchMock } = recordingFetch(() =>
			jsonResponse({ choices: [{ message: { content: "ok" } }] }),
		);

		await executeLoadBalancedTransport(
			lbProfile({ loadBalancedPath: "/v1/completions" }),
			requestFixture(),
			{ fetch: fetchMock },
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://ep-lb.api.runpod.ai/v1/completions");
	});

	test("preserves SSE text data events from the load-balanced path", async () => {
		const sseBody = [
			'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}',
			"",
			'data: {"choices":[{"delta":{"content":" from"},"index":0}]}',
			"",
			'data: {"choices":[{"delta":{"content":" Runpod"},"index":0}]}',
			"",
		].join("\n");
		const { calls, fetchMock } = recordingFetch(
			() => new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		const streamRequest = requestFixture({ stream: true });
		const result = await executeLoadBalancedTransport(lbProfile({ mode: "stream" }), streamRequest, {
			fetch: fetchMock,
		});

		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe(LB_URL);
		expect(call.init?.method).toBe("POST");
		expect(JSON.parse(call.init!.body as string)).toEqual(streamRequest);

		// Every SSE data payload's delta content is preserved as a text event.
		expect(result.events).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " from" },
			{ type: "text", text: " Runpod" },
		]);
		expect(result.details).toEqual({ requestedMode: "stream", actualMode: "stream", downgrades: [] });
	});

	test("preserves SSE reasoning_content events ahead of text and aggregates them", async () => {
		const sseBody = [
			'data: {"choices":[{"delta":{"reasoning_content":"Let me"},"index":0}]}',
			"",
			'data: {"choices":[{"delta":{"reasoning_content":" think."},"index":0}]}',
			"",
			'data: {"choices":[{"delta":{"content":"Answer."},"index":0}]}',
			"",
		].join("\n");
		const { fetchMock } = recordingFetch(
			() => new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		const result = await executeLoadBalancedTransport(
			lbProfile({ mode: "stream" }),
			requestFixture({ stream: true }),
			{ fetch: fetchMock },
		);

		// Reasoning units and text units are each preserved as distinct events.
		expect(result.events).toEqual([
			{ type: "reasoning", text: "Let me" },
			{ type: "reasoning", text: " think." },
			{ type: "text", text: "Answer." },
		]);
		expect(result.response).toEqual({
			text: "Answer.",
			reasoning: "Let me think.",
			downgrades: [],
		});
	});

	test("decodes reasoning_content from a JSON completion body", async () => {
		const { fetchMock } = recordingFetch(() =>
			jsonResponse({
				choices: [{ message: { content: "Final", reasoning_content: "Hidden chain" } }],
			}),
		);

		const result = await executeLoadBalancedTransport(lbProfile(), requestFixture(), { fetch: fetchMock });

		expect(result.response).toEqual({
			text: "Final",
			reasoning: "Hidden chain",
			downgrades: [],
		});
	});

	test("details omit the queue-only jobId, status, and depth fields", async () => {
		const { fetchMock } = recordingFetch(() =>
			jsonResponse({ choices: [{ message: { content: "done" } }] }),
		);

		const result = await executeLoadBalancedTransport(lbProfile(), requestFixture(), { fetch: fetchMock });

		// Exact match: the three approved fields and nothing else.
		expect(result.details).toEqual({ requestedMode: "sync", actualMode: "sync", downgrades: [] });
		expect(result.details).not.toHaveProperty("jobId");
		expect(result.details).not.toHaveProperty("status");
		expect(result.details).not.toHaveProperty("depth");
	});

	test("marks HTTP 5xx failures as transient (retryable)", async () => {
		const { fetchMock } = recordingFetch(() =>
			jsonResponse({ error: { message: "Bad Gateway" } }, 502),
		);

		const error = await executeLoadBalancedTransport(lbProfile(), requestFixture(), {
			fetch: fetchMock,
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("HTTP 502");
		expect(isRetryableError(error)).toBe(true);
	});

	test("leaves deterministic HTTP 4xx failures non-retryable", async () => {
		const { fetchMock } = recordingFetch(() =>
			jsonResponse({ error: { message: "Bad Request" } }, 400),
		);

		const error = await executeLoadBalancedTransport(lbProfile(), requestFixture(), {
			fetch: fetchMock,
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("HTTP 400");
		expect(isRetryableError(error)).toBe(false);
	});
});

/** Optional per the plan: probe tests are skipped when the export is absent. */
const healthProbe = lbTransport.probeLoadBalancedHealth;

describe.skipIf(healthProbe === undefined)("probeLoadBalancedHealth", () => {
	const probe = healthProbe;
	const PING_URL = "https://ep-lb.api.runpod.ai/ping";

	test("maps HTTP 200 to healthy", async () => {
		const { calls, fetchMock } = recordingFetch(() => new Response("ok", { status: 200 }));

		await expect(probe(lbProfile(), { fetch: fetchMock })).resolves.toBe("healthy");

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(PING_URL);
		// GET by default: a correct implementation may omit init entirely.
		expect(calls[0]!.init?.method ?? "GET").toBe("GET");
	});

	test("maps HTTP 204 to initializing", async () => {
		const { fetchMock } = recordingFetch(() => new Response(null, { status: 204 }));

		await expect(probe(lbProfile(), { fetch: fetchMock })).resolves.toBe("initializing");
	});

	test("maps any other status to unhealthy", async () => {
		const { calls, fetchMock } = recordingFetch(() => new Response("boom", { status: 500 }));

		await expect(probe(lbProfile(), { fetch: fetchMock })).resolves.toBe("unhealthy");

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(PING_URL);
	});
});

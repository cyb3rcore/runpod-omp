/**
 * Contract tests for the default provider stream dispatch (test-first, per
 * the approved plan).
 *
 * These tests fail today because the module they import does not exist yet.
 * Implement the following contract to make them pass:
 *
 * src/provider.ts
 *   - a focused exported builder `createRunpodStream(profiles, deps)` that
 *     returns the OMP `streamSimple`-shaped function
 *     `(model, context, options?) => AssistantMessageEventStream`. It must be
 *     supplied the injectable functions `deps.executeQueue`,
 *     `deps.executeLoadBalanced`, and `deps.resolveApiKey`:
 *       - `executeQueue(profile, request, deps?)` /
 *         `executeLoadBalanced(profile, request, deps?)` where `deps` carries
 *         `{ apiKey?: string; signal?: AbortSignal }` — the resolved key and
 *         the caller's signal forwarded to the transport layer (mirrors
 *         `TransportDeps.apiKey`/`TransportDeps.signal`);
 *       - `resolveApiKey(options, profile)` resolving the effective key in
 *         production precedence (caller key → profile reference → default).
 *     `createRunpodStream` returns a REAL `AssistantMessageEventStream`
 *     (from `@oh-my-pi/pi-ai`), never a plain value or a synchronous throw.
 *
 * Dispatch contract:
 *   - selects the profile strictly by `model.id` (own-key lookup only);
 *   - normalizes `Context` + `SimpleStreamOptions` into a
 *     `NormalizedRequest` (`model = profile.model.id`, messages mapped to
 *     system/user/assistant/tool, `stream = profile.request.mode ===
 *     "stream"`, plus `temperature`/`maxTokens` when the options carry them);
 *   - routes by `profile.endpointType`: `"queue"` → `executeQueue`,
 *     `"load-balanced"` → `executeLoadBalanced`;
 *   - `options.signal` reaches the transport (in the forwarded `deps.signal`);
 *   - replays the normalized text/usage into valid OMP events and a terminal
 *     `done` event whose message carries the assistant text and the mapped
 *     usage (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`),
 *     stopping with `stopReason: "stop"`.
 *
 * Failure contract: unknown `model.id`, a key-resolution failure, and a
 * transport failure each FAIL the returned stream (via `stream.fail`) with
 * an explicit `Error` whose message surfaces the underlying cause (known
 * credential bytes replaced by `[redacted]`), never a synchronous throw
 * from `createRunpodStream`. Failures happen before any dispatch when they
 * precede it.
 *
 * No real Runpod credentials or network are used: the transports and key
 * resolver are recording mocks; the stream is consumed through the real
 * `AssistantMessageEventStream` async-iterator and `result()`.
 */
import { describe, expect, test } from "bun:test";

// Named import pins the required stream-builder entry point (link-time
// failure if the module omits it).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunpodStream, type RunpodStreamDeps } from "../src/provider.js";
import { createJournal } from "../src/journal.js";
import type { Profile } from "../src/profile-schema.js";
import { markRetryable } from "../src/transport/types.js";
import type {
	DowngradeRecord,
	NormalizedRequest,
	RequestMode,
	TransportExecutionResult,
} from "../src/transport/types.js";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";

/** Model metadata for the queue profile. */
const QUEUE_MODEL = {
	id: "meta-llama/llama-3.3-70b-instruct",
	name: "Llama 3.3 70B Instruct",
	contextWindow: 131_072,
	maxTokens: 8_192,
	reasoning: false,
	input: ["text"],
	supportsTools: true,
	supportsVision: false,
};

/** Model metadata for the load-balanced profile. */
const LB_MODEL = {
	id: "qwen/qwen3-32b",
	name: "Qwen3 32B",
	contextWindow: 262_144,
	maxTokens: 16_384,
	reasoning: true,
	input: ["text", "image"],
	supportsTools: true,
	supportsVision: true,
};

const QUEUE = "queue-profile";
const LB = "lb-profile";
const POD = "pod-profile";

/** Build a merged queue profile; overrides replace whole fields. */
function queueProfile(overrides: { mode?: RequestMode } = {}): Profile {
	return {
		endpointType: "queue",
		invokeUrl: "https://api.runpod.ai/v2/ep-queue",
		model: QUEUE_MODEL,
		apiKey: { kind: "secret-reference", ref: "env:RUNPOD_API_KEY", redacted: "[redacted]" },
		request: {
			mode: overrides.mode ?? "stream",
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" },
			loadBalancedPath: "/v1/chat/completions",
		},
		policy: { maxAttempts: 1, fallbackProfiles: [] },
	};
}

/** Build a merged pod profile (control-plane address resolution at call time). */
function podProfile(): Profile {
	return {
		endpointType: "pod",
		model: LB_MODEL,
		apiKey: { kind: "secret-reference", ref: "env:RUNPOD_API_KEY", redacted: "[redacted]" },
		request: {
			mode: "stream",
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" },
			loadBalancedPath: "/v1/chat/completions",
		},
		policy: { maxAttempts: 1, fallbackProfiles: [] },
		pod: { id: "pod_abc123", port: 8000 },
	};
}

/** Build a merged load-balanced profile (direct worker HTTP, no queue). */
function lbProfile(): Profile {
	return {
		endpointType: "load-balanced",
		invokeUrl: "https://lb.example.com",
		model: LB_MODEL,
		apiKey: { kind: "secret-reference", ref: "env:RUNPOD_API_KEY", redacted: "[redacted]" },
		request: {
			mode: "stream",
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" },
			loadBalancedPath: "/v1/chat/completions",
		},
		policy: { maxAttempts: 1, fallbackProfiles: [] },
	};
}

/** The profiles keyed by profile name — the map `createRunpodStream` dispatches over. */
const PROFILES: Record<string, Profile> = {
	[QUEUE]: queueProfile(),
	[LB]: lbProfile(),
	[POD]: podProfile(),
};

/** A conversation exercising every normalizeMessage role mapping. */
const FAKE_CONTEXT = {
	messages: [
		{ role: "user", content: "ping" },
		{ role: "assistant", content: [{ type: "text", text: "pong" }] },
		{ role: "developer", content: "be concise" },
		{
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "file contents" }],
		},
	],
} as unknown as Context;

const signal = new AbortController().signal;

/** Options carrying every field the request normalization and transport forward. */
const FAKE_OPTIONS = {
	apiKey: "test-key",
	temperature: 0.7,
	maxTokens: 64,
	signal,
} as unknown as SimpleStreamOptions;

/** The normalized request every queue test expects. */
function expectedRequest(modelId: string): NormalizedRequest {
	return {
		model: modelId,
		messages: [
			// The mid-conversation developer message is hoisted to a single
			// system message at index 0 (Qwen3 templates reject system
			// anywhere else); non-system messages keep their order.
			{ role: "system", content: "be concise" },
			{ role: "user", content: "ping" },
			{ role: "assistant", content: "pong" },
			{ role: "tool", content: "file contents", name: "read" },
		],
		stream: true,
		// Streamed responses omit usage unless explicitly requested.
		stream_options: { include_usage: true },
		temperature: 0.7,
		maxTokens: 64,
	};
}

/** Usage reported by the mocked transport, in transport vocabulary. */
const STREAM_USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/** A stream-mode transport result: two text chunks plus usage. */
const STREAM_RESULT: TransportExecutionResult = {
	events: [
		{ type: "text", text: "Hello" },
		{ type: "text", text: " world" },
		{ type: "usage", usage: STREAM_USAGE },
	],
	details: { requestedMode: "stream", actualMode: "stream", downgrades: [] as DowngradeRecord[] },
};

/** The transport deps the builder forwards to the injected dispatch functions. */
interface RunpodStreamTransportDeps {
	apiKey?: string;
	signal?: AbortSignal;
}

/** A recorded dispatch into the injected transport. */
interface RecordedDispatch {
	method: "queue" | "loadBalanced" | "pod";
	profile: Profile;
	request: NormalizedRequest;
	deps?: RunpodStreamTransportDeps;
}

/** A recorded key-resolution call. */
interface RecordedKeyCall {
	options: SimpleStreamOptions | undefined;
	profile: Profile;
}

/**
 * Injectable default-stream deps: records every dispatch/key call, returns a
 * fixed stream result, and lets a test override the queue/LB result or the
 * key resolver.
 */
function makeDeps(
	overrides: {
		queue?: () => TransportExecutionResult | Promise<TransportExecutionResult>;
		loadBalanced?: () => TransportExecutionResult | Promise<TransportExecutionResult>;
		pod?: () => TransportExecutionResult | Promise<TransportExecutionResult>;
		resolve?: () => string | undefined | Promise<string | undefined>;
	} = {},
) {
	const dispatches: RecordedDispatch[] = [];
	const keyCalls: RecordedKeyCall[] = [];
	const sleeps: number[] = [];
	const RESOLVED_KEY = "resolved-key-9f3a";
	const deps: RunpodStreamDeps = {
		executeQueue(profile: Profile, request: NormalizedRequest, d?: RunpodStreamTransportDeps) {
			dispatches.push({ method: "queue", profile, request, deps: d });
			return overrides.queue?.() ?? STREAM_RESULT;
		},
		executeLoadBalanced(profile: Profile, request: NormalizedRequest, d?: RunpodStreamTransportDeps) {
			dispatches.push({ method: "loadBalanced", profile, request, deps: d });
			return (
				overrides.loadBalanced?.() ?? {
					events: [{ type: "text", text: "LB reply" }],
					details: {
						requestedMode: "stream",
						actualMode: "stream",
						downgrades: [] as DowngradeRecord[],
					},
				}
			);
		},
		executePod(profile: Profile, request: NormalizedRequest, d?: RunpodStreamTransportDeps) {
			dispatches.push({ method: "pod", profile, request, deps: d });
			return (
				overrides.pod?.() ?? {
					events: [{ type: "text", text: "POD reply" }],
					details: {
						requestedMode: "stream",
						actualMode: "stream",
						downgrades: [] as DowngradeRecord[],
					},
				}
			);
		},
		resolveApiKey(options: SimpleStreamOptions | undefined, profile: Profile) {
			keyCalls.push({ options, profile });
			return overrides.resolve?.() ?? RESOLVED_KEY;
		},
		// Instant sleep so retry backoff never slows the tests; every
		// backoff wait is still recorded for assertions.
		sleep(ms: number) {
			sleeps.push(ms);
			return Promise.resolve();
		},
	};
	return {
		resolvedKey: RESOLVED_KEY,
		dispatches,
		keyCalls,
		sleeps,
		deps,
	};
}

/** Consume a real AssistantMessageEventStream end-to-end and capture every event. */
async function collect(
	stream: AssistantMessageEventStream,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

/** Await `stream.result()` and return the rejection, or throw on success. */
async function resultError(stream: AssistantMessageEventStream): Promise<unknown> {
	try {
		await stream.result();
	} catch (error) {
		return error;
	}
	throw new Error("expected the stream result to reject, but it resolved");
}

/** A minimal model id — the only field the dispatcher may read. */
function modelFor(profileName: string): { id: string } {
	return { id: profileName };
}

describe("createRunpodStream dispatch", () => {
	test("dispatches a queue profile to executeQueue with the normalized request", async () => {
		const mk = makeDeps();
		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);
		const profile = PROFILES[QUEUE]!;
		await stream.result();

		expect(mk.keyCalls).toHaveLength(1);
		expect(mk.keyCalls[0]!.options).toBe(FAKE_OPTIONS);
		expect(mk.keyCalls[0]!.profile).toBe(profile);

		expect(mk.dispatches).toHaveLength(1);
		const d = mk.dispatches[0]!;
		expect(d.method).toBe("queue");
		expect(d.profile).toBe(profile);
		expect(d.request).toEqual(expectedRequest(QUEUE_MODEL.id));
	});

	test("dispatches a load-balanced profile to executeLoadBalanced by model id", async () => {
		const mk = makeDeps();
		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(LB), FAKE_CONTEXT, FAKE_OPTIONS);
		const profile = PROFILES[LB]!;
		await stream.result();

		expect(mk.keyCalls).toHaveLength(1);
		expect(mk.keyCalls[0]!.profile).toBe(profile);

		expect(mk.dispatches).toHaveLength(1);
		const d = mk.dispatches[0]!;
		expect(d.method).toBe("loadBalanced");
		expect(d.profile).toBe(profile);
		expect(d.request.model).toBe(LB_MODEL.id);
		expect(d.request.stream).toBe(true);
	});

	test("forwards the resolved key and options.signal to the transport", async () => {
		const mk = makeDeps();
		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);
		await stream.result();

		const d = mk.dispatches[0]!;
		expect(d.deps?.apiKey).toBe(mk.resolvedKey);
		expect(d.deps?.signal).toBe(FAKE_OPTIONS.signal);
	});

	test("a non-stream profile sets stream:false and still replays its response", async () => {
		const qp = queueProfile({ mode: "sync" });
		const mk = makeDeps({
			queue: () => ({
				response: {
					text: "Full reply",
					usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
					downgrades: [] as DowngradeRecord[],
				},
				events: [],
				details: { requestedMode: "sync", actualMode: "sync", downgrades: [] as DowngradeRecord[] },
			}),
		});
		const stream = createRunpodStream({ [QUEUE]: qp }, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);

		const events = await collect(stream);
		expect(mk.dispatches[0]!.request.stream).toBe(false);

		const deltas = events.filter(
			(e): e is Extract<AssistantMessageEvent, { type: "text_delta" }> => e.type === "text_delta",
		);
		expect(deltas.map((d) => d.delta)).toEqual(["Full reply"]);

		const done = events.find(
			(e): e is Extract<AssistantMessageEvent, { type: "done" }> => e.type === "done",
		)!;
		expect(done.message.content).toEqual([{ type: "text", text: "Full reply" }]);
		expect(done.message.usage).toMatchObject({ input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 });
	});
});

describe("createRunpodStream event replay", () => {
	test("replays normalized text and usage into valid OMP events ending in done with stop", async () => {
		const mk = makeDeps();
		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);

		const events = await collect(stream);
		expect(events.map((e) => e.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);

		const deltas = events.filter(
			(e): e is Extract<AssistantMessageEvent, { type: "text_delta" }> => e.type === "text_delta",
		);
		expect(deltas.map((d) => d.delta)).toEqual(["Hello", " world"]);

		const starts = events.filter(
			(e): e is Extract<AssistantMessageEvent, { type: "text_start" }> => e.type === "text_start",
		);
		expect(starts.map((s) => s.contentIndex)).toEqual([0, 1]);

		const done = events.find(
			(e): e is Extract<AssistantMessageEvent, { type: "done" }> => e.type === "done",
		)!;
		expect(done.type).toBe("done");
		expect(done.reason).toBe("stop");
		expect(done.message.role).toBe("assistant");
		expect(done.message.stopReason).toBe("stop");
		expect(done.message.content).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
		]);
		expect(done.message.usage).toMatchObject({
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
		});

		// result() resolves to the same assistant message the done event carried.
		const result: AssistantMessage = await stream.result();
		expect(result).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
		});
		expect(result.content).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
		]);
	});
});

describe("createRunpodStream system-message normalization", () => {
	test("merges multiple system messages into one at index 0, preserving non-system order", async () => {
		const mk = makeDeps();
		const context = {
			messages: [
				{ role: "user", content: "q1" },
				{ role: "developer", content: "first instruction" },
				{ role: "assistant", content: "a1" },
				{ role: "developer", content: "second instruction" },
			],
		} as unknown as Context;

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), context, FAKE_OPTIONS);
		await stream.result();

		expect(mk.dispatches[0]!.request.messages).toEqual([
			{ role: "system", content: "first instruction\n\nsecond instruction" },
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
		]);
	});

	test("a conversation with no system messages is sent unchanged", async () => {
		const mk = makeDeps();
		const context = {
			messages: [{ role: "user", content: "q1" }],
		} as unknown as Context;

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), context, FAKE_OPTIONS);
		await stream.result();

		expect(mk.dispatches[0]!.request.messages).toEqual([{ role: "user", content: "q1" }]);
	});
});

describe("createRunpodStream reasoning replay", () => {
	test("response-mode reasoning replays as a thinking block before the text", async () => {
		const qp = queueProfile({ mode: "sync" });
		const mk = makeDeps({
			queue: () => ({
				response: {
					text: "Final answer",
					reasoning: "Let me think about this.",
					usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
					downgrades: [] as DowngradeRecord[],
				},
				events: [],
				details: { requestedMode: "sync", actualMode: "sync", downgrades: [] as DowngradeRecord[] },
			}),
		});

		const stream = createRunpodStream({ [QUEUE]: qp }, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);
		const events = await collect(stream);

		expect(events.map((e) => e.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);

		const thinking = events.find(
			(e): e is Extract<AssistantMessageEvent, { type: "thinking_end" }> => e.type === "thinking_end",
		)!;
		expect(thinking.contentIndex).toBe(0);
		expect(thinking.content).toBe("Let me think about this.");

		const textStart = events.find(
			(e): e is Extract<AssistantMessageEvent, { type: "text_start" }> => e.type === "text_start",
		)!;
		expect(textStart.contentIndex).toBe(1);

		const done = events.find(
			(e): e is Extract<AssistantMessageEvent, { type: "done" }> => e.type === "done",
		)!;
		expect(done.message.content).toEqual([
			{ type: "thinking", thinking: "Let me think about this." },
			{ type: "text", text: "Final answer" },
		]);
		expect(done.message.usage).toMatchObject({ input: 3, output: 2, totalTokens: 5 });
	});

	test("streamed reasoning events accumulate into the thinking block", async () => {
		const mk = makeDeps({
			queue: () => ({
				events: [
					{ type: "reasoning", text: "Step one. " },
					{ type: "reasoning", text: "Step two." },
					{ type: "text", text: "Answer." },
					{ type: "usage", usage: STREAM_USAGE },
				],
				details: {
					requestedMode: "stream",
					actualMode: "stream",
					downgrades: [] as DowngradeRecord[],
				},
			}),
		});

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);
		const events = await collect(stream);

		const thinking = events.find(
			(e): e is Extract<AssistantMessageEvent, { type: "thinking_end" }> => e.type === "thinking_end",
		)!;
		expect(thinking.content).toBe("Step one. Step two.");

		const textDeltas = events
			.filter((e): e is Extract<AssistantMessageEvent, { type: "text_delta" }> => e.type === "text_delta")
			.map((d) => d.delta);
		expect(textDeltas).toEqual(["Answer."]);

		const done = events.find(
			(e): e is Extract<AssistantMessageEvent, { type: "done" }> => e.type === "done",
		)!;
		expect(done.message.content).toEqual([
			{ type: "thinking", thinking: "Step one. Step two." },
			{ type: "text", text: "Answer." },
		]);
	});
});

describe("createRunpodStream retry & fallback", () => {
	test("retries a transient failure up to policy.maxAttempts, then succeeds", async () => {
		let failures = 2;
		const mk = makeDeps({
			queue: () => {
				if (failures-- > 0) {
					return Promise.reject(markRetryable(new Error("Load-balanced request failed: HTTP 502 Bad Gateway")));
				}
				return STREAM_RESULT;
			},
		});
		const qp = queueProfile();
		qp.policy.maxAttempts = 3;

		const stream = createRunpodStream({ [QUEUE]: qp }, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);
		const events = await collect(stream);

		// Two failed attempts + one success; backoff ran between attempts.
		expect(mk.dispatches).toHaveLength(3);
		expect(mk.sleeps).toEqual([1000, 1000]);
		const done = events.find(
			(e): e is Extract<AssistantMessageEvent, { type: "done" }> => e.type === "done",
		)!;
		expect(done.message.content).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
		]);
	});

	test("does not retry a deterministic (non-retryable) failure", async () => {
		const mk = makeDeps({
			queue: () => Promise.reject(new Error("Load-balanced request failed: HTTP 400 Bad Request")),
		});
		const qp = queueProfile();
		qp.policy.maxAttempts = 3;

		const stream = createRunpodStream({ [QUEUE]: qp }, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);
		const error = await resultError(stream);

		expect(mk.dispatches).toHaveLength(1);
		expect(mk.sleeps).toEqual([]);
		expect((error as Error).message).toContain("HTTP 400");
	});

	test("the default maxAttempts of 1 means no retry", async () => {
		const mk = makeDeps({
			queue: () => Promise.reject(markRetryable(new Error("Load-balanced request failed: HTTP 503"))),
		});

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);
		const error = await resultError(stream);

		expect(mk.dispatches).toHaveLength(1);
		expect(mk.sleeps).toEqual([]);
		expect((error as Error).message).toContain("HTTP 503");
	});

	test("falls back to a named profile after the primary exhausts retries", async () => {
		const mk = makeDeps({
			queue: () => Promise.reject(markRetryable(new Error("Load-balanced request failed: HTTP 502"))),
		});
		const qp = queueProfile();
		qp.policy.fallbackProfiles = [LB];
		const profiles: Record<string, Profile> = { [QUEUE]: qp, [LB]: lbProfile() };

		const stream = createRunpodStream(profiles, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);
		const events = await collect(stream);

		// Primary once (maxAttempts 1) then the fallback once; backoff before
		// the fallback; the fallback's own key is resolved and its request
		// rebuilt with its model id.
		expect(mk.dispatches.map((d) => d.method)).toEqual(["queue", "loadBalanced"]);
		expect(mk.dispatches[1]!.profile).toBe(profiles[LB]);
		expect(mk.dispatches[1]!.request.model).toBe(LB_MODEL.id);
		expect(mk.keyCalls.map((k) => k.profile)).toEqual([profiles[QUEUE], profiles[LB]]);
		expect(mk.sleeps).toEqual([1000]);
		const done = events.find(
			(e): e is Extract<AssistantMessageEvent, { type: "done" }> => e.type === "done",
		)!;
		expect(done.message.content).toEqual([{ type: "text", text: "LB reply" }]);
	});

	test("surfaces the last error when the primary and all fallbacks fail", async () => {
		const mk = makeDeps({
			queue: () => Promise.reject(markRetryable(new Error("primary 502"))),
			loadBalanced: () => Promise.reject(markRetryable(new Error("fallback 503"))),
		});
		const qp = queueProfile();
		qp.policy.fallbackProfiles = [LB];
		const profiles: Record<string, Profile> = { [QUEUE]: qp, [LB]: lbProfile() };

		const stream = createRunpodStream(profiles, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);
		const error = await resultError(stream);

		expect(mk.dispatches.map((d) => d.method)).toEqual(["queue", "loadBalanced"]);
		expect((error as Error).message).toContain("fallback 503");
	});

	test("sends the profile maxTokens when the caller passes none", async () => {
		const mk = makeDeps();
		const options = { temperature: 0.2, signal } as unknown as SimpleStreamOptions;

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, options);
		await stream.result();

		expect(mk.dispatches[0]!.request.maxTokens).toBe(QUEUE_MODEL.maxTokens);
	});
});

describe("createRunpodStream tool calling", () => {
	test("forwards context.tools as OpenAI function definitions", async () => {
		const mk = makeDeps();
		const tool = {
			name: "bash",
			description: "Run a shell command",
			parameters: { type: "object", properties: { command: { type: "string" } } },
		};
		const context = {
			messages: [{ role: "user", content: "list files" }],
			tools: [tool],
		} as unknown as Context;

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), context, FAKE_OPTIONS);
		await stream.result();

		expect(mk.dispatches[0]!.request.tools).toEqual([
			{ type: "function", function: tool },
		]);
	});

	test("strips grammar-unsafe pattern/format keywords from forwarded tool schemas", async () => {
		const mk = makeDeps();
		const tool = {
			name: "mcp__runpod_get_capacity",
			description: "Check GPU capacity",
			parameters: {
				type: "object",
				properties: {
					cudaVersions: {
						type: "array",
						items: { type: "string", pattern: "^\\d{1,2}\\.\\d{1,2}$" },
					},
					since: { type: "string", format: "date-time" },
					limit: { type: "integer", minimum: 1, maximum: 100 },
				},
			},
		};
		const context = {
			messages: [{ role: "user", content: "check capacity" }],
			tools: [tool],
		} as unknown as Context;

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), context, FAKE_OPTIONS);
		await stream.result();

		// The regex-ish keywords that break llama.cpp's grammar converter are
		// gone at every nesting level; structural constraints stay.
		expect(mk.dispatches[0]!.request.tools).toEqual([
			{
				type: "function",
				function: {
					name: "mcp__runpod_get_capacity",
					description: "Check GPU capacity",
					parameters: {
						type: "object",
						properties: {
							cudaVersions: { type: "array", items: { type: "string" } },
							since: { type: "string" },
							limit: { type: "integer", minimum: 1, maximum: 100 },
						},
					},
				},
			},
		]);
	});

	test("round-trips assistant tool calls into wire tool_calls", async () => {
		const mk = makeDeps();
		const context = {
			messages: [
				{ role: "user", content: "list files" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "" },
						{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
					],
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "a.txt" }],
				},
			],
		} as unknown as Context;

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), context, FAKE_OPTIONS);
		await stream.result();

		const request = mk.dispatches[0]!.request;
		expect(request.messages[1]).toEqual({
			role: "assistant",
			content: "",
			toolCalls: [{ id: "call_1", name: "bash", argumentsJson: '{"command":"ls"}' }],
		});
		expect(request.messages[2]).toEqual({ role: "tool", content: "a.txt", name: "bash" });
	});

	test("replays response tool calls as toolcall events with toolUse stop reason", async () => {
		const qp = queueProfile({ mode: "sync" });
		const mk = makeDeps({
			queue: () => ({
				response: {
					text: "",
					toolCalls: [{ id: "call_9", name: "bash", argumentsJson: '{"command":"ls"}' }],
					usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
					downgrades: [] as DowngradeRecord[],
				},
				events: [],
				details: { requestedMode: "sync", actualMode: "sync", downgrades: [] as DowngradeRecord[] },
			}),
		});

		const stream = createRunpodStream({ [QUEUE]: qp }, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);
		const events = await collect(stream);

		expect(events.map((e) => e.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);

		const end = events.find(
			(e): e is Extract<AssistantMessageEvent, { type: "toolcall_end" }> => e.type === "toolcall_end",
		)!;
		expect(end.contentIndex).toBe(0);
		expect(end.toolCall).toEqual({
			type: "toolCall",
			id: "call_9",
			name: "bash",
			arguments: { command: "ls" },
		});

		const done = events.find(
			(e): e is Extract<AssistantMessageEvent, { type: "done" }> => e.type === "done",
		)!;
		expect(done.reason).toBe("toolUse");
		expect(done.message.content).toEqual([
			{ type: "toolCall", id: "call_9", name: "bash", arguments: { command: "ls" } },
		]);
		expect(done.message.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
	});

	test("replays streamed toolcall events ahead of the done event", async () => {
		const mk = makeDeps({
			queue: () => ({
				events: [
					{ type: "toolcall", call: { id: "call_7", name: "read", argumentsJson: '{"path":"a"}' } },
					{ type: "usage", usage: STREAM_USAGE },
				],
				details: {
					requestedMode: "stream",
					actualMode: "stream",
					downgrades: [] as DowngradeRecord[],
				},
			}),
		});

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);
		const events = await collect(stream);

		expect(events.map((e) => e.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		const done = events.find(
			(e): e is Extract<AssistantMessageEvent, { type: "done" }> => e.type === "done",
		)!;
		expect(done.reason).toBe("toolUse");
	});
});

describe("createRunpodStream journal", () => {
	test("journals the dispatch lifecycle when deps provide a journal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runpod-journal-"));
		const journalPath = join(dir, "journal.jsonl");
		const mk = makeDeps();
		mk.deps.journal = createJournal(journalPath);

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);
		await stream.result();

		const lines = readFileSync(journalPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines.map((line) => line.kind)).toEqual(["dispatch", "dispatch-done", "replay-done"]);
		expect(lines[0]).toMatchObject({
			model: QUEUE,
			profile: QUEUE_MODEL.id,
			attempt: 1,
			candidate: QUEUE_MODEL.id,
		});
		expect(lines[0].request).toMatchObject({ messages: 4, tools: 0, stream: true, maxTokens: 64 });
		expect(typeof lines[1].durationMs).toBe("number");
		expect(lines[1].response).toMatchObject({ textChars: 11 });
	});

	test("journals dispatch errors and the surfaced failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runpod-journal-"));
		const journalPath = join(dir, "journal.jsonl");
		const mk = makeDeps({
			queue: () => Promise.reject(markRetryable(new Error("Load-balanced request failed: HTTP 502"))),
		});
		mk.deps.journal = createJournal(journalPath);

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);
		await resultError(stream);

		const lines = readFileSync(journalPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines.map((line) => line.kind)).toEqual(["dispatch", "dispatch-error", "failed"]);
		expect(lines[1].error).toMatchObject({ message: expect.stringContaining("HTTP 502") });
		expect(lines[2].error).toMatchObject({
			message: expect.stringContaining("request failed: Load-balanced request failed: HTTP 502"),
		});
	});
});

describe("createRunpodStream failures", () => {
	test("fails the returned stream with an explicit error for an unknown model id", async () => {
		const mk = makeDeps();
		const UNKNOWN = "ghost-profile";

		// The builder returns a failed stream rather than throwing synchronously.
		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(UNKNOWN), FAKE_CONTEXT, FAKE_OPTIONS);

		const error = await resultError(stream);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("unknown model id");
		expect((error as Error).message).not.toContain(UNKNOWN);
		expect(mk.dispatches).toHaveLength(0);
		expect(mk.keyCalls).toHaveLength(0);
	});

	test("a key-resolution failure fails the stream with the resolver's explicit error and dispatches nothing", async () => {
		const SECRET = "wipe-the-earth-token-123";
		// The production resolver already builds secret-free errors; the mock
		// mirrors that shape so the surfaced message stays meaningful.
		const mk = makeDeps({
			resolve: () => {
				throw new Error(
					"no apiKey source: profile has no apiKey reference, OMP key, or RUNPOD_API_KEY (redacted)",
				);
			},
		});

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);

		const error = await resultError(stream);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("no apiKey source");
		expect((error as Error).message).toContain("redacted");
		expect((error as Error).message).not.toContain(SECRET);
		expect(mk.dispatches).toHaveLength(0);
	});

	test("a transport rejection fails the stream with the transport's explicit error", async () => {
		const RAW = "connection refused to runpod worker";
		const mk = makeDeps({ queue: () => Promise.reject(new Error(RAW)) });

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);

		const error = await resultError(stream);
		expect(error).toBeInstanceOf(Error);
		// The surfaced message is the actionable transport error, not a marker.
		expect((error as Error).message).toContain(RAW);
	});

	test("a transport error echoing the resolved key has those bytes redacted", async () => {
		const mk = makeDeps({
			queue: () => Promise.reject(new Error(`worker rejected: ${mk.resolvedKey}`)),
		});

		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(QUEUE), FAKE_CONTEXT, FAKE_OPTIONS);

		const error = await resultError(stream);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("worker rejected: [redacted]");
		expect(message).not.toContain(mk.resolvedKey);
	});
});

describe("createRunpodStream pod dispatch", () => {
	test("dispatches a pod profile to executePod with the normalized request and resolved key", async () => {
		const mk = makeDeps();
		const stream = createRunpodStream(PROFILES, mk.deps)(modelFor(POD), FAKE_CONTEXT, FAKE_OPTIONS);

		const events = await collect(stream);

		const dispatch = mk.dispatches[0]!;
		expect(dispatch.method).toBe("pod");
		expect(dispatch.profile.endpointType).toBe("pod");
		expect(dispatch.request).toEqual(expectedRequest(PROFILES[POD]!.model.id));
		expect(dispatch.deps?.apiKey).toBe(mk.resolvedKey);
		expect(dispatch.deps?.signal).toBe(signal);
		const done = events.find(
			(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
		);
		expect(done?.message.content).toEqual([{ type: "text", text: "POD reply" }]);
	});

	test("falls back from a transient pod failure to the named fallback profile", async () => {
		const queueWithFallback: Profile = {
			...podProfile(),
			policy: { maxAttempts: 1, fallbackProfiles: [QUEUE] },
		};
		const profiles = { ...PROFILES, [POD]: queueWithFallback };
		const mk = makeDeps({
			pod: () => {
				throw markRetryable(new Error("pod worker transient failure"));
			},
		});
		const stream = createRunpodStream(profiles, mk.deps)(modelFor(POD), FAKE_CONTEXT, FAKE_OPTIONS);

		const events = await collect(stream);

		expect(mk.dispatches.map((dispatch) => dispatch.method)).toEqual(["pod", "queue"]);
		const done = events.find(
			(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
		);
		expect(done?.message.content).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
		]);
	});

	test("a deterministic pod failure surfaces immediately without fallback", async () => {
		const podWithFallback: Profile = {
			...podProfile(),
			policy: { maxAttempts: 1, fallbackProfiles: [QUEUE] },
		};
		const profiles = { ...PROFILES, [POD]: podWithFallback };
		const mk = makeDeps({
			pod: () => {
				throw new Error("runpod provider: pod pod_abc123 is EXITED — start it with /runpod pod start");
			},
		});
		const stream = createRunpodStream(profiles, mk.deps)(modelFor(POD), FAKE_CONTEXT, FAKE_OPTIONS);

		const error = await resultError(stream);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("pod_abc123 is EXITED");
		expect(mk.dispatches.map((dispatch) => dispatch.method)).toEqual(["pod"]);
	});
});

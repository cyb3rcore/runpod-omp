/**
 * Contract for the real provider transport wiring.
 *
 * Calling `registerRunpodProvider(pi, profiles)` must wire `streamSimple` to
 * the real transports — `createRunpodStream` over `executeQueueTransport` /
 * `executeLoadBalancedTransport` and
 * `resolveProfileApiKey(profile, { ompApiKey, env, runCommand })`. The
 * factory's ordinary call path performs REAL transport dispatch, so a
 * selected profile actually reaches a Runpod endpoint through the mocked
 * HTTP layer.
 *
 * No real Runpod endpoint or credential is used: fetch is a recording mock
 * installed on `defaultTransportDeps.fetch` (the only transport dependency
 * the wiring does not override — the wired transports forward only the
 * resolved key and signal), and `RUNPOD_API_KEY` is pinned/recovered so key
 * resolution and the Authorization header are deterministic.
 */
import { afterAll, describe, expect, test } from "bun:test";

// Named imports pin the required entry points (link-time failure if a module
// omits them).
import { registerRunpodProvider } from "../src/provider.js";
import { defaultTransportDeps } from "../src/transport/types.js";
import type { Profile } from "../src/profile-schema.js";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";

const QUEUE_PROFILE_NAME = "queue-profile";
const LB_PROFILE_NAME = "lb-profile";

// The default wiring resolves the profile's `env:RUNPOD_API_KEY` reference
// from the environment; pin the variable so the Authorization header and the
// key-redaction assertions are deterministic.
const API_TOKEN = "test-runpod-key-secret-9182";
const PREV_RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
process.env.RUNPOD_API_KEY = API_TOKEN;

/** The production fetch the default transports fall back to (restored after). */
const PREV_DEFAULT_FETCH = defaultTransportDeps.fetch;
afterAll(() => {
	defaultTransportDeps.fetch = PREV_DEFAULT_FETCH;
	if (PREV_RUNPOD_API_KEY === undefined) {
		delete process.env.RUNPOD_API_KEY;
	} else {
		process.env.RUNPOD_API_KEY = PREV_RUNPOD_API_KEY;
	}
});

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

/** A merged profile routed through the managed-queue transport (sync). */
function queueProfile(): Profile {
	return {
		endpointType: "queue",
		invokeUrl: "https://api.runpod.ai/v2/ep-queue",
		model: QUEUE_MODEL,
		apiKey: { kind: "secret-reference", ref: "env:RUNPOD_API_KEY", redacted: "[redacted]" },
		request: {
			mode: "sync",
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" },
			loadBalancedPath: "/v1/chat/completions",
		},
		policy: { maxAttempts: 1, fallbackProfiles: [] },
	};
}

/** A merged profile routed directly to the worker (no queue semantics). */
function lbProfile(): Profile {
	return {
		endpointType: "load-balanced",
		invokeUrl: "https://lb.example.com",
		model: LB_MODEL,
		apiKey: { kind: "secret-reference", ref: "env:RUNPOD_API_KEY", redacted: "[redacted]" },
		request: {
			mode: "sync",
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" },
			loadBalancedPath: "/v1/chat/completions",
		},
		policy: { maxAttempts: 1, fallbackProfiles: [] },
	};
}

/** A deterministic ExtensionAPI stand-in that records provider registrations. */
function mockPi(): {
	pi: ExtensionAPI;
	registrations: Array<{ name: string; config: ProviderConfig }>;
} {
	const registrations: Array<{ name: string; config: ProviderConfig }> = [];
	const pi = {
		registerProvider(name: string, config: ProviderConfig): void {
			registrations.push({ name, config });
		},
	} as unknown as ExtensionAPI;
	return { pi, registrations };
}

type StreamSimple = NonNullable<ProviderConfig["streamSimple"]>;

/** A model whose id is the profile name — all the dispatcher is allowed to read. */
function modelFor(profileName: string): { id: string } {
	return { id: profileName };
}

/** A minimal conversation; the dispatcher normalizes it into the request body. */
const FAKE_CONTEXT = {
	messages: [{ role: "user", content: "ping" }],
} as unknown as Context;

/**
 * Options with no `apiKey`: the key must come from the environment
 * (`env:RUNPOD_API_KEY`) so we can prove it reaches the Authorization header
 * and never leaks into the assistant/error output.
 */
const FAKE_OPTIONS = {} as SimpleStreamOptions;

/** OpenAI-shaped completion the worker returns for a completed job. */
const COMPLETION = {
	id: "chatcmpl-default-1",
	model: "meta-llama/llama-3.3-70b-instruct",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "Hello from Runpod" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
};

/** A recorded fetch invocation. */
interface FetchCall {
	url: string;
	init: RequestInit | undefined;
}

/**
 * Install a recording fetch as the transport's production default
 * (`defaultTransportDeps.fetch` — the dependency the wired transports do not
 * override). Every call is recorded; `respond` builds the Response.
 */
function installFetch(respond: (call: FetchCall) => Response): { calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	defaultTransportDeps.fetch = async (input, init) => {
		const call: FetchCall = { url: String(input), init };
		calls.push(call);
		return respond(call);
	};
	return { calls };
}

/** JSON-body response helper. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Consume a real AssistantMessageEventStream end-to-end and capture every event. */
async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

/** The terminal message carried by the `done` event. */
function doneMessage(events: AssistantMessageEvent[]): AssistantMessage {
	const done = events.find((event) => event.type === "done");
	if (done === undefined || done.type !== "done") {
		throw new Error("expected a terminal done event, but the stream ended without one");
	}
	return done.message;
}

/** Concatenate the plain-text blocks of an assistant message. */
function messageText(message: AssistantMessage): string {
	return message.content
		.filter((block) => "text" in block && typeof (block as { text?: unknown }).text === "string")
		.map((block) => (block as { text: string }).text)
		.join("");
}

describe("registerRunpodProvider default transport wiring", () => {
	test("wires the default queue transport: /runsync?wait=300000, bearer auth, completed OpenAI job", async () => {
		const profile = queueProfile();
		const { calls } = installFetch(() =>
			jsonResponse({ id: "job-default-queue", status: "COMPLETED", output: COMPLETION }),
		);

		const { pi, registrations } = mockPi();
		registerRunpodProvider(pi, { [QUEUE_PROFILE_NAME]: profile });

		// Ordinary factory call path.
		const streamSimple = registrations[0]!.config.streamSimple! as StreamSimple;
		const stream = streamSimple(
			modelFor(QUEUE_PROFILE_NAME),
			FAKE_CONTEXT,
			FAKE_OPTIONS,
		) as AssistantMessageEventStream;

		const events = await collect(stream);

		// One real queue dispatch: a single POST to /runsync with the resolved key.
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe(`${profile.invokeUrl}/runsync?wait=300000`);
		expect(call.init?.method).toBe("POST");
		const headers = new Headers(call.init?.headers);
		expect(headers.get("content-type")).toContain("application/json");
		expect(headers.get("authorization")).toBe(`Bearer ${API_TOKEN}`);
		// The queue wire body is the adapter envelope: the normalized request
		// under `input`; a sync profile sets stream:false, and the profile's
		// maxTokens is always sent (bounds generation even without options).
		const expectedRequest = {
			model: profile.model.id,
			messages: [{ role: "user", content: "ping" }],
			stream: false,
			maxTokens: profile.model.maxTokens,
		};
		expect(JSON.parse(call.init!.body as string)).toEqual({ input: expectedRequest });

		// Real event replay: start → text triple → done.
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		const message = doneMessage(events);
		expect(message.role).toBe("assistant");
		expect(messageText(message)).toBe("Hello from Runpod");
		expect(message.stopReason).toBe("stop");
		expect(message.model).toBe(profile.model.id);
		// done usage maps the wire prompt/completion/total tokens.
		expect(message.usage).toMatchObject({ input: 12, output: 5, totalTokens: 17 });

		// The resolved key reaches auth but never leaks into the assistant/error output.
		expect(JSON.stringify(events)).not.toContain(API_TOKEN);
		expect(JSON.stringify(message)).not.toContain(API_TOKEN);
	});

	test("wires the default load-balanced transport: direct request, no queue routes", async () => {
		const lb = lbProfile();
		const { calls } = installFetch(() => jsonResponse(COMPLETION));

		const { pi, registrations } = mockPi();
		registerRunpodProvider(pi, { [LB_PROFILE_NAME]: lb });

		const streamSimple = registrations[0]!.config.streamSimple! as StreamSimple;
		const stream = streamSimple(
			modelFor(LB_PROFILE_NAME),
			FAKE_CONTEXT,
			FAKE_OPTIONS,
		) as AssistantMessageEventStream;

		const events = await collect(stream);

		// One direct HTTP request to invokeUrl + loadBalancedPath — no queue routes.
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe(`${lb.invokeUrl}/v1/chat/completions`);
		expect(call.init?.method).toBe("POST");
		const headers = new Headers(call.init?.headers);
		expect(headers.get("content-type")).toContain("application/json");
		expect(headers.get("authorization")).toBe(`Bearer ${API_TOKEN}`);
		// The LB wire posts the normalized request directly — NOT under an
		// `{ input }` queue envelope; maxTokens defaults to the profile's.
		const expectedRequest = {
			model: lb.model.id,
			messages: [{ role: "user", content: "ping" }],
			stream: false,
			maxTokens: lb.model.maxTokens,
		};
		expect(JSON.parse(call.init!.body as string)).toEqual(expectedRequest);

		const message = doneMessage(events);
		expect(messageText(message)).toBe("Hello from Runpod");
		expect(message.stopReason).toBe("stop");
		expect(message.usage).toMatchObject({ input: 12, output: 5, totalTokens: 17 });

		expect(JSON.stringify(events)).not.toContain(API_TOKEN);
		expect(JSON.stringify(message)).not.toContain(API_TOKEN);
	});
});

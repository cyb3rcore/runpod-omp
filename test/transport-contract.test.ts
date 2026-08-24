/**
 * Transport adapter contract tests (test-first, per the approved plan).
 *
 * These tests fail today because the modules they import do not exist yet.
 * Implement the following contract to make them pass:
 *
 * src/transport/types.ts
 *   - `RequestMode`: "sync" | "async" | "stream"
 *   - `NormalizedMessage`: { role: "system" | "user" | "assistant" | "tool";
 *     content: string; name?: string }
 *   - `NormalizedRequest`: { model: string; messages: NormalizedMessage[];
 *     stream: boolean; temperature?: number; maxTokens?: number }
 *   - `NormalizedUsage`: { inputTokens: number; outputTokens: number;
 *     totalTokens: number }
 *   - `DowngradeRecord`: { requested: RequestMode; actual: RequestMode;
 *     reason?: string }
 *   - `NormalizedStreamEvent`: discriminated union
 *       | { type: "text"; text: string }
 *       | { type: "tool"; name: string; argumentsJson?: string; result?: string }
 *       | { type: "usage"; usage: NormalizedUsage }
 *       | { type: "downgrade"; record: DowngradeRecord }
 *   - `NormalizedResponse`: { text: string; usage?: NormalizedUsage;
 *     downgrades: DowngradeRecord[] }
 *   - `UnsupportedOutputShapeError`: Error subclass whose message names the
 *     expected shape (used by both decoders).
 *
 * src/adapters/openai-shaped.ts
 *   - `encodeOpenAiShaped(request: NormalizedRequest): { input: NormalizedRequest }`
 *     — the whole normalized request under `input`, content unchanged, no
 *     extra keys.
 *   - `decodeOpenAiShaped(output: unknown): NormalizedResponse` — accepts an
 *     OpenAI chat-completion object (the worker's output value, NOT the job
 *     status envelope): text from `choices[0].message.content`, usage mapped
 *     prompt_tokens/completion_tokens/total_tokens → inputTokens/outputTokens/
 *     totalTokens. Anything else throws `UnsupportedOutputShapeError`.
 *
 * src/adapters/messages-text.ts
 *   - `encodeMessagesText(request: NormalizedRequest):
 *     { input: { messages: NormalizedMessage[]; text: string } }` — `text` is
 *     the content of the latest user message; throws an explicit Error
 *     mentioning "user message" when none exists.
 *   - `decodeMessagesText(output: unknown): NormalizedResponse` — accepts a
 *     plain string. Anything else throws `UnsupportedOutputShapeError`.
 *
 * Decoders never guess: an unrecognized output shape is an explicit error.
 */
import { describe, expect, test } from "bun:test";

import { decodeOpenAiShaped, encodeOpenAiShaped } from "../src/adapters/openai-shaped";
import { decodeMessagesText, encodeMessagesText } from "../src/adapters/messages-text";
import { UnsupportedOutputShapeError } from "../src/transport/types";
import type {
	DowngradeRecord,
	NormalizedMessage,
	NormalizedRequest,
	NormalizedResponse,
	NormalizedStreamEvent,
	NormalizedUsage,
	RequestMode,
} from "../src/transport/types";

describe("openai-shaped adapter", () => {
	test("encodeOpenAiShaped wraps the normalized request under input unchanged", () => {
		const request: NormalizedRequest = {
			model: "runpod/llama-3-8b",
			stream: true,
			temperature: 0.2,
			maxTokens: 256,
			messages: [
				{ role: "system", content: "You are terse." },
				{ role: "user", content: "Explain queue endpoints." },
			],
		};

		const payload = encodeOpenAiShaped(request);

		// The payload is exactly { input }, nothing added.
		expect(Object.keys(payload)).toEqual(["input"]);
		// The wrapped request is content-identical to the input request.
		expect(payload.input).toEqual(request);
	});

	test("decodeOpenAiShaped decodes an OpenAI chat completion into a normalized response", () => {
		const completion = {
			id: "chatcmpl-123",
			model: "runpod/llama-3-8b",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "Hello from Runpod" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
		};

		expect(decodeOpenAiShaped(completion)).toEqual({
			text: "Hello from Runpod",
			usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
			downgrades: [],
		});
	});

	test("decodeOpenAiShaped preserves llama.cpp prompt-cache hits as cacheReadTokens", () => {
		const completion = {
			choices: [{ message: { role: "assistant", content: "cached answer" } }],
			usage: {
				prompt_tokens: 12,
				completion_tokens: 5,
				total_tokens: 17,
				prompt_tokens_details: { cached_tokens: 7 },
			},
		};

		expect(decodeOpenAiShaped(completion).usage).toEqual({
			inputTokens: 12,
			outputTokens: 5,
			totalTokens: 17,
			cacheReadTokens: 7,
		});
	});

	test("decodeOpenAiShaped omits cacheReadTokens when the wire reports no cache details", () => {
		const completion = {
			choices: [{ message: { role: "assistant", content: "no cache" } }],
			usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
		};

		const usage = decodeOpenAiShaped(completion).usage;
		expect(usage).toEqual({ inputTokens: 4, outputTokens: 3, totalTokens: 7 });
		expect(Object.keys(usage!)).toEqual(["inputTokens", "outputTokens", "totalTokens"]);
	});

	test("decodeOpenAiShaped rejects non-OpenAI output shapes with an explicit error", () => {
		for (const bad of [{ foo: "bar" }, { choices: [] }, null]) {
			let thrown: unknown;
			try {
				decodeOpenAiShaped(bad);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(UnsupportedOutputShapeError);
			const message = (thrown as Error).message;
			// The error names the expected shape instead of guessing at the value.
			expect(message).toMatch(/OpenAI/);
			expect(message).toMatch(/choices/);
		}
	});
});

describe("messages-text adapter", () => {
	test("encodeMessagesText emits input.messages plus the latest user text", () => {
		const request: NormalizedRequest = {
			model: "runpod/llama-3-8b",
			stream: false,
			messages: [
				{ role: "system", content: "You are terse." },
				{ role: "user", content: "First question" },
				{ role: "assistant", content: "First answer" },
				{ role: "user", content: "Second question" },
			],
		};

		const payload = encodeMessagesText(request);

		expect(Object.keys(payload)).toEqual(["input"]);
		expect(Object.keys(payload.input).sort()).toEqual(["messages", "text"]);
		expect(payload.input.messages).toEqual(request.messages);
		expect(payload.input.text).toBe("Second question");
	});

	test("encodeMessagesText uses the latest USER message even when a later message follows", () => {
		const request: NormalizedRequest = {
			model: "runpod/llama-3-8b",
			stream: false,
			messages: [
				{ role: "user", content: "only question" },
				{ role: "assistant", content: "answer after the user" },
			],
		};

		expect(encodeMessagesText(request).input.text).toBe("only question");
	});

	test("encodeMessagesText throws an explicit error when no user message exists", () => {
		const request: NormalizedRequest = {
			model: "runpod/llama-3-8b",
			stream: false,
			messages: [
				{ role: "system", content: "system preamble" },
				{ role: "assistant", content: "unsolicited answer" },
			],
		};

		expect(() => encodeMessagesText(request)).toThrow(/user message/i);
	});

	test("decodeMessagesText decodes a plain-text output", () => {
		expect(decodeMessagesText("plain result")).toEqual({
			text: "plain result",
			downgrades: [],
		});
	});

	test("decodeMessagesText rejects non-string outputs with an explicit error", () => {
		for (const bad of [{ output: "wrapped in an object" }, 42]) {
			let thrown: unknown;
			try {
				decodeMessagesText(bad);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(UnsupportedOutputShapeError);
			expect((thrown as Error).message).toMatch(/string/);
		}
	});
});

describe("transport types", () => {
	test("normalized stream events preserve text, tool, and usage output", () => {
		const usage: NormalizedUsage = { inputTokens: 40, outputTokens: 12, totalTokens: 52 };
		const events = [
			{ type: "text", text: "first chunk" },
			{ type: "tool", name: "read_file", argumentsJson: '{"path":"src/a.ts"}', result: "file contents" },
			{ type: "text", text: "second chunk" },
			{ type: "usage", usage },
			{ type: "downgrade", record: { requested: "stream", actual: "sync", reason: "endpoint does not stream" } },
		] satisfies NormalizedStreamEvent[];

		expect(events[0]).toEqual({ type: "text", text: "first chunk" });
		expect(Object.keys(events[0]).sort()).toEqual(["text", "type"]);

		expect(events[1]).toEqual({
			type: "tool",
			name: "read_file",
			argumentsJson: '{"path":"src/a.ts"}',
			result: "file contents",
		});
		expect(Object.keys(events[1]).sort()).toEqual(["argumentsJson", "name", "result", "type"]);

		expect(events[2]).toEqual({ type: "text", text: "second chunk" });

		expect(events[3]).toEqual({ type: "usage", usage });
		expect(Object.keys(events[3]).sort()).toEqual(["type", "usage"]);
		expect(Object.keys(events[3].usage).sort()).toEqual(["inputTokens", "outputTokens", "totalTokens"]);

		expect(events[4]).toEqual({
			type: "downgrade",
			record: { requested: "stream", actual: "sync", reason: "endpoint does not stream" },
		});
		expect(Object.keys(events[4]).sort()).toEqual(["record", "type"]);
	});

	test("downgrade records carry requested and actual modes", () => {
		const requestedMode: RequestMode = "stream";
		const actualMode: RequestMode = "async";
		const record: DowngradeRecord = {
			requested: requestedMode,
			actual: actualMode,
			reason: "queue endpoint exposes /status, not /stream",
		};

		expect(record.requested).toBe("stream");
		expect(record.actual).toBe("async");
		expect(record.reason).toBe("queue endpoint exposes /status, not /stream");

		// Downgrade records survive on the normalized response.
		const response: NormalizedResponse = { text: "done", downgrades: [record] };
		const [downgrade] = response.downgrades;
		expect(downgrade).toBeDefined();
		expect(downgrade!.requested).toBe("stream");
		expect(downgrade!.actual).toBe("async");
	});
});

// Compile-time witness: the request fixtures above stay assignable to the
// normalized message shape the transports consume.
const _messageShape: NormalizedMessage = { role: "user", content: "witness" };

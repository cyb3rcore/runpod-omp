/**
 * Runpod OMP provider registration.
 *
 * Registers exactly one `runpod` provider in a single `registerProvider` call,
 * with one `ProviderModelConfig` per merged Runpod profile. A model's `id` is
 * its profile name (never the served model id), so selecting `runpod/<profile>`
 * in OMP's native model picker selects that profile.
 *
 * Every model shares the plugin-owned custom api id `runpod-queue`, which
 * labels the custom transport rather than implying queue semantics. A single
 * `streamSimple` dispatcher resolves the profile strictly by `model.id` and
 * routes the call to the real queue or load-balanced transport by
 * `profile.endpointType`. `pi.setModel` is never called here: model selection
 * stays with OMP.
 *
 * The provider-level `baseUrl` and `apiKey` are registration placeholders.
 * Dispatch never consults the base URL (each profile carries its own
 * `invokeUrl`), and OMP resolves the `RUNPOD_API_KEY` env-var reference into
 * the key delivered to `streamSimple` as `options.apiKey`, which the transport
 * layer uses to authenticate.
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	resolveApiKeyOnce,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Message,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import { resolveProfileApiKey } from "./config.js";
import type { Profile } from "./profile-schema.js";
import { executeLoadBalancedTransport } from "./transport/load-balanced.js";
import { executePodTransport } from "./transport/pod.js";
import { executeQueueTransport } from "./transport/queue.js";
import { isRetryableError } from "./transport/types.js";
import { createJournal, resolveJournalPath, type Journal } from "./journal.js";
import type {
	NormalizedMessage,
	NormalizedRequest,
	NormalizedToolCall,
	TransportExecutionResult,
} from "./transport/types.js";

/** Custom api id shared by every profile model; labels the plugin-owned transport. */
const RUNPOD_API_ID = "runpod-queue";

/**
 * Env-var reference installed at provider level. OMP resolves it through the
 * auth store and delivers the value to `streamSimple` as `options.apiKey`.
 */
const RUNPOD_API_KEY_REF = "RUNPOD_API_KEY";

/**
 * Provider-level baseUrl placeholder required for model registration. It is
 * never consulted by the dispatcher — routing comes from each profile's
 * `invokeUrl` — so it exists only to satisfy OMP's registration validation.
 */
const RUNPOD_PROVIDER_BASE_URL = "https://api.runpod.ai/v2/runpod-omp-placeholder";

/** Marker substituted for identity-bearing values in error messages. */
const REDACTED = "[redacted]";

/** Delay between retry/fallback dispatch attempts, in milliseconds. */
const RETRY_BACKOFF_MS = 1000;

/** Default async wait used by retry backoff when `deps.sleep` is absent. */
const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait `ms` for retry backoff, rejecting early when the caller's signal
 * aborts mid-wait so a cancelled turn never hangs on the backoff.
 */
function sleepWithAbort(
	sleep: (ms: number) => Promise<void>,
	ms: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (signal === undefined) {
		return sleep(ms);
	}
	if (signal.aborted) {
		return Promise.reject(new Error("runpod provider: dispatch aborted"));
	}
	return new Promise<void>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error("runpod provider: dispatch aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void sleep(ms).then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

/**
 * Build one registered model per merged profile. Model metadata is copied
 * verbatim from the profile; only the `id` is the profile name and `api` is
 * pinned to the plugin-owned custom api id.
 *
 * Model `compat` is intentionally omitted: for a custom api id,
 * `ProviderModelConfig["compat"]` resolves to `undefined` (`CompatConfigOf<Api>`
 * only matches the built-in wire APIs), and the compat vocabulary governs the
 * built-in transports this provider does not use — the custom transport owns
 * its wire semantics. Tool/vision capability stays on the profile
 * (`supportsTools`, `supportsVision`, and the `input` array, which is
 * schema-validated to "text"/"image" only) for the transport layer; there is
 * no supported `compat` field that carries them. No provider-level `compat`
 * exists on `ProviderConfig`, so none is set.
 */
function buildModels(profiles: Record<string, Profile>): ProviderModelConfig[] {
	const models: ProviderModelConfig[] = [];
	for (const [profileName, profile] of Object.entries(profiles)) {
		models.push({
			id: profileName,
			name: profile.model.name,
			api: RUNPOD_API_ID,
			reasoning: profile.model.reasoning,
			// Profile schema validates every entry as "text" or "image".
			input: profile.model.input as ("text" | "image")[],
			// OMP requires a structural per-million-token cost; Runpod
			// serverless is time-billed, so zeros state the truth (real cost
			// surfaces live in `/runpod cost` and the status line).
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: profile.model.contextWindow,
			maxTokens: profile.model.maxTokens,
		});
	}
	return models;
}

/** Extract the plain-text projection of a message's content blocks. */
function extractMessageText(content: string | readonly unknown[]): string {
	if (typeof content === "string") {
		return content;
	}
	const blocks: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			blocks.push(part);
		} else if (part !== null && typeof part === "object") {
			const candidate = part as { type?: unknown; text?: unknown };
			if (candidate.type === "text" && typeof candidate.text === "string") {
				blocks.push(candidate.text);
			}
		}
	}
	return blocks.join("\n");
}

/**
 * Map one OMP message to the transport's normalized role/content vocabulary.
 * Image parts are the wiring module's concern; tool-call parts on assistant
 * messages serialize as OpenAI `message.tool_calls` so the Qwen3 template can
 * accept the following `tool`-role result.
 */
function normalizeMessage(message: Message): NormalizedMessage {
	switch (message.role) {
		case "user":
		case "developer":
			return {
				role: message.role === "developer" ? "system" : "user",
				content: extractMessageText(message.content),
			};
		case "assistant": {
			const normalized: NormalizedMessage = {
				role: "assistant",
				content: extractMessageText(message.content),
			};
			const toolCalls = extractToolCalls(message.content);
			if (toolCalls.length > 0) {
				normalized.toolCalls = toolCalls;
			}
			return normalized;
		}
		case "toolResult":
			return { role: "tool", content: extractMessageText(message.content), name: message.toolName };
		default: {
			// Every Message role is handled above, so `message` is `never` here;
			// binding it (not a property of it) keeps the exhaustiveness check.
			const exhaustive: never = message;
			throw new Error(`runpod provider: unsupported message role ${String(exhaustive)}`);
		}
	}
}

/**
 * Extract OpenAI-shaped tool calls from an assistant message's content
 * blocks: each `{type: "toolCall", id, name, arguments}` block becomes a
 * normalized call whose arguments are JSON-stringified for the wire.
 */
function extractToolCalls(content: string | readonly unknown[]): NormalizedToolCall[] {
	if (typeof content === "string") {
		return [];
	}
	const calls: NormalizedToolCall[] = [];
	for (const part of content) {
		if (part === null || typeof part !== "object") {
			continue;
		}
		const candidate = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
		if (
			candidate.type === "toolCall" &&
			typeof candidate.id === "string" &&
			candidate.id.length > 0 &&
			typeof candidate.name === "string" &&
			candidate.name.length > 0
		) {
			const args = candidate.arguments;
			calls.push({
				id: candidate.id,
				name: candidate.name,
				argumentsJson:
					args !== undefined && typeof args === "object" && args !== null
						? JSON.stringify(args)
						: "{}",
			});
		}
	}
	return calls;
}

/**
 * Build the normalized request handed to a transport: the served model id
 * from the profile, the text projection of the conversation, and the
 * stream/sampling preferences. `stream` mirrors the profile's declared mode;
 * the transport decides how to honor it.
 *
 * System messages are hoisted and merged into a single message at index 0:
 * strict chat templates (e.g. llama.cpp's Qwen3 template) reject a system
 * message anywhere but the first position with a 500, and OMP legitimately
 * injects developer-role messages mid-conversation (turn reminders,
 * compaction notes, interjections). Content is preserved — the instructions
 * still reach the model, just earlier in context — and no non-system message
 * changes position.
 */
function buildNormalizedRequest(
	profile: Profile,
	context: Context,
	options: SimpleStreamOptions | undefined,
): NormalizedRequest {
	const request: NormalizedRequest = {
		model: profile.model.id,
		messages: hoistSystemMessages(context.messages.map(normalizeMessage)),
		stream: profile.request.mode === "stream",
	};
	if (options?.temperature !== undefined) {
		request.temperature = options.temperature;
	}
	// Always bound the generation: the profile's ceiling applies when the
	// caller does not pass one, so a runaway (or zombie, post-abort) task
	// cannot burn the slot unbounded.
	request.maxTokens = options?.maxTokens ?? profile.model.maxTokens;
	// Streamed responses omit the usage object unless it is explicitly
	// requested (OpenAI spec; llama.cpp honors stream_options) — without
	// this the turn would show no per-turn token counts.
	if (request.stream) {
		request.stream_options = { include_usage: true };
	}
	// Forward OMP's function-tool catalog so the worker can offer tool
	// calling; absent when the context carries no tools. Schemas are
	// sanitized: llama.cpp's JSON-schema→grammar converter passes regex-ish
	// keywords (`pattern`, `format`) through into the GBNF grammar, whose
	// parser rejects escapes like `\d` — one such schema fails the whole
	// request at sampler init. OMP still validates arguments locally against
	// the original schema, so dropping them on the wire loses no safety.
	const allowed = profile.request.toolAllowlist;
	const tools =
		context.tools !== undefined && context.tools.length > 0
			? allowed !== undefined && allowed.length > 0
				? context.tools.filter((tool) => allowed.includes(tool.name))
				: context.tools
			: undefined;
	if (tools !== undefined && tools.length > 0) {
		request.tools = tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: sanitizeToolSchema(tool.parameters),
			},
		}));
	}
	return request;
}

/**
 * Return a deep copy of a JSON-Schema object with grammar-unsafe constraint
 * keywords (`pattern`, `format`) removed at every level. Anything that is
 * not a plain object or array passes through unchanged.
 */
function sanitizeToolSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) {
		return schema.map(sanitizeToolSchema);
	}
	if (typeof schema !== "object" || schema === null) {
		return schema;
	}
	const record = schema as Record<string, unknown>;
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		// Only the JSON-Schema constraint keywords are grammar-unsafe. A
		// property that merely shares the name — e.g. the grep tool's
		// required `pattern` string property — is a schema object (or other
		// non-string) and must be forwarded intact, or the model emits the
		// call without it and OMP's local validation rejects it.
		if ((key === "pattern" || key === "format") && typeof value === "string") {
			continue;
		}
		cleaned[key] = sanitizeToolSchema(value);
	}
	return cleaned;
}

/**
 * Reorder normalized messages for chat templates that require a single
 * system message at the very beginning: every system message is joined into
 * one (in original relative order) and placed at index 0; all non-system
 * messages keep their relative order. No message content is dropped; when
 * there is no system message the array is returned unchanged.
 */
function hoistSystemMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
	const systemParts: string[] = [];
	const rest: NormalizedMessage[] = [];
	for (const message of messages) {
		if (message.role === "system") {
			systemParts.push(message.content);
		} else {
			rest.push(message);
		}
	}
	if (systemParts.length === 0) {
		return messages;
	}
	return [{ role: "system", content: systemParts.join("\n\n") }, ...rest];
}

/**
 * The default stream builder's injectable surface: the queue/load-balanced
 * transports and the key resolver, supplied by tests (recording mocks) or a
 * production wiring module. `executeQueue`/`executeLoadBalanced` forward the
 * resolved key and the caller's signal (mirroring `TransportDeps.apiKey` /
 * `TransportDeps.signal`) so transports can authenticate and honor aborts.
 */
export interface RunpodStreamDeps {
	executeQueue(
		profile: Profile,
		request: NormalizedRequest,
		deps?: RunpodStreamTransportDeps,
	): TransportExecutionResult | Promise<TransportExecutionResult>;
	executePod(
		profile: Profile,
		request: NormalizedRequest,
		deps?: RunpodStreamTransportDeps,
	): TransportExecutionResult | Promise<TransportExecutionResult>;
	executeLoadBalanced(
		profile: Profile,
		request: NormalizedRequest,
		deps?: RunpodStreamTransportDeps,
	): TransportExecutionResult | Promise<TransportExecutionResult>;
	resolveApiKey(
		options: SimpleStreamOptions | undefined,
		profile: Profile,
	): string | undefined | Promise<string | undefined>;
	/** Async wait used by retry backoff; defaults to a setTimeout-based sleep. */
	sleep?: (ms: number) => Promise<void>;
	/** Per-request journal; defaults to the env-configured journal. */
	journal?: Journal;
}

/** Transport deps forwarded from the stream builder. */
export interface RunpodStreamTransportDeps {
	apiKey?: string;
	signal?: AbortSignal;
}

/**
 * Surface a failed stream as an explicit error: the underlying cause's
 * message — transports and the key resolver build actionable, secret-free
 * messages — with any known credential bytes (the OMP-provided or resolved
 * API key) replaced by the `REDACTED` marker. The original error survives
 * as `cause`; an empty or unusable message degrades to the marker so the
 * surfaced error is never blank.
 */
function surfaceRunpodError(cause: unknown, secrets: readonly (string | undefined)[]): Error {
	const message = `runpod provider: request failed: ${errorText(cause, secrets)}`;
	return new Error(message, { cause });
}

/** Extract a usable message from a thrown value, redacting known secrets. */
function errorText(cause: unknown, secrets: readonly (string | undefined)[]): string {
	let text =
		cause instanceof Error && cause.message.length > 0
			? cause.message
			: typeof cause === "string" && cause.length > 0
				? cause
				: "unknown error";
	for (const secret of secrets) {
		if (secret !== undefined && secret.length >= 8) {
			text = text.split(secret).join(REDACTED);
		}
	}
	if (text.trim() === "" || text === REDACTED) {
		return REDACTED;
	}
	// The unknown-model-id error already carries the provider prefix; avoid
	// the doubled "runpod provider: runpod provider: …" phrasing.
	return text.replace(/^runpod provider: /, "");
}

/** Journal helper: summarize a normalized request without its message bodies. */
function requestSummary(request: NormalizedRequest): Record<string, unknown> {
	return {
		messages: request.messages.length,
		tools: request.tools?.length ?? 0,
		...(request.tools !== undefined && request.tools.length > 0
			? { toolNames: request.tools.map((tool) => tool.function.name) }
			: {}),
		...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
		stream: request.stream,
	};
}

/** Journal helper: summarize a transport result (lengths, calls, usage). */
function responseSummary(result: TransportExecutionResult): Record<string, unknown> {
	let textChars = 0;
	let reasoningChars = 0;
	let toolCalls = 0;
	let inputTokens: number | undefined;
	let outputTokens: number | undefined;
	let cacheReadTokens: number | undefined;
	if (result.response !== undefined) {
		textChars = result.response.text.length;
		reasoningChars = result.response.reasoning?.length ?? 0;
		toolCalls = result.response.toolCalls?.length ?? 0;
		inputTokens = result.response.usage?.inputTokens;
		outputTokens = result.response.usage?.outputTokens;
		cacheReadTokens = result.response.usage?.cacheReadTokens;
	} else {
		for (const event of result.events) {
			if (event.type === "text") {
				textChars += event.text.length;
			} else if (event.type === "reasoning") {
				reasoningChars += event.text.length;
			} else if (event.type === "toolcall") {
				toolCalls += 1;
			} else if (event.type === "usage") {
				inputTokens = event.usage.inputTokens;
				outputTokens = event.usage.outputTokens;
				cacheReadTokens = event.usage.cacheReadTokens;
			}
		}
	}
	return {
		textChars,
		...(reasoningChars > 0 ? { reasoningChars } : {}),
		...(toolCalls > 0 ? { toolCalls } : {}),
		...(inputTokens !== undefined ? { inputTokens, outputTokens } : {}),
		...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
	};
}

/** Journal helper: message plus one level of cause, never credential bytes. */
function errorSummary(error: unknown): { message: string; cause?: string } {
	const summary: { message: string; cause?: string } = {
		message: error instanceof Error ? error.message : String(error),
	};
	if (error instanceof Error && error.cause instanceof Error) {
		summary.cause = error.cause.message;
	}
	return summary;
}

/**
 * Replay a normalized transport result as a valid OMP assistant event
 * sequence: a `start`, one thinking_start/thinking_delta/thinking_end triple
 * for the response's reasoning (when present), one
 * text_start/text_delta/text_end triple per text block, one
 * toolcall_start/toolcall_delta/toolcall_end triple per completed tool call
 * (when the worker chose to call tools), and a terminal `done` event whose
 * message carries the assembled content (thinking, then text, then tool-call
 * blocks), the mapped usage (`input`/`output`/`cacheRead`/`cacheWrite`/
 * `totalTokens`), and `stopReason` — `"toolUse"` when calls are present,
 * `"stop"` otherwise. Partial metadata always carries the provider
 * (`runpod`), model id, and API id so consumers can attribute the turn.
 */
function replayRunpodStream(
	stream: AssistantMessageEventStream,
	result: TransportExecutionResult,
	profile: Profile,
): void {
	// Ordered text blocks: a non-stream response yields its single text; a
	// streamed result yields each text unit (and its usage) in arrival order.
	const texts: string[] = [];
	const toolCalls: NormalizedToolCall[] = [];
	let reasoning = "";
	let inputTokens = 0;
	let outputTokens = 0;
	let totalTokens = 0;
	let cacheReadTokens: number | undefined;

	if (result.response !== undefined) {
		// Tool-calling turns carry empty content; an empty text never
		// produces a text block (the streamed path only emits non-empty
		// text events anyway).
		if (result.response.text.length > 0) {
			texts.push(result.response.text);
		}
		if (result.response.reasoning !== undefined) {
			reasoning = result.response.reasoning;
		}
		toolCalls.push(...(result.response.toolCalls ?? []));
		const usage = result.response.usage;
		if (usage !== undefined) {
			inputTokens = usage.inputTokens;
			outputTokens = usage.outputTokens;
			totalTokens = usage.totalTokens;
			cacheReadTokens = usage.cacheReadTokens;
		}
	} else {
		for (const event of result.events) {
			if (event.type === "text") {
				texts.push(event.text);
			} else if (event.type === "reasoning") {
				reasoning += event.text;
			} else if (event.type === "toolcall") {
				toolCalls.push(event.call);
			} else if (event.type === "usage") {
				inputTokens = event.usage.inputTokens;
				outputTokens = event.usage.outputTokens;
				totalTokens = event.usage.totalTokens;
				cacheReadTokens = event.usage.cacheReadTokens;
			}
		}
	}

	// Thinking precedes the answer, tool calls follow it; each block owns
	// its content index.
	const toolBlocks: ToolCall[] = toolCalls.map((call) => ({
		type: "toolCall",
		id: call.id,
		name: call.name,
		arguments: parseArguments(call.argumentsJson),
	}));
	const content: (ThinkingContent | TextContent | ToolCall)[] = [];
	if (reasoning.length > 0) {
		content.push({ type: "thinking", thinking: reasoning });
	}
	for (const text of texts) {
		content.push({ type: "text", text });
	}
	content.push(...toolBlocks);

	const partial: AssistantMessage = {
		role: "assistant",
		content,
		api: RUNPOD_API_ID,
		provider: "runpod",
		model: profile.model.id,
		usage: {
			input: inputTokens,
			output: outputTokens,
			cacheRead: cacheReadTokens ?? 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		// The direct (load-balanced/pod) transports measure the exchange span
		// and first-byte time; queue transports omit both, so the tooltip
		// keeps showing the rate/TTFT only where they are honest.
		...(result.durationMs !== undefined ? { duration: result.durationMs } : {}),
		...(result.ttftMs !== undefined ? { ttft: result.ttftMs } : {}),
	};

	stream.push({ type: "start", partial });

	let nextIndex = 0;
	if (reasoning.length > 0) {
		stream.push({ type: "thinking_start", contentIndex: 0, partial });
		stream.push({ type: "thinking_delta", contentIndex: 0, delta: reasoning, partial });
		stream.push({ type: "thinking_end", contentIndex: 0, content: reasoning, partial });
		nextIndex = 1;
	}
	texts.forEach((text, offset) => {
		const contentIndex = nextIndex + offset;
		stream.push({ type: "text_start", contentIndex, partial });
		stream.push({ type: "text_delta", contentIndex, delta: text, partial });
		stream.push({ type: "text_end", contentIndex, content: text, partial });
	});
	toolBlocks.forEach((toolCall, offset) => {
		const contentIndex = nextIndex + texts.length + offset;
		stream.push({ type: "toolcall_start", contentIndex, partial });
		stream.push({
			type: "toolcall_delta",
			contentIndex,
			delta: toolCalls[offset]!.argumentsJson,
			partial,
		});
		stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
	});

	stream.push({
		type: "done",
		reason: toolBlocks.length > 0 ? "toolUse" : "stop",
		message: partial,
	});
}

/** Parse a tool call's wire arguments JSON into a plain record; {} on any failure. */
function parseArguments(json: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(json);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * Build the OMP `streamSimple`-shaped default stream dispatcher for the given
 * merged profiles. This is the real stream path: it normalizes `Context` +
 * `SimpleStreamOptions` into a `NormalizedRequest`, resolves the effective
 * key, routes strictly by `profile.endpointType` to the injected transport,
 * and replays the normalized result as a valid assistant event sequence.
 *
 * It always returns a REAL `AssistantMessageEventStream` — never a plain
 * value or a synchronous throw. Unknown model ids, key-resolution failures,
 * and transport failures are each surfaced asynchronously via
 * `stream.fail(...)` with an explicit error (known credential bytes
 * redacted), and no dispatch happens before its preceding step has
 * succeeded. Profile lookup is an own-key read on the
 * `Record`; routing consumes only `profile.endpointType` and no provider-level
 * endpoint configuration.
 */
export function createRunpodStream(
	profiles: Record<string, Profile>,
	deps: RunpodStreamDeps,
): (
	model: { id: string },
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		void run();
		return stream;

		async function run(): Promise<void> {
			// Hoisted out of the try block so the catch can redact the
			// resolved key's bytes if a later step's error echoes them.
			let apiKey: string | undefined;
			try {
				// Own-key lookup strictly by model.id; never inherited keys.
				const profile = Object.hasOwn(profiles, model.id) ? profiles[model.id] : undefined;
				if (profile === undefined) {
					throw new Error(
						"runpod provider: unknown model id — no configured Runpod profile matches; run /runpod doctor to inspect the merged profile configuration",
					);
				}
				apiKey = await deps.resolveApiKey(options, profile);
				const baseDeps: RunpodStreamTransportDeps = {};
				if (apiKey !== undefined) {
					baseDeps.apiKey = apiKey;
				}
				if (options?.signal !== undefined) {
					baseDeps.signal = options.signal;
				}

				// Dispatch the primary profile up to `policy.maxAttempts`,
				// then each named fallback profile once. Only transient
				// failures (HTTP 5xx, network) retry or fall back — a
				// deterministic 4xx/shape/job error surfaces immediately, and
				// aborts/timeouts never retry. A backoff separates attempts.
				const journal = deps.journal;
				const maxAttempts = Math.max(1, profile.policy.maxAttempts);
				const fallbacks = profile.policy.fallbackProfiles.filter(
					(name) => Object.hasOwn(profiles, name) && name !== model.id,
				);
				const sleep = deps.sleep ?? defaultSleep;

				let dispatched = false;
				let lastError: unknown;
				for (let candidateIndex = 0; candidateIndex <= fallbacks.length && !dispatched; candidateIndex++) {
					const candidate =
						candidateIndex === 0 ? profile : profiles[fallbacks[candidateIndex - 1]!]!;
					const attempts = candidateIndex === 0 ? maxAttempts : 1;
					for (let attempt = 0; attempt < attempts && !dispatched; attempt++) {
						if (attempt > 0 || candidateIndex > 0) {
							await sleepWithAbort(sleep, RETRY_BACKOFF_MS, options?.signal);
						}
						const attemptStartedAt = Date.now();
						try {
							const candidateKey =
								candidateIndex === 0 ? apiKey : await deps.resolveApiKey(options, candidate);
							const candidateDeps: RunpodStreamTransportDeps = { ...baseDeps };
							if (candidateKey !== undefined) {
								candidateDeps.apiKey = candidateKey;
							}
							const request = buildNormalizedRequest(candidate, context, options);
							journal?.record({
								kind: "dispatch",
								ts: new Date().toISOString(),
								model: model.id,
								profile: candidate.model.id,
								attempt: attempt + 1,
								candidate: candidate.model.id,
								request: requestSummary(request),
							});
							let result: TransportExecutionResult;
							if (candidate.endpointType === "queue") {
								result = await deps.executeQueue(candidate, request, candidateDeps);
							} else if (candidate.endpointType === "pod") {
								result = await deps.executePod(candidate, request, candidateDeps);
							} else {
								result = await deps.executeLoadBalanced(candidate, request, candidateDeps);
							}
							journal?.record({
								kind: "dispatch-done",
								ts: new Date().toISOString(),
								model: model.id,
								profile: candidate.model.id,
								attempt: attempt + 1,
								candidate: candidate.model.id,
								durationMs: Date.now() - attemptStartedAt,
								...(result.durationMs !== undefined
									? { transportDurationMs: result.durationMs }
									: {}),
								...(result.ttftMs !== undefined ? { ttftMs: result.ttftMs } : {}),
								response: responseSummary(result),
							});
							replayRunpodStream(stream, result, candidate);
							journal?.record({
								kind: "replay-done",
								ts: new Date().toISOString(),
								model: model.id,
								profile: candidate.model.id,
								attempt: attempt + 1,
								candidate: candidate.model.id,
							});
							dispatched = true;
						} catch (error) {
							lastError = error;
							journal?.record({
								kind: "dispatch-error",
								ts: new Date().toISOString(),
								model: model.id,
								profile: candidate.model.id,
								attempt: attempt + 1,
								candidate: candidate.model.id,
								durationMs: Date.now() - attemptStartedAt,
								error: errorSummary(error),
							});
							if (!isRetryableError(error)) {
								throw error;
							}
						}
					}
				}
				if (!dispatched) {
					throw lastError ?? new Error("runpod provider: dispatch failed");
				}
			} catch (error) {
				// Only literal key bytes can be redacted; OMP also permits an
				// ApiKeyResolver function as options.apiKey, which carries no
				// secret material itself.
				const ompKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
				const surfaced = surfaceRunpodError(error, [ompKey, apiKey]);
				deps.journal?.record({
					kind: "failed",
					ts: new Date().toISOString(),
					model: model.id,
					error: errorSummary(surfaced),
				});
				stream.fail(surfaced);
			}
		}
	};
}

/**
 * Default production dependencies for createRunpodStream: the real queue and
 * load-balanced transports plus the profile key resolver. The resolver is fed
 * the OMP key (`options.apiKey`) ahead of the env fallback (`RUNPOD_API_KEY`)
 * and a local redacted shell runner for `!command` references, per the
 * resolver's documented precedence.
 */
function createDefaultStreamDeps(): RunpodStreamDeps {
	return {
		executeQueue: (profile, request, deps) => executeQueueTransport(profile, request, deps),
		executeLoadBalanced: (profile, request, deps) =>
			executeLoadBalancedTransport(profile, request, deps),
		executePod: (profile, request, deps) => executePodTransport(profile, request, deps),
		resolveApiKey: async (options, profile) => {
			const ompApiKey = await resolveApiKeyOnce(options?.apiKey, options?.signal);
			return resolveProfileApiKey(profile, {
				ompApiKey,
				env: process.env,
				runCommand: runCommandReference,
			});
		},
		sleep: defaultSleep,
		journal: createJournal(resolveJournalPath()),
	};
}

/**
 * Run a profile `!command` key reference through a local shell and capture
 * stdout. Resolves with the stdout for a successful invocation that produced
 * output; rejects with a generic error — never the command or its output — on
 * nonzero exit or empty output. `resolveProfileApiKey` catches any rejection
 * and rethrows a redacted error.
 */
function runCommandReference(command: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		execFile("/bin/sh", ["-c", command], (error, stdout) => {
			if (error) {
				reject(new Error("runpod provider: command reference failed to execute"));
				return;
			}
			if (stdout.trim() === "") {
				reject(new Error("runpod provider: command reference produced no output"));
				return;
			}
			resolve(stdout);
		});
	});
}

/**
 * Register the `runpod` provider. Exactly one `registerProvider` call happens;
 * an empty profile map still registers the provider once with no models.
 *
 * `streamSimple` wires to the real transports (`createRunpodStream` over
 * `executeQueueTransport` / `executeLoadBalancedTransport` and
 * `resolveProfileApiKey`), so dispatch actually reaches a Runpod endpoint.
 *
 * @param pi the extension API surface
 * @param profiles merged profile map (profile name → Profile)
 */
export function registerRunpodProvider(
	pi: ExtensionAPI,
	profiles: Record<string, Profile>,
): void {
	const models = buildModels(profiles);

	// Build the default stream dispatcher once, so every dispatch shares the
	// same transports, key resolver, and runner.
	const defaultStream = createRunpodStream(profiles, createDefaultStreamDeps());

	pi.registerProvider("runpod", {
		api: RUNPOD_API_ID,
		apiKey: RUNPOD_API_KEY_REF,
		baseUrl: RUNPOD_PROVIDER_BASE_URL,
		models,
		streamSimple: (model, context, options) => {
			// Always a REAL AssistantMessageEventStream: unknown ids,
			// key-resolution failures, and transport failures surface
			// asynchronously via stream.fail (explicit, secrets redacted).
			return defaultStream(model, context, options);
		},
	});
}

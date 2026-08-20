/**
 * OpenAI-shaped transport adapter for Runpod workers that expose an OpenAI
 * chat-completion protocol: the request is wrapped whole under `input`, and
 * the output is a completion object whose `choices[0].message.content` is the
 * assistant text, whose optional `choices[0].message.reasoning_content` is the
 * model's thinking (streamed models may emit it under
 * `choices[0].delta.reasoning_content`), whose optional
 * `choices[0].message.tool_calls` are the function calls the model chose, and
 * whose optional `usage` carries the token counts.
 */

import { UnsupportedOutputShapeError } from "../transport/types.js";
import type {
	NormalizedRequest,
	NormalizedResponse,
	NormalizedToolCall,
	NormalizedUsage,
} from "../transport/types.js";

const EXPECTED_SHAPE =
	"an OpenAI chat-completion object with a non-empty choices array, " +
	"a choices[0].message with string content and/or a tool_calls array, " +
	"and an optional usage object with numeric " +
	"prompt_tokens/completion_tokens/total_tokens";

/** Narrow unknown to a plain record; the parser boundary for wire data. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Encode a normalized request for an OpenAI-shaped worker: the whole request
 * goes under `input`, unchanged, with no extra keys.
 */
export function encodeOpenAiShaped(request: NormalizedRequest): { input: NormalizedRequest } {
	return { input: request };
}

/**
 * Decode an OpenAI chat-completion object (the worker's output value, not the
 * job-status envelope) into a normalized response. Anything that is not the
 * documented completion shape throws `UnsupportedOutputShapeError`.
 */
export function decodeOpenAiShaped(output: unknown): NormalizedResponse {
	if (!isRecord(output) || !Array.isArray(output.choices) || output.choices.length === 0) {
		throw new UnsupportedOutputShapeError(EXPECTED_SHAPE);
	}

	const choice = output.choices[0];
	if (!isRecord(choice) || !isRecord(choice.message)) {
		throw new UnsupportedOutputShapeError(EXPECTED_SHAPE);
	}

	// Tool-calling turns legitimately carry empty content; at least one of
	// content or tool_calls must be present.
	const toolCalls = parseToolCalls(choice.message.tool_calls);
	const content = choice.message.content;
	if (typeof content !== "string" && toolCalls.length === 0) {
		throw new UnsupportedOutputShapeError(EXPECTED_SHAPE);
	}

	const response: NormalizedResponse = {
		text: typeof content === "string" ? content : "",
		downgrades: [],
	};
	if (toolCalls.length > 0) {
		response.toolCalls = toolCalls;
	}

	// Thinking is optional: preserve it when the worker emits it separately.
	const reasoning = choice.message.reasoning_content;
	if (typeof reasoning === "string" && reasoning.length > 0) {
		response.reasoning = reasoning;
	}

	if (output.usage !== undefined) {
		if (!isRecord(output.usage)) {
			throw new UnsupportedOutputShapeError(EXPECTED_SHAPE);
		}
		const { prompt_tokens, completion_tokens, total_tokens } = output.usage;
		if (
			typeof prompt_tokens !== "number" ||
			typeof completion_tokens !== "number" ||
			typeof total_tokens !== "number"
		) {
			throw new UnsupportedOutputShapeError(EXPECTED_SHAPE);
		}
		const usage: NormalizedUsage = {
			inputTokens: prompt_tokens,
			outputTokens: completion_tokens,
			totalTokens: total_tokens,
		};
		response.usage = usage;
	}

	return response;
}

/**
 * Parse an OpenAI `message.tool_calls` array into normalized calls. Each item
 * is `{id, type, function: {name, arguments}}` with `arguments` as a JSON
 * string; malformed items are skipped, an empty result means no calls.
 */
function parseToolCalls(input: unknown): NormalizedToolCall[] {
	if (!Array.isArray(input)) {
		return [];
	}
	const calls: NormalizedToolCall[] = [];
	for (const item of input) {
		if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) {
			continue;
		}
		const fn = isRecord(item.function) ? item.function : undefined;
		if (fn === undefined || typeof fn.name !== "string" || fn.name.length === 0) {
			continue;
		}
		const argumentsJson = typeof fn.arguments === "string" ? fn.arguments : "";
		calls.push({ id: item.id, name: fn.name, argumentsJson });
	}
	return calls;
}

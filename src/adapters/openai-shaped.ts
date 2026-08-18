/**
 * OpenAI-shaped transport adapter for Runpod workers that expose an OpenAI
 * chat-completion protocol: the request is wrapped whole under `input`, and
 * the output is a completion object whose `choices[0].message.content` is the
 * assistant text and whose optional `usage` carries the token counts.
 */

import { UnsupportedOutputShapeError } from "../transport/types.js";
import type {
	NormalizedRequest,
	NormalizedResponse,
	NormalizedUsage,
} from "../transport/types.js";

const EXPECTED_SHAPE =
	"an OpenAI chat-completion object with a non-empty choices array, " +
	"string choices[0].message.content, and an optional usage object with " +
	"numeric prompt_tokens/completion_tokens/total_tokens";

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

	const content = choice.message.content;
	if (typeof content !== "string") {
		throw new UnsupportedOutputShapeError(EXPECTED_SHAPE);
	}

	const response: NormalizedResponse = { text: content, downgrades: [] };

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

/**
 * Plain-text transport adapter for Runpod workers that take the conversation
 * as `input.messages` plus the latest user text under `input.text`, and return
 * the assistant answer as a bare string.
 */

import { UnsupportedOutputShapeError } from "../transport/types.js";
import type {
	NormalizedMessage,
	NormalizedRequest,
	NormalizedResponse,
} from "../transport/types.js";

/**
 * Encode a normalized request for a text worker: the full message list under
 * `input.messages` plus the content of the latest user message under
 * `input.text`. Throws when the conversation has no user message.
 */
export function encodeMessagesText(
	request: NormalizedRequest,
): { input: { messages: NormalizedMessage[]; text: string } } {
	let latestUserText: string | undefined;
	for (const message of request.messages) {
		if (message.role === "user") {
			latestUserText = message.content;
		}
	}
	if (latestUserText === undefined) {
		throw new Error("encodeMessagesText: no user message found in the request");
	}

	return { input: { messages: request.messages, text: latestUserText } };
}

/**
 * Decode a plain-string worker output into a normalized response. Anything
 * that is not a string throws `UnsupportedOutputShapeError`.
 */
export function decodeMessagesText(output: unknown): NormalizedResponse {
	if (typeof output !== "string") {
		throw new UnsupportedOutputShapeError("a plain string");
	}

	return { text: output, downgrades: [] };
}

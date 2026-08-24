/**
 * Load-balanced transport for Runpod serverless endpoints.
 *
 * Load-balanced endpoints route HTTP requests straight to a worker path
 * (default `/v1/chat/completions`): there is no managed queue, so this
 * transport never calls the queue-only `/run`, `/runsync`, `/status`, or
 * `/stream` routes, and its result details never carry the queue-only
 * `jobId`, `status`, or `depth` fields. The normalized OpenAI Chat
 * completions request is POSTed directly (no `input` envelope — that is the
 * queue wire format) and the response is decoded with the openai-shaped
 * adapter (JSON) or parsed as Server-Sent Events (SSE): each `data:` frame's
 * `choices[0].delta.content` is preserved as a text event and its
 * `choices[0].delta.reasoning_content` as a reasoning event, both aggregated
 * into the response, `[DONE]` is ignored, and a chunk's usage is kept
 * when present.
 *
 * A load-balanced profile has a single wire behavior (one direct HTTP
 * request), so `requestedMode` always equals `actualMode` and downgrades
 * stay empty — there is no queue to fall back to.
 */

import { decodeOpenAiShaped } from "../adapters/openai-shaped.js";
import { isRecord, type Profile } from "../profile-schema.js";
import { UnsupportedOutputShapeError, defaultTransportDeps, markRetryable } from "./types.js";
import {
	resolveSecretRef,
	type NormalizedRequest,
	type NormalizedResponse,
	type NormalizedStreamEvent,
	type NormalizedToolCall,
	type NormalizedUsage,
	type RequestMode,
	type TransportDeps,
	type TransportExecutionResult,
} from "./types.js";

/** Health states mapped from the load-balanced `/ping` probe. */
export type LoadBalancedHealth = "healthy" | "initializing" | "unhealthy";

/** The wire shape the openai-shaped decoder expects (for non-JSON bodies). */
const EXPECTED_JSON_BODY = "an OpenAI chat-completion JSON body with a non-empty choices array";

/** Where a fetch failure happened, for explicit error messages. */
type FailurePhase = "request" | "response read";

/** Builds the explicit error for a failed phase, honoring abort/timeout first. */
type FailureFactory = (error: unknown, phase: FailurePhase) => Error;

/** Join an endpoint base and a path, tolerating slashes on either side. */
function joinUrl(base: string, path: string): string {
	const trimmedBase = base.replace(/\/+$/, "");
	if (path.length === 0) {
		return trimmedBase;
	}
	return path.startsWith("/") ? trimmedBase + path : `${trimmedBase}/${path}`;
}

/**
 * Resolve the bearer token with the same safe precedence as the queue
 * transport: a pre-resolved key from the caller (e.g. OMP's provider key or
 * a plugin-resolved command secret) first, then the profile's own secret
 * reference, then the `RUNPOD_API_KEY` default. A profile reference is
 * `env:NAME`, a bare environment-variable name (falling back to a literal
 * key when no such variable is set), or a `!command` reference — command
 * references cannot be executed inside a transport and fail explicitly; the
 * plugin resolves them and injects the value via `deps.apiKey`. Returns
 * undefined when nothing resolves so the call proceeds without an
 * Authorization header (an unauthenticated LB call surfaces an explicit
 * HTTP 401). Resolved key bytes never appear in error messages.
 */
function resolveBearerToken(profile: Profile, deps: TransportDeps): string | undefined {
	if (deps.apiKey !== undefined && deps.apiKey.length > 0) {
		return deps.apiKey;
	}
	const reference = profile.apiKey;
	if (reference !== undefined) {
		const resolved = resolveSecretRef(reference.ref, process.env);
		if (resolved !== undefined) {
			return resolved;
		}
	}
	const defaultKey =
		deps.noEnvKeyFallback === true ? undefined : process.env.RUNPOD_API_KEY;
	if (defaultKey !== undefined && defaultKey.length > 0) {
		return defaultKey;
	}
	return undefined;
}

/**
 * Build a request-scoped abort signal: the caller's signal (if any) plus a
 * hard timeout. Dispose clears the timer and listener as soon as the request
 * (and any body read) settles, so no resource outlives the call.
 */
function createAbortScope(
	timeoutMs: number,
	callerSignal: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const onAbort = (): void => controller.abort();
	if (callerSignal !== undefined) {
		if (callerSignal.aborted) {
			controller.abort();
		} else {
			callerSignal.addEventListener("abort", onAbort, { once: true });
		}
	}
	const timer =
		timeoutMs > 0
			? setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
			: undefined;
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			if (callerSignal !== undefined) {
				callerSignal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * Turn a thrown fetch/body error into an explicit one, preferring the most
 * actionable cause: a caller abort, then the request timeout, then the
 * underlying failure. Error text never includes resolved key material.
 * Network-level failures (the fallthrough path) are marked transient so the
 * provider can retry them; aborts and timeouts never are.
 */
function abortAwareError(
	error: unknown,
	phase: FailurePhase,
	timeoutMs: number,
	callerSignal: AbortSignal | undefined,
	scopeAborted: boolean,
): Error {
	if (callerSignal !== undefined && callerSignal.aborted) {
		return new Error("Load-balanced request aborted by the caller");
	}
	if (scopeAborted) {
		return new Error(`Load-balanced request timed out after ${timeoutMs} ms`);
	}
	if (error instanceof Error && error.name === "AbortError") {
		return new Error("Load-balanced request aborted");
	}
	const message = error instanceof Error ? error.message : String(error);
	return markRetryable(new Error(`Load-balanced ${phase} failed: ${message}`));
}

/**
 * Build an explicit error for a non-OK status. The message carries the
 * status and, when the error body is a JSON object with an `error.message`,
 * a truncated, control-character-stripped excerpt — never key material.
 * HTTP 5xx responses are marked transient (the LB returns them while
 * workers cold-start, route badly, or crash); 4xx are deterministic.
 */
async function httpError(response: Response): Promise<Error> {
	const statusText = response.statusText.length > 0 ? ` ${response.statusText}` : "";
	let detail = "";
	try {
		const body: unknown = await response.json();
		if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
			const message = body.error.message.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
			if (message.length > 0) {
				detail = `: ${message.slice(0, 200)}`;
			}
		}
	} catch {
		// Non-JSON or unreadable error bodies add no detail; the status suffices.
	}
	const error = new Error(`Load-balanced request failed: HTTP ${response.status}${statusText}${detail}`);
	return response.status >= 500 ? markRetryable(error) : error;
}

/**
 * Parse an SSE document into normalized text/reasoning/toolcall/usage events
 * plus the aggregated response. `data:` frames are JSON OpenAI
 * chat-completion chunks: `choices[0].delta.content` becomes a text event,
 * `choices[0].delta.reasoning_content` becomes a reasoning event (and the
 * response reasoning), `choices[0].delta.tool_calls` are accumulated by
 * index into completed calls (a call's `id`/`function.name` arrive on the
 * first fragment and `function.arguments` arrives split across fragments),
 * a chunk's usage becomes a usage event (and the response usage), and
 * `[DONE]` is ignored. Frames that are neither `[DONE]` nor valid JSON are
 * an explicit error — never guessed into a successful answer.
 */
function parseSse(bodyText: string): {
	events: NormalizedStreamEvent[];
	text: string;
	reasoning?: string;
	toolCalls?: NormalizedToolCall[];
	usage?: NormalizedUsage;
} {
	const events: NormalizedStreamEvent[] = [];
	let text = "";
	let reasoning = "";
	let usage: NormalizedUsage | undefined;
	let frame = "";
	let frameHasData = false;

	// Index-keyed tool-call fragments: id/name arrive on the first delta for
	// an index, arguments arrive split across subsequent deltas.
	const toolCallParts = new Map<number, { id?: string; name?: string; argumentsJson: string }>();

	const flushFrame = (): void => {
		if (!frameHasData) {
			return;
		}
		const payload = frame;
		frame = "";
		frameHasData = false;

		if (payload.trim() === "[DONE]") {
			return;
		}

		let chunk: unknown;
		try {
			chunk = JSON.parse(payload);
		} catch {
			throw new Error("Load-balanced stream: SSE data frame is not valid JSON");
		}

		if (isRecord(chunk)) {
			const rawChoices: unknown = chunk.choices;
			if (Array.isArray(rawChoices) && rawChoices.length > 0) {
				const choice: unknown = rawChoices[0];
				if (isRecord(choice)) {
					const delta: unknown = choice.delta;
					if (isRecord(delta)) {
						if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
							events.push({ type: "reasoning", text: delta.reasoning_content });
							reasoning += delta.reasoning_content;
						}
						if (typeof delta.content === "string" && delta.content.length > 0) {
							events.push({ type: "text", text: delta.content });
							text += delta.content;
						}
						accumulateToolCallFragments(delta.tool_calls, toolCallParts);
					}
				}
			}
			if (isRecord(chunk.usage)) {
				const { prompt_tokens, completion_tokens, total_tokens } = chunk.usage;
				if (
					typeof prompt_tokens === "number" &&
					typeof completion_tokens === "number" &&
					typeof total_tokens === "number"
				) {
					const mapped: NormalizedUsage = {
						inputTokens: prompt_tokens,
						outputTokens: completion_tokens,
						totalTokens: total_tokens,
					};
					usage = mapped;
					events.push({ type: "usage", usage: mapped });
				}
			}
		}
	};

	for (const line of bodyText.split(/\r\n|\r|\n/)) {
		if (line.startsWith("data:")) {
			const raw = line.slice("data:".length);
			const payload = raw.startsWith(" ") ? raw.slice(1) : raw;
			frame += frameHasData ? `\n${payload}` : payload;
			frameHasData = true;
		} else if (line.length === 0) {
			flushFrame();
		}
		// `event:`, `id:`, `retry:` and comment lines carry no data payload.
	}
	flushFrame();

	// Finalize every index that accumulated a complete call (id + name).
	const toolCalls: NormalizedToolCall[] = [];
	for (const [index, parts] of [...toolCallParts.entries()].sort((a, b) => a[0] - b[0])) {
		if (parts.id !== undefined && parts.name !== undefined) {
			const call: NormalizedToolCall = { id: parts.id, name: parts.name, argumentsJson: parts.argumentsJson };
			toolCalls.push(call);
			events.push({ type: "toolcall", call });
		} else {
			// An index that never received id/name is an incomplete call — it
			// is dropped rather than guessed, but only after the finalization
			// loop so partial fragments never leak as calls.
			void index;
		}
	}

	return { events, text, reasoning, toolCalls, usage };
}

/**
 * Merge one `delta.tool_calls` payload into the index-keyed fragment map.
 * Each entry is `{index, id?, type?, function?: {name?, arguments?}}`; the
 * `arguments` fragments for an index are concatenated in arrival order.
 */
function accumulateToolCallFragments(
	input: unknown,
	parts: Map<number, { id?: string; name?: string; argumentsJson: string }>,
): void {
	if (!Array.isArray(input)) {
		return;
	}
	for (const entry of input) {
		if (!isRecord(entry) || typeof entry.index !== "number") {
			continue;
		}
		const existing = parts.get(entry.index) ?? { argumentsJson: "" };
		if (typeof entry.id === "string" && entry.id.length > 0) {
			existing.id = entry.id;
		}
		const fn = isRecord(entry.function) ? entry.function : undefined;
		if (fn !== undefined) {
			if (typeof fn.name === "string" && fn.name.length > 0) {
				existing.name = fn.name;
			}
			if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
				existing.argumentsJson += fn.arguments;
			}
		}
		parts.set(entry.index, existing);
	}
}

/** Decode a JSON completion body with the openai-shaped adapter. */
async function parseJsonResponse(
	response: Response,
	mode: RequestMode,
	failure: FailureFactory,
): Promise<TransportExecutionResult> {
	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw failure(error, "response read");
		}
		throw new UnsupportedOutputShapeError(EXPECTED_JSON_BODY);
	}
	return {
		response: decodeOpenAiShaped(body),
		events: [],
		// Mode labels only — the queue-only jobId/status/depth fields never appear.
		details: { requestedMode: mode, actualMode: mode, downgrades: [] },
	};
}

/** Parse an SSE completion stream into text events plus the aggregated response. */
async function parseSseResponse(
	response: Response,
	mode: RequestMode,
	failure: FailureFactory,
): Promise<TransportExecutionResult> {
	let bodyText: string;
	try {
		bodyText = await response.text();
	} catch (error) {
		throw failure(error, "response read");
	}
	const { events, text, reasoning, toolCalls, usage } = parseSse(bodyText);
	const responseBody: NormalizedResponse = { text, downgrades: [] };
	if (reasoning !== undefined && reasoning.length > 0) {
		responseBody.reasoning = reasoning;
	}
	if (toolCalls !== undefined && toolCalls.length > 0) {
		responseBody.toolCalls = toolCalls;
	}
	if (usage !== undefined) {
		responseBody.usage = usage;
	}
	return {
		response: responseBody,
		events,
		details: { requestedMode: mode, actualMode: mode, downgrades: [] },
	};
}

/**
 * Execute one normalized request against a load-balanced Runpod endpoint.
 *
 * The normalized OpenAI Chat Completions request is POSTed directly to
 * `invokeUrl + loadBalancedPath` (no `input` envelope, no queue routes).
 * JSON responses are decoded with the openai-shaped adapter; SSE responses
 * preserve each `data:` frame's `choices[0].delta.content` as a text event
 * and `choices[0].delta.reasoning_content` as a reasoning event, both
 * aggregated into the response. The caller's AbortSignal and the
 * profile's request timeout bound the call, and errors never include
 * resolved key material.
 */
export async function executeLoadBalancedTransport(
	profile: Profile,
	request: NormalizedRequest,
	deps: TransportDeps = {},
): Promise<TransportExecutionResult> {
	if (profile.invokeUrl === undefined) {
		throw new Error(
			`Load-balanced transport requires a profile invokeUrl; profile endpointType is ${JSON.stringify(profile.endpointType)}`,
		);
	}

	const fetchImpl = deps.fetch ?? defaultTransportDeps.fetch;
	const url = joinUrl(profile.invokeUrl, profile.request.loadBalancedPath);

	const headers: Record<string, string> = { "content-type": "application/json" };
	const token = resolveBearerToken(profile, deps);
	if (token !== undefined) {
		headers.authorization = `Bearer ${token}`;
	}

	const scope = createAbortScope(profile.request.timeoutMs, deps.signal);
	const failure: FailureFactory = (error, phase) =>
		abortAwareError(error, phase, profile.request.timeoutMs, deps.signal, scope.signal.aborted);

	try {
		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: "POST",
				headers,
				body: JSON.stringify(request),
				signal: scope.signal,
			});
		} catch (error) {
			throw failure(error, "request");
		}

		if (!response.ok) {
			throw await httpError(response);
		}

		const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
		if (contentType.includes("text/event-stream")) {
			return await parseSseResponse(response, profile.request.mode, failure);
		}
		return await parseJsonResponse(response, profile.request.mode, failure);
	} finally {
		scope.dispose();
	}
}

/**
 * Probe a load-balanced endpoint's readiness: GET `invokeUrl + "/ping"`.
 * HTTP 200 maps to "healthy", 204 to "initializing", and every other status
 * or transport failure (network error, caller abort, timeout) to "unhealthy".
 */
export async function probeLoadBalancedHealth(
	profile: Profile,
	deps: TransportDeps = {},
): Promise<LoadBalancedHealth> {
	if (profile.invokeUrl === undefined) {
		throw new Error(
			`Load-balanced health probe requires a profile invokeUrl; profile endpointType is ${JSON.stringify(profile.endpointType)}`,
		);
	}

	const fetchImpl = deps.fetch ?? defaultTransportDeps.fetch;
	const url = joinUrl(profile.invokeUrl, "/ping");

	const headers: Record<string, string> = {};
	const token = resolveBearerToken(profile, deps);
	if (token !== undefined) {
		headers.authorization = `Bearer ${token}`;
	}

	const scope = createAbortScope(profile.request.timeoutMs, deps.signal);
	let response: Response;
	try {
		response = await fetchImpl(url, { method: "GET", headers, signal: scope.signal });
	} catch {
		// Any transport failure (network, caller abort, timeout) is unhealthy.
		return "unhealthy";
	} finally {
		scope.dispose();
	}

	if (response.status === 200) {
		return "healthy";
	}
	if (response.status === 204) {
		return "initializing";
	}
	return "unhealthy";
}

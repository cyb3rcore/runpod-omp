/**
 * Normalized transport contract shared by every Runpod transport adapter.
 *
 * Transports translate between OMP's normalized request/response shapes and a
 * Runpod worker's wire format (OpenAI-shaped completions or plain text).
 * Decoders never guess: an unrecognized output shape raises
 * `UnsupportedOutputShapeError` naming the shape they expected.
 */

/** How a transport submits a request and receives its result. */
export type RequestMode = "sync" | "async" | "stream";

/** One chat message in the normalized conversation. */
export interface NormalizedMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	name?: string;
	/** Assistant wire tool calls (OpenAI `message.tool_calls`), preserved for round-trips. */
	toolCalls?: NormalizedToolCall[];
}

/** OpenAI function-tool definition forwarded from OMP's `Context.tools`. */
export interface NormalizedTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: unknown;
	};
}

/** A completed tool call decoded from the worker response. */
export interface NormalizedToolCall {
	id: string;
	name: string;
	/** The arguments payload exactly as the worker emitted it (JSON text). */
	argumentsJson: string;
}

/** Normalized request handed to a transport adapter. */
export interface NormalizedRequest {
	model: string;
	messages: NormalizedMessage[];
	stream: boolean;
	temperature?: number;
	maxTokens?: number;
	/** Function-tool definitions; absent when the context carried no tools. */
	tools?: NormalizedTool[];
}

/** Token accounting mapped from the wire format's own usage shape. */
export interface NormalizedUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

/** Why a transport fell back from the requested mode to another one. */
export interface DowngradeRecord {
	requested: RequestMode;
	actual: RequestMode;
	reason?: string;
}

/** A unit of streamed output; the union is discriminated on `type`. */
export type NormalizedStreamEvent =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "toolcall"; call: NormalizedToolCall }
	| { type: "tool"; name: string; argumentsJson?: string; result?: string }
	| { type: "usage"; usage: NormalizedUsage }
	| { type: "downgrade"; record: DowngradeRecord };

/**
 * Normalized result of a transport call; usage is omitted when absent, and
 * `reasoning` carries the model's thinking text (e.g. OpenAI `reasoning_content`)
 * when the worker emits it separately from the answer. `toolCalls` carries
 * completed function calls when the worker chose to call tools.
 */
export interface NormalizedResponse {
	text: string;
	reasoning?: string;
	toolCalls?: NormalizedToolCall[];
	usage?: NormalizedUsage;
	downgrades: DowngradeRecord[];
}

/**
 * Raised by a decoder when the worker output does not match the wire shape
 * the adapter understands. The message names the expected shape instead of
 * guessing at the value.
 */
export class UnsupportedOutputShapeError extends Error {
	constructor(expectedShape: string) {
		super(`Unsupported output shape: expected ${expectedShape}`);
		this.name = "UnsupportedOutputShapeError";
	}
}

/**
 * Classify a thrown transport error as transient (safe to retry): HTTP 5xx
 * responses and network-level failures. Deterministic failures (4xx, shape
 * errors, job failures) and caller-side aborts/timeouts are never retryable.
 * Throw sites set the `retryable` marker explicitly; anything unmarked is
 * treated as non-retryable.
 */
export function isRetryableError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error as { retryable?: unknown }).retryable === true
	);
}

/** Mark a transport error as transient so the provider can retry it. */
export function markRetryable(error: Error, retryable = true): Error {
	(error as { retryable?: unknown }).retryable = retryable;
	return error;
}

/** Injectable runtime dependencies for a transport adapter. */
export interface TransportDeps {
	/** HTTP client; defaults to the global fetch. */
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	/** Async wait used by polling loops; defaults to a setTimeout-based sleep. */
	sleep?: (ms: number) => Promise<void>;
	/** Clock used for TTL accounting; defaults to Date.now. */
	now?: () => number;
	/** Pre-resolved bearer token (transports may resolve profile references themselves). */
	apiKey?: string;
	/** Abort signal forwarded to fetch, e.g. from the OMP session. */
	signal?: AbortSignal;
}

/**
 * Queue job lifecycle statuses reported by the Runpod managed queue, plus the
 * expiry sentinels a transport emits when polling exhausts its TTL while the
 * job is still non-terminal. Kept broad enough for the documented statuses
 * and the "RUNNING" alias without narrowing transports onto one value.
 */
export type QueueJobStatus =
	| "IN_QUEUE"
	| "IN_PROGRESS"
	| "RUNNING"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "TIMED_OUT"
	| "unknown"
	| "expired";

/** Per-call execution bookkeeping shared by every transport adapter. */
export interface TransportDetails {
	requestedMode: RequestMode;
	actualMode: RequestMode;
	downgrades: DowngradeRecord[];
	/** Queue transports only: the submitted job id. */
	jobId?: string;
	/** Queue transports only: the job's current or terminal status. */
	status?: QueueJobStatus;
	/** Queue transports only: polling exhausted the TTL while non-terminal. */
	expired?: boolean;
}

/** Normalized outcome of a transport execution. */
export interface TransportExecutionResult {
	/** Non-stream result; absent for stream and expired executions. */
	response?: NormalizedResponse;
	/** Streamed units in arrival order; empty for non-stream executions. */
	events: NormalizedStreamEvent[];
	details: TransportDetails;
}

/**
 * Production defaults for the injectable dependencies: the global fetch, a
 * setTimeout-based sleep, and Date.now. Transports merge these under any
 * caller-provided deps so callers only pass what they override.
 */
export const defaultTransportDeps: Required<Pick<TransportDeps, "fetch" | "sleep" | "now">> = {
	fetch: globalThis.fetch,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
};

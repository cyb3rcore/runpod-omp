/**
 * Managed-queue transport for Runpod serverless endpoints.
 *
 * A queue endpoint receives jobs through the platform queue under
 * `profile.invokeUrl` (the runtime base ending in `/v2/<endpoint-id>`):
 * `POST /run` submits, `POST /runsync?wait=<ms>` submits and blocks up to the
 * documented 300 s maximum, `GET /status/<id>` reports job lifecycle state,
 * and `GET /stream/<id>` returns the buffered output of a generator worker.
 *
 * Every call authenticates with a bearer token resolved from `deps.apiKey`
 * first, then from the profile's secret reference (`env:NAME` or a bare
 * environment-variable name). Resolved key bytes never appear in errors:
 * HTTP and output-shape failures name the status and the expected shape only.
 */

import { decodeMessagesText, encodeMessagesText } from "../adapters/messages-text.js";
import { decodeOpenAiShaped, encodeOpenAiShaped } from "../adapters/openai-shaped.js";
import { isRecord } from "../profile-schema.js";
import type { Profile } from "../profile-schema.js";
import { UnsupportedOutputShapeError, defaultTransportDeps } from "./types.js";
import type {
	DowngradeRecord,
	NormalizedRequest,
	NormalizedResponse,
	NormalizedStreamEvent,
	RequestMode,
	TransportDetails,
	TransportDeps,
	TransportExecutionResult,
} from "./types.js";

/** The longest wait the Runpod queue honors for `/runsync` (5 minutes). */
const RUNSYNC_MAX_WAIT_MS = 300_000;

/**
 * Execute one request against a managed-queue Runpod endpoint.
 *
 * The profile's `request.mode` selects the wire path:
 * - `sync` POSTs the adapter envelope to `/runsync?wait=<min(timeoutMs,
 *   300000)>` and decodes the COMPLETED job's `output`; when the wait elapses
 *   with the job still queued it downgrades to polling `/status/<id>` under
 *   the same job id and records a sync→async downgrade;
 * - `async` POSTs to `/run`, then polls `/status/<id>` (treating `RUNNING`
 *   as in progress) until a terminal status, sleeping the profile polling
 *   interval between checks;
 * - `stream` POSTs to `/run`, then reads `/stream/<id>` and preserves every
 *   chunk's `output` as normalized events; when the stream carries no chunks
 *   it downgrades to status polling and records a stream→async downgrade.
 *
 * Polling honors `request.polling.ttlMs`: when the TTL elapses while the job
 * is still non-terminal the result is explicit (`expired: true`, status
 * `unknown`) instead of a healthy-looking response derived from a stale job.
 * `FAILED`, `CANCELLED`, and `TIMED_OUT` are explicit errors, never healthy
 * or zero results.
 */
export async function executeQueueTransport(
	profile: Profile,
	request: NormalizedRequest,
	deps: TransportDeps = {},
): Promise<TransportExecutionResult> {
	if (profile.endpointType !== "queue") {
		throw new Error(
			`Runpod queue transport requires a queue endpoint profile (endpointType "${profile.endpointType}")`,
		);
	}

	const adapter = selectAdapter(profile.request.queueAdapter.kind);
	const context: QueueTransportContext = {
		base: profile.invokeUrl.replace(/\/+$/, ""),
		fetchImpl: deps.fetch ?? defaultTransportDeps.fetch,
		sleep: deps.sleep ?? defaultTransportDeps.sleep,
		now: deps.now ?? defaultTransportDeps.now,
		signal: deps.signal,
		headers: {
			Authorization: `Bearer ${resolveBearerToken(profile, deps)}`,
			"Content-Type": "application/json",
		},
		encode: adapter.encode,
		decode: adapter.decode,
		request,
		profile,
	};

	switch (profile.request.mode) {
		case "sync":
			return executeSync(context);
		case "async":
			return executeAsync(context);
		case "stream":
			return executeStream(context);
		default: {
			const exhaustive: never = profile.request.mode;
			throw new Error(`Runpod queue transport does not support mode "${String(exhaustive)}"`);
		}
	}
}

/** Everything a queue execution needs, resolved once per call. */
interface QueueTransportContext {
	/** `profile.invokeUrl` with any trailing slashes removed. */
	base: string;
	fetchImpl: NonNullable<TransportDeps["fetch"]>;
	sleep: NonNullable<TransportDeps["sleep"]>;
	now: NonNullable<TransportDeps["now"]>;
	signal: AbortSignal | undefined;
	/** Authorization plus JSON content type; applied to every queue call. */
	headers: Record<string, string>;
	encode: (request: NormalizedRequest) => { input: unknown };
	decode: (output: unknown) => NormalizedResponse;
	request: NormalizedRequest;
	profile: Profile;
}

/** Submit and wait via `/runsync`, downgrading to status polling on wait expiry. */
async function executeSync(params: QueueTransportContext): Promise<TransportExecutionResult> {
	const waitMs = Math.max(0, Math.min(Math.floor(params.profile.request.timeoutMs), RUNSYNC_MAX_WAIT_MS));
	const body = await postJson(
		params.fetchImpl,
		`${params.base}/runsync?wait=${waitMs}`,
		params.encode(params.request),
		params.headers,
		params.signal,
		"runsync",
	);
	const envelope = parseJobEnvelope(body, "runsync");
	const jobId = typeof envelope.id === "string" ? envelope.id : undefined;
	const classification = classifyStatus(envelope.status);

	switch (classification) {
		case "completed":
			return {
				response: params.decode(envelope.output),
				events: [],
				details: {
					requestedMode: "sync",
					actualMode: "sync",
					downgrades: [],
					...(jobId === undefined ? {} : { jobId }),
					status: "COMPLETED",
				},
			};
		case "failed":
			throw jobStatusError(jobId, envelope.status, envelope.output);
		case "in-progress": {
			// The wait elapsed while the job was still queued; the job keeps
			// running under its id, so fall back to polling /status.
			if (jobId === undefined) {
				throw new Error('Runpod queue runsync returned a non-terminal job without a string "id"');
			}
			const downgrade: DowngradeRecord = {
				requested: "sync",
				actual: "async",
				reason: "runsync wait elapsed before completion; polling job status",
			};
			const polled = await pollUntilTerminal({ ...params, jobId, requestedMode: "sync" });
			return {
				response: polled.response,
				events: [],
				details: {
					...polled.details,
					downgrades: [downgrade, ...polled.details.downgrades],
				},
			};
		}
		case "malformed":
			throw new Error('Runpod queue runsync response is missing a string "status"');
		default: {
			const exhaustive: never = classification;
			throw new Error(`Runpod queue runsync returned unknown job classification "${String(exhaustive)}"`);
		}
	}
}

/** Submit via `/run` and poll `/status/<id>` until terminal or TTL expiry. */
async function executeAsync(params: QueueTransportContext): Promise<TransportExecutionResult> {
	const body = await postJson(
		params.fetchImpl,
		`${params.base}/run`,
		params.encode(params.request),
		params.headers,
		params.signal,
		"run",
	);
	const jobId = requireJobId(body, "run");
	const polled = await pollUntilTerminal({ ...params, jobId, requestedMode: "async" });
	return { response: polled.response, events: [], details: polled.details };
}

/**
 * Submit via `/run` and consume `/stream/<id>` chunk outputs; downgrade to
 * status polling when the stream carries no chunks.
 */
async function executeStream(params: QueueTransportContext): Promise<TransportExecutionResult> {
	const runBody = await postJson(
		params.fetchImpl,
		`${params.base}/run`,
		params.encode(params.request),
		params.headers,
		params.signal,
		"run",
	);
	const jobId = requireJobId(runBody, "run");

	const streamBody = await getJson(
		params.fetchImpl,
		`${params.base}/stream/${jobId}`,
		params.headers,
		params.signal,
		"stream",
	);
	const chunks = parseStreamChunks(streamBody);
	if (chunks === null || chunks.length === 0) {
		// The worker is not a generator (or finished before the stream was
		// read): the buffered output is available through the job status.
		const downgrade: DowngradeRecord = {
			requested: "stream",
			actual: "async",
			reason: "no stream chunks received; falling back to status polling",
		};
		const polled = await pollUntilTerminal({ ...params, jobId, requestedMode: "stream" });
		return {
			response: polled.response,
			events: [],
			details: {
				...polled.details,
				downgrades: [downgrade, ...polled.details.downgrades],
			},
		};
	}

	// Every chunk output is preserved as events — never dropped or guessed.
	const events: NormalizedStreamEvent[] = [];
	for (const chunk of chunks) {
		const decoded = params.decode(streamChunkOutput(chunk));
		events.push({ type: "text", text: decoded.text });
		if (decoded.usage !== undefined) {
			events.push({ type: "usage", usage: decoded.usage });
		}
		for (const record of decoded.downgrades) {
			events.push({ type: "downgrade", record });
		}
	}
	return {
		events,
		details: {
			requestedMode: "stream",
			actualMode: "stream",
			downgrades: [],
			jobId,
		},
	};
}

/** Poll context: everything `pollUntilTerminal` needs beyond a submit result. */
type PollContext = Pick<
	QueueTransportContext,
	"base" | "fetchImpl" | "sleep" | "now" | "signal" | "headers" | "decode" | "profile"
> & {
	jobId: string;
	requestedMode: RequestMode;
};

/**
 * Poll `/status/<jobId>` until the job is terminal, the profile TTL elapses,
 * or the caller's signal aborts. The TTL is measured from the first poll via
 * the injected clock; an exhausted TTL yields an explicit unknown/expired
 * state, never a healthy result derived from a non-terminal job.
 */
async function pollUntilTerminal(
	params: PollContext,
): Promise<{ response?: NormalizedResponse; details: TransportDetails }> {
	const { intervalMs, ttlMs } = params.profile.request.polling;
	const startedAt = params.now();
	for (;;) {
		if (params.now() - startedAt > ttlMs) {
			return {
				details: {
					requestedMode: params.requestedMode,
					actualMode: "async",
					downgrades: [],
					jobId: params.jobId,
					status: "unknown",
					expired: true,
				},
			};
		}

		const body = await getJson(
			params.fetchImpl,
			`${params.base}/status/${params.jobId}`,
			params.headers,
			params.signal,
			"status",
		);
		const envelope = parseJobEnvelope(body, "status");
		switch (classifyStatus(envelope.status)) {
			case "completed":
				return {
					response: params.decode(envelope.output),
					details: {
						requestedMode: params.requestedMode,
						actualMode: "async",
						downgrades: [],
						jobId: params.jobId,
						status: "COMPLETED",
					},
				};
			case "failed":
				throw jobStatusError(params.jobId, envelope.status, envelope.output);
			case "in-progress":
				break;
			case "malformed":
				throw new Error(
					`Runpod queue status response for job ${params.jobId} is missing a string "status"`,
				);
		}

		await sleepWithAbort(params.sleep, intervalMs, params.signal);
	}
}

/** Classify a job status value into terminal/in-progress/shape buckets. */
function classifyStatus(status: unknown): "completed" | "failed" | "in-progress" | "malformed" {
	if (status === "COMPLETED") {
		return "completed";
	}
	if (typeof status === "string") {
		if (status === "FAILED" || status === "CANCELLED" || status === "TIMED_OUT") {
			return "failed";
		}
		// Unknown status strings (including the "RUNNING" alias) are
		// treated as in-progress: polling is bounded by the profile TTL, so a
		// future status can never hang a call.
		return "in-progress";
	}
	return "malformed";
}

/**
 * A job envelope from `/run`, `/runsync`, or `/status`. Every field stays
 * `unknown` until validated at its use site; `parseJobEnvelope` asserts the
 * body is a JSON object and checks which of `id`, `status`, and `output` are
 * present. An absent field stays `undefined` — a `/run` response carries no
 * `output` until its job completes.
 */
interface JobEnvelope {
	id: unknown;
	status: unknown;
	output: unknown;
}

/** Narrow a parsed body to a job envelope, rejecting non-object shapes. */
function parseJobEnvelope(body: unknown, what: string): JobEnvelope {
	if (!isRecord(body)) {
		throw new Error(`Runpod queue ${what} response is not a JSON object`);
	}
	// The three envelope fields are presence-checked here so the return is a
	// real JobEnvelope, never the raw record; the values are then validated
	// by the callers that consume them (requireJobId, classifyStatus, and
	// the adapter decoder).
	return {
		id: "id" in body ? body.id : undefined,
		status: "status" in body ? body.status : undefined,
		output: "output" in body ? body.output : undefined,
	};
}

/** Require a string job id from a submit response. */
function requireJobId(body: unknown, what: string): string {
	const envelope = parseJobEnvelope(body, what);
	if (typeof envelope.id !== "string" || envelope.id.length === 0) {
		throw new Error(`Runpod queue ${what} response is missing a string "id"`);
	}
	return envelope.id;
}

/**
 * Extract stream chunk outputs from a `/stream` body. The current documented
 * shape is an array of `{"metrics": {...}, "output": ...}` items; the
 * `{"status": [...], "stream": [...]}` wrapper is also tolerated. Returns
 * null when the body carries no stream document at all.
 */
function parseStreamChunks(body: unknown): unknown[] | null {
	if (Array.isArray(body)) {
		return body;
	}
	if (isRecord(body) && Array.isArray(body.stream)) {
		return body.stream;
	}
	return null;
}

/** The decode value of one stream chunk: its `output` field, when present. */
function streamChunkOutput(item: unknown): unknown {
	if (isRecord(item) && "output" in item) {
		return item.output;
	}
	throw new UnsupportedOutputShapeError(
		"a /stream chunk array whose items are objects carrying an output field",
	);
}

/** Pick the encode/decode pair for the profile's queue adapter. */
function selectAdapter(kind: Profile["request"]["queueAdapter"]["kind"]): {
	encode: (request: NormalizedRequest) => { input: unknown };
	decode: (output: unknown) => NormalizedResponse;
} {
	switch (kind) {
		case "openai-shaped":
			return { encode: encodeOpenAiShaped, decode: decodeOpenAiShaped };
		case "messages-text":
			return { encode: encodeMessagesText, decode: decodeMessagesText };
		case "module":
			// The module kind loads a local adapter file through the
			// configuration layer; no module implementation belongs here, so
			// it fails explicitly instead of being served from this file.
			throw new Error(
				'Runpod queue transport does not support adapter kind "module"; use openai-shaped or messages-text',
			);
		default: {
			// A future adapter kind must never be silently served from this
			// file: reaching this branch is a compile-time error.
			const exhaustive: never = kind;
			throw new Error(
				`Runpod queue transport does not support adapter kind "${String(exhaustive)}"; use openai-shaped or messages-text`,
			);
		}
	}
}

/**
 * Resolve the bearer token for a call: a pre-resolved `deps.apiKey` wins,
 * then the profile's secret reference. References accept `env:NAME` and bare
 * environment-variable names; command (`!`) and other reference forms cannot
 * be resolved here and fail explicitly. The resolved value is never included
 * in any error.
 */
function resolveBearerToken(profile: Profile, deps: TransportDeps): string {
	if (deps.apiKey !== undefined && deps.apiKey.length > 0) {
		return deps.apiKey;
	}
	const ref = profile.apiKey?.ref;
	if (ref === undefined) {
		return requireEnvValue("RUNPOD_API_KEY", "RUNPOD_API_KEY");
	}
	if (ref.startsWith("env:")) {
		const name = ref.slice("env:".length);
		if (name.length === 0) {
			throw new Error(
				"Runpod queue profile apiKey env reference has an empty variable name (value redacted)",
			);
		}
		return requireEnvValue(name, ref);
	}
	if (ref.startsWith("!")) {
		throw new Error(
			"Runpod queue profile apiKey is a command secret reference that the transport cannot resolve; pass the resolved key as deps.apiKey",
		);
	}
	if (ref.includes(":")) {
		throw new Error(
			"Runpod queue profile apiKey uses an unsupported reference form; use env:NAME or a bare environment-variable name",
		);
	}
	return requireEnvValue(ref, ref);
}

/** Read a required environment variable; the value is never included in errors. */
function requireEnvValue(name: string, referenceForm: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) {
		throw new Error(
			`Runpod queue profile apiKey reference ${referenceForm} does not resolve to a set environment variable (value redacted)`,
		);
	}
	return value;
}

/** POST a JSON payload and return the parsed JSON body. */
async function postJson(
	fetchImpl: NonNullable<TransportDeps["fetch"]>,
	url: string,
	payload: unknown,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
	what: string,
): Promise<unknown> {
	if (signal?.aborted === true) {
		throw abortError();
	}
	const response = await fetchImpl(url, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
		signal,
	});
	return readJson(response, what);
}

/** GET a JSON body. */
async function getJson(
	fetchImpl: NonNullable<TransportDeps["fetch"]>,
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
	what: string,
): Promise<unknown> {
	if (signal?.aborted === true) {
		throw abortError();
	}
	const response = await fetchImpl(url, { method: "GET", headers, signal });
	return readJson(response, what);
}

/**
 * Parse a response body as JSON, converting HTTP and parse failures to
 * explicit, secret-free errors.
 */
async function readJson(response: Response, what: string): Promise<unknown> {
	if (!response.ok) {
		throw new Error(
			`Runpod queue ${what} request failed with HTTP ${response.status}${await serverErrorText(response)}`,
		);
	}
	try {
		return (await response.json()) as unknown;
	} catch {
		throw new Error(`Runpod queue ${what} returned an invalid JSON body (HTTP ${response.status})`);
	}
}

/** Extract a short diagnostic from a non-OK response body, when parseable. */
async function serverErrorText(response: Response): Promise<string> {
	try {
		const body: unknown = await response.json();
		const message = serverErrorMessage(body);
		return message === "" ? "" : `: ${message}`;
	} catch {
		return "";
	}
}

/**
 * Truncated server-provided failure detail, when the output carries one.
 * Diagnostics are capped so an over-long server message cannot swamp a
 * transport error.
 */
function serverErrorMessage(output: unknown): string {
	if (typeof output === "string" && output.length > 0) {
		return output.length <= 300 ? output : `${output.slice(0, 300)}...`;
	}
	if (!isRecord(output)) {
		return "";
	}
	for (const key of ["message", "error", "detail"]) {
		const value = output[key];
		if (typeof value === "string" && value.length > 0) {
			return value.length <= 300 ? value : `${value.slice(0, 300)}...`;
		}
	}
	return "";
}

/** A terminal failure error for a job whose status is FAILED/CANCELLED/TIMED_OUT. */
function jobStatusError(jobId: string | undefined, status: unknown, output: unknown): Error {
	const id = jobId === undefined ? "(unknown id)" : jobId;
	const detail = serverErrorMessage(output);
	return new Error(
		`Runpod queue job ${id} terminated with status ${String(status)}${detail === "" ? "" : `: ${detail}`}`,
	);
}

/** Sleep, rejecting early when the caller's signal aborts mid-wait. */
function sleepWithAbort(
	sleep: NonNullable<TransportDeps["sleep"]>,
	ms: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (signal === undefined) {
		return sleep(ms);
	}
	if (signal.aborted) {
		return Promise.reject(abortError());
	}
	return new Promise<void>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(abortError());
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

function abortError(): Error {
	const error = new Error("Runpod queue transport aborted");
	error.name = "AbortError";
	return error;
}

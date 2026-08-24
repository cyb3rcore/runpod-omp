/**
 * Profile configuration schema for the Runpod OMP provider.
 *
 * A profile document is versioned YAML (`version: 1`) whose `profiles` key is
 * a name-keyed map, never an array. `parseProfileDocument` accepts YAML text
 * or an already-parsed plain value and returns the parsed document plus any
 * retained validation errors. Malformed profiles are excluded from the
 * document while their errors are kept; unsupported versions and non-document
 * roots reject the whole document (`document` is null).
 *
 * Secrets are never resolved here: the parser performs no environment lookups
 * and runs no commands. API keys are accepted as an environment-variable name
 * or literal string, a `!command` reference, or a `{ ref }` object, and every
 * form is normalized to `{ kind: "secret-reference", ref, redacted }` where
 * `ref` is the user-provided reference verbatim and `redacted` is a fixed
 * marker used by every exposed diagnostic/output form, so resolved credential
 * bytes never enter the document.
 */

import { parse as parseYaml } from "yaml";

import type { RequestMode } from "./transport/types.js";

/** How a Runpod endpoint routes requests: managed queue, direct HTTP, or a pod. */
export type EndpointType = "queue" | "load-balanced" | "pod";

/**
 * Transport adapter kinds the provider can speak to a worker with. The
 * built-in `openai-shaped` and `messages-text` adapters need no extra fields;
 * the `module` kind loads a local adapter module (see {@link QueueAdapterConfig}).
 */
export type AdapterKind = "openai-shaped" | "messages-text" | "module";

/** An unresolved API key reference; the configuration layer never resolves it. */
export interface SecretReference {
	kind: "secret-reference";
	ref: string;
	redacted: string;
}

/** Model metadata attached to a profile; no model-level defaults are applied. */
export interface ModelMetadata {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: string[];
	supportsTools: boolean;
	supportsVision: boolean;
}

/**
 * Queue adapter selection. The `module` kind requires a `module` path
 * (relative to the profile's config file) and accepts an optional `export`
 * name defaulting to `"adapter"`; the built-in kinds accept neither field.
 */
export interface QueueAdapterConfig {
	kind: AdapterKind;
	module?: string;
	export?: string;
}

/** Request-side profile settings; every field carries a planned default. */
export interface ProfileRequest {
	mode: RequestMode;
	timeoutMs: number;
	polling: {
		intervalMs: number;
		ttlMs: number;
		focusAware: boolean;
	};
	queueAdapter: QueueAdapterConfig;
	loadBalancedPath: string;
}

/** Pod-targeted config for `endpointType: pod` profiles. */
export interface PodConfig {
	/** Runpod pod id (e.g. "pod_abc123") — control-plane + TCP resolution. */
	id: string;
	/** Internal port llama.cpp listens on; defaults to 8000. */
	port: number;
	/** Optional Bearer token for llama.cpp --api-key; absent = keyless. */
	inferenceApiKey?: SecretReference;
}

/** Retry/fallback policy for an inference profile. */
export interface ProfilePolicy {
	maxAttempts: number;
	fallbackProfiles: string[];
}

/**
 * A validated profile: required fields plus applied planned defaults.
 * `invokeUrl` is required for queue/load-balanced profiles and optional for
 * pod profiles (absent = TCP auto-derivation at runtime; present = static
 * override such as a proxy URL or tunnel).
 */
export interface Profile {
	endpointType: EndpointType;
	invokeUrl?: string;
	model: ModelMetadata;
	apiKey?: SecretReference;
	request: ProfileRequest;
	policy: ProfilePolicy;
	/** Present only when `endpointType === "pod"`. */
	pod?: PodConfig;
}

/** A parsed version-1 profile document. */
export interface ProfileDocument {
	version: 1;
	profiles: Record<string, Profile>;
}

/** A validation problem tied to the document it came from. */
export interface ProfileValidationError {
	sourcePath: string;
	message: string;
}

/** Result of parsing a profile document: the document plus retained errors. */
export interface ProfileDocumentResult {
	sourcePath: string;
	document: ProfileDocument | null;
	errors: ProfileValidationError[];
}

const ENDPOINT_TYPES: readonly EndpointType[] = ["queue", "load-balanced", "pod"];
const REQUEST_MODES: readonly RequestMode[] = ["sync", "async", "stream"];
const ADAPTER_KINDS: readonly AdapterKind[] = ["openai-shaped", "messages-text", "module"];
const MODEL_INPUT_MODES: readonly string[] = ["text", "image"];

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLLING_INTERVAL_MS = 1_000;
const DEFAULT_POLLING_TTL_MS = 1_800_000;
const DEFAULT_FOCUS_AWARE = true;
const DEFAULT_QUEUE_ADAPTER_KIND: AdapterKind = "openai-shaped";
const DEFAULT_QUEUE_ADAPTER_EXPORT = "adapter";
const DEFAULT_LOAD_BALANCED_PATH = "/v1/chat/completions";
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_POD_PORT = 8000;
const REDACTED = "[redacted]";

/**
 * Canonical plain-record guard for the package's config-boundary data. This
 * module is the only one that parses untrusted shapes, so the guard lives
 * here once and is exported for reuse instead of being recreated at call
 * sites. Field validation happens after narrowing via the per-field checks
 * below.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a version-1 profile document from YAML text (or an already-parsed
 * plain value). Returns the parsed document with defaults applied, or null
 * plus retained errors for unsupported versions and non-document roots.
 * Malformed profiles are excluded from `document.profiles` while their
 * validation errors are retained in `errors`.
 */
export function parseProfileDocument(
	input: string | unknown,
	sourcePath: string,
): ProfileDocumentResult {
	const errors: ProfileValidationError[] = [];

	let value: unknown = input;
	if (typeof input === "string") {
		try {
			value = parseYaml(input);
		} catch (cause) {
			errors.push({
				sourcePath,
				message: `document is not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
			});
			return { sourcePath, document: null, errors };
		}
	}

	if (!isRecord(value)) {
		errors.push({ sourcePath, message: "document root must be an object" });
		return { sourcePath, document: null, errors };
	}

	const version = value.version;
	if (version !== 1) {
		errors.push({
			sourcePath,
			message:
				version === undefined
					? `document is missing required field "version"; expected version 1`
					: `unsupported document version ${JSON.stringify(version)}; expected version 1`,
		});
		return { sourcePath, document: null, errors };
	}

	const profilesRaw = value.profiles;
	if (!isRecord(profilesRaw)) {
		errors.push({
			sourcePath,
			message:
				profilesRaw === undefined
					? `document is missing required field "profiles"`
					: `document field "profiles" must be an object mapping profile names to profiles`,
		});
		return { sourcePath, document: null, errors };
	}

	const profiles: Record<string, Profile> = {};
	for (const [name, rawProfile] of Object.entries(profilesRaw)) {
		const profile = parseProfile(name, rawProfile, sourcePath, errors);
		if (profile !== null) {
			profiles[name] = profile;
		}
	}

	return { sourcePath, document: { version: 1, profiles }, errors };
}

/** Validate one profile-map entry; returns null (with errors) when malformed. */
function parseProfile(
	name: string,
	value: unknown,
	sourcePath: string,
	errors: ProfileValidationError[],
): Profile | null {
	if (!isRecord(value)) {
		errors.push({ sourcePath, message: `profile "${name}" must be an object` });
		return null;
	}

	const endpointType = parseEnum(
		value.endpointType,
		ENDPOINT_TYPES,
		`profile "${name}" field "endpointType"`,
		sourcePath,
		errors,
	);
	// Non-pod profiles carry no pod block; only a failed parse yields null.
	const pod = endpointType === "pod" ? parsePod(value.pod, name, sourcePath, errors) : undefined;
	// queue/load-balanced profiles require invokeUrl; pod profiles accept it
	// as an optional static override — absent (undefined) means TCP
	// auto-derivation at runtime from the pod's public port mapping, while a
	// null parse result means the field was present but invalid.
	let invokeUrl: string | null | undefined;
	if (endpointType === "pod" && value.invokeUrl === undefined) {
		invokeUrl = undefined;
	} else {
		invokeUrl = parseInvokeUrl(
			value.invokeUrl,
			`profile "${name}" field "invokeUrl"`,
			sourcePath,
			errors,
		);
	}
	const model = parseModel(value.model, name, sourcePath, errors);
	if (endpointType === null || pod === null || invokeUrl === null || model === null) {
		return null;
	}

	let apiKey: SecretReference | undefined;
	if (value.apiKey !== undefined) {
		const parsedApiKey = parseApiKey(value.apiKey, name, sourcePath, errors);
		if (parsedApiKey === null) {
			return null;
		}
		apiKey = parsedApiKey;
	}

	const request = parseRequest(value.request, name, sourcePath, errors);
	if (request === null) {
		return null;
	}

	const policy = parsePolicy(value.policy, name, sourcePath, errors);
	if (policy === null) {
		return null;
	}

	return {
		endpointType,
		invokeUrl: invokeUrl ?? undefined,
		model,
		apiKey,
		request,
		policy,
		pod: pod ?? undefined,
	};
}

/** Validate an enum-typed field against an allowed list. */
function parseEnum<T extends string>(
	input: unknown,
	allowed: readonly T[],
	fieldLabel: string,
	sourcePath: string,
	errors: ProfileValidationError[],
): T | null {
	const match = allowed.find((value) => value === input);
	if (match === undefined) {
		errors.push({
			sourcePath,
			message: `${fieldLabel} must be one of ${allowed.map((value) => JSON.stringify(value)).join(", ")}`,
		});
		return null;
	}
	return match;
}

/** Validate a required non-empty string field. */
function parseRequiredString(
	input: unknown,
	fieldLabel: string,
	sourcePath: string,
	errors: ProfileValidationError[],
): string | null {
	if (typeof input !== "string" || input.length === 0) {
		errors.push({ sourcePath, message: `${fieldLabel} is required and must be a non-empty string` });
		return null;
	}
	return input;
}

/**
 * Validate a required `invokeUrl`: a non-empty string that parses as an
 * absolute http(s) URL. The original spelling is preserved verbatim.
 */
function parseInvokeUrl(
	input: unknown,
	fieldLabel: string,
	sourcePath: string,
	errors: ProfileValidationError[],
): string | null {
	const url = parseRequiredString(input, fieldLabel, sourcePath, errors);
	if (url === null) {
		return null;
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		errors.push({ sourcePath, message: `${fieldLabel} must be a parseable absolute URL` });
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		errors.push({ sourcePath, message: `${fieldLabel} must use the http or https protocol` });
		return null;
	}
	return url;
}

/** Validate a required boolean field. */
function parseBoolean(
	input: unknown,
	fieldLabel: string,
	sourcePath: string,
	errors: ProfileValidationError[],
): boolean | null {
	if (typeof input !== "boolean") {
		errors.push({ sourcePath, message: `${fieldLabel} must be a boolean` });
		return null;
	}
	return input;
}

/**
 * Validate a finite number greater than zero. When `defaultValue` is omitted
 * the field is required; when absent it errors instead of defaulting.
 */
function parsePositiveNumber(
	input: unknown,
	fieldLabel: string,
	sourcePath: string,
	errors: ProfileValidationError[],
	defaultValue?: number,
): number | null {
	if (input === undefined) {
		if (defaultValue === undefined) {
			errors.push({ sourcePath, message: `${fieldLabel} is required and must be a finite number greater than zero` });
			return null;
		}
		return defaultValue;
	}
	if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
		errors.push({ sourcePath, message: `${fieldLabel} must be a finite number greater than zero` });
		return null;
	}
	return input;
}

/**
 * Validate a positive integer (counts and token windows). When `defaultValue`
 * is omitted the field is required; when absent it errors instead of defaulting.
 */
function parsePositiveInteger(
	input: unknown,
	fieldLabel: string,
	sourcePath: string,
	errors: ProfileValidationError[],
	defaultValue?: number,
): number | null {
	if (input === undefined) {
		if (defaultValue === undefined) {
			errors.push({ sourcePath, message: `${fieldLabel} is required and must be a positive integer` });
			return null;
		}
		return defaultValue;
	}
	if (typeof input !== "number" || !Number.isInteger(input) || input <= 0) {
		errors.push({ sourcePath, message: `${fieldLabel} must be a positive integer` });
		return null;
	}
	return input;
}

/**
 * Validate model metadata in full. The plan defines no model-level defaults:
 * every field is required and strictly validated (id/name non-empty strings,
 * positive integer token counts, boolean capability flags, and a non-empty
 * text/image input array), then reconstructed as a fresh typed object.
 */
function parseModel(
	input: unknown,
	name: string,
	sourcePath: string,
	errors: ProfileValidationError[],
): ModelMetadata | null {
	if (!isRecord(input)) {
		errors.push({ sourcePath, message: `profile "${name}" field "model" must be an object` });
		return null;
	}

	const id = parseRequiredString(
		input.id,
		`profile "${name}" field "model.id"`,
		sourcePath,
		errors,
	);
	const modelName = parseRequiredString(
		input.name,
		`profile "${name}" field "model.name"`,
		sourcePath,
		errors,
	);
	const contextWindow = parsePositiveInteger(
		input.contextWindow,
		`profile "${name}" field "model.contextWindow"`,
		sourcePath,
		errors,
	);
	const maxTokens = parsePositiveInteger(
		input.maxTokens,
		`profile "${name}" field "model.maxTokens"`,
		sourcePath,
		errors,
	);
	const reasoning = parseBoolean(
		input.reasoning,
		`profile "${name}" field "model.reasoning"`,
		sourcePath,
		errors,
	);
	const inputModes = parseModelInput(input.input, name, sourcePath, errors);
	const supportsTools = parseBoolean(
		input.supportsTools,
		`profile "${name}" field "model.supportsTools"`,
		sourcePath,
		errors,
	);
	const supportsVision = parseBoolean(
		input.supportsVision,
		`profile "${name}" field "model.supportsVision"`,
		sourcePath,
		errors,
	);

	if (
		id === null ||
		modelName === null ||
		contextWindow === null ||
		maxTokens === null ||
		reasoning === null ||
		inputModes === null ||
		supportsTools === null ||
		supportsVision === null
	) {
		return null;
	}

	return {
		id,
		name: modelName,
		contextWindow,
		maxTokens,
		reasoning,
		input: inputModes,
		supportsTools,
		supportsVision,
	};
}

/**
 * Validate `model.input`: a non-empty array whose entries are each "text" or
 * "image". The entries are preserved verbatim in a fresh array.
 */
function parseModelInput(
	input: unknown,
	name: string,
	sourcePath: string,
	errors: ProfileValidationError[],
): string[] | null {
	if (!Array.isArray(input) || input.length === 0) {
		errors.push({
			sourcePath,
			message: `profile "${name}" field "model.input" must be a non-empty array of "text" and/or "image"`,
		});
		return null;
	}
	const modes: string[] = [];
	for (const item of input) {
		if (typeof item !== "string" || !MODEL_INPUT_MODES.includes(item)) {
			errors.push({
				sourcePath,
				message: `profile "${name}" field "model.input" must contain only "text" and "image"`,
			});
			return null;
		}
		modes.push(item);
	}
	return modes;
}

/**
 * Validate a pod block for `endpointType: pod` profiles: a required non-empty
 * pod id, a positive-integer internal port defaulting to 8000, and an
 * optional inference API key reference (parsed like `apiKey`, never resolved
 * here).
 */
function parsePod(
	input: unknown,
	name: string,
	sourcePath: string,
	errors: ProfileValidationError[],
): PodConfig | null {
	if (!isRecord(input)) {
		errors.push({ sourcePath, message: `profile "${name}" field "pod" must be an object` });
		return null;
	}

	const id = parseRequiredString(
		input.id,
		`profile "${name}" field "pod.id"`,
		sourcePath,
		errors,
	);
	const port = parsePositiveInteger(
		input.port,
		`profile "${name}" field "pod.port"`,
		sourcePath,
		errors,
		DEFAULT_POD_PORT,
	);
	let inferenceApiKey: SecretReference | undefined;
	if (input.inferenceApiKey !== undefined) {
		const parsedApiKey = parseApiKey(
			input.inferenceApiKey,
			name,
			sourcePath,
			errors,
			"pod.inferenceApiKey",
		);
		if (parsedApiKey === null) {
			return null;
		}
		inferenceApiKey = parsedApiKey;
	}

	if (id === null || port === null) {
		return null;
	}

	return { id, port, inferenceApiKey };
}

/**
 * Validate an API key. Keys are never resolved here: the accepted forms are a
…
 * like OMP custom providers), a `!command` reference string, or a reference
 * object like `{ ref: "env:VAR" }`. Every form is normalized to a
 * secret-reference whose `ref` is the user-provided reference verbatim and
 * whose `redacted` is a fixed marker, so no resolved credential bytes enter
 * the document.
 */
function parseApiKey(
	input: unknown,
	name: string,
	sourcePath: string,
	errors: ProfileValidationError[],
	field = "apiKey",
): SecretReference | null {
	if (typeof input === "string") {
		if (input.length === 0) {
			errors.push({
				sourcePath,
				message: `profile "${name}" field "${field}" must be a non-empty string or a secret reference object like { ref: "env:VAR" }`,
			});
			return null;
		}
		return { kind: "secret-reference", ref: input, redacted: REDACTED };
	}
	if (isRecord(input) && typeof input.ref === "string" && input.ref.length > 0) {
		return { kind: "secret-reference", ref: input.ref, redacted: REDACTED };
	}
	errors.push({
		sourcePath,
		message: `profile "${name}" field "${field}" must be an environment-variable name, a literal, a "!command" reference, or a secret reference object like { ref: "env:VAR" }`,
	});
	return null;
}

/** Validate request settings, applying the planned defaults field by field. */
function parseRequest(
	input: unknown,
	name: string,
	sourcePath: string,
	errors: ProfileValidationError[],
): ProfileRequest | null {
	if (input === undefined) {
		return {
			mode: "sync",
			timeoutMs: DEFAULT_TIMEOUT_MS,
			polling: {
				intervalMs: DEFAULT_POLLING_INTERVAL_MS,
				ttlMs: DEFAULT_POLLING_TTL_MS,
				focusAware: DEFAULT_FOCUS_AWARE,
			},
			queueAdapter: { kind: DEFAULT_QUEUE_ADAPTER_KIND },
			loadBalancedPath: DEFAULT_LOAD_BALANCED_PATH,
		};
	}
	if (!isRecord(input)) {
		errors.push({ sourcePath, message: `profile "${name}" field "request" must be an object` });
		return null;
	}

	let mode: RequestMode = "sync";
	if (input.mode !== undefined) {
		const parsedMode = parseEnum(
			input.mode,
			REQUEST_MODES,
			`profile "${name}" field "request.mode"`,
			sourcePath,
			errors,
		);
		if (parsedMode === null) {
			return null;
		}
		mode = parsedMode;
	}

	const timeoutMs = parsePositiveNumber(
		input.timeoutMs,
		`profile "${name}" field "request.timeoutMs"`,
		sourcePath,
		errors,
		DEFAULT_TIMEOUT_MS,
	);
	if (timeoutMs === null) {
		return null;
	}

	let polling: ProfileRequest["polling"] = {
		intervalMs: DEFAULT_POLLING_INTERVAL_MS,
		ttlMs: DEFAULT_POLLING_TTL_MS,
		focusAware: DEFAULT_FOCUS_AWARE,
	};
	if (input.polling !== undefined) {
		if (!isRecord(input.polling)) {
			errors.push({ sourcePath, message: `profile "${name}" field "request.polling" must be an object` });
			return null;
		}
		const intervalMs = parsePositiveNumber(
			input.polling.intervalMs,
			`profile "${name}" field "request.polling.intervalMs"`,
			sourcePath,
			errors,
			DEFAULT_POLLING_INTERVAL_MS,
		);
		if (intervalMs === null) {
			return null;
		}
		const ttlMs = parsePositiveNumber(
			input.polling.ttlMs,
			`profile "${name}" field "request.polling.ttlMs"`,
			sourcePath,
			errors,
			DEFAULT_POLLING_TTL_MS,
		);
		if (ttlMs === null) {
			return null;
		}
		let focusAware = DEFAULT_FOCUS_AWARE;
		if (input.polling.focusAware !== undefined) {
			if (typeof input.polling.focusAware !== "boolean") {
				errors.push({
					sourcePath,
					message: `profile "${name}" field "request.polling.focusAware" must be a boolean`,
				});
				return null;
			}
			focusAware = input.polling.focusAware;
		}
		polling = { intervalMs, ttlMs, focusAware };
	}

	let queueAdapter: QueueAdapterConfig = { kind: DEFAULT_QUEUE_ADAPTER_KIND };
	if (input.queueAdapter !== undefined) {
		const parsedQueueAdapter = parseQueueAdapter(input.queueAdapter, name, sourcePath, errors);
		if (parsedQueueAdapter === null) {
			return null;
		}
		queueAdapter = parsedQueueAdapter;
	}

	let loadBalancedPath = DEFAULT_LOAD_BALANCED_PATH;
	if (input.loadBalancedPath !== undefined) {
		if (typeof input.loadBalancedPath !== "string" || input.loadBalancedPath.length === 0) {
			errors.push({
				sourcePath,
				message: `profile "${name}" field "request.loadBalancedPath" must be a non-empty string`,
			});
			return null;
		}
		loadBalancedPath = input.loadBalancedPath;
	}

	return { mode, timeoutMs, polling, queueAdapter, loadBalancedPath };
}

/**
 * Validate a queue adapter selection. The `module` kind requires a non-empty
 * `module` path and accepts an optional `export` name defaulting to
 * `"adapter"`; the built-in kinds accept neither field. The result is a fresh
 * typed object reconstructed from the validated fields.
 */
function parseQueueAdapter(
	input: unknown,
	name: string,
	sourcePath: string,
	errors: ProfileValidationError[],
): QueueAdapterConfig | null {
	if (!isRecord(input) || typeof input.kind !== "string" || !ADAPTER_KINDS.some((value) => value === input.kind)) {
		errors.push({
			sourcePath,
			message: `profile "${name}" field "request.queueAdapter.kind" must be one of ${ADAPTER_KINDS.map((value) => JSON.stringify(value)).join(", ")}`,
		});
		return null;
	}

	switch (input.kind) {
		case "openai-shaped":
		case "messages-text": {
			if (input.module !== undefined || input.export !== undefined) {
				errors.push({
					sourcePath,
					message: `profile "${name}" field "request.queueAdapter" with kind "${input.kind}" accepts no "module" or "export" fields`,
				});
				return null;
			}
			return { kind: input.kind };
		}
		case "module": {
			const module = parseRequiredString(
				input.module,
				`profile "${name}" field "request.queueAdapter.module"`,
				sourcePath,
				errors,
			);
			if (module === null) {
				return null;
			}
			let exportName = DEFAULT_QUEUE_ADAPTER_EXPORT;
			if (input.export !== undefined) {
				if (typeof input.export !== "string" || input.export.length === 0) {
					errors.push({
						sourcePath,
						message: `profile "${name}" field "request.queueAdapter.export" must be a non-empty string`,
					});
					return null;
				}
				exportName = input.export;
			}
			return { kind: "module", module, export: exportName };
		}
		default:
			// Unreachable: `kind` was validated against ADAPTER_KINDS above.
			return null;
	}
}

/** Validate retry/fallback policy, applying the planned defaults field by field. */
function parsePolicy(
	input: unknown,
	name: string,
	sourcePath: string,
	errors: ProfileValidationError[],
): ProfilePolicy | null {
	if (input === undefined) {
		return {
			maxAttempts: DEFAULT_MAX_ATTEMPTS,
			fallbackProfiles: [],
		};
	}
	if (!isRecord(input)) {
		errors.push({ sourcePath, message: `profile "${name}" field "policy" must be an object` });
		return null;
	}

	const maxAttempts = parsePositiveInteger(
		input.maxAttempts,
		`profile "${name}" field "policy.maxAttempts"`,
		sourcePath,
		errors,
		DEFAULT_MAX_ATTEMPTS,
	);
	if (maxAttempts === null) {
		return null;
	}

	let fallbackProfiles: string[] = [];
	if (input.fallbackProfiles !== undefined) {
		if (
			!Array.isArray(input.fallbackProfiles) ||
			input.fallbackProfiles.some((item) => typeof item !== "string")
		) {
			errors.push({
				sourcePath,
				message: `profile "${name}" field "policy.fallbackProfiles" must be an array of profile names`,
			});
			return null;
		}
		fallbackProfiles = [...input.fallbackProfiles];
	}

	return { maxAttempts, fallbackProfiles };
}

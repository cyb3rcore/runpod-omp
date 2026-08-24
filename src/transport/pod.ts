/**
 * Pod transport for Runpod pod profiles.
 *
 * A pod profile carries no serverless endpoint: inference reaches the pod's
 * llama.cpp server over its public TCP address, resolved at call time from
 * the Runpod control plane (`GET /v2/pods/{id}` → `runtime.ports`). The HTTP
 * call itself delegates to the load-balanced transport — streaming, tool
 * calling, retry classification, and the maxTokens ceiling are inherited —
 * while this module owns the address resolution and the key separation:
 * the control key (account-scoped) is used only for the pod API lookup and
 * never reaches the worker; the optional inference token
 * (`pod.inferenceApiKey`) is the only credential forwarded to llama.cpp.
 */

import type { Profile } from "../profile-schema.js";
import {
	executeLoadBalancedTransport,
	type LoadBalancedHealth,
} from "./load-balanced.js";
import {
	defaultTransportDeps,
	markRetryable,
	resolveSecretRef,
	type NormalizedRequest,
	type TransportDeps,
	type TransportExecutionResult,
} from "./types.js";

/** The pod API lookup is control-plane work; 15 s bounds it regardless of the inference timeout. */
const POD_API_TIMEOUT_MS = 15_000;

/**
 * Build a request-scoped abort signal for a pod API call: the caller's
 * signal (if any) plus a hard 15 s timeout. Dispose clears the timer and
 * listener as soon as the call settles.
 */
function createPodAbortScope(
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
			? setTimeout(() => controller.abort(new Error(`pod API request timed out after ${timeoutMs} ms`)), timeoutMs)
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

/** The inference token the worker may demand; absent means keyless. */
function resolveInferenceToken(profile: Profile): string | undefined {
	const reference = profile.pod?.inferenceApiKey;
	return reference === undefined ? undefined : resolveSecretRef(reference.ref, process.env);
}

/**
 * Resolve the HTTP base a pod profile's worker answers at.
 *
 * Static mode: a configured `invokeUrl` is returned verbatim (proxy URL or
 * tunnel override). TCP mode: `GET https://api.runpod.io/v2/pods/{id}` with
 * the control key, then the `runtime.ports` entry for `pod.port` (falling
 * back to the first TCP entry with an ip+public pair). Deterministic errors
 * name the pod state and remedy, or the available port pairs, so callers
 * can act instead of guessing.
 */
export async function resolvePodHttpAddress(
	profile: Profile,
	deps: TransportDeps = {},
): Promise<string> {
	if (profile.invokeUrl !== undefined) {
		return profile.invokeUrl;
	}
	const podId = profile.pod?.id;
	if (podId === undefined) {
		throw new Error("runpod provider: pod profile is missing its pod id");
	}

	const controlKey = deps.apiKey;
	if (controlKey === undefined || controlKey.length === 0) {
		throw new Error(
			`runpod provider: pod ${podId} control requires an API key — set profile apiKey or RUNPOD_API_KEY`,
		);
	}

	const fetchImpl = deps.fetch ?? defaultTransportDeps.fetch;
	// The control-plane base is the public API host; the RUNPOD_CONTROL_BASE
	// override exists for tests and tunnel setups (the control layer exposes
	// the same seam via ControlProfile.controlBaseUrl).
	const controlBase =
		process.env.RUNPOD_CONTROL_BASE !== undefined && process.env.RUNPOD_CONTROL_BASE !== ""
			? process.env.RUNPOD_CONTROL_BASE
			: "https://api.runpod.io";
	const scope = createPodAbortScope(POD_API_TIMEOUT_MS, deps.signal);
	let response: Response;
	try {
		response = await fetchImpl(`${controlBase}/v2/pods/${podId}`, {
			method: "GET",
			headers: { authorization: `Bearer ${controlKey}` },
			signal: scope.signal,
		});
	} catch (error) {
		// Network-level failure or caller abort; only the former may retry.
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`runpod provider: pod API request for ${podId} was aborted`);
		}
		throw markRetryable(
			new Error(`runpod provider: pod API request for ${podId} failed: ${error instanceof Error ? error.message : String(error)}`),
		);
	} finally {
		scope.dispose();
	}

	if (response.status >= 500) {
		throw markRetryable(
			new Error(`runpod provider: pod API for ${podId} returned HTTP ${response.status}`),
		);
	}
	if (!response.ok) {
		throw new Error(
			`runpod provider: pod API for ${podId} returned HTTP ${response.status}`,
		);
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new Error(`runpod provider: unexpected pod API response from ${podId}`);
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new Error(`runpod provider: unexpected pod API response from ${podId}`);
	}
	const record = body as Record<string, unknown>;
	const status = record.status;
	if (typeof status !== "string") {
		throw new Error(`runpod provider: unexpected pod API response from ${podId}`);
	}
	if (status !== "RUNNING") {
		throw new Error(
			`runpod provider: pod ${podId} is ${status} — start it with /runpod pod start`,
		);
	}

	const runtime = record.runtime;
	const ports =
		typeof runtime === "object" &&
		runtime !== null &&
		!Array.isArray(runtime) &&
		Array.isArray((runtime as Record<string, unknown>).ports)
			? ((runtime as Record<string, unknown>).ports as unknown[])
			: [];
	const portEntries = ports.filter(
		(entry): entry is Record<string, unknown> =>
			typeof entry === "object" && entry !== null && !Array.isArray(entry),
	);
	const port = profile.pod?.port;
	const wanted = portEntries.find((entry) => entry.private === port);
	const candidate =
		wanted ??
		portEntries.find(
			(entry) => entry.type === "tcp" && typeof entry.ip === "string" && typeof entry.public === "number",
		);
	if (candidate === undefined) {
		const available = portEntries
			.map((entry) => `${String(entry.private)}(${typeof entry.type === "string" ? entry.type : "unknown"})`)
			.join(", ");
		throw new Error(
			`runpod provider: pod ${podId} exposes no TCP port for internal port ${String(port)} — available: ${available || "none reported"}`,
		);
	}
	const ip = candidate.ip;
	const publicPort = candidate.public;
	if (typeof ip !== "string" || typeof publicPort !== "number") {
		throw new Error(
			`runpod provider: pod ${podId} exposes no TCP port for internal port ${String(port)} — available: none reported`,
		);
	}
	return `http://${ip}:${publicPort}`;
}

/**
 * Execute one normalized request against a pod profile: resolve the worker's
 * HTTP address, then delegate the call to the load-balanced transport with
 * only the inference token (never the control key) as the bearer credential.
 */
export async function executePodTransport(
	profile: Profile,
	request: NormalizedRequest,
	deps: TransportDeps = {},
): Promise<TransportExecutionResult> {
	if (profile.endpointType !== "pod") {
		throw new Error(
			`Pod transport requires a pod profile; profile endpointType is ${JSON.stringify(profile.endpointType)}`,
		);
	}

	const address = await resolvePodHttpAddress(profile, deps);
	const inferenceToken = resolveInferenceToken(profile);

	// The control key must never reach the worker: strip the profile's own
	// apiKey (account-scoped) so only `deps.apiKey` — the inference token,
	// or undefined for a keyless pod — is forwarded.
	const delegatedProfile: Profile = {
		...profile,
		endpointType: "load-balanced",
		invokeUrl: address,
	};
	delete delegatedProfile.apiKey;

	// `noEnvKeyFallback` stops the delegated transport's RUNPOD_API_KEY
	// fallback: for pod profiles that env var holds the account-scoped
	// control key, which must never reach the worker.
	return executeLoadBalancedTransport(delegatedProfile, request, {
		...deps,
		apiKey: inferenceToken,
		noEnvKeyFallback: true,
	});
}

/**
 * Probe a pod profile's readiness: resolve the worker address, then GET
 * `${address}/health` with the inference token. HTTP 200 maps to "healthy",
 * 204 to "initializing", and every other status or failure (resolution,
 * network, caller abort, timeout, invalid token reference) to "unhealthy".
 * Never throws.
 */
export async function probePodHealth(
	profile: Profile,
	deps: TransportDeps = {},
): Promise<LoadBalancedHealth> {
	let address: string;
	try {
		address = await resolvePodHttpAddress(profile, deps);
	} catch {
		return "unhealthy";
	}

	let inferenceToken: string | undefined;
	try {
		inferenceToken = resolveInferenceToken(profile);
	} catch {
		return "unhealthy";
	}

	const fetchImpl = deps.fetch ?? defaultTransportDeps.fetch;
	const scope = createPodAbortScope(POD_API_TIMEOUT_MS, deps.signal);
	let response: Response;
	try {
		const headers: Record<string, string> = {};
		if (inferenceToken !== undefined) {
			headers.authorization = `Bearer ${inferenceToken}`;
		}
		response = await fetchImpl(`${address}/health`, {
			method: "GET",
			headers,
			signal: scope.signal,
		});
	} catch {
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

/**
 * Pod transport contract tests (test-first, per the approved plan).
 *
 * `executePodTransport` resolves the pod's public TCP address through the
 * fake control plane (`GET /v2/pods/{id}`), then delegates the call to the
 * load-balanced transport with only the inference token — never the control
 * key — as the bearer credential. `resolvePodHttpAddress` covers the address
 * resolution matrix; `probePodHealth` covers readiness. No real Runpod
 * credentials or network are used: fetch is a recording mock per test.
 */
import { describe, expect, test } from "bun:test";

import { executePodTransport, probePodHealth, resolvePodHttpAddress } from "../src/transport/pod.js";
import { isRetryableError } from "../src/transport/types.js";
import type { NormalizedRequest } from "../src/transport/types.js";
import type { Profile } from "../src/profile-schema.js";

/** Model metadata block, matching the approved profile schema. */
const MODEL = {
	id: "teneburu/Qwen3.8-27B-UD-Q6_K_XL",
	name: "Qwen3.8 27B UD Q6",
	contextWindow: 131_072,
	maxTokens: 8_192,
	reasoning: true,
	input: ["text", "image"],
	supportsTools: true,
	supportsVision: true,
} as const;

/** Build a pod profile; overrides replace whole fields. */
function podProfile(overrides: {
	invokeUrl?: string;
	podId?: string;
	port?: number;
} = {}): Profile {
	const pod = {
		id: overrides.podId ?? "pod_abc123",
		port: overrides.port ?? 8000,
	};
	return {
		endpointType: "pod",
		invokeUrl: overrides.invokeUrl,
		model: MODEL,
		apiKey: { kind: "secret-reference", ref: "env:RUNPOD_API_KEY", redacted: "[redacted]" },
		request: {
			mode: "sync",
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" },
			loadBalancedPath: "/v1/chat/completions",
		},
		policy: { maxAttempts: 1, fallbackProfiles: [] },
		pod,
	};
}

/** Build a normalized request; overrides replace whole fields. */
function requestFixture(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
	return {
		model: "runpod/pod-profile",
		messages: [
			{ role: "system", content: "You are terse." },
			{ role: "user", content: "Explain pods." },
		],
		stream: false,
		temperature: 0.2,
		maxTokens: 256,
		...overrides,
	};
}

/** A recorded fetch invocation. */
interface FetchCall {
	url: string;
	init: RequestInit | undefined;
}

/** Deterministic fetch double: records every call and hands the response to the test. */
function recordingFetch(
	respond: (call: FetchCall) => Response,
): { calls: FetchCall[]; fetchMock: typeof fetch } {
	const calls: FetchCall[] = [];
	const fetchMock: typeof fetch = async (input, init) => {
		const call: FetchCall = { url: String(input), init };
		calls.push(call);
		return respond(call);
	};
	return { calls, fetchMock };
}

/** JSON-body response helper. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A RUNNING pod body with the classic llama TCP port mapping. */
function runningPodBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "pod_abc123",
		name: "qwen-subs",
		status: "RUNNING",
		cost: 1.19,
		dataCenterId: "US-TX-1",
		runtime: {
			uptime: 7_200,
			ports: [{ private: 8000, public: 43210, type: "tcp", ip: "45.23.12.1" }],
		},
		...overrides,
	};
}

describe("resolvePodHttpAddress", () => {
	test("static invokeUrl wins and skips the control plane entirely", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse({}));
		const profile = podProfile({ invokeUrl: "https://tunnel.example.com/llama" });
		const address = await resolvePodHttpAddress(profile, { fetch: fetchMock, apiKey: "control-key" });
		expect(address).toBe("https://tunnel.example.com/llama");
		expect(calls.length).toBe(0);
	});

	test("derives http://ip:public from the pod.port TCP entry for a RUNNING pod", async () => {
		const { calls, fetchMock } = recordingFetch(() => jsonResponse(runningPodBody()));
		const address = await resolvePodHttpAddress(podProfile(), { fetch: fetchMock, apiKey: "control-key" });
		expect(address).toBe("http://45.23.12.1:43210");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://api.runpod.io/v2/pods/pod_abc123");
		expect(calls[0]!.init?.method).toBe("GET");
		expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe(
			"Bearer control-key",
		);
	});

	test("falls back to the first tcp entry with ip+public when pod.port is absent", async () => {
		const { fetchMock } = recordingFetch(() =>
			jsonResponse(
				runningPodBody({
					runtime: {
						uptime: 100,
						ports: [
							{ private: 22, public: null, type: "tcp", ip: null },
							{ private: 8000, public: 55555, type: "tcp", ip: "10.0.0.9" },
						],
					},
				}),
			),
		);
		const address = await resolvePodHttpAddress(podProfile({ port: 9999 }), {
			fetch: fetchMock,
			apiKey: "control-key",
		});
		expect(address).toBe("http://10.0.0.9:55555");
	});

	test("a non-RUNNING pod fails with the state and the /runpod pod start remedy", async () => {
		const { fetchMock } = recordingFetch(() =>
			jsonResponse(runningPodBody({ status: "EXITED", runtime: null, cost: 0 })),
		);
		await expect(
			resolvePodHttpAddress(podProfile(), { fetch: fetchMock, apiKey: "control-key" }),
		).rejects.toThrow(/pod_abc123 is EXITED.*\/runpod pod start/);
	});

	test("missing TCP ports lists the available pairs", async () => {
		const { fetchMock } = recordingFetch(() =>
			jsonResponse(
				runningPodBody({
					runtime: { uptime: 100, ports: [{ private: 22, public: null, type: "tcp", ip: null }] },
				}),
			),
		);
		await expect(
			resolvePodHttpAddress(podProfile(), { fetch: fetchMock, apiKey: "control-key" }),
		).rejects.toThrow(/exposes no TCP port for internal port 8000.*available: 22\(tcp\)/);
	});

	test("missing control key fails explicitly with the apiKey remedy", async () => {
		await expect(resolvePodHttpAddress(podProfile(), {})).rejects.toThrow(
			/pod_abc123 control requires an API key — set profile apiKey or RUNPOD_API_KEY/,
		);
	});

	test("a 5xx from the pod API is marked retryable; a 4xx is deterministic", async () => {
		const fiveHundred = recordingFetch(() => new Response("boom", { status: 503 }));
		const fiveError = await resolvePodHttpAddress(podProfile(), {
			fetch: fiveHundred.fetchMock,
			apiKey: "control-key",
		}).catch((error: unknown) => error);
		expect(fiveError).toBeInstanceOf(Error);
		expect(isRetryableError(fiveError)).toBe(true);

		const fourHundred = recordingFetch(() => new Response("denied", { status: 403 }));
		const fourError = await resolvePodHttpAddress(podProfile(), {
			fetch: fourHundred.fetchMock,
			apiKey: "control-key",
		}).catch((error: unknown) => error);
		expect(fourError).toBeInstanceOf(Error);
		expect(isRetryableError(fourError)).toBe(false);
	});

	test("a network failure is marked retryable", async () => {
		const { fetchMock } = recordingFetch(() => {
			throw new TypeError("fetch failed");
		});
		const error = await resolvePodHttpAddress(podProfile(), {
			fetch: fetchMock,
			apiKey: "control-key",
		}).catch((caught: unknown) => caught);
		expect(isRetryableError(error)).toBe(true);
	});
});

describe("executePodTransport", () => {
	const POD_URL = "http://45.23.12.1:43210/v1/chat/completions";

	test("delegates to the load-balanced transport with only the inference token", async () => {
		const { calls, fetchMock } = recordingFetch((call) => {
			if (call.url === "https://api.runpod.io/v2/pods/pod_abc123") {
				return jsonResponse(runningPodBody());
			}
			return jsonResponse({
				id: "chatcmpl-1",
				object: "chat.completion",
				created: 1,
				model: "runpod/pod-profile",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "POD_REPLY" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
			});
		});
		const profile = podProfile();
		profile.pod = {
			id: "pod_abc123",
			port: 8000,
			inferenceApiKey: { kind: "secret-reference", ref: "POD_INFERENCE_KEY", redacted: "[redacted]" },
		};
		const result = await executePodTransport(profile, requestFixture(), {
			fetch: fetchMock,
			apiKey: "control-key",
		});

		expect(result.response?.text).toBe("POD_REPLY");
		const workerCall = calls.find((call) => call.url === POD_URL);
		expect(workerCall).toBeDefined();
		expect(workerCall!.init?.method).toBe("POST");
		const headers = workerCall!.init?.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer POD_INFERENCE_KEY");
		expect(headers.authorization).not.toContain("control-key");
		// The control key appears only on the pod API call, never on the worker.
		const controlCalls = calls.filter((call) => call.url.startsWith("https://api.runpod.io"));
		expect(controlCalls).toHaveLength(1);
	});

	test("keyless pod sends no Authorization header to the worker and no control key", async () => {
		const { calls, fetchMock } = recordingFetch((call) => {
			if (call.url === "https://api.runpod.io/v2/pods/pod_abc123") {
				return jsonResponse(runningPodBody());
			}
			return jsonResponse({
				id: "chatcmpl-2",
				object: "chat.completion",
				created: 1,
				model: "runpod/pod-profile",
				choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
			});
		});
		await executePodTransport(podProfile(), requestFixture(), {
			fetch: fetchMock,
			apiKey: "control-key",
		});

		const workerCall = calls.find((call) => call.url === POD_URL);
		const headers = workerCall!.init?.headers as Record<string, string>;
		expect(headers.authorization).toBeUndefined();
	});

	test("rejects non-pod profiles with an explicit error", async () => {
		const lb: Profile = { ...podProfile(), endpointType: "load-balanced", invokeUrl: "https://lb.example.com" };
		await expect(executePodTransport(lb, requestFixture(), {})).rejects.toThrow(
			/Pod transport requires a pod profile/,
		);
	});

	test("a stopped pod surfaces the actionable error and performs no worker call", async () => {
		const { calls, fetchMock } = recordingFetch(() =>
			jsonResponse(runningPodBody({ status: "EXITED", runtime: null, cost: 0 })),
		);
		await expect(
			executePodTransport(podProfile(), requestFixture(), {
				fetch: fetchMock,
				apiKey: "control-key",
			}),
		).rejects.toThrow(/pod_abc123 is EXITED — start it with \/runpod pod start/);
		expect(calls.every((call) => call.url.startsWith("https://api.runpod.io"))).toBe(true);
	});
});

describe("probePodHealth", () => {
	test("HTTP 200 on the resolved /health maps to healthy", async () => {
		const { fetchMock } = recordingFetch((call) => {
			if (call.url === "https://api.runpod.io/v2/pods/pod_abc123") {
				return jsonResponse(runningPodBody());
			}
			expect(call.url).toBe("http://45.23.12.1:43210/health");
			return new Response("ok", { status: 200 });
		});
		expect(await probePodHealth(podProfile(), { fetch: fetchMock, apiKey: "control-key" })).toBe(
			"healthy",
		);
	});

	test("HTTP 204 maps to initializing", async () => {
		const { fetchMock } = recordingFetch((call) => {
			if (call.url === "https://api.runpod.io/v2/pods/pod_abc123") {
				return jsonResponse(runningPodBody());
			}
			return new Response(null, { status: 204 });
		});
		expect(await probePodHealth(podProfile(), { fetch: fetchMock, apiKey: "control-key" })).toBe(
			"initializing",
		);
	});

	test("HTTP 503 and a resolution failure (EXITED pod) map to unhealthy, never throw", async () => {
		const { fetchMock } = recordingFetch(() => new Response("busy", { status: 503 }));
		expect(await probePodHealth(podProfile(), { fetch: fetchMock, apiKey: "control-key" })).toBe(
			"unhealthy",
		);

		const stopped = recordingFetch(() =>
			jsonResponse(runningPodBody({ status: "EXITED", runtime: null, cost: 0 })),
		);
		expect(await probePodHealth(podProfile(), { fetch: stopped.fetchMock, apiKey: "control-key" })).toBe(
			"unhealthy",
		);
	});

	test("a network failure maps to unhealthy without throwing", async () => {
		const { fetchMock } = recordingFetch(() => {
			throw new TypeError("fetch failed");
		});
		expect(await probePodHealth(podProfile(), { fetch: fetchMock, apiKey: "control-key" })).toBe(
			"unhealthy",
		);
	});
});

/**
 * Contract tests for the Runpod OMP provider registration (test-first, per
 * the approved plan).
 *
 * These tests fail today because the module they import does not exist yet.
 * Implement the following contract to make them pass:
 *
 * src/provider.ts
 *   - `registerRunpodProvider(pi: ExtensionAPI, profiles: Record<string,
 *     Profile>): void` — registers the `runpod` provider in exactly one
 *     `pi.registerProvider("runpod", ...)` call. `profiles` is the merged
 *     profile map (profile name → Profile). The real transports
 *     (`createRunpodStream` over `executeQueueTransport` /
 *     `executeLoadBalancedTransport`) are wired unconditionally; the
 *     dispatch contract of that wiring is covered by
 *     provider-stream.test.ts / provider-default-transport.test.ts.
 *
 * Registration contract:
 *   - one `registerProvider("runpod", config)` call; `pi.setModel` is never
 *     called (model selection stays with OMP's native model picker);
 *   - provider-level placeholders: `config.api` is `"runpod-queue"`,
 *     `config.apiKey` is the `"RUNPOD_API_KEY"` env-var reference (OMP
 *     resolves it and delivers the value to `streamSimple` via
 *     `options.apiKey`), and `config.baseUrl` is a valid absolute http(s)
 *     URL that the transport dispatch never consults;
 *   - `config.models` has one entry per merged profile. Each model's `id`
 *     is the profile name (NOT `profile.model.id`), `name` is
 *     `profile.model.name`, `api` is `"runpod-queue"`, the profile model
 *     metadata (`contextWindow`, `maxTokens`, `reasoning`, `input`) is
 *     copied verbatim, and the registered cost is always the zero structure
 *     (Runpod serverless is time-billed). (How
 *     `supportsTools`/`supportsVision` surface via `compat` is
 *     implementation freedom and is not pinned here.)
 *   - an empty profile map still produces one `runpod` registration with
 *     `models: []`.
 */
import { describe, expect, test } from "bun:test";

// Named import pins the required provider entry point (link-time failure if
// the module omits it).
import { registerRunpodProvider } from "../src/provider.js";
import type { Profile } from "../src/profile-schema.js";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

/** Model metadata for the queue profile. */
const QUEUE_MODEL = {
	id: "meta-llama/llama-3.3-70b-instruct",
	name: "Llama 3.3 70B Instruct",
	contextWindow: 131_072,
	maxTokens: 8_192,
	reasoning: false,
	input: ["text"],
	supportsTools: true,
	supportsVision: false,
};

/** Model metadata for the load-balanced profile; distinct values prove the copy is per-profile. */
const LB_MODEL = {
	id: "qwen/qwen3-32b",
	name: "Qwen3 32B",
	contextWindow: 262_144,
	maxTokens: 16_384,
	reasoning: true,
	input: ["text", "image"],
	supportsTools: true,
	supportsVision: true,
};

const QUEUE_PROFILE_NAME = "queue-profile";
const LB_PROFILE_NAME = "lb-profile";

/** A merged profile routed through the managed-queue transport. */
function queueProfile(): Profile {
	return {
		endpointType: "queue",
		invokeUrl: "https://api.runpod.ai/v2/ep-queue",
		model: QUEUE_MODEL,
		apiKey: { kind: "secret-reference", ref: "env:RUNPOD_API_KEY", redacted: "[redacted]" },
		request: {
			mode: "stream",
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" },
			loadBalancedPath: "/v1/chat/completions",
		},
		policy: { maxAttempts: 1, fallbackProfiles: [] },
	};
}

/** A merged profile routed directly to the worker (no queue semantics). */
function lbProfile(): Profile {
	return {
		endpointType: "load-balanced",
		invokeUrl: "https://lb.example.com",
		model: LB_MODEL,
		apiKey: { kind: "secret-reference", ref: "env:RUNPOD_API_KEY", redacted: "[redacted]" },
		request: {
			mode: "stream",
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" },
			loadBalancedPath: "/v1/chat/completions",
		},
		policy: { maxAttempts: 1, fallbackProfiles: [] },
	};
}

/** A deterministic ExtensionAPI stand-in that records provider registrations. */
function mockPi() {
	const registrations: Array<{ name: string; config: ProviderConfig }> = [];
	const setModelCalls: unknown[] = [];
	const pi = {
		registerProvider(name: string, config: ProviderConfig): void {
			registrations.push({ name, config });
		},
		setModel(model: unknown): Promise<boolean> {
			setModelCalls.push(model);
			return Promise.resolve(true);
		},
	} as unknown as ExtensionAPI;
	return { pi, registrations, setModelCalls };
}

describe("registerRunpodProvider", () => {
	test("registers exactly one provider named runpod and never calls setModel", () => {
		const { pi, registrations, setModelCalls } = mockPi();
		registerRunpodProvider(pi, {
			[QUEUE_PROFILE_NAME]: queueProfile(),
			[LB_PROFILE_NAME]: lbProfile(),
		});

		expect(registrations.length).toBe(1);
		expect(registrations[0]!.name).toBe("runpod");
		expect(setModelCalls.length).toBe(0);
	});

	test("registers one model per profile: id is the profile name, metadata copied", () => {
		const { pi, registrations } = mockPi();
		const profiles = {
			[QUEUE_PROFILE_NAME]: queueProfile(),
			[LB_PROFILE_NAME]: lbProfile(),
		};
		registerRunpodProvider(pi, profiles);

		const config = registrations[0]!.config;
		expect(config.models).toBeDefined();
		const models = config.models!;
		expect(models).toHaveLength(2);

		const byId: Record<string, ProviderModelConfig> = {};
		for (const model of models) {
			byId[model.id] = model;
		}
		expect(Object.keys(byId).sort()).toEqual([QUEUE_PROFILE_NAME, LB_PROFILE_NAME].sort());

		for (const [profileName, profile] of Object.entries(profiles)) {
			const model = byId[profileName];
			expect(model).toBeDefined();

			// The registered id is the profile name, not the served model id.
			expect(model!.id).toBe(profileName);
			expect(model!.id).not.toBe(profile.model.id);
			expect(model!.name).toBe(profile.model.name);
			expect(model!.api).toBe("runpod-queue");

			// Profile model metadata is copied verbatim (Runpod is time-billed,
			// so the registered OMP cost is always the zero structure).
			expect(model!.contextWindow).toBe(profile.model.contextWindow);
			expect(model!.maxTokens).toBe(profile.model.maxTokens);
			expect(model!.reasoning).toBe(profile.model.reasoning);
			expect(model!.input).toEqual(profile.model.input);
			expect(model!.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});

	test("carries the provider-level placeholders: api, apiKey, and a valid baseUrl", () => {
		const { pi, registrations } = mockPi();
		registerRunpodProvider(pi, { [QUEUE_PROFILE_NAME]: queueProfile() });

		const config = registrations[0]!.config;
		expect(config.api).toBe("runpod-queue");
		expect(config.apiKey).toBe("RUNPOD_API_KEY");

		// baseUrl is a placeholder but must parse as an absolute http(s) URL.
		expect(typeof config.baseUrl).toBe("string");
		const url = new URL(config.baseUrl!);
		expect(["http:", "https:"]).toContain(url.protocol);
	});

	test("an empty profile set still registers the provider once with no models", () => {
		const { pi, registrations } = mockPi();
		registerRunpodProvider(pi, {});

		expect(registrations.length).toBe(1);
		expect(registrations[0]!.name).toBe("runpod");
		expect(registrations[0]!.config.models).toEqual([]);
	});
});

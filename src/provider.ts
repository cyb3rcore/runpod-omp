/**
 * Runpod OMP provider registration.
 *
 * Registers exactly one `runpod` provider in a single `registerProvider` call,
 * with one `ProviderModelConfig` per merged Runpod profile. A model's `id` is
 * its profile name (never the served model id), so selecting `runpod/<profile>`
 * in OMP's native model picker selects that profile.
 *
 * Every model shares the plugin-owned custom api id `runpod-queue`, which
 * labels the custom transport rather than implying queue semantics. A single
 * `streamSimple` dispatcher resolves the profile strictly by `model.id` and
 * routes the call to the real queue or load-balanced transport by
 * `profile.endpointType`. `pi.setModel` is never called here: model selection
 * stays with OMP.
 *
 * The provider-level `baseUrl` and `apiKey` are registration placeholders.
 * Dispatch never consults the base URL (each profile carries its own
 * `invokeUrl`), and OMP resolves the `RUNPOD_API_KEY` env-var reference into
 * the key delivered to `streamSimple` as `options.apiKey`, which the transport
 * layer uses to authenticate.
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	resolveApiKeyOnce,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Message,
	type SimpleStreamOptions,
	type TextContent,
} from "@oh-my-pi/pi-ai";
import { resolveProfileApiKey } from "./config.js";
import type { Profile } from "./profile-schema.js";
import { executeLoadBalancedTransport } from "./transport/load-balanced.js";
import { executeQueueTransport } from "./transport/queue.js";
import type {
	NormalizedMessage,
	NormalizedRequest,
	TransportExecutionResult,
} from "./transport/types.js";

/** Custom api id shared by every profile model; labels the plugin-owned transport. */
const RUNPOD_API_ID = "runpod-queue";

/**
 * Env-var reference installed at provider level. OMP resolves it through the
 * auth store and delivers the value to `streamSimple` as `options.apiKey`.
 */
const RUNPOD_API_KEY_REF = "RUNPOD_API_KEY";

/**
 * Provider-level baseUrl placeholder required for model registration. It is
 * never consulted by the dispatcher — routing comes from each profile's
 * `invokeUrl` — so it exists only to satisfy OMP's registration validation.
 */
const RUNPOD_PROVIDER_BASE_URL = "https://api.runpod.ai/v2/runpod-omp-placeholder";

/** Marker substituted for identity-bearing values in error messages. */
const REDACTED = "[redacted]";

/**
 * Build one registered model per merged profile. Model metadata is copied
 * verbatim from the profile; only the `id` is the profile name and `api` is
 * pinned to the plugin-owned custom api id.
 *
 * Model `compat` is intentionally omitted: for a custom api id,
 * `ProviderModelConfig["compat"]` resolves to `undefined` (`CompatConfigOf<Api>`
 * only matches the built-in wire APIs), and the compat vocabulary governs the
 * built-in transports this provider does not use — the custom transport owns
 * its wire semantics. Tool/vision capability stays on the profile
 * (`supportsTools`, `supportsVision`, and the `input` array, which is
 * schema-validated to "text"/"image" only) for the transport layer; there is
 * no supported `compat` field that carries them. No provider-level `compat`
 * exists on `ProviderConfig`, so none is set.
 */
function buildModels(profiles: Record<string, Profile>): ProviderModelConfig[] {
	const models: ProviderModelConfig[] = [];
	for (const [profileName, profile] of Object.entries(profiles)) {
		models.push({
			id: profileName,
			name: profile.model.name,
			api: RUNPOD_API_ID,
			reasoning: profile.model.reasoning,
			// Profile schema validates every entry as "text" or "image".
			input: profile.model.input as ("text" | "image")[],
			// OMP requires a structural per-million-token cost; Runpod
			// serverless is time-billed, so zeros state the truth (real cost
			// surfaces live in `/runpod cost` and the status line).
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: profile.model.contextWindow,
			maxTokens: profile.model.maxTokens,
		});
	}
	return models;
}

/** Extract the plain-text projection of a message's content blocks. */
function extractMessageText(content: string | readonly unknown[]): string {
	if (typeof content === "string") {
		return content;
	}
	const blocks: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			blocks.push(part);
		} else if (part !== null && typeof part === "object") {
			const candidate = part as { type?: unknown; text?: unknown };
			if (candidate.type === "text" && typeof candidate.text === "string") {
				blocks.push(candidate.text);
			}
		}
	}
	return blocks.join("\n");
}

/**
 * Map one OMP message to the transport's normalized role/content vocabulary.
 * Image and tool-call parts are the wiring module's concern; this is the
 * faithful text projection the transport adapters encode.
 */
function normalizeMessage(message: Message): NormalizedMessage {
	switch (message.role) {
		case "user":
		case "developer":
			return {
				role: message.role === "developer" ? "system" : "user",
				content: extractMessageText(message.content),
			};
		case "assistant":
			return { role: "assistant", content: extractMessageText(message.content) };
		case "toolResult":
			return { role: "tool", content: extractMessageText(message.content), name: message.toolName };
		default: {
			// Every Message role is handled above, so `message` is `never` here;
			// binding it (not a property of it) keeps the exhaustiveness check.
			const exhaustive: never = message;
			throw new Error(`runpod provider: unsupported message role ${String(exhaustive)}`);
		}
	}
}

/**
 * Build the normalized request handed to a transport: the served model id
 * from the profile, the text projection of the conversation, and the
 * stream/sampling preferences. `stream` mirrors the profile's declared mode;
 * the transport decides how to honor it.
 */
function buildNormalizedRequest(
	profile: Profile,
	context: Context,
	options: SimpleStreamOptions | undefined,
): NormalizedRequest {
	const request: NormalizedRequest = {
		model: profile.model.id,
		messages: context.messages.map(normalizeMessage),
		stream: profile.request.mode === "stream",
	};
	if (options?.temperature !== undefined) {
		request.temperature = options.temperature;
	}
	if (options?.maxTokens !== undefined) {
		request.maxTokens = options.maxTokens;
	}
	return request;
}

/**
 * The default stream builder's injectable surface: the queue/load-balanced
 * transports and the key resolver, supplied by tests (recording mocks) or a
 * production wiring module. `executeQueue`/`executeLoadBalanced` forward the
 * resolved key and the caller's signal (mirroring `TransportDeps.apiKey` /
 * `TransportDeps.signal`) so transports can authenticate and honor aborts.
 */
export interface RunpodStreamDeps {
	executeQueue(
		profile: Profile,
		request: NormalizedRequest,
		deps?: RunpodStreamTransportDeps,
	): TransportExecutionResult | Promise<TransportExecutionResult>;
	executeLoadBalanced(
		profile: Profile,
		request: NormalizedRequest,
		deps?: RunpodStreamTransportDeps,
	): TransportExecutionResult | Promise<TransportExecutionResult>;
	resolveApiKey(
		options: SimpleStreamOptions | undefined,
		profile: Profile,
	): string | undefined | Promise<string | undefined>;
}

/** Transport deps forwarded from the stream builder. */
export interface RunpodStreamTransportDeps {
	apiKey?: string;
	signal?: AbortSignal;
}

/**
 * Fresh, redacted error surfaced to a failed stream. The message is fixed
 * prose carrying the `REDACTED` marker — never the raw model id, key, or
 * transport error bytes. The original error survives only as `cause`, out of
 * reach of the surfaced `.message`.
 */
function redactRunpodError(cause: unknown): Error {
	const message = `runpod provider: request failed: ${REDACTED}`;
	return new Error(message, { cause });
}

/**
 * Replay a normalized transport result as a valid OMP assistant event
 * sequence: a `start`, one text_start/text_delta/text_end triple per text
 * block, and a terminal `done` event whose message carries the assembled
 * text content, the mapped usage (`input`/`output`/`cacheRead`/`cacheWrite`/
 * `totalTokens`), and `stopReason: "stop"`. Partial metadata always carries
 * the provider (`runpod`), model id, and API id so consumers can attribute
 * the turn.
 */
function replayRunpodStream(
	stream: AssistantMessageEventStream,
	result: TransportExecutionResult,
	profile: Profile,
): void {
	// Ordered text blocks: a non-stream response yields its single text; a
	// streamed result yields each text unit (and its usage) in arrival order.
	const texts: string[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	let totalTokens = 0;

	if (result.response !== undefined) {
		texts.push(result.response.text);
		const usage = result.response.usage;
		if (usage !== undefined) {
			inputTokens = usage.inputTokens;
			outputTokens = usage.outputTokens;
			totalTokens = usage.totalTokens;
		}
	} else {
		for (const event of result.events) {
			if (event.type === "text") {
				texts.push(event.text);
			} else if (event.type === "usage") {
				inputTokens = event.usage.inputTokens;
				outputTokens = event.usage.outputTokens;
				totalTokens = event.usage.totalTokens;
			}
		}
	}

	const content: TextContent[] = texts.map((text) => ({ type: "text", text }));
	const partial: AssistantMessage = {
		role: "assistant",
		content,
		api: RUNPOD_API_ID,
		provider: "runpod",
		model: profile.model.id,
		usage: {
			input: inputTokens,
			output: outputTokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	stream.push({ type: "start", partial });

	content.forEach((block, contentIndex) => {
		stream.push({ type: "text_start", contentIndex, partial });
		stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
		stream.push({ type: "text_end", contentIndex, content: block.text, partial });
	});

	stream.push({ type: "done", reason: "stop", message: partial });
}

/**
 * Build the OMP `streamSimple`-shaped default stream dispatcher for the given
 * merged profiles. This is the real stream path: it normalizes `Context` +
 * `SimpleStreamOptions` into a `NormalizedRequest`, resolves the effective
 * key, routes strictly by `profile.endpointType` to the injected transport,
 * and replays the normalized result as a valid assistant event sequence.
 *
 * It always returns a REAL `AssistantMessageEventStream` — never a plain
 * value or a synchronous throw. Unknown model ids, key-resolution failures,
 * and transport failures are each surfaced asynchronously via
 * `stream.fail(...)` with a redacted error, and no dispatch happens before
 * its preceding step has succeeded. Profile lookup is an own-key read on the
 * `Record`; routing consumes only `profile.endpointType` and no provider-level
 * endpoint configuration.
 */
export function createRunpodStream(
	profiles: Record<string, Profile>,
	deps: RunpodStreamDeps,
): (
	model: { id: string },
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		void run();
		return stream;

		async function run(): Promise<void> {
			try {
				// Own-key lookup strictly by model.id; never inherited keys.
				const profile = Object.hasOwn(profiles, model.id) ? profiles[model.id] : undefined;
				if (profile === undefined) {
					throw new Error(
						"runpod provider: unknown model id — no configured Runpod profile matches; run /runpod doctor to inspect the merged profile configuration",
					);
				}
				const request = buildNormalizedRequest(profile, context, options);
				const apiKey = await deps.resolveApiKey(options, profile);
				const transportDeps: RunpodStreamTransportDeps = {};
				if (apiKey !== undefined) {
					transportDeps.apiKey = apiKey;
				}
				if (options?.signal !== undefined) {
					transportDeps.signal = options.signal;
				}

				const result =
					profile.endpointType === "queue"
						? await deps.executeQueue(profile, request, transportDeps)
						: await deps.executeLoadBalanced(profile, request, transportDeps);

				replayRunpodStream(stream, result, profile);
			} catch (error) {
				stream.fail(redactRunpodError(error));
			}
		}
	};
}

/**
 * Default production dependencies for createRunpodStream: the real queue and
 * load-balanced transports plus the profile key resolver. The resolver is fed
 * the OMP key (`options.apiKey`) ahead of the env fallback (`RUNPOD_API_KEY`)
 * and a local redacted shell runner for `!command` references, per the
 * resolver's documented precedence.
 */
function createDefaultStreamDeps(): RunpodStreamDeps {
	return {
		executeQueue: (profile, request, deps) => executeQueueTransport(profile, request, deps),
		executeLoadBalanced: (profile, request, deps) =>
			executeLoadBalancedTransport(profile, request, deps),
		resolveApiKey: async (options, profile) => {
			const ompApiKey = await resolveApiKeyOnce(options?.apiKey, options?.signal);
			return resolveProfileApiKey(profile, {
				ompApiKey,
				env: process.env,
				runCommand: runCommandReference,
			});
		},
	};
}

/**
 * Run a profile `!command` key reference through a local shell and capture
 * stdout. Resolves with the stdout for a successful invocation that produced
 * output; rejects with a generic error — never the command or its output — on
 * nonzero exit or empty output. `resolveProfileApiKey` catches any rejection
 * and rethrows a redacted error.
 */
function runCommandReference(command: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		execFile("/bin/sh", ["-c", command], (error, stdout) => {
			if (error) {
				reject(new Error("runpod provider: command reference failed to execute"));
				return;
			}
			if (stdout.trim() === "") {
				reject(new Error("runpod provider: command reference produced no output"));
				return;
			}
			resolve(stdout);
		});
	});
}

/**
 * Register the `runpod` provider. Exactly one `registerProvider` call happens;
 * an empty profile map still registers the provider once with no models.
 *
 * `streamSimple` wires to the real transports (`createRunpodStream` over
 * `executeQueueTransport` / `executeLoadBalancedTransport` and
 * `resolveProfileApiKey`), so dispatch actually reaches a Runpod endpoint.
 *
 * @param pi the extension API surface
 * @param profiles merged profile map (profile name → Profile)
 */
export function registerRunpodProvider(
	pi: ExtensionAPI,
	profiles: Record<string, Profile>,
): void {
	const models = buildModels(profiles);

	// Build the default stream dispatcher once, so every dispatch shares the
	// same transports, key resolver, and runner.
	const defaultStream = createRunpodStream(profiles, createDefaultStreamDeps());

	pi.registerProvider("runpod", {
		api: RUNPOD_API_ID,
		apiKey: RUNPOD_API_KEY_REF,
		baseUrl: RUNPOD_PROVIDER_BASE_URL,
		models,
		streamSimple: (model, context, options) => {
			// Always a REAL AssistantMessageEventStream: unknown ids,
			// key-resolution failures, and transport failures surface
			// asynchronously via stream.fail (redacted).
			return defaultStream(model, context, options);
		},
	});
}

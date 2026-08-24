/**
 * @cyb3rcore/runpod-omp — OMP extension factory.
 *
 * The factory performs its registration work eagerly during its (async)
 * evaluation, because OMP consumes provider and command registrations
 * immediately after extension factories finish loading — before
 * `session_start` ever fires. At load time it resolves the agent directory
 * and the project cwd, loads and merges the global
 * (`<agentDir>/runpod.yml`) and project (`<cwd>/.omp/runpod.yml`) profile
 * layers, and registers:
 *
 * - exactly one `runpod` provider, with one model per merged profile;
 * - the `/runpod` slash command; and
 * - the read-only operational tools (`runpod_health`, `runpod_ping`, and
 *   `runpod_status`), adapted onto OMP's `registerTool` surface with a control
 *   dispatcher that defers all profile lookup, network, and key resolution
 *   until a tool execute call.
 *
 * The agent directory comes from the `PI_CODING_AGENT_DIR` override channel
 * (the live equivalent of the documented `getAgentDir()` root export, which
 * this package re-exports from `@oh-my-pi/pi-utils` and which freezes its
 * value at module load), falling back to the canonical agent directory via
 * `getAgentDir()`.
 *
 * The factory performs no runtime actions (`sendMessage`, `setModel`, UI),
 * no network requests, no timers, and no model selection — the only I/O is
 * reading the two approved config files. Malformed profiles are excluded by
 * the loader while their validation errors are retained; a malformed layer
 * never blocks the valid profiles of either layer. The merged profiles and
 * retained validation errors are held in the per-instance runtime state for
 * the later command and status work. Session lifecycle hooks are kept only
 * for runtime cleanup/status — they register nothing.
 */

import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadRunpodProfiles, writeProfileDocument } from "./config.js";
import type { MergedProfiles } from "./config.js";
import { parseProfileDocument } from "./profile-schema.js";
import type {
	EndpointType,
	ModelMetadata,
	Profile,
	ProfileValidationError,
	SecretReference,
} from "./profile-schema.js";
import { registerRunpodProvider } from "./provider.js";
import { registerRunpodCommands } from "./commands.js";
import type {
	CommandNoticeKind,
	CommandProfile,
	ConfigTargetScope,
	RunpodConfigCommandRuntime,
} from "./commands.js";
import { registerRunpodTools } from "./operations.js";
import type {
	RunpodControl,
	RunpodPodProbe,
	RunpodTool,
	RunpodToolDetails,
	ToolRegistrationApi,
} from "./operations.js";
import type { NormalizedPodStatus } from "./control.js";
import { resolvePodHttpAddress, probePodHealth } from "./transport/pod.js";
import type { TransportDeps } from "./transport/types.js";
import { RUNPOD_CONTROL_BASE, executeControl } from "./control.js";
import { createCostService } from "./cost.js";
import type { CostService } from "./cost.js";
import { registerRunpodLifecycle, runpodStatusText } from "./lifecycle.js";
import type { RunpodSessionContext } from "./lifecycle.js";

/** Display label shown in OMP's extension list. */
const EXTENSION_LABEL = "runpod — Runpod queue, load-balanced & pod provider profiles";

/**
 * Registration hooks for the Runpod feature modules (config, provider,
 * commands). These are the extension's wiring points, satisfied eagerly
 * during the async factory evaluation — OMP consumes provider and command
 * registrations immediately after factories load, so the hooks no longer run
 * from a session lifecycle handler. An absent hook is simply skipped.
 */
export interface RunpodRegistrationHooks {
	/**
	 * Load and merge the global (`<agentDir>/runpod.yml`) and project
	 * (`<cwd>/.omp/runpod.yml`) profile config. Malformed profiles are
	 * excluded internally with their errors retained; a throwing `loadConfig`
	 * degrades to an unregistered provider with the error held in state.
	 * Runs first, before provider registration, so `registerProvider` reads
	 * the merged profiles.
	 */
	loadConfig?: (pi: ExtensionAPI) => Promise<MergedProfiles> | MergedProfiles;
	/**
	 * Register the single `runpod` provider with one model per merged profile.
	 */
	registerProvider?: (pi: ExtensionAPI, profiles: Record<string, Profile>) => void;
	/** Register the `/runpod` command namespace. */
	registerCommands?: (pi: ExtensionAPI, state: RunpodExtensionState) => void;
	/**
	 * Release extension-owned resources (managed timers, in-flight polls) on
	 * `session_shutdown`. `ctx`-managed timers are cleared automatically by the
	 * runtime; this hook covers anything the extension tracked itself.
	 */
	dispose?: () => void | Promise<void>;
}

/** Per-instance runtime state: merged profiles plus retained validation errors. */
export interface RunpodExtensionState {
	/** Valid merged profiles (profile name → Profile) shown to provider and commands. */
	profiles: Record<string, Profile>;
	/** Validation errors retained from either layer, for `/runpod doctor`. */
	errors: ProfileValidationError[];
	/** Epoch ms of the most recent `session_start`; cleared on `session_shutdown`. */
	activeSince?: number;
	/** The extension-level default profile selected via `/runpod profile <name>`. */
	defaultProfile?: string;
	/** Stop function for the active session's status-line refresh; set on start, cleared on shutdown. */
	statusRefresherStop?: () => void;
}

/**
 * Default model metadata used by the guided configure/profile-add prompt when
 * no model is chosen interactively (the plan defines no model-level defaults,
 * so a fixed, valid model keeps the written document schema-valid).
 */
const DEFAULT_GUIDED_MODEL: ModelMetadata = {
	id: "meta-llama/llama-3.3-70b-instruct",
	name: "Llama 3.3 70B Instruct",
	contextWindow: 131_072,
	maxTokens: 8_192,
	reasoning: false,
	input: ["text"],
	supportsTools: true,
	supportsVision: false,
};

/**
 * Structural view of the OMP command context the config runtime reads: just
 * the reduced fields it needs (`hasUI`, `cwd`, and the `ui` surface). The real
 * `ExtensionCommandContext` satisfies this shape, and so does the test double.
 * Every field is read defensively and narrowed so no value is trusted blindly.
 */
interface CommandContextShape {
	hasUI?: unknown;
	cwd?: unknown;
	ui?: {
		select?: (title: string, options: unknown[]) => unknown;
		input?: (title: string, placeholder?: string) => unknown;
		confirm?: (title: string, message: string) => unknown;
		notify?: (message: string, type?: string) => void;
	};
}

/** Narrow an `unknown` command context to its readable shape. */
function narrowCommandContext(ctx: unknown): CommandContextShape {
	if (typeof ctx !== "object" || ctx === null) {
		return {};
	}
	return ctx as CommandContextShape;
}

/**
 * Build a context-aware {@link RunpodConfigCommandRuntime} for one command
 * dispatch, bound to the current OMP command context. Guided config drives the
 * context's UI (scope/endpoint selects, value inputs, confirmation) and routes
 * notices through `ctx.ui.notify`; in headless/print mode (`hasUI` false) no
 * interactive method is called and guided flows fail closed. All file paths
 * derive from the injected agent directory and the context's `cwd`, config is
 * written atomically, and state is reloaded in place so the command-visible
 * profile list reflects a write immediately. Provider re-registration is a
 * restart-required no-op (OMP cannot make new native models live mid-session).
 */
function buildConfigRuntime(
	state: RunpodExtensionState,
	pi: ExtensionAPI,
	agentDir: string,
	ctx: unknown,
	costService: CostService,
): RunpodConfigCommandRuntime {
	const context = narrowCommandContext(ctx);
	const hasUI = context.hasUI === true;
	const ui = context.ui ?? {};
	const cwd = typeof context.cwd === "string" && context.cwd !== "" ? context.cwd : process.cwd();
	const globalPath = join(agentDir, "runpod.yml");
	const projectPath = join(cwd, ".omp", "runpod.yml");

	const notify = (message: string, kind: CommandNoticeKind = "info"): void => {
		if (typeof ui.notify === "function") {
			// OMP's notify type is info/warning/error — collapse "success" to
			// "info" rather than passing an unsupported type.
			ui.notify(message, kind === "error" ? "error" : "info");
		} else {
			pi.logger.info(`[runpod] ${kind}: ${message}`);
		}
	};

	return {
		listProfiles(): CommandProfile[] {
			const list: CommandProfile[] = [];
			for (const [name, profile] of Object.entries(state.profiles)) {
				list.push({ name, endpointType: profile.endpointType });
			}
			return list;
		},
		getDefaultProfile(): string | null {
			return state.defaultProfile ?? null;
		},
		async setDefaultProfile(name) {
			if (!Object.hasOwn(state.profiles, name)) {
				throw new Error(`Unknown profile: ${name}.`);
			}
			state.defaultProfile = name;
		},
		async confirm(prompt) {
			if (!hasUI || typeof ui.confirm !== "function") {
				// Headless/print convention: nothing can confirm, so fail closed.
				return false;
			}
			return (await ui.confirm("Runpod configuration", prompt)) === true;
		},
		async deleteProfile(name) {
			delete state.profiles[name];
			if (state.defaultProfile === name) {
				delete state.defaultProfile;
			}
		},
		async runQueueMutation(profileName, operation, jobId) {
			if (operation !== "purge" && jobId === undefined) {
				throw new Error(`Runpod ${operation} requires a job id.`);
			}
			const input =
				operation === "purge" ? { operation } : { operation, jobId };
			const outcome = await createControlWrapper(state.profiles)(profileName, input);
			if (!outcome.ok) {
				throw new Error(outcome.supported ? outcome.detail : outcome.reason);
			}
		},
		async runCost(profileName) {
			const profile = state.profiles[profileName];
			if (profile === undefined) {
				throw new Error(`Unknown profile: ${profileName}.`);
			}
			return costService.report(profileName, profile.endpointType);
		},
		async runPodOperation(profileName, operation) {
			const outcome = await createControlWrapper(state.profiles)(profileName, { operation });
			if (!outcome.ok) {
				throw new Error(outcome.supported ? outcome.detail : outcome.reason);
			}
			if (!("pod" in outcome) || outcome.operation !== operation) {
				throw new Error("Unexpected control outcome.");
			}
			return outcome.pod;
		},
		// The probe reads the live `state.profiles` at call time so a config
		// reload immediately affects pod status reports.
		podProbe: (profileName) => createPodProbe(state.profiles)(profileName),
		notify,
		configPath(scope: ConfigTargetScope): string {
			return scope === "global" ? globalPath : projectPath;
		},
		async askTargetScope() {
			if (!hasUI || typeof ui.select !== "function") {
				return "global";
			}
			const label = await ui.select("Which layer should this runpod profile target?", [
				{ label: "global", description: "Shared agent directory (all projects)" },
				{ label: "project", description: "This project (.omp/runpod.yml)" },
			]);
			return typeof label === "string" && label.toLowerCase() === "project"
				? "project"
				: "global";
		},
		async askConfigValues(profileName) {
			const name = profileName ?? "default";
			if (!hasUI || typeof ui.select !== "function" || typeof ui.input !== "function") {
				return { cancelled: true };
			}
			const endpointLabel = await ui.select(
				"Endpoint type for this runpod profile",
				[
					{ label: "queue", description: "Async queue endpoint (job-based)" },
					{ label: "load-balanced", description: "Sync load-balanced HTTP endpoint" },
					{
						label: "pod",
						description: "Dedicated Runpod pod (public TCP address auto-derived)",
					},
				],
			);
			const normalizedEndpoint =
				typeof endpointLabel === "string" ? endpointLabel.toLowerCase() : "";
			const endpointType: EndpointType =
				normalizedEndpoint === "load-balanced"
					? "load-balanced"
					: normalizedEndpoint === "pod"
						? "pod"
						: "queue";
			const invokeUrl = await ui.input(
				"Runpod endpoint invoke URL (optional for pods; empty = auto-derived TCP address)",
			);
			if (
				endpointType !== "pod" &&
				(typeof invokeUrl !== "string" || invokeUrl.trim() === "")
			) {
				// Incomplete prompt: fail closed with no write.
				return { cancelled: true };
			}
			const apiKeyRef = await ui.input(
				"Runpod API key reference (env:VAR, !cmd, or literal; empty for none)",
			);
			const ref = typeof apiKeyRef === "string" ? apiKeyRef.trim() : "";
			let pod: { id: string; port: number; inferenceApiKeyRef: string | null } | undefined;
			if (endpointType === "pod") {
				const podId = await ui.input("Runpod pod id (e.g. pod_abc123)");
				if (typeof podId !== "string" || podId.trim() === "") {
					return { cancelled: true };
				}
				const portInput = await ui.input("Internal llama.cpp port (default 8000)");
				const port =
					typeof portInput === "string" && portInput.trim() !== ""
						? Number.parseInt(portInput.trim(), 10)
						: 8000;
				if (!Number.isInteger(port) || port <= 0) {
					return { cancelled: true };
				}
				const inferenceKeyInput = await ui.input(
					"Pod inference API key reference (env:VAR, !cmd, literal; empty for keyless)",
				);
				const inferenceApiKeyRef =
					typeof inferenceKeyInput === "string" && inferenceKeyInput.trim() !== ""
						? inferenceKeyInput.trim()
						: null;
				pod = { id: podId.trim(), port, inferenceApiKeyRef };
			}
			return {
				cancelled: false,
				values: {
					name,
					endpointType,
					invokeUrl:
						typeof invokeUrl === "string" && invokeUrl.trim() !== ""
							? invokeUrl.trim()
							: undefined,
					model: DEFAULT_GUIDED_MODEL,
					apiKeyRef: ref.length > 0 ? ref : null,
					pod,
				},
			};
		},
		async readConfigLayer(scope) {
			const path = scope === "global" ? globalPath : projectPath;
			let text: string | null;
			try {
				text = await readFile(path, "utf8");
			} catch (cause) {
				if (
					typeof cause === "object" &&
					cause !== null &&
					"code" in cause &&
					cause.code === "ENOENT"
				) {
					text = null;
				} else {
					throw cause;
				}
			}
			if (text === null) {
				return { version: 1, profiles: {} };
			}
			const parsed = parseProfileDocument(text, path);
			return parsed.document ?? { version: 1, profiles: {} };
		},
		async writeConfigLayer(scope, document) {
			const target = scope === "global" ? globalPath : projectPath;
			await mkdir(dirname(target), { recursive: true });
			await writeProfileDocument(target, document);
		},
		async reloadConfig() {
			const merged = await loadRunpodProfiles({ agentDir, cwd });
			state.profiles = merged.profiles;
			state.errors = merged.errors;
		},
		async reRegisterProviders() {
			// OMP consumes native provider models only while extension factories
			// load; a config write cannot make new models live mid-session. Emit a
			// restart/refresh-required notice instead of an ineffective dynamic
			// registration — pi.setModel/registerProvider are never called here.
			notify(
				"Runpod profile saved. Restart (or refresh) this session so OMP reloads the runpod provider models.",
				"info",
			);
		},
		async loadDoctorReport() {
			return {
				globalPath,
				projectPath,
				profiles: Object.entries(state.profiles).map(([name, profile]) => ({
					name,
					apiKeyRef: profile.apiKey?.ref ?? null,
				})),
				errors: state.errors.map((error) => ({
					path: error.sourcePath,
					message: error.message,
				})),
			};
		},
	};
}

/** Adapt a read-only Runpod tool onto OMP's `registerTool` surface. */
function adaptTool(tool: RunpodTool): ToolDefinition<typeof tool.parameters, RunpodToolDetails> {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		approval: "read",
		execute: (toolCallId, params) =>
			tool.execute(toolCallId, params, undefined, undefined, undefined),
	};
}

/** Narrow ToolRegistrationApi adapter backed by OMP's `ExtensionAPI.registerTool`. */
function adaptToolApi(pi: ExtensionAPI): ToolRegistrationApi {
	return {
		registerTool: (tool) => {
			pi.registerTool(adaptTool(tool));
		},
	};
}

/**
 * Synchronously resolve a secret reference to a key for direct control
 * operations: `env:NAME` looks up `NAME` in the process environment, any
 * other reference resolves environment-first then as a literal. The value is
 * handed only to the control layer's redacted execution — it is never logged
 * or surfaced, and an unresolvable reference yields `undefined` so the control
 * layer reports a redacted failure.
 */
function resolveControlKey(ref: SecretReference): string | undefined {
	if (ref.ref.startsWith("env:")) {
		const name = ref.ref.slice("env:".length);
		if (name === "") {
			return undefined;
		}
		const value = process.env[name];
		return value !== undefined && value !== "" ? value : undefined;
	}
	const envValue = process.env[ref.ref];
	return envValue !== undefined && envValue !== "" ? envValue : ref.ref;
}

/**
 * Resolve a pod profile's control key: the profile's own reference first,
 * then the `RUNPOD_API_KEY` env fallback (mirroring the provider-level key
 * precedence). Used only for the pod API address lookup; never forwarded to
 * the worker.
 */
function resolvePodControlKey(profile: Profile): string | undefined {
	if (profile.apiKey !== undefined) {
		return resolveControlKey(profile.apiKey);
	}
	const fallback = process.env.RUNPOD_API_KEY;
	return fallback !== undefined && fallback !== "" ? fallback : undefined;
}

/**
 * Build the pod probe used by the `runpod_pod` tool and `/runpod pod` report:
 * resolve the worker's HTTP address (control key), then probe `/health` with
 * the inference token. Never throws; failures carry a deterministic reason.
 */
function createPodProbe(profiles: Record<string, Profile>): RunpodPodProbe {
	return async (profileName) => {
		const profile = profiles[profileName];
		if (profile === undefined) {
			return {
				health: "unhealthy",
				reason: "No profile matched the supplied profile name.",
			};
		}
		const deps: TransportDeps = { apiKey: resolvePodControlKey(profile) };
		try {
			const address = await resolvePodHttpAddress(profile, deps);
			const health = await probePodHealth(profile, deps);
			return { address, health };
		} catch (error) {
			return {
				health: "unhealthy",
				reason:
					error instanceof Error && error.message.length > 0
						? error.message
						: "pod probe failed",
			};
		}
	};
}

/**
 * Build the control dispatcher the tool layer is wired with. It resolves the
 * target profile by name ONLY when a tool execute handler runs — at factory
 * time nothing is looked up, fetched, or key-resolved. An unknown profile
 * name yields a safe unsupported outcome with zero network or key work.
 */
function createControlWrapper(profiles: Record<string, Profile>): RunpodControl {
	return async (profileName, input) => {
		const profile = profiles[profileName];
		if (profile === undefined) {
			return {
				ok: false,
				operation: input.operation,
				supported: false,
				reason: "No profile matched the supplied profile name.",
			};
		}
		return executeControl(
			{
				endpointType: profile.endpointType,
				// Pod profiles carry no static invokeUrl; their control ops use
				// the explicit pod id, so an empty string is never consulted.
				invokeUrl: profile.invokeUrl ?? "",
				apiKey: profile.apiKey,
				controlBaseUrl: RUNPOD_CONTROL_BASE,
			},
			input,
			{ fetch: globalThis.fetch, resolveKey: resolveControlKey },
		);
	};
}

/**
 * Structural view of the session model the active-profile adapter reads from
 * an OMP context: a real `Model` object narrowed to just the two fields used
 * here (`provider` and `id`). Nothing else on the model is inspected.
 */
interface ActiveModelShape {
	provider: unknown;
	id: unknown;
}

/**
 * The session context as the active-profile adapter reads it: the reduced
 * `RunpodSessionContext` plus the two tolerated shapes — the real OMP `model`
 * object (`{ provider, id }`) and a `currentModel` string of the form
 * `runpod/<profile>` used by test doubles and minimal adapter hosts. Both are
 * optional, so every runpod session context satisfies this shape.
 */
interface ActiveProfileContext extends RunpodSessionContext {
	model?: unknown;
	currentModel?: unknown;
}

/** Narrow `model` to a runpod `Model`'s id, or reject any other provider/unknown. */
function isRunpodModel(model: unknown): model is { id: string } {
	if (typeof model !== "object" || model === null) return false;
	const candidate = model as ActiveModelShape;
	return (
		candidate.provider === "runpod" &&
		typeof candidate.id === "string" &&
		candidate.id !== ""
	);
}

/**
 * Parse a test-double `currentModel` value of the form `runpod/<profile>`
 * into its profile id. Returns `undefined` for anything that is not a runpod
 * model id — so a non-runpod active model never resolves to a profile.
 */
function activeProfileIdFromCurrentModel(currentModel: string): string | undefined {
	if (!currentModel.startsWith("runpod/")) return undefined;
	const id = currentModel.slice("runpod/".length);
	return id === "" ? undefined : id;
}

/**
 * Map a candidate profile id to itself only when it names a configured
 * profile; anything unknown (or absent) maps to `undefined`. This keeps the
 * status line naming only known runpod profiles.
 */
function configuredProfileId(
	profiles: Record<string, Profile>,
	id: string | undefined,
): string | undefined {
	return id !== undefined && Object.hasOwn(profiles, id) ? id : undefined;
}

/**
 * OMP extension factory. During its (async) evaluation it loads and merges
 * the profile config, registers the single `runpod` provider, the `/runpod`
 * command, and the read-only operational tools, and wires the session
 * lifecycle handlers. No runtime action, network request, timer, UI, or
 * model selection runs here — the only I/O is reading the two approved config
 * files; the tools' fetch/key work is deferred to tool execution.
 */
export default async function runpodExtension(pi: ExtensionAPI): Promise<void> {
	pi.setLabel(EXTENSION_LABEL);

	const state: RunpodExtensionState = { profiles: {}, errors: [] };

	// Resolve the agent directory once; it seeds every config layer path and
	// reload for the command runtime for the lifetime of this extension.
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();

	// Load and merge the profile layers. A malformed layer already degrades
	// inside the loader (valid profiles kept, errors retained); a hard load
	// failure degrades to an unregistered provider with the error retained so
	// the extension still loads and the command surface stays available.
	let merged: MergedProfiles;
	try {
		merged = await loadRunpodProfiles({
			agentDir,
			cwd: process.cwd(),
		});
	} catch (error) {
		merged = {
			profiles: {},
			errors: [
				{
					sourcePath: "runpod profile config",
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
	state.profiles = merged.profiles;
	state.errors = merged.errors;

	// OMP consumes these registrations immediately after the factory resolves,
	// so they run here, during evaluation — never from a session handler.
	registerRunpodProvider(pi, state.profiles);
	// A context-bound runtime factory: each `/runpod` dispatch builds a config
	// runtime bound to that invocation's command context, so guided configure/
	// doctor drive the real UI and config IO, while the pure profile/cancel
	// surface keeps working. The runtime reads the shared `state`, so a config
	// write + reload immediately updates the command-visible profile list.
	//
	// The cost service is created once so its price/worker caches survive
	// dispatches, but its control dispatcher resolves the profile through the
	// live `state.profiles` at call time — a config reload replaces that
	// object, and `/runpod cost` must see the new profiles immediately.
	const costService = createCostService(async (profileName, input) =>
		createControlWrapper(state.profiles)(profileName, input),
	);
	registerRunpodCommands(pi, (ctx) =>
		buildConfigRuntime(state, pi, agentDir, ctx, costService),
	);

	// Register the read-only operational tools, adapted onto OMP's
	// `registerTool` surface. Their control dispatcher defers all profile
	// lookup, network, and key resolution until a tool execute call. The pod
	// probe (readiness + address) is wired only when a pod profile exists.
	registerRunpodTools(
		adaptToolApi(pi),
		state.profiles,
		createControlWrapper(state.profiles),
		createPodProbe(state.profiles),
	);

	// Map the active session model to the configured runpod profile id. It
	// reads the real OMP `ctx.model` (a `Model` object) and tolerates the
	// `currentModel` string shape used by test doubles/adapter hosts; the
	// result is `undefined` for any non-runpod or unconfigured profile so the
	// lifecycle never guesses or leaks.
	const getActiveProfileId = (ctx: RunpodSessionContext): string | undefined => {
		const wide = ctx as ActiveProfileContext;
		if (isRunpodModel(wide.model)) {
			return configuredProfileId(state.profiles, wide.model.id);
		}
		if (typeof wide.currentModel === "string") {
			return configuredProfileId(
				state.profiles,
				activeProfileIdFromCurrentModel(wide.currentModel),
			);
		}
		return undefined;
	};

	// Session status text: the profile name plus a live burn-rate estimate
	// when one can be computed. Never throws — a failing estimate or no active
	// workers yields the profile-only line so the status bar never errors.
	const buildStatusText = async (profileId: string): Promise<string> => {
		const estimate = await costService.estimate(profileId);
		if ("error" in estimate || estimate.totalWorkers === 0) {
			return runpodStatusText(profileId);
		}
		return `Runpod profile: ${profileId} · est $${estimate.ratePerHour.toFixed(2)}/hr`;
	};

	// Register the session lifecycle hooks. Registration itself performs NO UI
	// set, NO status write, NO timer, and NO control/cost action — it only
	// registers the `session_start` / `session_shutdown` handlers.
	registerRunpodLifecycle(pi, state, { getActiveProfileId, buildStatusText });
}

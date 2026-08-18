/**
 * Integration contract for the OMP extension factory — the default export of
 * src/index.ts.
 *
 * OMP consumes provider registrations immediately after extension factories
 * finish loading, before `session_start` fires. The factory MUST therefore
 * load and merge the approved profile config files during its (async)
 * evaluation and call `pi.registerProvider("runpod", ...)` and
 * `pi.registerCommand("runpod", ...)` then — never lazily from a session
 * handler:
 *
 * - global profiles come from `<PI_CODING_AGENT_DIR>/runpod.yml` (the
 *   injected equivalent of `~/.omp/agent/runpod.yml`);
 * - project profiles come from `<cwd>/.omp/runpod.yml`;
 * - project profiles replace same-named global profiles, global-only
 *   profiles keep their positions, and project-only profiles append;
 * - exactly one `runpod` provider is registered, with one model per merged
 *   profile (model id = profile name, metadata copied from the profile);
 * - malformed profiles are excluded from the registration without blocking
 *   the valid ones;
 * - the `/runpod` command registers during factory evaluation;
 * - runtime actions (`sendMessage`, `setModel`, UI), network requests, and
 *   timers never run during factory evaluation — the only I/O is reading the
 *   two approved config files.
 *
 * These tests intentionally fail against the current registration-only
 * shell, which defers config loading and provider/command registration to
 * `session_start`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";

import runpodExtension from "../src/index.js";
import type {
	ExtensionAPI,
	ExtensionFactory,
	ProviderConfig,
} from "@oh-my-pi/pi-coding-agent";

/** One `pi.registerProvider` call as recorded by the mock. */
interface RecordedProvider {
	name: string;
	config: ProviderConfig;
}

/** One `pi.registerCommand` call as recorded by the mock. */
interface RecordedCommand {
	name: string;
	description: string | undefined;
	handler: unknown;
}

/** One `pi.on` call as recorded by the mock. */
interface RecordedEvent {
	event: string;
	handler: unknown;
}

/** One `pi.registerTool` call as recorded by the mock. */
interface RecordedTool {
	name: string;
	approval: string;
	/** The registration-time execute handler, wrapped as an invocation spy. */
	execute: unknown;
}

/** Every call the mock ExtensionAPI observed during factory evaluation. */
interface CallLog {
	labels: string[];
	providers: RecordedProvider[];
	commands: RecordedCommand[];
	events: RecordedEvent[];
	tools: RecordedTool[];
	/** Names of tool execute handlers invoked during factory evaluation. */
	toolExecutions: string[];
	/** Names of runtime-action members the factory must never touch. */
	runtimeActions: string[];
}

/**
 * Deterministic ExtensionAPI stand-in: records the registration surface
 * (setLabel/registerProvider/registerCommand/registerTool/on) and throws on
 * every runtime action, so a factory that touches the session at load time
 * fails the test naming the offending member. The direct OMP mock cast is
 * confined to this helper, inside the test file only.
 */
function createMockPi(log: CallLog): ExtensionAPI {
	const throwRuntimeAction = (name: string): (() => never) => () => {
		log.runtimeActions.push(name);
		throw new Error(`runpod factory called runtime action ${name} during evaluation`);
	};
	const pi = {
		logger: {
			debug: (): void => {},
			info: (): void => {},
			warn: (): void => {},
			error: (): void => {},
		},
		setLabel(label: string): void {
			log.labels.push(label);
		},
		registerProvider(name: string, config: ProviderConfig): void {
			log.providers.push({ name, config });
		},
		registerCommand(name: string, options: { description?: string; handler: unknown }): void {
			log.commands.push({ name, description: options.description, handler: options.handler });
		},
		registerTool(tool: { name: string; approval: string; execute: unknown }): void {
			// Wrap the execute handler as an invocation spy so a factory that
			// runs tool logic at load time is caught by the toolExecutions
			// assertion rather than silently executing unseen.
			const execute = tool.execute as (...args: unknown[]) => unknown;
			const spied = (...args: unknown[]): unknown => {
				log.toolExecutions.push(tool.name);
				return execute(...args);
			};
			log.tools.push({ name: tool.name, approval: tool.approval, execute: spied });
		},
		on(event: string, handler: unknown): void {
			log.events.push({ event, handler });
		},
		sendMessage: throwRuntimeAction("sendMessage"),
		sendUserMessage: throwRuntimeAction("sendUserMessage"),
		setModel: throwRuntimeAction("setModel"),
		appendEntry: throwRuntimeAction("appendEntry"),
		exec: throwRuntimeAction("exec"),
		setActiveTools: throwRuntimeAction("setActiveTools"),
		/** Guard against hypothetical UI access through the API object. */
		get ui(): never {
			log.runtimeActions.push("ui");
			throw new Error("runpod factory accessed extension UI during evaluation");
		},
	} as unknown as ExtensionAPI;
	return pi;
}

/** Snapshot of the process environment taken before any test mutates it. */
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "runpod-omp-extension-"));
});

/** Restore the exact process environment/cwd and drop the temp fixtures. */
afterEach(async () => {
	if (ORIGINAL_AGENT_DIR === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
	}
	process.chdir(ORIGINAL_CWD);
	await rm(tempRoot, { recursive: true, force: true });
});

/**
 * Materialize the global (`<agentDir>/runpod.yml`) and project
 * (`<cwd>/.omp/runpod.yml`) fixtures, then point the factory at them via
 * `PI_CODING_AGENT_DIR` and the process cwd. A missing layer is a valid
 * empty layer.
 */
async function installLayout(
	globalDoc?: Record<string, unknown>,
	projectDoc?: Record<string, unknown>,
): Promise<void> {
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "project");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(cwd, ".omp"), { recursive: true });
	if (globalDoc !== undefined) {
		await writeFile(join(agentDir, "runpod.yml"), toYaml(globalDoc), "utf8");
	}
	if (projectDoc !== undefined) {
		await writeFile(join(cwd, ".omp", "runpod.yml"), toYaml(projectDoc), "utf8");
	}
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(cwd);
}

/** Build a valid model-metadata block for a YAML fixture. */
function modelFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "meta-llama/llama-3.3-70b-instruct",
		name: "Llama 3.3 70B Instruct",
		contextWindow: 131_072,
		maxTokens: 8_192,
		reasoning: false,
		input: ["text"],
		supportsTools: true,
		supportsVision: false,
		...overrides,
	};
}

/** Build a minimal valid profile-map entry for a YAML fixture. */
function profileFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		endpointType: "queue",
		invokeUrl: "https://api.runpod.ai/v2/ep-fixture",
		model: modelFixture(),
		...overrides,
	};
}

/** Global-layer fixture: a shared profile plus a global-only profile. */
const GLOBAL_DOC = {
	version: 1,
	profiles: {
		shared: profileFixture({
			invokeUrl: "https://api.runpod.ai/v2/ep-global-shared",
			apiKey: { ref: "env:RUNPOD_API_KEY" },
			model: modelFixture({ name: "Global Shared Model", contextWindow: 131_072 }),
		}),
		"global-only": profileFixture({
			endpointType: "load-balanced",
			invokeUrl: "https://lb.global.example",
			model: modelFixture({
				id: "qwen/qwen3-32b",
				name: "Global Only Model",
				contextWindow: 262_144,
				maxTokens: 16_384,
				reasoning: true,
				input: ["text", "image"],
				supportsVision: true,
			}),
		}),
	},
};

/** Project-layer fixture: overrides `shared` and adds a project-only profile. */
const PROJECT_DOC = {
	version: 1,
	profiles: {
		shared: profileFixture({
			endpointType: "load-balanced",
			invokeUrl: "https://lb.project.example/shared",
			request: { mode: "stream" },
			model: modelFixture({ name: "Project Shared Model", contextWindow: 65_536 }),
		}),
		"project-only": profileFixture({
			invokeUrl: "https://api.runpod.ai/v2/ep-project-only",
			model: modelFixture({ name: "Project Only Model" }),
		}),
	},
};

function emptyLog(): CallLog {
	return {
		labels: [],
		providers: [],
		commands: [],
		events: [],
		tools: [],
		toolExecutions: [],
		runtimeActions: [],
	};
}

/**
 * Assert the factory registered exactly one provider, named `runpod`, and
 * return its config.
 */
function expectSingleRunpodProvider(log: CallLog): ProviderConfig {
	expect(log.providers).toHaveLength(1);
	expect(log.providers[0]?.name).toBe("runpod");
	return log.providers[0]!.config;
}

/** The model ids registered under the runpod provider, sorted. */
function registeredModelIds(config: ProviderConfig): string[] {
	return (config.models ?? []).map((model) => model.id).sort();
}

/** The names of the operational tools registered during factory evaluation, sorted. */
function registeredToolNames(log: CallLog): string[] {
	return log.tools.map((tool) => tool.name).sort();
}

/** Spies installed around one factory evaluation: network and timer calls. */
interface GuardCalls {
	network: unknown[][];
	timers: unknown[][];
}

/**
 * Await the factory with `fetch` and the timer globals instrumented:
 * `fetch` throws (a network call at load time is a contract violation), the
 * timers pass through while recording. Assertions on the recorded calls are
 * the caller's.
 */
async function runFactoryUnderGuards(
	factory: ExtensionFactory,
	pi: ExtensionAPI,
): Promise<GuardCalls> {
	const originalFetch = globalThis.fetch;
	const originalSetTimeout = globalThis.setTimeout;
	const originalSetInterval = globalThis.setInterval;
	const originalSetImmediate = globalThis.setImmediate;
	const guard: GuardCalls = { network: [], timers: [] };

	globalThis.fetch = ((...args: unknown[]) => {
		guard.network.push(args);
		throw new Error("runpod factory performed a network request during evaluation");
	}) as typeof fetch;
	globalThis.setTimeout = ((...args: unknown[]) => {
		guard.timers.push(["setTimeout", ...args]);
		return originalSetTimeout(...(args as never[]));
	}) as typeof setTimeout;
	globalThis.setInterval = ((...args: unknown[]) => {
		guard.timers.push(["setInterval", ...args]);
		return originalSetInterval(...(args as never[]));
	}) as typeof setInterval;
	if (typeof originalSetImmediate === "function") {
		globalThis.setImmediate = ((...args: unknown[]) => {
			guard.timers.push(["setImmediate", ...args]);
			return originalSetImmediate(...(args as never[]));
		}) as typeof setImmediate;
	}

	try {
		await factory(pi);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.setTimeout = originalSetTimeout;
		globalThis.setInterval = originalSetInterval;
		if (typeof originalSetImmediate === "function") {
			globalThis.setImmediate = originalSetImmediate;
		}
	}
	return guard;
}

describe("runpod extension factory", () => {
	test("loads and merges both profile layers and registers exactly one runpod provider during factory evaluation", async () => {
		await installLayout(GLOBAL_DOC, PROJECT_DOC);
		const log = emptyLog();
		const pi = createMockPi(log);

		// The factory may be sync or async; either way its registration work
		// must be done by the time this await resolves — with no
		// session_start handler ever invoked.
		await (runpodExtension as ExtensionFactory)(pi);

		const eventNames = log.events.map((entry) => entry.event);
		expect(eventNames).toContain("session_start");
		expect(eventNames).toContain("session_shutdown");

		const config = expectSingleRunpodProvider(log);
		expect(registeredModelIds(config)).toEqual(["global-only", "project-only", "shared"]);

		// Model metadata is copied from the merged profiles; the project
		// layer replaced the global "shared" profile.
		const models = new Map((config.models ?? []).map((model) => [model.id, model]));
		expect(models.get("shared")?.name).toBe("Project Shared Model");
		expect(models.get("shared")?.contextWindow).toBe(65_536);
		expect(models.get("global-only")?.name).toBe("Global Only Model");
		expect(models.get("global-only")?.reasoning).toBe(true);
		expect(models.get("project-only")?.name).toBe("Project Only Model");

		// The extension label and the /runpod command register at load time.
		expect(log.labels.length).toBeGreaterThan(0);
		expect(log.labels.some((label) => label.includes("runpod"))).toBe(true);
		expect(log.commands).toHaveLength(1);
		expect(log.commands[0]?.name).toBe("runpod");
		expect(log.commands[0]?.description).toBeTypeOf("string");
		expect(typeof log.commands[0]?.handler).toBe("function");

		// Read-only operational tools register during factory evaluation, per
		// the src/operations.ts contract: queue health and LB ping for the
		// respective endpoint surfaces, plus job status for any profile. The
		// merged fixtures include a queue profile (project-only) and LB
		// profiles (shared, global-only), so all three read-only tools appear.
		expect(registeredToolNames(log)).toEqual([
			"runpod_health",
			"runpod_ping",
			"runpod_status",
		]);
		// Operational tools are a fixed read-only surface; no queue mutation is
		// model-callable regardless of profile configuration.
		expect(registeredToolNames(log)).not.toContain("runpod_cancel");
		expect(registeredToolNames(log)).not.toContain("runpod_retry");
		expect(registeredToolNames(log)).not.toContain("runpod_purge");
		// Every registered tool carries a read-only approval.
		expect(log.tools.every((tool) => tool.approval === "read")).toBe(true);
		// The factory registers tools but never invokes their execute handlers.
		expect(log.toolExecutions).toEqual([]);

		// No runtime action was called during factory evaluation.
		expect(log.runtimeActions).toEqual([]);
	});

	test("project profiles override same-named global profiles in the registered models", async () => {
		await installLayout(GLOBAL_DOC, PROJECT_DOC);
		const log = emptyLog();
		await (runpodExtension as ExtensionFactory)(createMockPi(log));

		const config = expectSingleRunpodProvider(log);
		const models = new Map((config.models ?? []).map((model) => [model.id, model]));
		expect(models.size).toBe(3);
		// "shared" exists in both layers; the project version wins.
		expect(models.get("shared")?.name).toBe("Project Shared Model");
		expect(models.get("shared")?.contextWindow).toBe(65_536);
		// The global-only profile is kept alongside the override.
		expect(models.get("global-only")?.name).toBe("Global Only Model");
		// The project-only profile is appended to the merged set.
		expect(models.get("project-only")?.name).toBe("Project Only Model");
		expect(log.runtimeActions).toEqual([]);
	});

	test("excludes a malformed profile without blocking registration of the valid profiles", async () => {
		await installLayout(
			{
				version: 1,
				profiles: {
					"global-valid": profileFixture({
						invokeUrl: "https://api.runpod.ai/v2/ep-global-valid",
						model: modelFixture({ name: "Global Valid Model" }),
					}),
				},
			},
			{
				version: 1,
				profiles: {
					// Invalid invokeUrl: the whole profile is rejected.
					broken: profileFixture({ invokeUrl: "not-a-url" }),
					"project-valid": profileFixture({
						invokeUrl: "https://api.runpod.ai/v2/ep-project-valid",
						model: modelFixture({ name: "Project Valid Model" }),
					}),
				},
			},
		);
		const log = emptyLog();
		await (runpodExtension as ExtensionFactory)(createMockPi(log));

		const config = expectSingleRunpodProvider(log);
		const modelIds = registeredModelIds(config);
		expect(modelIds).toEqual(["global-valid", "project-valid"]);
		expect(modelIds).not.toContain("broken");
		expect(log.runtimeActions).toEqual([]);
	});

	test("performs no runtime actions, network requests, timers, or UI during factory evaluation", async () => {
		await installLayout({
			version: 1,
			profiles: {
				primary: profileFixture({
					invokeUrl: "https://api.runpod.ai/v2/ep-primary",
					model: modelFixture({ name: "Primary Model" }),
				}),
			},
		});
		const log = emptyLog();
		const pi = createMockPi(log);

		const guard = await runFactoryUnderGuards(runpodExtension as ExtensionFactory, pi);

		expect(guard.network).toEqual([]);
		expect(guard.timers).toEqual([]);
		expect(log.runtimeActions).toEqual([]);
		// Registration still happened — the only I/O was the config file.
		const config = expectSingleRunpodProvider(log);
		expect(registeredModelIds(config)).toEqual(["primary"]);
	});

	test("session lifecycle: start sets status from the live estimate and schedules the refresh interval; shutdown stops it and clears the status; headless stays quiet", async () => {
		await installLayout(GLOBAL_DOC, PROJECT_DOC);
		const log = emptyLog();
		await (runpodExtension as ExtensionFactory)(createMockPi(log));

		// Capture the lifecycle handlers the factory registered via `pi.on`.
		// Factory evaluation must never invoke them — only this test does,
		// after all factory-time assertions have settled.
		const start = log.events.find((entry) => entry.event === "session_start");
		const shutdown = log.events.find((entry) => entry.event === "session_shutdown");
		expect(start).toBeDefined();
		expect(shutdown).toBeDefined();
		expect(typeof start!.handler).toBe("function");
		expect(typeof shutdown!.handler).toBe("function");

		// A UI status recorder observing every setStatus write.
		const interactiveStatus = new Map<string, string | undefined>();
		const interactiveCtx = {
			// The active session model maps to the configured `shared` profile.
			currentModel: "runpod/shared",
			hasUI: true,
			ui: {
				setStatus(key: string, value: string | undefined): void {
					interactiveStatus.set(key, value);
				},
			},
		};

		// Headless context: no UI interaction may happen; the recorder proves it.
		const headlessStatus = new Map<string, string | undefined>();
		const headlessCtx = {
			currentModel: "runpod/shared",
			hasUI: false,
			ui: {
				setStatus(key: string, value: string | undefined): void {
					headlessStatus.set(key, value);
				},
			},
		};

		// No status may be written during factory evaluation (handlers not yet
		// invoked). Instrument fetch/timers around the handler invocations: the
		// interactive session MAY fetch the live estimate and MUST schedule a
		// 60s refresh interval; shutdown MUST stop it; headless MUST do none.
		expect(interactiveStatus.size).toBe(0);

		const originalFetch = globalThis.fetch;
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		const timers: unknown[][] = [];
		const clearedIntervals: unknown[] = [];
		const network: unknown[][] = [];
		globalThis.fetch = ((...args: unknown[]) => {
			network.push(args);
			throw new Error("runpod lifecycle handler performed a network request");
		}) as typeof fetch;
		globalThis.setInterval = ((...args: unknown[]) => {
			timers.push(["setInterval", ...args]);
			return originalSetInterval(...(args as never[]));
		}) as typeof setInterval;
		globalThis.clearInterval = ((id: unknown) => {
			clearedIntervals.push(id);
			return originalClearInterval(id as never);
		}) as typeof clearInterval;
		try {
			// Interactive start: names the active profile, never URL/key bytes.
			// The status write is the refresher's immediate tick, so let it
			// settle. The estimate cannot resolve an API key in this
			// environment, so it fails closed BEFORE any network (zero fetch)
			// and the status degrades to the profile-only line.
			(start!.handler as (ctx: unknown) => unknown)(interactiveCtx);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(interactiveStatus.get("runpod")).toBe("Runpod profile: shared");
			expect(interactiveStatus.get("runpod")).not.toContain("ep-global-shared");
			expect(interactiveStatus.get("runpod")).not.toContain("RUNPOD_API_KEY");
			expect(network).toEqual([]);

			// The 60s refresh interval was scheduled.
			expect(
				timers.some(
					([name, , ms]) => name === "setInterval" && ms === 60_000,
				),
			).toBe(true);

			// Interactive shutdown: stops the refresher and clears the status.
			(shutdown!.handler as (ctx: unknown) => unknown)(interactiveCtx);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(interactiveStatus.get("runpod")).toBeUndefined();
			expect(clearedIntervals.length).toBeGreaterThan(0);

			// Headless start: zero UI writes, no new fetch, no new timer.
			const fetchesBefore = network.length;
			const timersBefore = timers.length;
			(start!.handler as (ctx: unknown) => unknown)(headlessCtx);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(headlessStatus.size).toBe(0);
			expect(network.length).toBe(fetchesBefore);
			expect(timers.length).toBe(timersBefore);
		} finally {
			globalThis.fetch = originalFetch;
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});
});

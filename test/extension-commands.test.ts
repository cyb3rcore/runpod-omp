/**
 * End-to-end integration tests for the guided configuration commands as
 * wired by the OMP extension factory (the default export of src/index.ts).
 *
 * Where commands-config.test.ts drives the pure orchestration runtime by
 * injecting a {@link RunpodConfigCommandRuntime} directly, this file proves
 * the *factory* actually supplies that capability and binds it to the real
 * OMP command context: it captures the `/runpod` handler registered by the
 * factory, then invokes it the way the OMP dispatcher does — `handler(args,
 * ctx)` with a realistic `ExtensionCommandContext` carrying
 * `hasUI`/`ui.select`/`ui.input`/`ui.confirm`/`ui.notify`.
 *
 * `registerRunpodCommands` routes every user-facing effect through the
 * injected runtime, so for the guided configuration to work end-to-end the
 * factory's runtime must:
 *
 * - implement the {@link RunpodConfigCommandRuntime} config capability
 *   (askTargetScope, askConfigValues, configPath, readConfigLayer,
 *   writeConfigLayer, reloadConfig, loadDoctorReport) and drive it from the
 *   command context's UI (scope select, value inputs, confirmation);
 * - route notices through `ctx.ui.notify` (command-context binding);
 * - write config atomically to the real `<cwd>/.omp/runpod.yml` project layer
 *   (or the global layer), keeping the `apiKey` as a verbatim secret
 *   reference — never resolved, never emitted;
 * - reload the in-memory merged config so the command-visible profile list
 *   reflects the write immediately; and
 * - report a restart/refresh-required notice instead of attempting an
 *   ineffective dynamic provider re-registration, because OMP consumes
 *   native provider models only while extension factories load — a config
 *   write cannot safely make new native models live in this session.
 *
 * These tests intentionally fail against the current factory runtime, which
 * wires only the base {@link RunpodCommandRuntime} (no config capability, no
 * command-context UI/IO binding). They document the expected wired behavior
 * and pin where the factory integration still falls short.
 *
 * No real Runpod network access or fetch is performed: the only I/O is
 * reading/writing the temp config fixture files and the atomic config write
 * that the guided flow is contractually required to make.
 */
import { afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";

import runpodExtension from "../src/index.js";
import { parseProfileDocument } from "../src/profile-schema.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ProviderConfig,
} from "@oh-my-pi/pi-coding-agent";

/** The profile name the guided configure flow is staged to produce. */
const PROFILE_NAME = "default";
/** The invoke URL the staged UI satisfies for the configured profile. */
const INVOKE_URL = "https://api.runpod.ai/v2/ep-cfg";
/** The verbatim apiKey reference the staged UI supplies (never resolved). */
const API_KEY_REF = "env:RUNPOD_API_KEY";

/** Full model-metadata block; the plan defines no profile-model defaults. */
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

/** Doctor fixture: a global profile carries a secret ref, the project one does not. */
const DOCTOR_GLOBAL_DOC = {
	version: 1,
	profiles: {
		prod: profileFixture({
			invokeUrl: "https://api.runpod.ai/v2/ep-prod",
			apiKey: { ref: API_KEY_REF },
		}),
	},
};
const DOCTOR_PROJECT_DOC = {
	version: 1,
	profiles: {
		dev: profileFixture({ invokeUrl: "https://api.runpod.ai/v2/ep-dev" }),
	},
};

/** One `pi.registerProvider` call as recorded by the mock. */
interface RecordedProvider {
	name: string;
	config: ProviderConfig;
}

/** One `pi.registerCommand` call as recorded by the mock. */
interface RecordedCommand {
	name: string;
	description: string | undefined;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/** Every call the mock ExtensionAPI observed during a factory evaluation. */
interface CallLog {
	labels: string[];
	providers: RecordedProvider[];
	commands: RecordedCommand[];
	tools: string[];
}

/** UI interactions staged through the command context, for assertions. */
interface UiLog {
	selects: Array<{ title: string; optionCount: number }>;
	inputs: Array<{ title: string }>;
	confirms: Array<{ title: string; message: string }>;
	notifies: Array<{ message: string; type?: string }>;
}

/**
 * Deterministic ExtensionAPI stand-in: records the registration surface
 * (setLabel/registerProvider/registerCommand/registerTool/on) and exposes a
 * `setModel` spy so the test pins that config commands never touch OMP model
 * selection. The cast to the full `ExtensionAPI` is confined to this helper.
 */
function createMockPi(log: CallLog): { pi: ExtensionAPI; setModel: Mock<(model: unknown) => void> } {
	const setModel = mock<(model: unknown) => void>();
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
		registerCommand(
			name: string,
			options: {
				description?: string;
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		): void {
			log.commands.push({
				name,
				description: options.description,
				handler: options.handler,
			});
		},
		registerTool(tool: { name: string }): void {
			log.tools.push(tool.name);
		},
		on(_event: string, _handler: unknown): void {},
		setModel,
	} as unknown as ExtensionAPI;
	return { pi, setModel };
}

/** Shared empty call log. */
function emptyLog(): CallLog {
	return { labels: [], providers: [], commands: [], tools: [] };
}

/** Staged interactive UI: scope select → "project", input queue → [url, keyRef], confirm → true. */
function makeInteractiveUi(
	opts: { inputQueue?: string[]; confirmResult?: boolean } = {},
): { ui: unknown; uiLog: UiLog } {
	const uiLog: UiLog = { selects: [], inputs: [], confirms: [], notifies: [] };
	const inputQueue = opts.inputQueue ?? [INVOKE_URL, API_KEY_REF];
	let nextInput = 0;
	const ui = {
		select(title: string, options: unknown[]): string {
			uiLog.selects.push({
				title,
				optionCount: Array.isArray(options) ? options.length : 0,
			});
			const t = title.toLowerCase();
			// The scope prompt quite literally asks which layer to target; any
			// other select (endpoint type, model) resolves to a queue profile.
			if (/(scope|target|layer)/.test(t)) {
				return "project";
			}
			return "queue";
		},
		input(title: string): string | undefined {
			uiLog.inputs.push({ title });
			const value = inputQueue[nextInput];
			if (nextInput < inputQueue.length) {
				nextInput += 1;
			}
			return value;
		},
		confirm(title: string, message: string): boolean {
			uiLog.confirms.push({ title, message });
			return opts.confirmResult ?? true;
		},
		notify(message: string, type?: string): void {
			uiLog.notifies.push({ message, type });
		},
	};
	return { ui, uiLog };
}

/**
 * Headless/print command context: `hasUI` is false, so any interactive UI
 * method that a command actually calls is a wiring bug and throws; `notify`
 * still records so the fail-closed error surface is observable.
 */
function makeHeadlessUi(): { ui: unknown; uiLog: UiLog } {
	const uiLog: UiLog = { selects: [], inputs: [], confirms: [], notifies: [] };
	const ui = {
		select(): never {
			throw new Error("no UI in headless/print mode");
		},
		input(): never {
			throw new Error("no UI in headless/print mode");
		},
		confirm(): never {
			throw new Error("no UI in headless/print mode");
		},
		notify(message: string, type?: string): void {
			uiLog.notifies.push({ message, type });
		},
	};
	return { ui, uiLog };
}

/** Build a command context from a UI stub (cast confined to this helper). */
function makeCtx(ui: unknown, hasUI: boolean, cwd: string): ExtensionCommandContext {
	return {
		ui,
		hasUI,
		mode: hasUI ? ("tui" as const) : ("print" as const),
		cwd,
	} as unknown as ExtensionCommandContext;
}

/** Snapshot of the process environment taken before any test mutates it. */
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

let tempRoot: string;
let agentDir: string;
let projectCwd: string;
let projectYaml: string;

beforeEach(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "runpod-omp-ext-cmd-"));
	agentDir = join(tempRoot, "agent");
	projectCwd = join(tempRoot, "project");
	projectYaml = join(projectCwd, ".omp", "runpod.yml");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(projectCwd, ".omp"), { recursive: true });
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
 * Point the factory at the temp layout via `PI_CODING_AGENT_DIR` and the
 * process cwd, writing the given global/project layer documents (a missing
 * layer is a valid empty layer).
 */
async function installLayout(
	globalDoc?: Record<string, unknown>,
	projectDoc?: Record<string, unknown>,
): Promise<void> {
	if (globalDoc !== undefined) {
		await writeFile(join(agentDir, "runpod.yml"), toYaml(globalDoc), "utf8");
	}
	if (projectDoc !== undefined) {
		await writeFile(projectYaml, toYaml(projectDoc), "utf8");
	}
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(projectCwd);
}

/** Run the factory and return the captured `/runpod` handler and the setModel spy. */
async function runFactory(): Promise<{
	log: CallLog;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	setModel: Mock<(model: unknown) => void>;
}> {
	const log = emptyLog();
	const { pi, setModel } = createMockPi(log);
	await runpodExtension(pi);
	const handler = log.commands.find((command) => command.name === "runpod");
	expect(handler).toBeDefined();
	return { log, handler: handler!.handler, setModel };
}

describe("runpod extension factory: /runpod configure end-to-end", () => {
	test("collects values through the command-context UI, writes valid project YAML preserving the secret ref, reloads command-visible profiles, and asks for a restart", async () => {
		// Empty layout: after configure, `default` is the only profile.
		await installLayout();
		const { log, handler, setModel } = await runFactory();
		const { ui, uiLog } = makeInteractiveUi();
		const beforeProviderCount = log.providers.length;

		await handler("configure", makeCtx(ui, true, projectCwd));

		// The guided flow drove the command-context UI: a scope select, value
		// inputs, and a confirmation gate all fired.
		expect(uiLog.selects.length).toBeGreaterThan(0);
		expect(uiLog.inputs.length).toBeGreaterThan(0);
		expect(uiLog.confirms).toHaveLength(1);

		// The staged scope was project, so the write landed at the project layer.
		expect(access(projectYaml).then(() => true).catch(() => false)).resolves.toBe(true);
		const projectText = await readFile(projectYaml, "utf8");
		// The written document is a valid profile document that round-trips
		// through the schema with zero validation errors.
		const parsed = parseProfileDocument(projectText, "project");
		expect(parsed.errors).toEqual([]);
		expect(parsed.document).not.toBeNull();
		expect(Object.keys(parsed.document!.profiles)).toEqual([PROFILE_NAME]);
		// The apiKey stays a verbatim secret reference — never resolved, never
		// a credential byte, and written exactly as provided.
		expect(parsed.document!.profiles[PROFILE_NAME]!.apiKey?.ref).toBe(API_KEY_REF);

		// A restart/refresh-required notice is emitted: a config write cannot
		// make new native provider models live in this session, so the user is
		// told to restart/refresh rather than being misled by an ineffective
		// dynamic registration.
		const restartNotice = uiLog.notifies.find((notice) =>
			/restart|refresh/i.test(notice.message),
		);
		expect(restartNotice).toBeDefined();
		// No notice ever leaks the secret reference or any credential bytes.
		for (const notice of uiLog.notifies) {
			expect(notice.message).not.toContain(API_KEY_REF);
			expect(notice.message).not.toContain("sk-");
		}

		// Settings did not attempt an ineffective dynamic provider re-write:
		// the provider registration set is exactly what the factory produced.
		expect(log.providers).toHaveLength(beforeProviderCount);

		// The in-memory merged config was reloaded, so the command-visible
		// profile list now reflects the newly configured profile.
		await handler("", makeCtx(ui, true, projectCwd));
		const listNotice = uiLog.notifies.find((notice) =>
			notice.message.includes("Runpod profiles"),
		);
		expect(listNotice).toBeDefined();
		expect(listNotice!.message).toContain(PROFILE_NAME);

		// Config commands never touch the OMP model selection.
		expect(setModel).not.toHaveBeenCalled();
	});

	test("headless mode fails closed: no UI is driven and nothing is written", async () => {
		await installLayout();
		const { handler, setModel } = await runFactory();
		const { ui, uiLog } = makeHeadlessUi();

		await handler("configure", makeCtx(ui, false, projectCwd));

		// No interactive UI was driven (any such drive would have thrown).
		expect(uiLog.selects).toEqual([]);
		expect(uiLog.inputs).toEqual([]);
		expect(uiLog.confirms).toEqual([]);
		// A fail-closed error surfaced instead of a silent success.
		expect(uiLog.notifies.some((notice) => notice.type === "error")).toBe(true);
		// Nothing was written to either config layer.
		expect(access(projectYaml).then(() => true).catch(() => false)).resolves.toBe(false);
		expect(access(join(agentDir, "runpod.yml")).then(() => true).catch(() => false)).resolves.toBe(false);
		expect(setModel).not.toHaveBeenCalled();
	});
});

describe("runpod extension factory: /runpod doctor end-to-end", () => {
	test("reports config layer/profile info with apiKey refs redacted and never reveals credential bytes", async () => {
		await installLayout(DOCTOR_GLOBAL_DOC, DOCTOR_PROJECT_DOC);
		const { log, handler, setModel } = await runFactory();
		const { ui, uiLog } = makeInteractiveUi();
		const providerBefore = log.providers.length;

		await handler("doctor", makeCtx(ui, true, projectCwd));

		const report = uiLog.notifies
			.map((notice) => notice.message)
			.join("\n");
		// Source-path and profile-name context is reported…
		expect(report).toContain(join(agentDir, "runpod.yml"));
		expect(report).toContain(join(projectCwd, ".omp", "runpod.yml"));
		expect(report).toContain("prod");
		expect(report).toContain("dev");
		// …the profile with a secret ref is surfaced as redacted…
		expect(report).toContain("[redacted]");
		// …while the ref text and any resolved credential bytes never appear.
		expect(report).not.toContain(API_KEY_REF);
		expect(report).not.toContain("sk-");

		// Doctor is read-only: no provider change, no model selection.
		expect(log.providers).toHaveLength(providerBefore);
		expect(setModel).not.toHaveBeenCalled();
	});

	test("config commands (configure + doctor) never touch the OMP model selection", async () => {
		await installLayout(DOCTOR_GLOBAL_DOC, DOCTOR_PROJECT_DOC);
		const { handler, setModel } = await runFactory();
		const { ui, uiLog } = makeInteractiveUi();

		await handler("configure", makeCtx(ui, true, projectCwd));
		await handler("doctor", makeCtx(ui, true, projectCwd));

		expect(setModel).not.toHaveBeenCalled();
		// The configure flow had UI to drive; this guard confirms the flow ran.
		expect(uiLog.selects.length).toBeGreaterThan(0);
	});
});

describe("runpod extension factory: explicit human queue control", () => {
	test("confirms a named cancellation and invokes the queue control route", async () => {
		await installLayout(DOCTOR_GLOBAL_DOC);
		const { handler } = await runFactory();
		const { ui, uiLog } = makeInteractiveUi();
		const originalFetch = globalThis.fetch;
		const originalKey = process.env.RUNPOD_API_KEY;
		const requests: Array<{ url: string; method: string | undefined }> = [];
		process.env.RUNPOD_API_KEY = "test-control-key";
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ url: String(input), method: init?.method });
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		try {
			await handler("cancel prod job-42", makeCtx(ui, true, projectCwd));
		} finally {
			globalThis.fetch = originalFetch;
			if (originalKey === undefined) {
				delete process.env.RUNPOD_API_KEY;
			} else {
				process.env.RUNPOD_API_KEY = originalKey;
			}
		}

		expect(uiLog.confirms).toEqual([
			{ title: "Runpod configuration", message: "Cancel job job-42 on profile prod?" },
		]);
		expect(requests).toEqual([
			{ url: "https://api.runpod.ai/v2/ep-prod/cancel/job-42", method: "POST" },
		]);
		expect(uiLog.notifies).toContainEqual({
			message: "Cancelled job job-42 on profile prod.",
			type: "info",
		});
	});
});

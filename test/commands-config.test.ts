/**
 * Contract tests for the `/runpod configure`, `/runpod profile add`, and
 * `/runpod doctor` command surface — the guided configuration capability of
 * the Runpod OMP extension.
 *
 * These tests pin the observable behavior of the approved plan on top of
 * {@link registerRunpodCommands} (src/commands.ts), which today only handles
 * `profile` (list/select/rm) and `cancel`. The three commands here extend the
 * same dispatch/notification convention through an *extended* runtime,
 * {@link RunpodConfigCommandRuntime}, that adds fully-injected config
 * IO/prompt/reload/provider-registration dependencies. Because src/commands.ts
 * does not yet export this surface, these tests intentionally fail until it is
 * implemented; they also deliberately leave production files untouched.
 *
 * Contract:
 * - `/runpod configure` asks a target scope (global vs project), collects
 *   structured values through the injected prompt, confirms the destination,
 *   writes a *valid* profile document atomically
 *   (`runtime.writeConfigLayer(scope, doc)`), and *immediately* reloads the
 *   merged config and re-registers the full provider model set. It never
 *   touches the OMP model selection (`pi.setModel` is never called).
 * - `/runpod profile add <name>` is the same guided flow but the profile name
 *   is taken from the explicit argument: it merges into the layer read back
 *   via `runtime.readConfigLayer(scope)` (appends a new name, replaces an
 *   existing same-named profile), writes, reloads, and re-registers.
 * - Headless mode fail-closes: when the injected prompt reports
 *   `cancelled: true`, or the `runtime.confirm(...)` gate resolves false (the
 *   headless/print surrogate), the handler performs no write, no reload, and
 *   no re-register, and reports a structured error notice — it never guesses
 *   nor writes.
 * - `/runpod doctor` reports the global/project source paths, valid profile
 *   names, and retained validation errors, redacting every `apiKey` reference
 *   to `[redacted]` and never emitting a resolved credential byte. Doctor is
 *   read-only: it performs no write, reload, re-register, or model change.
 *
 * All config side effects go through the injected runtime (spies backed by
 * fixture documents), so no real tmp file or real configuration is required.
 */
import { describe, expect, mock, test, type Mock } from "bun:test";
import { stringify as toYaml } from "yaml";

import { registerRunpodCommands } from "../src/commands.js";
import type {
	CommandNoticeKind,
	CommandRegistrationAPI,
	RunpodCommandRuntime,
} from "../src/commands.js";
import { parseProfileDocument } from "../src/profile-schema.js";
import type {
	EndpointType,
	ModelMetadata,
	Profile,
	ProfileDocument,
	ProfilePolicy,
	ProfileRequest,
} from "../src/profile-schema.js";

/** Injected config-layer paths the stub hands back (pure strings; no real file). */
const GLOBAL_PATH = "/home/agent/runpod.yml";
const PROJECT_PATH = "/home/project/.omp/runpod.yml";

/** Full model metadata block; the plan defines no model-level defaults. */
const MODEL: ModelMetadata = {
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
 * Build a valid profile with the applied schema defaults, ready to appear in
 * a written `ProfileDocument`. `apiKeyRef` becomes a verbatim secret
 * reference; `null` means the profile carries no apiKey.
 */
function makeProfile(
	name: string,
	endpointType: EndpointType,
	invokeUrl: string,
	apiKeyRef: string | null,
): Profile {
	const profile = {
		endpointType,
		invokeUrl,
		model: MODEL,
		request: {
			mode: "sync" as const,
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" as const },
			loadBalancedPath: "/v1/chat/completions",
		},
		policy: { maxAttempts: 1, fallbackProfiles: [] },
	} satisfies Omit<Profile, "apiKey">;
	if (apiKeyRef === null) {
		return profile;
	}
	return { ...profile, apiKey: { kind: "secret-reference", ref: apiKeyRef, redacted: "[redacted]" } };
}

/** The base profiles shared by the configure/profile-add fixtures. */
const PROD_PROFILE = makeProfile(
	"prod",
	"queue",
	"https://api.runpod.ai/v2/ep-prod",
	"env:RUNPOD_API_KEY",
);

/** Where a config write targets: the global agent layer or the project layer. */
type ConfigTargetScope = "global" | "project";

/** Structured field values collected by the guided configure/profile-add prompt. */
interface ConfigPromptValues {
	/** Profile name; forced to the explicit argument for `profile add`. */
	name: string;
	endpointType: EndpointType;
	invokeUrl: string;
	model: ModelMetadata;
	/** Verbatim apiKey reference (e.g. "env:VAR", "!cmd", or a literal); null = none. */
	apiKeyRef: string | null;
	request?: Partial<ProfileRequest>;
	policy?: Partial<ProfilePolicy>;
}

/** Result of an interactive config prompt; `cancelled` marks headless/no-collect. */
interface ConfigPromptResult {
	cancelled: boolean;
	values?: ConfigPromptValues;
}

/** Structured doctor report: source paths, valid profile names, retained errors. */
interface DoctorReport {
	globalPath: string | null;
	projectPath: string | null;
	profiles: Array<{ name: string; apiKeyRef: string | null }>;
	errors: Array<{ path: string; message: string }>;
}

/**
 * Extended runtime the `/runpod` command surface uses for configure, profile
 * add, and doctor. It extends the base profile/notice runtime with fully
 * injected config IO (scope → path, read/write layer), reload and
 * provider-registration effects, structured prompts, and a doctor report
 * source. The commands module only orchestrates these; it performs no real IO.
 */
interface RunpodConfigCommandRuntime extends RunpodCommandRuntime {
	/** Resolve the injected filesystem path for a target scope. */
	configPath(scope: ConfigTargetScope): string;
	/** Ask which scope the guided flow should target. */
	askTargetScope(): Promise<ConfigTargetScope>;
	/** Collect structured values; `profileName` pre-fills the prompted name. */
	askConfigValues(profileName?: string): Promise<ConfigPromptResult>;
	/** Read the current profile document for a scope (empty doc when absent). */
	readConfigLayer(scope: ConfigTargetScope): Promise<ProfileDocument>;
	/** Atomically write a profile document to the scope's runpod.yml. */
	writeConfigLayer(scope: ConfigTargetScope, document: ProfileDocument): Promise<void>;
	/** Reload the merged global+project config after a write. */
	reloadConfig(): Promise<void>;
	/** Re-register the full provider model set from the reloaded config. */
	reRegisterProviders(): Promise<void>;
	/** Produce the structured doctor report (raw refs; the command surface redacts). */
	loadDoctorReport(): Promise<DoctorReport>;
}

/** The prompt values the stubbed guided flow returns when it collects. */
const VALID_VALUES: ConfigPromptValues = {
	name: "default",
	endpointType: "queue",
	invokeUrl: "https://api.runpod.ai/v2/ep-cfg",
	model: MODEL,
	apiKeyRef: "env:RUNPOD_API_KEY",
};

/** A clean doctor report: two profiles (one with a secret ref), no errors. */
const CLEAN_REPORT: DoctorReport = {
	globalPath: GLOBAL_PATH,
	projectPath: PROJECT_PATH,
	profiles: [
		{ name: "prod", apiKeyRef: "env:RUNPOD_API_KEY" },
		{ name: "dev", apiKeyRef: null },
	],
	errors: [],
};

/** Calls made to the extended runtime during one test. */
interface ConfigRuntimeCallLog {
	setDefaultProfile: string[];
	deleteProfile: string[];
	confirms: string[];
	notices: Array<{ message: string; kind: CommandNoticeKind }>;
	asksScope: ConfigTargetScope[];
	prompts: Array<{ profileName: string | undefined }>;
	writes: Array<{ scope: ConfigTargetScope; document: ProfileDocument }>;
	reloads: number;
	reRegisters: number;
	/** Ordered effect sequence for configure/profile-add (write→reload→reRegister). */
	flow: string[];
	doctorCalls: number;
}

/** Options shaping default stub behavior (no real IO performed). */
interface ConfigRuntimeOptions {
	askTargetScope?: ConfigTargetScope;
	askConfigValues?: ConfigPromptResult;
	readLayer?: ProfileDocument;
	doctorReport?: DoctorReport;
	/** false stands in for headless/print mode, where no UI can confirm a write. */
	confirmResult?: boolean;
}

/**
 * Build an injectable extended-runtime stub. Every action records into `log`;
 * `notify` defaults to kind "info". No real file is touched: config paths are
 * injected strings and every effect is a recording spy.
 */
function createConfigRuntime(
	overrides: Partial<RunpodConfigCommandRuntime> = {},
	options: ConfigRuntimeOptions = {},
): { runtime: RunpodConfigCommandRuntime; log: ConfigRuntimeCallLog } {
	const log: ConfigRuntimeCallLog = {
		setDefaultProfile: [],
		deleteProfile: [],
		confirms: [],
		notices: [],
		asksScope: [],
		prompts: [],
		writes: [],
		reloads: 0,
		reRegisters: 0,
		flow: [],
		doctorCalls: 0,
	};
	const runtime: RunpodConfigCommandRuntime = {
		listProfiles: () => [],
		getDefaultProfile: () => null,
		async setDefaultProfile(name) {
			log.setDefaultProfile.push(name);
		},
		async confirm(prompt) {
			log.confirms.push(prompt);
			return options.confirmResult ?? true;
		},
		notify(message, kind = "info") {
			log.notices.push({ message, kind });
		},
		async deleteProfile(name) {
			log.deleteProfile.push(name);
		},
		async runQueueMutation() {},
		async runCost(profileName) {
			return { profile: profileName, endpointType: "queue" };
		},
		configPath(scope) {
			return scope === "global" ? GLOBAL_PATH : PROJECT_PATH;
		},
		async askTargetScope() {
			log.asksScope.push(options.askTargetScope ?? "global");
			return options.askTargetScope ?? "global";
		},
		async askConfigValues(profileName) {
			log.prompts.push({ profileName });
			return options.askConfigValues ?? { cancelled: false, values: VALID_VALUES };
		},
		async readConfigLayer(scope) {
			return options.readLayer ?? { version: 1, profiles: {} };
		},
		async writeConfigLayer(scope, document) {
			log.writes.push({ scope, document });
			log.flow.push("write");
		},
		async reloadConfig() {
			log.reloads += 1;
			log.flow.push("reload");
		},
		async reRegisterProviders() {
			log.reRegisters += 1;
			log.flow.push("reRegister");
		},
		async loadDoctorReport() {
			log.doctorCalls += 1;
			return options.doctorReport ?? CLEAN_REPORT;
		},
		...overrides,
	};
	return { runtime, log };
}

interface CommandRegistration {
	name: string;
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

/** Minimal OMP extension-API surface the commands module uses. */
interface CommandPiMock extends CommandRegistrationAPI {
	setModel: Mock<(model: unknown) => void>;
}

/** Deterministic pi mock: registerCommand records, setModel is a spy. */
function createPiMock(): {
	pi: CommandPiMock;
	setModel: CommandPiMock["setModel"];
	registrations: CommandRegistration[];
} {
	const registrations: CommandRegistration[] = [];
	const setModel = mock<(model: unknown) => void>();
	const pi: CommandPiMock = {
		registerCommand(name, options) {
			registrations.push({ name, description: options.description, handler: options.handler });
		},
		setModel,
	};
	return { pi, setModel, registrations };
}

/**
 * Register the commands with a fresh pi mock and return the captured handler
 * plus the setModel spy. Tests invoke the handler the way the OMP dispatcher
 * would: `await handler(args, ctx)` where args is everything after `/runpod `.
 */
function register(runtime: RunpodConfigCommandRuntime): {
	setModel: CommandPiMock["setModel"];
	handler: (args: string, ctx: unknown) => Promise<void>;
} {
	const { pi, setModel, registrations } = createPiMock();
	registerRunpodCommands(pi, runtime);
	return { setModel, handler: registrations[0]!.handler };
}

describe("registerRunpodCommands: /runpod configure", () => {
	test("asks target scope, confirms, writes a valid config atomically, reloads, and re-registers", async () => {
		const { runtime, log } = createConfigRuntime();
		const { handler, setModel } = register(runtime);

		await handler("configure", {});

		// Guided flow: scope first, then structured values (no explicit name).
		expect(log.asksScope).toEqual(["global"]);
		expect(log.prompts).toEqual([{ profileName: undefined }]);
		// The write destination is named in the confirmation gate.
		expect(log.confirms).toHaveLength(1);
		expect(log.confirms[0]!).toContain("default");
		expect(log.confirms[0]!).toContain(GLOBAL_PATH);
		// Exactly one atomic write to the global layer.
		expect(log.writes).toHaveLength(1);
		expect(log.writes[0]!.scope).toBe("global");
		// The written document is a valid profile document that round-trips
		// through parseProfileDocument with zero validation errors.
		const written = log.writes[0]!.document;
		expect(written.version).toBe(1);
		expect(Object.keys(written.profiles)).toEqual(["default"]);
		const roundTrip = parseProfileDocument(toYaml(written), "written");
		expect(roundTrip.errors).toEqual([]);
		expect(Object.keys(roundTrip.document!.profiles)).toEqual(["default"]);
		// The profile carries structured values; the apiKey stays a verbatim ref.
		expect(written.profiles["default"]!.endpointType).toBe("queue");
		expect(written.profiles["default"]!.invokeUrl).toBe("https://api.runpod.ai/v2/ep-cfg");
		expect(written.profiles["default"]!.apiKey).toEqual({
			kind: "secret-reference",
			ref: "env:RUNPOD_API_KEY",
			redacted: "[redacted]",
		});
		// Immediate reload then re-register, in that order, after the write.
		expect(log.reloads).toBe(1);
		expect(log.reRegisters).toBe(1);
		expect(log.flow.join(",")).toBe("write,reload,reRegister");
		expect(log.notices).toEqual([
			{ message: `Configured runpod profile default at ${GLOBAL_PATH}.`, kind: "success" },
		]);
		// Config commands never touch the OMP model selection.
		expect(setModel).not.toHaveBeenCalled();
	});

	test("writes the project layer when the prompted scope is project", async () => {
		const { runtime, log } = createConfigRuntime({}, { askTargetScope: "project" });
		const { handler } = register(runtime);

		await handler("configure", {});

		expect(log.asksScope).toEqual(["project"]);
		expect(log.writes).toHaveLength(1);
		expect(log.writes[0]!.scope).toBe("project");
		expect(log.confirms[0]!).toContain(PROJECT_PATH);
		expect(log.reloads).toBe(1);
		expect(log.reRegisters).toBe(1);
		expect(log.notices).toEqual([
			{ message: `Configured runpod profile default at ${PROJECT_PATH}.`, kind: "success" },
		]);
	});

	test("headless mode: confirmation fails, so nothing is written, reloaded, or re-registered", async () => {
		// Headless/print runtimes resolve confirm() to false without prompting.
		const { runtime, log } = createConfigRuntime({}, { confirmResult: false });
		const { handler } = register(runtime);

		await handler("configure", {});

		// The handler asked for confirmation before mutating…
		expect(log.confirms).toHaveLength(1);
		expect(log.confirms[0]!).toContain(GLOBAL_PATH);
		// …and never performed any mutation or re-registration.
		expect(log.writes).toEqual([]);
		expect(log.reloads).toBe(0);
		expect(log.reRegisters).toBe(0);
		expect(log.flow).toEqual([]);
		expect(log.notices).toHaveLength(1);
		expect(log.notices[0]!.kind).toBe("error");
		expect(log.notices[0]!.message).toContain("default");
	});

	test("cancelled prompt: no values collected, so nothing is written, reloaded, or re-registered", async () => {
		const { runtime, log } = createConfigRuntime(
			{},
			{ askConfigValues: { cancelled: true } },
		);
		const { handler } = register(runtime);

		await handler("configure", {});

		expect(log.writes).toEqual([]);
		expect(log.reloads).toBe(0);
		expect(log.reRegisters).toBe(0);
		expect(log.flow).toEqual([]);
		expect(log.notices).toHaveLength(1);
		expect(log.notices[0]!.kind).toBe("error");
	});
});

describe("registerRunpodCommands: /runpod profile add", () => {
	test("appends the explicit named profile to the current layer, then reloads and re-registers", async () => {
		const { runtime, log } = createConfigRuntime(
			{},
			{ readLayer: { version: 1, profiles: { prod: PROD_PROFILE } } },
		);
		const { handler } = register(runtime);

		await handler("profile add staging", {});

		// The prompt is pre-filled with the explicit argument name.
		expect(log.prompts).toEqual([{ profileName: "staging" }]);
		// The explicit name, not the prompted default, is used.
		expect(log.writes).toHaveLength(1);
		expect(log.writes[0]!.scope).toBe("global");
		const written = log.writes[0]!.document;
		expect(Object.keys(written.profiles)).toEqual(["prod", "staging"]);
		expect(written.profiles["prod"]).toEqual(PROD_PROFILE);
		expect(written.profiles["staging"]!.invokeUrl).toBe("https://api.runpod.ai/v2/ep-cfg");
		expect(written.profiles["staging"]!.apiKey).toEqual({
			kind: "secret-reference",
			ref: "env:RUNPOD_API_KEY",
			redacted: "[redacted]",
		});
		// The written document round-trips valid, so it is a valid config.
		const roundTrip = parseProfileDocument(toYaml(written), "written");
		expect(roundTrip.errors).toEqual([]);
		expect(log.flow.join(",")).toBe("write,reload,reRegister");
		expect(log.notices).toEqual([
			{ message: `Added profile staging at ${GLOBAL_PATH}.`, kind: "success" },
		]);
	});

	test("replaces an existing same-named profile in place", async () => {
		const oldProfile = makeProfile(
			"staging",
			"load-balanced",
			"https://old.example/staging",
			null,
		);
		const { runtime, log } = createConfigRuntime(
			{},
			{ readLayer: { version: 1, profiles: { staging: oldProfile } } },
		);
		const { handler } = register(runtime);

		await handler("profile add staging", {});

		expect(log.writes).toHaveLength(1);
		const { document } = log.writes[0]!;
		// Still exactly one key: the same-named profile is replaced, not duplicated.
		expect(Object.keys(document.profiles)).toEqual(["staging"]);
		// The new structured values and the new key ref replace the old ones.
		expect(document.profiles["staging"]!.endpointType).toBe("queue");
		expect(document.profiles["staging"]!.invokeUrl).toBe("https://api.runpod.ai/v2/ep-cfg");
		expect(document.profiles["staging"]!.apiKey).toEqual({
			kind: "secret-reference",
			ref: "env:RUNPOD_API_KEY",
			redacted: "[redacted]",
		});
		expect(log.reloads).toBe(1);
		expect(log.reRegisters).toBe(1);
	});

	test("missing explicit name is an error and performs no mutation", async () => {
		const { runtime, log } = createConfigRuntime();
		const { handler } = register(runtime);

		await handler("profile add", {});

		expect(log.notices).toHaveLength(1);
		expect(log.notices[0]!.kind).toBe("error");
		expect(log.notices[0]!.message).toContain("add");
		expect(log.asksScope).toEqual([]);
		expect(log.writes).toEqual([]);
		expect(log.reloads).toBe(0);
		expect(log.reRegisters).toBe(0);
	});

	test("headless mode: confirmation fails, so the profile is not added", async () => {
		const { runtime, log } = createConfigRuntime({}, { confirmResult: false });
		const { handler } = register(runtime);

		await handler("profile add staging", {});

		expect(log.confirms).toHaveLength(1);
		expect(log.writes).toEqual([]);
		expect(log.reloads).toBe(0);
		expect(log.reRegisters).toBe(0);
		expect(log.notices).toHaveLength(1);
		expect(log.notices[0]!.kind).toBe("error");
		expect(log.notices[0]!.message).toContain("staging");
	});
});

describe("registerRunpodCommands: /runpod doctor", () => {
	test("reports global/project source paths and valid profile names with apiKey refs redacted", async () => {
		const { runtime, log } = createConfigRuntime();
		const { handler, setModel } = register(runtime);

		await handler("doctor", {});

		expect(log.doctorCalls).toBe(1);
		const notice = log.notices;
		expect(notice).toHaveLength(1);
		expect(notice[0]!.kind).toBe("info");
		expect(notice[0]!.message).toContain(GLOBAL_PATH);
		expect(notice[0]!.message).toContain(PROJECT_PATH);
		expect(notice[0]!.message).toContain("prod");
		expect(notice[0]!.message).toContain("dev");
		// The profile with a secret ref is shown as redacted…
		expect(notice[0]!.message).toContain("[redacted]");
		// …the ref text itself and any resolved credential bytes never appear.
		expect(notice[0]!.message).not.toContain("env:RUNPOD_API_KEY");
		expect(notice[0]!.message).not.toContain("sk-");
		// Doctor is read-only: no mutation, reload, re-register, or model change.
		expect(log.writes).toEqual([]);
		expect(log.reloads).toBe(0);
		expect(log.reRegisters).toBe(0);
		expect(log.setDefaultProfile).toEqual([]);
		expect(setModel).not.toHaveBeenCalled();
	});

	test("reports validation errors with their exact source paths, still redacting secrets", async () => {
		const errorPath = "/home/project/.omp/runpod.yml";
		const message = "document is not valid YAML: expected the node content";
		const { runtime, log } = createConfigRuntime(
			{},
			{
				doctorReport: {
					globalPath: GLOBAL_PATH,
					projectPath: PROJECT_PATH,
					profiles: [{ name: "prod", apiKeyRef: "env:RUNPOD_API_KEY" }],
					errors: [{ path: errorPath, message }],
				},
			},
		);
		const { handler } = register(runtime);

		await handler("doctor", {});

		const notice = log.notices[0]!.message;
		expect(log.notices).toHaveLength(1);
		expect(log.notices[0]!.kind).toBe("info");
		expect(notice).toContain(errorPath);
		expect(notice).toContain(message);
		expect(notice).not.toContain("env:RUNPOD_API_KEY");
		expect(notice).not.toContain("sk-");
	});

	test("reports an explicit empty state when no config files exist", async () => {
		const { runtime, log } = createConfigRuntime(
			{},
			{
				doctorReport: {
					globalPath: null,
					projectPath: null,
					profiles: [],
					errors: [],
				},
			},
		);
		const { handler } = register(runtime);

		await handler("doctor", {});

		const notice = log.notices[0]!.message;
		expect(log.notices).toHaveLength(1);
		expect(log.notices[0]!.kind).toBe("info");
		expect(notice).toContain("(none)");
		expect(log.writes).toEqual([]);
		expect(log.reloads).toBe(0);
		expect(log.reRegisters).toBe(0);
	});
});

describe("registerRunpodCommands: config commands never touch the OMP model selection", () => {
	test("configure, profile add, and doctor all avoid pi.setModel", async () => {
		const { runtime } = createConfigRuntime();
		const { handler, setModel } = register(runtime);

		await handler("configure", {});
		await handler("profile add staging", {});
		await handler("doctor", {});

		expect(setModel).not.toHaveBeenCalled();
	});
});

/**
 * Command runtime surface for the `/runpod` slash command.
 *
 * This module is the command surface of the Runpod OMP extension: it registers
 * exactly one extension command (`runpod`) whose handler dispatches on the
 * first whitespace-separated argument. Every behavior — profile listing,
 * default selection, deletion confirmation, explicit human queue control,
 * guided configuration, and all user-facing output — goes through the injected
 * {@link RunpodCommandRuntime} (or the extended
 * {@link RunpodConfigCommandRuntime}), never through OMP UI, model, or session
 * objects. In particular the extension-level default profile is never
 * conflated with the OMP model selection: no path in this module calls
 * `pi.setModel`. Handlers await and catch every runtime method and always
 * resolve normally, so failures surface as error notices instead of throwing
 * into the OMP command dispatcher.
 *
 * The configure / profile-add / doctor commands require the optional config
 * capability (`configPath`, `askTargetScope`, `askConfigValues`,
 * `readConfigLayer`, `writeConfigLayer`, `reloadConfig`,
 * `reRegisterProviders`, `loadDoctorReport`). When the injected runtime lacks
 * it, those commands fail closed with an honest error notice rather than
 * guessing or touching files; the base profile/control surface keeps working.
 */

import type {
	EndpointType,
	ModelMetadata,
	Profile,
	ProfileDocument,
	ProfilePolicy,
	ProfileRequest,
} from "./profile-schema.js";
import type { CostReport } from "./cost.js";
import type { NormalizedPodStatus } from "./control.js";
import type { PodProbeResult } from "./operations.js";

/** A Runpod profile as surfaced to the command surface. */
export interface CommandProfile {
	name: string;
	endpointType: EndpointType;
}

/** Notice kinds the command surface may emit through `runtime.notify`. */
export type CommandNoticeKind = "info" | "success" | "error";

/** A destructive queue operation available only through a human slash command. */
export type QueueMutation = "cancel" | "retry" | "purge";

/**
 * The minimal OMP extension-API surface the commands module uses: command
 * registration only. All other extension APIs are deliberately out of scope
 * here so the command surface stays testable with a narrowed pi.
 */
export interface CommandRegistrationAPI {
	registerCommand(
		name: string,
		options: {
			description: string;
			handler: (args: string, ctx: unknown) => Promise<void>;
		},
	): void;
}

/**
 * Injectable runtime for the `/runpod` command surface. The runtime owns all
 * data access (profile listing, the current default), all effects (default
 * selection, deletion, explicit queue control, interactive confirmation), and
 * all user-facing output (`notify`). Methods returning promises are awaited and
 * caught by the handlers.
 */
export interface RunpodCommandRuntime {
	listProfiles(): readonly CommandProfile[];
	getDefaultProfile(): string | null;
	setDefaultProfile(name: string): Promise<void>;
	confirm(prompt: string): Promise<boolean>;
	deleteProfile(name: string): Promise<void>;
	runQueueMutation(profile: string, operation: QueueMutation, jobId?: string): Promise<void>;
	/** Produce a fresh cost report (live estimate + actual billed) for a profile. */
	runCost(profileName: string): Promise<CostReport>;
	/** Run a pod control-plane operation; throws with an actionable message on failure. */
	runPodOperation(
		profileName: string,
		operation: "pod-status" | "pod-start" | "pod-stop" | "pod-restart",
	): Promise<NormalizedPodStatus>;
	/** Probe a pod profile's resolved address + readiness; never throws. */
	podProbe(profileName: string): Promise<PodProbeResult>;
	notify(message: string, kind?: CommandNoticeKind): void;
}

/** Where a guided config write targets: the global agent layer or the project layer. */
export type ConfigTargetScope = "global" | "project";

/** Structured field values collected by the guided configure/profile-add prompt. */
export interface ConfigPromptValues {
	/** Profile name; forced to the explicit argument for `profile add`. */
	name: string;
	endpointType: EndpointType;
	/** Static invokeUrl; required for queue/load-balanced, optional for pods. */
	invokeUrl?: string;
	model: ModelMetadata;
	/** Verbatim apiKey reference (e.g. "env:VAR", "!cmd", or a literal); null = none. */
	apiKeyRef: string | null;
	/** Pod block for `endpointType: "pod"` profiles; absent otherwise. */
	pod?: { id: string; port: number; inferenceApiKeyRef: string | null };
	request?: Partial<ProfileRequest>;
	policy?: Partial<ProfilePolicy>;
}

/** Result of an interactive config prompt; `cancelled` marks headless/no-collect. */
export interface ConfigPromptResult {
	cancelled: boolean;
	values?: ConfigPromptValues;
}

/** Structured doctor report: source paths, valid profile names, retained errors. */
export interface DoctorReport {
	globalPath: string | null;
	projectPath: string | null;
	profiles: Array<{ name: string; apiKeyRef: string | null }>;
	errors: Array<{ path: string; message: string }>;
}

/**
 * A per-invocation runtime source: either a ready {@link RunpodCommandRuntime}
 * object (used by direct module callers, e.g. the contract tests) or a factory
 * bound to the current command context that produces the runtime for each
 * dispatch. The factory form lets the extension harness build a
 * context-aware runtime — command-context UI/IO binding, per-invocation config
 * paths, reload and doctor — at dispatch time.
 */
export type RunpodCommandRuntimeResolver =
	| RunpodCommandRuntime
	| ((ctx: unknown) => RunpodCommandRuntime);

/**
 * Extended runtime enabling the guided configuration commands. It extends the
 * base profile/notice runtime with fully injected config IO (scope → path,
 * read/write layer), reload and provider-registration effects, structured
 * prompts, and a doctor report source. The command surface only orchestrates
 * these; it performs no real IO and never resolves secret references.
 */
export interface RunpodConfigCommandRuntime extends RunpodCommandRuntime {
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

/** The written secret redaction placeholder. */
const REDACTED = "[redacted]";

/**
 * Register the `/runpod` command surface: exactly one command named `runpod`
 * with a description and handler, and no other side effects.
 */
export function registerRunpodCommands(
	pi: CommandRegistrationAPI,
	runtime: RunpodCommandRuntimeResolver,
): void {
	pi.registerCommand("runpod", {
		description:
			"Manage Runpod profiles, guided configuration, diagnostics, and explicitly confirmed queue control.",
		handler: (args, ctx) =>
			runCommand(typeof runtime === "function" ? runtime(ctx) : runtime, args),
	});
}

/** Split a command argument string into whitespace-separated tokens. */
function tokenize(args: string): string[] {
	return args
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0);
}

/**
 * Narrow a base runtime to the config capability when it is actually present,
 * so configure/profile-add/doctor can run on extended runtimes and fail
 * honestly (an error notice) on base ones.
 */
function isConfigRuntime(
	runtime: RunpodCommandRuntime,
): runtime is RunpodConfigCommandRuntime {
	return (
		typeof (runtime as Partial<RunpodConfigCommandRuntime>).askConfigValues === "function"
	);
}

/** Handle one `/runpod` invocation; never throws into the dispatcher. */
async function runCommand(runtime: RunpodCommandRuntime, args: string): Promise<void> {
	try {
		const tokens = tokenize(args);
		const command = tokens[0];
		if (command === undefined) {
			// Bare `/runpod` lists the configured profiles (same as `profile`).
			reportProfiles(runtime);
			return;
		}
		const rest = tokens.slice(1);
		if (command === "profile") {
			await runProfile(runtime, rest);
			return;
		}
		if (command === "configure") {
			await runConfigure(runtime);
			return;
		}
		if (command === "doctor") {
			await runDoctor(runtime);
			return;
		}
		if (command === "cancel" || command === "retry" || command === "purge") {
			await runQueueMutation(runtime, command, rest);
			return;
		}
		if (command === "cost") {
			await runCostCommand(runtime, rest);
			return;
		}
		if (command === "pod") {
			await runPodCommand(runtime, rest);
			return;
		}
		runtime.notify(`Unknown runpod command: ${command}.`, "error");
	} catch (error) {
		reportError(runtime, error);
	}
}

/** Report an unexpected failure through the runtime; the handler still resolves. */
function reportError(runtime: RunpodCommandRuntime, error: unknown): void {
	const message =
		error instanceof Error && error.message.length > 0
			? error.message
			: "Something went wrong while running the runpod command.";
	try {
		runtime.notify(message, "error");
	} catch {
		// The runtime's own notify failed; there is no other channel to report through.
	}
}

/** Handle the `profile` subcommand: list, add, select, or `rm`. */
async function runProfile(runtime: RunpodCommandRuntime, rest: string[]): Promise<void> {
	const [subcommand, ...args] = rest;
	if (subcommand === undefined) {
		reportProfiles(runtime);
		return;
	}
	if (subcommand === "rm") {
		await removeProfile(runtime, args);
		return;
	}
	if (subcommand === "add") {
		await runProfileAdd(runtime, args);
		return;
	}
	await selectDefaultProfile(runtime, subcommand);
}

/** List profiles in runtime display order, marking the current default. */
function reportProfiles(runtime: RunpodCommandRuntime): void {
	const profiles = runtime.listProfiles();
	if (profiles.length === 0) {
		runtime.notify("Runpod profiles:\n  (none)", "info");
		return;
	}
	const defaultName = runtime.getDefaultProfile();
	const lines = profiles.map((profile) => {
		const suffix = profile.endpointType === "pod" ? " (pod)" : "";
		const marker = profile.name === defaultName ? " (default)" : "";
		return `  ${profile.name}${suffix}${marker}`;
	});
	runtime.notify(`Runpod profiles:\n${lines.join("\n")}`, "info");
}

/** Persist the named profile as the extension default; unknown names error. */
async function selectDefaultProfile(
	runtime: RunpodCommandRuntime,
	name: string,
): Promise<void> {
	const known = runtime.listProfiles().some((profile) => profile.name === name);
	if (!known) {
		runtime.notify(`Unknown profile: ${name}.`, "error");
		return;
	}
	await runtime.setDefaultProfile(name);
	runtime.notify(`Default profile set to ${name}.`, "success");
}

/** Delete a profile only after interactive confirmation; fail closed otherwise. */
async function removeProfile(runtime: RunpodCommandRuntime, args: string[]): Promise<void> {
	const name = args[0];
	if (name === undefined) {
		runtime.notify("Missing profile name for rm.", "error");
		return;
	}
	const confirmed = await runtime.confirm(`Delete profile ${name}? This cannot be undone.`);
	if (!confirmed) {
		runtime.notify(`Deletion of profile ${name} cancelled.`, "error");
		return;
	}
	await runtime.deleteProfile(name);
	runtime.notify(`Deleted profile ${name}.`, "success");
}

/** Run an explicitly targeted, interactive queue-control operation. */
async function runQueueMutation(
	runtime: RunpodCommandRuntime,
	operation: QueueMutation,
	args: string[],
): Promise<void> {
	const profileName = args[0];
	if (profileName === undefined) {
		runtime.notify(`Missing profile name for ${operation}.`, "error");
		return;
	}
	const jobId = args[1];
	if (operation !== "purge" && jobId === undefined) {
		runtime.notify(`Missing job id for ${operation}.`, "error");
		return;
	}
	const profile = runtime.listProfiles().find((candidate) => candidate.name === profileName);
	if (profile === undefined) {
		runtime.notify(`Unknown profile ${profileName}; cannot ${operation}.`, "error");
		return;
	}
	if (profile.endpointType !== "queue") {
		runtime.notify(
			`Cannot ${operation} on load-balanced profile ${profileName}; queue control requires a queue endpoint.`,
			"error",
		);
		return;
	}
	const prompt =
		operation === "purge"
			? `Purge all pending jobs on profile ${profileName}?`
			: `${operation[0]!.toUpperCase()}${operation.slice(1)} job ${jobId} on profile ${profileName}?`;
	if (!(await runtime.confirm(prompt))) {
		runtime.notify(`${operation[0]!.toUpperCase()}${operation.slice(1)} on profile ${profileName} was not confirmed.`, "error");
		return;
	}
	await runtime.runQueueMutation(profileName, operation, jobId);
	if (operation === "purge") {
		runtime.notify(`Purged pending jobs on profile ${profileName}.`, "success");
		return;
	}
	const pastTense = operation === "cancel" ? "Cancelled" : "Retried";
	runtime.notify(`${pastTense} job ${jobId} on profile ${profileName}.`, "success");
}

/** Format a USD amount with two decimals. */
function formatUsd(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

/** Format an uptime in seconds as "Xh Ym"; null (not running) renders as such. */
function formatUptime(seconds: number | null): string {
	if (seconds === null) {
		return "n/a (not running)";
	}
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return `${hours}h ${minutes}m`;
}

/**
 * `/runpod pod …`: pod lifecycle surface, commands only — no auto-start, no
 * idle auto-stop. `pod` lists each pod profile's live state; `pod <profile>`
 * shows the full report (state, uptime, rate, data center, resolved address,
 * readiness); `pod start|stop|restart <profile>` requires interactive
 * confirmation first (headless sessions fail closed).
 */
async function runPodCommand(runtime: RunpodCommandRuntime, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	if (subcommand === undefined) {
		const podProfiles = runtime.listProfiles().filter((profile) => profile.endpointType === "pod");
		if (podProfiles.length === 0) {
			runtime.notify("No pod profiles configured.", "info");
			return;
		}
		const lines = ["Runpod pods:"];
		for (const profile of podProfiles) {
			try {
				const status = await runtime.runPodOperation(profile.name, "pod-status");
				lines.push(`  ${profile.name} · ${status.status} · ${formatUsd(status.costPerHour)}/hr`);
			} catch (error) {
				lines.push(
					`  ${profile.name} · unavailable (${error instanceof Error ? error.message : "unknown error"})`,
				);
			}
		}
		runtime.notify(lines.join("\n"), "info");
		return;
	}

	if (subcommand === "start" || subcommand === "stop" || subcommand === "restart") {
		const profileName = rest[0];
		if (profileName === undefined) {
			runtime.notify(`Missing profile name for pod ${subcommand}.`, "error");
			return;
		}
		await runPodMutation(runtime, subcommand, profileName);
		return;
	}

	await showPodReport(runtime, subcommand);
}

/** Interactive, confirmed pod lifecycle transition; fails closed when headless. */
async function runPodMutation(
	runtime: RunpodCommandRuntime,
	operation: "start" | "stop" | "restart",
	profileName: string,
): Promise<void> {
	const profile = runtime.listProfiles().find((candidate) => candidate.name === profileName);
	if (profile === undefined) {
		runtime.notify(`Unknown profile ${profileName}; cannot ${operation} pod.`, "error");
		return;
	}
	if (profile.endpointType !== "pod") {
		runtime.notify(
			`Profile ${profileName} is not a pod profile; pod ${operation} requires a pod endpoint.`,
			"error",
		);
		return;
	}
	const prompt = `Runpod pod ${operation} on profile ${profileName}?`;
	if (!(await runtime.confirm(prompt))) {
		runtime.notify(`Pod ${operation} on profile ${profileName} was not confirmed.`, "error");
		return;
	}
	const status = await runtime.runPodOperation(profileName, `pod-${operation}`);
	runtime.notify(`Pod ${operation} on profile ${profileName}: now ${status.status}.`, "success");
}

/** Full pod status report for one profile; read-only, no confirmation. */
async function showPodReport(runtime: RunpodCommandRuntime, profileName: string): Promise<void> {
	const profile = runtime.listProfiles().find((candidate) => candidate.name === profileName);
	if (profile === undefined) {
		runtime.notify(`Unknown profile ${profileName}; cannot show pod status.`, "error");
		return;
	}
	if (profile.endpointType !== "pod") {
		runtime.notify(`Profile ${profileName} is not a pod profile.`, "error");
		return;
	}
	const status = await runtime.runPodOperation(profileName, "pod-status");
	const probe = await runtime.podProbe(profileName);
	const lines = [`runpod pod · profile "${profileName}"`];
	lines.push(`  state: ${status.status}`);
	lines.push(`  cost: ${formatUsd(status.costPerHour)}/hr`);
	lines.push(`  uptime: ${formatUptime(status.uptimeSeconds)}`);
	if (status.dataCenterId !== null) {
		lines.push(`  data center: ${status.dataCenterId}`);
	}
	if (probe.address !== undefined) {
		lines.push(`  address: ${probe.address}`);
	}
	lines.push(`  readiness: ${probe.health}`);
	if (probe.reason !== undefined) {
		lines.push(`  note: ${probe.reason}`);
	}
	runtime.notify(lines.join("\n"), "info");
}

/**
 * `/runpod cost [profile]`: read-only, always-fresh cost report. Live line is
 * the instantaneous estimate (placed workers × serverless price, plus accrued
 * from worker uptime); billed line is the actual per-endpoint billing history
 * (which lags the live state by the platform's ~5 minute billing cycle).
 * Each line degrades to `unavailable — <reason>` independently.
 */
async function runCostCommand(runtime: RunpodCommandRuntime, args: string[]): Promise<void> {
	const profileName = args[0] ?? runtime.getDefaultProfile();
	if (profileName === null) {
		runtime.notify("no default profile; pass a profile name", "error");
		return;
	}
	const profile = runtime.listProfiles().find((candidate) => candidate.name === profileName);
	if (profile === undefined) {
		runtime.notify(`Unknown profile ${profileName}; cannot show cost.`, "error");
		return;
	}
	const report = await runtime.runCost(profileName);
	const lines = [`runpod cost · profile "${profileName}"`];
	if (report.pod !== undefined) {
		lines.push(
			`Live (pod): ${formatUsd(report.pod.costPerHour)}/hr · ~${formatUsd(report.pod.accruedUsd)} accrued (state ${report.pod.state})`,
		);
	} else if (report.estimate !== undefined) {
		if (report.estimate.totalWorkers === 0) {
			lines.push(`Live (est): ${formatUsd(0)}/hr burn (no active workers)`);
		} else {
			let line = `Live (est): ${formatUsd(report.estimate.ratePerHour)}/hr burn · ~${formatUsd(report.estimate.accruedUsd)} accrued by ${report.estimate.totalWorkers} current workers`;
			if (report.estimate.partial) {
				line += ` (${report.estimate.pricedWorkers} of ${report.estimate.totalWorkers} workers priced)`;
			}
			lines.push(line);
		}
	} else {
		lines.push(`Live (est): unavailable — ${report.estimateError ?? "unknown error"}`);
	}
	if (report.billed !== undefined) {
		lines.push(
			`Billed (actual): ${formatUsd(report.billed.totalUsd)} last 24h (gpu ${formatUsd(report.billed.gpuUsd)} · disk ${formatUsd(report.billed.diskUsd)} · fee ${formatUsd(report.billed.feeUsd)}) · ${formatUsd(report.billed.todayUsd)} current hour`,
		);
	} else {
		lines.push(`Billed (actual): unavailable — ${report.billedError ?? "unknown error"}`);
	}
	runtime.notify(lines.join("\n"), "info");
}

/**
 * Build a complete, valid profile from the structured prompt values, applying
 * the planned request/policy defaults and keeping any apiKey as an unresolved
 * verbatim secret reference (never resolved here).
 */
function buildProfile(values: ConfigPromptValues): Profile {
	const request: ProfileRequest = {
		mode: "sync",
		timeoutMs: 300_000,
		polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
		queueAdapter: { kind: "openai-shaped" },
		loadBalancedPath: "/v1/chat/completions",
	};
	const policy: ProfilePolicy = {
		maxAttempts: 1,
		fallbackProfiles: [],
	};
	if (values.request !== undefined) {
		Object.assign(request, values.request);
	}
	if (values.policy !== undefined) {
		Object.assign(policy, values.policy);
	}
	const profile: Profile = {
		endpointType: values.endpointType,
		model: values.model,
		request,
		policy,
	};
	if (values.invokeUrl !== undefined && values.invokeUrl !== "") {
		profile.invokeUrl = values.invokeUrl;
	}
	if (values.pod !== undefined) {
		const pod: Profile["pod"] = { id: values.pod.id, port: values.pod.port };
		if (values.pod.inferenceApiKeyRef !== null) {
			pod.inferenceApiKey = {
				kind: "secret-reference",
				ref: values.pod.inferenceApiKeyRef,
				redacted: REDACTED,
			};
		}
		profile.pod = pod;
	}
	if (values.apiKeyRef !== null) {
		profile.apiKey = {
			kind: "secret-reference",
			ref: values.apiKeyRef,
			redacted: REDACTED,
		};
	}
	return profile;
}

/**
 * `/runpod configure`: ask the target scope, collect structured values,
 * confirm the destination, write a valid profile document atomically, then
 * reload and re-register. Headless/cancelled runs fail closed before any write.
 */
async function runConfigure(runtime: RunpodCommandRuntime): Promise<void> {
	if (!isConfigRuntime(runtime)) {
		runtime.notify("Guided configuration is not supported by this runtime.", "error");
		return;
	}
	const scope = await runtime.askTargetScope();
	const prompt = await runtime.askConfigValues();
	if (prompt.cancelled) {
		runtime.notify("Profile configuration cancelled.", "error");
		return;
	}
	const values = prompt.values!;
	const name = values.name;
	const path = runtime.configPath(scope);
	const document: ProfileDocument = {
		version: 1,
		profiles: { [name]: buildProfile(values) },
	};
	const confirmed = await runtime.confirm(`Configure runpod profile ${name} at ${path}?`);
	if (!confirmed) {
		runtime.notify(`Configuration of profile ${name} cancelled.`, "error");
		return;
	}
	await runtime.writeConfigLayer(scope, document);
	await runtime.reloadConfig();
	await runtime.reRegisterProviders();
	runtime.notify(`Configured runpod profile ${name} at ${path}.`, "success");
}

/**
 * `/runpod profile add <name>`: the same guided flow but the profile name is
 * taken from the explicit argument. It merges into the layer read back via
 * `readConfigLayer` (appends a new name, replaces an existing same-named
 * profile), writes, reloads, and re-registers.
 */
async function runProfileAdd(runtime: RunpodCommandRuntime, args: string[]): Promise<void> {
	const name = args[0];
	if (name === undefined) {
		runtime.notify("Missing profile name for add.", "error");
		return;
	}
	if (!isConfigRuntime(runtime)) {
		runtime.notify(
			"Guided profile configuration is not supported by this runtime.",
			"error",
		);
		return;
	}
	const scope = await runtime.askTargetScope();
	const prompt = await runtime.askConfigValues(name);
	if (prompt.cancelled) {
		runtime.notify("Profile configuration cancelled.", "error");
		return;
	}
	const values = prompt.values!;
	const current = await runtime.readConfigLayer(scope);
	const document: ProfileDocument = {
		version: 1,
		profiles: { ...current.profiles, [name]: buildProfile(values) },
	};
	const path = runtime.configPath(scope);
	const confirmed = await runtime.confirm(`Add runpod profile ${name} at ${path}?`);
	if (!confirmed) {
		runtime.notify(`Profile ${name} was not added.`, "error");
		return;
	}
	await runtime.writeConfigLayer(scope, document);
	await runtime.reloadConfig();
	await runtime.reRegisterProviders();
	runtime.notify(`Added profile ${name} at ${path}.`, "success");
}

/**
 * `/runpod doctor`: report the global/project source paths, valid profile
 * names, and retained validation errors, redacting every `apiKey` reference
 * to the placeholder. Read-only: no write, reload, re-register, or model
 * change, and no resolved credential byte is ever emitted.
 */
async function runDoctor(runtime: RunpodCommandRuntime): Promise<void> {
	if (!isConfigRuntime(runtime)) {
		runtime.notify("Doctor report is not supported by this runtime.", "error");
		return;
	}
	const report = await runtime.loadDoctorReport();
	const lines: string[] = ["Runpod doctor:"];
	lines.push(`  global config: ${report.globalPath ?? "(none)"}`);
	lines.push(`  project config: ${report.projectPath ?? "(none)"}`);
	if (report.profiles.length === 0) {
		lines.push("  profiles: (none)");
	} else {
		lines.push("  profiles:");
		for (const profile of report.profiles) {
			const redacted = profile.apiKeyRef !== null ? ` (apiKey ${REDACTED})` : "";
			lines.push(`    ${profile.name}${redacted}`);
		}
	}
	if (report.errors.length === 0) {
		lines.push("  errors: none");
	} else {
		lines.push("  errors:");
		for (const error of report.errors) {
			lines.push(`    ${error.path}: ${error.message}`);
		}
	}
	runtime.notify(lines.join("\n"), "info");
}

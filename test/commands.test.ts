/**
 * Contract tests for the `/runpod` command surface.
 *
 * These tests define the observable behavior of the approved plan:
 *
 * - `registerRunpodCommands(pi, runtime)` (src/commands.ts) registers exactly
 *   one extension command named `runpod` via
 *   `pi.registerCommand("runpod", { description, handler })` and performs no
 *   other side effects. Both parameters are small dependency-injection types
 *   owned by the commands module: `pi` is narrowed to
 *   `CommandRegistrationAPI` (the registerCommand surface) and `runtime` is
 *   `RunpodCommandRuntime` (profile data, default selection, confirmations,
 *   mutations, and notices). OMP dispatches `/runpod profile` as command name
 *   `runpod` with args `profile`; the handler dispatches on the first
 *   whitespace-separated argument. All user-facing output and all data access
 *   go through the injected runtime — never through OMP UI, model, or session
 *   objects — so the tests pass a stub runtime and a mocked pi (only
 *   `registerCommand` is expected to be called; `setModel` is spied to prove
 *   the commands never touch the OMP model selection).
 * - `/runpod profile` (no further arguments) reports the merged profiles as a
 *   single info notice, one profile per line in display order (global first,
 *   project-appended):
 *
 *       Runpod profiles:
 *         <name>[ (default)]
 *         ...
 *
 *   The line of the profile named by `getDefaultProfile()` carries the
 *   ` (default)` suffix; with no profiles configured the body is `(none)`.
 *   The listing performs no mutation and never calls `pi.setModel`.
 * - `/runpod profile <name>` persists the extension-level default profile via
 *   `runtime.setDefaultProfile(name)` and reports `Default profile set to
 *   <name>.` It NEVER calls `pi.setModel` — the extension default is not the
 *   OMP model selection. An unknown name reports an error notice naming the
 *   profile and changes nothing.
 * - `/runpod profile rm <name>` deletes a profile only after
 *   `runtime.confirm(prompt)` resolves true (the prompt names the profile).
 *   When confirmation fails — including headless/print mode, where a runtime's
 *   `confirm` resolves false without prompting — an error notice names the
 *   profile and `runtime.deleteProfile` is never called.
 * - `/runpod cancel <profile> <jobId>`, `/runpod retry <profile> <jobId>`,
 *   and `/runpod purge <profile>` are explicit human queue-control commands.
 *   They reject unknown and load-balanced profiles before prompting, require
 *   interactive confirmation, and then invoke `runtime.runQueueMutation`.
 *   They never use the extension default: destructive commands require an
 *   explicit target profile.
 * - Any other first argument reports an error notice and performs no action.
 * - Failures are reported through `runtime.notify(..., "error")`; handlers
 *   resolve normally (they never throw into the OMP command dispatcher).
 *
 * These tests intentionally fail until src/commands.ts is implemented.
 */
import { describe, expect, mock, test, type Mock } from "bun:test";

import { registerRunpodCommands } from "../src/commands.js";
import type {
	CommandNoticeKind,
	CommandProfile,
	CommandRegistrationAPI,
	QueueMutation,
	RunpodCommandRuntime,
} from "../src/commands.js";

const QUEUE_PROFILE: CommandProfile = { name: "prod", endpointType: "queue" };
const LOAD_BALANCED_PROFILE: CommandProfile = {
	name: "dev",
	endpointType: "load-balanced",
};
const PROFILES: readonly CommandProfile[] = [QUEUE_PROFILE, LOAD_BALANCED_PROFILE];

/** Calls made to the injected runtime during one test. */
interface RuntimeCallLog {
	setDefaultProfile: string[];
	deleteProfile: string[];
	queueMutations: Array<{ profile: string; operation: QueueMutation; jobId?: string }>;
	costCalls: string[];
	confirms: string[];
	notices: Array<{ message: string; kind: CommandNoticeKind }>;
}

/**
 * Build an injectable runtime stub. Every action records into `log`; `notify`
 * defaults to kind "info". `confirmResult` models interactive availability:
 * false stands in for headless/print mode, where no UI can confirm a mutation.
 */
function createRuntime(
	overrides: Partial<RunpodCommandRuntime> = {},
	confirmResult: boolean = true,
): { runtime: RunpodCommandRuntime; log: RuntimeCallLog } {
	const log: RuntimeCallLog = {
		setDefaultProfile: [],
		deleteProfile: [],
		queueMutations: [],
		costCalls: [],
		confirms: [],
		notices: [],
	};
	const runtime: RunpodCommandRuntime = {
		listProfiles: () => [],
		getDefaultProfile: () => null,
		async setDefaultProfile(name) {
			log.setDefaultProfile.push(name);
		},
		async confirm(prompt) {
			log.confirms.push(prompt);
			return confirmResult;
		},
		notify(message, kind = "info") {
			log.notices.push({ message, kind });
		},
		async deleteProfile(name) {
			log.deleteProfile.push(name);
		},
		async runQueueMutation(profile, operation, jobId) {
			log.queueMutations.push({ profile, operation, ...(jobId === undefined ? {} : { jobId }) });
		},
		async runCost(profileName) {
			log.costCalls.push(profileName);
			return { profile: profileName, endpointType: "queue" };
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

/**
 * Minimal OMP extension-API surface the commands module is planned to use
 * (src/commands.ts exports it as `CommandRegistrationAPI`).
 */
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
 * Register the commands with a fresh pi mock and return the captured
 * registration, its handler, and the setModel spy. Tests invoke the handler
 * the way the OMP dispatcher would: `await handler(args, ctx)` where args is
 * everything after `/runpod ` (e.g. `"profile dev"`).
 */
function register(runtime: RunpodCommandRuntime): {
	setModel: CommandPiMock["setModel"];
	registrations: CommandRegistration[];
	handler: (args: string, ctx: unknown) => Promise<void>;
} {
	const { pi, setModel, registrations } = createPiMock();
	registerRunpodCommands(pi, runtime);
	return { setModel, registrations, handler: registrations[0]!.handler };
}

describe("registerRunpodCommands: registration", () => {
	test("registers exactly one command named 'runpod' with a handler", () => {
		const { runtime, log } = createRuntime();
		const { setModel, registrations } = register(runtime);

		expect(registrations).toHaveLength(1);
		const command = registrations[0]!;
		expect(command.name).toBe("runpod");
		expect(command.description?.length).toBeGreaterThan(0);
		expect(typeof command.handler).toBe("function");

		// Registration itself performs no runtime calls and no model changes.
		expect(log.notices).toEqual([]);
		expect(setModel).not.toHaveBeenCalled();
	});
});

describe("registerRunpodCommands: /runpod profile listing", () => {
	test("lists profiles in display order and marks the current default", async () => {
		const { runtime, log } = createRuntime({
			listProfiles: () => PROFILES,
			getDefaultProfile: () => "prod",
		});
		const { handler, setModel } = register(runtime);

		await handler("profile", {});

		expect(log.notices).toEqual([
			{ message: "Runpod profiles:\n  prod (default)\n  dev", kind: "info" },
		]);
		expect(log.setDefaultProfile).toEqual([]);
		expect(log.deleteProfile).toEqual([]);
		expect(log.queueMutations).toEqual([]);
		expect(setModel).not.toHaveBeenCalled();
	});

	test("lists profiles without a default marker when no default is set", async () => {
		const { runtime, log } = createRuntime({
			listProfiles: () => PROFILES,
			getDefaultProfile: () => null,
		});
		const { handler } = register(runtime);

		await handler("profile", {});

		expect(log.notices).toEqual([
			{ message: "Runpod profiles:\n  prod\n  dev", kind: "info" },
		]);
	});

	test("lists the empty state when no profiles are configured", async () => {
		const { runtime, log } = createRuntime();
		const { handler } = register(runtime);

		await handler("profile", {});

		expect(log.notices).toEqual([{ message: "Runpod profiles:\n  (none)", kind: "info" }]);
	});
});

describe("registerRunpodCommands: /runpod profile <name> default selection", () => {
	test("selects the named profile as the extension default without calling pi.setModel", async () => {
		const { runtime, log } = createRuntime({ listProfiles: () => PROFILES });
		const { handler, setModel } = register(runtime);

		await handler("profile dev", {});

		expect(log.setDefaultProfile).toEqual(["dev"]);
		expect(log.notices).toEqual([
			{ message: "Default profile set to dev.", kind: "success" },
		]);
		expect(setModel).not.toHaveBeenCalled();
	});

	test("rejects an unknown profile name without changing the default", async () => {
		const { runtime, log } = createRuntime({ listProfiles: () => PROFILES });
		const { handler, setModel } = register(runtime);

		await handler("profile nope", {});

		expect(log.setDefaultProfile).toEqual([]);
		expect(log.notices).toHaveLength(1);
		expect(log.notices[0]!.kind).toBe("error");
		expect(log.notices[0]!.message).toContain("nope");
		expect(setModel).not.toHaveBeenCalled();
	});
});

describe("registerRunpodCommands: explicit human queue control", () => {
	test("confirms and cancels a job on the named queue profile", async () => {
		const { runtime, log } = createRuntime({ listProfiles: () => PROFILES });
		const { handler } = register(runtime);

		await handler("cancel prod job-42", {});

		expect(log.confirms).toEqual(["Cancel job job-42 on profile prod?"]);
		expect(log.queueMutations).toEqual([
			{ profile: "prod", operation: "cancel", jobId: "job-42" },
		]);
		expect(log.notices).toEqual([
			{ message: "Cancelled job job-42 on profile prod.", kind: "success" },
		]);
	});

	test("confirms and retries a job on the named queue profile", async () => {
		const { runtime, log } = createRuntime({ listProfiles: () => PROFILES });
		const { handler } = register(runtime);

		await handler("retry prod job-42", {});

		expect(log.confirms).toEqual(["Retry job job-42 on profile prod?"]);
		expect(log.queueMutations).toEqual([
			{ profile: "prod", operation: "retry", jobId: "job-42" },
		]);
		expect(log.notices).toEqual([
			{ message: "Retried job job-42 on profile prod.", kind: "success" },
		]);
	});

	test("confirms and purges the named queue profile", async () => {
		const { runtime, log } = createRuntime({ listProfiles: () => PROFILES });
		const { handler } = register(runtime);

		await handler("purge prod", {});

		expect(log.confirms).toEqual(["Purge all pending jobs on profile prod?"]);
		expect(log.queueMutations).toEqual([{ profile: "prod", operation: "purge" }]);
		expect(log.notices).toEqual([
			{ message: "Purged pending jobs on profile prod.", kind: "success" },
		]);
	});

	test("rejects a load-balanced target before prompting or mutating", async () => {
		const { runtime, log } = createRuntime({ listProfiles: () => PROFILES });
		const { handler } = register(runtime);

		await handler("cancel dev job-42", {});

		expect(log.confirms).toEqual([]);
		expect(log.queueMutations).toEqual([]);
		expect(log.notices).toEqual([
			{
				message: "Cannot cancel on load-balanced profile dev; queue control requires a queue endpoint.",
				kind: "error",
			},
		]);
	});

	test("fails closed when interactive confirmation is unavailable", async () => {
		const { runtime, log } = createRuntime({ listProfiles: () => PROFILES }, false);
		const { handler } = register(runtime);

		await handler("purge prod", {});

		expect(log.confirms).toEqual(["Purge all pending jobs on profile prod?"]);
		expect(log.queueMutations).toEqual([]);
		expect(log.notices).toEqual([
			{ message: "Purge on profile prod was not confirmed.", kind: "error" },
		]);
	});

	test("requires an explicit queue profile and job id where applicable", async () => {
		const { runtime, log } = createRuntime({ listProfiles: () => PROFILES });
		const { handler } = register(runtime);

		await handler("retry prod", {});
		await handler("purge", {});

		expect(log.confirms).toEqual([]);
		expect(log.queueMutations).toEqual([]);
		expect(log.notices).toEqual([
			{ message: "Missing job id for retry.", kind: "error" },
			{ message: "Missing profile name for purge.", kind: "error" },
		]);
	});
});

describe("registerRunpodCommands: /runpod profile rm confirmation gate", () => {
	test("deletes the profile after interactive confirmation", async () => {
		const { runtime, log } = createRuntime({ listProfiles: () => PROFILES });
		const { handler } = register(runtime);

		await handler("profile rm dev", {});

		expect(log.confirms).toHaveLength(1);
		expect(log.confirms[0]!).toContain("dev");
		expect(log.deleteProfile).toEqual(["dev"]);
		expect(log.notices).toEqual([
			{ message: "Deleted profile dev.", kind: "success" },
		]);
	});

	test("headless mode: confirmation fails, so no mutation action is called", async () => {
		// Headless/print runtimes resolve confirm() to false without prompting.
		const { runtime, log } = createRuntime({ listProfiles: () => PROFILES }, false);
		const { handler } = register(runtime);

		await handler("profile rm dev", {});

		// The handler still asked for confirmation before mutating…
		expect(log.confirms).toHaveLength(1);
		expect(log.confirms[0]!).toContain("dev");
		// …and never performed the mutation.
		expect(log.deleteProfile).toEqual([]);
		expect(log.notices).toHaveLength(1);
		expect(log.notices[0]!.kind).toBe("error");
		expect(log.notices[0]!.message).toContain("dev");
	});
});

describe("registerRunpodCommands: /runpod cost", () => {
	test("renders the live estimate and billed actuals for the named profile", async () => {
		const costCalls: string[] = [];
		const { runtime, log } = createRuntime({
			listProfiles: () => PROFILES,
			async runCost(profileName) {
				costCalls.push(profileName);
				return {
					profile: "prod",
					endpointType: "queue",
					estimate: { ratePerHour: 1.1, accruedUsd: 1.1, pricedWorkers: 1, totalWorkers: 1, partial: false },
					billed: { hours: 24, totalUsd: 8.9, gpuUsd: 7.5, diskUsd: 0.4, feeUsd: 1.0, todayUsd: 8.9, recordCount: 1 },
				};
			},
		});
		const { handler, setModel } = register(runtime);

		await handler("cost prod", {});

		expect(costCalls).toEqual(["prod"]);
		expect(log.confirms).toEqual([]);
		expect(log.notices).toEqual([
			{
				message:
					'runpod cost · profile "prod"\n' +
					"Live (est): $1.10/hr burn · ~$1.10 accrued by 1 current workers\n" +
					"Billed (actual): $8.90 last 24h (gpu $7.50 · disk $0.40 · fee $1.00) · $8.90 current hour",
				kind: "info",
			},
		]);
		expect(setModel).not.toHaveBeenCalled();
	});

	test("falls back to the default profile when no name is given", async () => {
		const { runtime, log } = createRuntime({
			listProfiles: () => PROFILES,
			getDefaultProfile: () => "prod",
		});
		const { handler } = register(runtime);

		await handler("cost", {});

		expect(log.costCalls).toEqual(["prod"]);
		expect(log.notices[0]!.message).toContain('profile "prod"');
	});

	test("rejects an unknown profile without calling runCost", async () => {
		const { runtime, log } = createRuntime({ listProfiles: () => PROFILES });
		const { handler } = register(runtime);

		await handler("cost nope", {});

		expect(log.costCalls).toEqual([]);
		expect(log.notices).toEqual([
			{ message: "Unknown profile nope; cannot show cost.", kind: "error" },
		]);
	});

	test("requires a profile when no default is set", async () => {
		const { runtime, log } = createRuntime({ listProfiles: () => PROFILES });
		const { handler } = register(runtime);

		await handler("cost", {});

		expect(log.costCalls).toEqual([]);
		expect(log.notices).toEqual([
			{ message: "no default profile; pass a profile name", kind: "error" },
		]);
	});

	test("marks a partial estimate with the priced-worker counts", async () => {
		const { runtime, log } = createRuntime({
			listProfiles: () => PROFILES,
			async runCost() {
				return {
					profile: "prod",
					endpointType: "queue",
					estimate: { ratePerHour: 3.2, accruedUsd: 0.4, pricedWorkers: 1, totalWorkers: 3, partial: true },
					billed: { hours: 24, totalUsd: 0, gpuUsd: 0, diskUsd: 0, feeUsd: 0, todayUsd: 0, recordCount: 0 },
				};
			},
		});
		const { handler } = register(runtime);

		await handler("cost prod", {});

		expect(log.notices[0]!.message).toContain(
			"Live (est): $3.20/hr burn · ~$0.40 accrued by 3 current workers (1 of 3 workers priced)",
		);
	});

	test("shows the no-active-workers form instead of a zero rate", async () => {
		const { runtime, log } = createRuntime({
			listProfiles: () => PROFILES,
			async runCost() {
				return {
					profile: "prod",
					endpointType: "queue",
					estimate: { ratePerHour: 0, accruedUsd: 0, pricedWorkers: 0, totalWorkers: 0, partial: false },
					billed: { hours: 24, totalUsd: 0, gpuUsd: 0, diskUsd: 0, feeUsd: 0, todayUsd: 0, recordCount: 0 },
				};
			},
		});
		const { handler } = register(runtime);

		await handler("cost prod", {});

		expect(log.notices[0]!.message).toContain("Live (est): $0.00/hr burn (no active workers)");
	});

	test("degrades each line independently when a section errored", async () => {
		const { runtime, log } = createRuntime({
			listProfiles: () => PROFILES,
			async runCost() {
				return {
					profile: "prod",
					endpointType: "queue",
					estimateError: "control-plane access denied (key lacks required scope)",
					billedError: "cannot derive endpoint id from invokeUrl",
				};
			},
		});
		const { handler } = register(runtime);

		await handler("cost prod", {});

		expect(log.notices[0]!.message).toContain(
			"Live (est): unavailable — control-plane access denied (key lacks required scope)",
		);
		expect(log.notices[0]!.message).toContain(
			"Billed (actual): unavailable — cannot derive endpoint id from invokeUrl",
		);
	});
});

describe("registerRunpodCommands: unknown subcommand", () => {
	test("reports an error notice and performs no action", async () => {
		const { runtime, log } = createRuntime({ listProfiles: () => PROFILES });
		const { handler, setModel } = register(runtime);

		await handler("frobnicate", {});

		expect(log.notices).toHaveLength(1);
		expect(log.notices[0]!.kind).toBe("error");
		expect(log.setDefaultProfile).toEqual([]);
		expect(log.deleteProfile).toEqual([]);
		expect(log.queueMutations).toEqual([]);
		expect(setModel).not.toHaveBeenCalled();
	});
});

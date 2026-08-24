import { describe, expect, test } from "bun:test";

import { registerRunpodTools } from "../src/operations.js";
import type {
	RunpodControl,
	RunpodTool,
	RunpodToolDetails,
	RunpodToolOperation,
	RunpodToolResult,
	ToolRegistrationApi,
} from "../src/operations.js";
import type { ControlInput, ControlOperation, ControlOutcome } from "../src/control.js";
import type { Profile } from "../src/profile-schema.js";

const QUEUE_NAME = "llama-3-8b";
const LB_NAME = "qwen-lb";
const JOB_ID = "job-abc";
const SECRET_MARKER = "sup3r-s3cret-token-x9";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
	return {
		endpointType: "queue",
		invokeUrl: "https://api.runpod.ai/v2/ep",
		model: {
			id: "meta-llama/llama-3.3-70b-instruct",
			name: "Llama 3.3 70B",
			contextWindow: 131_072,
			maxTokens: 8_192,
			reasoning: false,
			input: ["text"],
			supportsTools: true,
			supportsVision: false,
		},
		apiKey: { kind: "secret-reference", ref: SECRET_MARKER, redacted: "[redacted]" },
		request: {
			mode: "async",
			timeoutMs: 300_000,
			polling: { intervalMs: 1_000, ttlMs: 1_800_000, focusAware: true },
			queueAdapter: { kind: "openai-shaped" },
			loadBalancedPath: "/v1/chat/completions",
		},
		policy: { maxAttempts: 1, fallbackProfiles: [] },
		...overrides,
	};
}

interface RecordedTool {
	tool: RunpodTool;
}

function createMockPi(log: RecordedTool[]): ToolRegistrationApi {
	return {
		registerTool(tool): void {
			log.push({ tool });
		},
	};
}

function registeredNames(log: RecordedTool[]): string[] {
	return log.map(({ tool }) => tool.name).sort();
}

function registered(log: RecordedTool[], name: string): RunpodTool {
	const matches = log.filter(({ tool }) => tool.name === name);
	expect(matches).toHaveLength(1);
	return matches[0]!.tool;
}

async function runTool(
	tool: RunpodTool,
	params: Record<string, unknown>,
): Promise<RunpodToolResult> {
	return await tool.execute("call_1", params, undefined, undefined, undefined);
}

interface ControlCall {
	profile: string;
	input: ControlInput;
}

function recordingControl(
	respond: (call: ControlCall) => ControlOutcome | Promise<ControlOutcome>,
): { calls: ControlCall[]; control: RunpodControl } {
	const calls: ControlCall[] = [];
	const control: RunpodControl = async (profile, input) => {
		const call = { profile, input };
		calls.push(call);
		return await respond(call);
	};
	return { calls, control };
}

function okOutcome(
	operation: ControlOperation,
	extra: Record<string, unknown> = {},
): ControlOutcome {
	return { ok: true, operation, ...extra } as ControlOutcome;
}

function assertRedacted(result: RunpodToolResult): void {
	expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
}

describe("registerRunpodTools", () => {
	test("registers only read-only health, ping, and status tools", () => {
		const log: RecordedTool[] = [];
		registerRunpodTools(
			createMockPi(log),
			{
				[QUEUE_NAME]: makeProfile(),
				[LB_NAME]: makeProfile({ endpointType: "load-balanced" }),
			},
			() => Promise.resolve(okOutcome("health")),
		);

		expect(registeredNames(log)).toEqual([
			"runpod_health",
			"runpod_ping",
			"runpod_status",
		]);
		expect(log.every(({ tool }) => tool.approval === "read")).toBe(true);
	});

	test("dispatches queue health with a redacted structured result", async () => {
		const { calls, control } = recordingControl(() => okOutcome("health"));
		const log: RecordedTool[] = [];
		registerRunpodTools(createMockPi(log), { [QUEUE_NAME]: makeProfile() }, control);

		const result = await runTool(registered(log, "runpod_health"), { profile: QUEUE_NAME });

		expect(calls).toEqual([{ profile: QUEUE_NAME, input: { operation: "health" } }]);
		expect(result.details).toEqual<RunpodToolDetails>({
			profile: QUEUE_NAME,
			endpointType: "queue",
			operation: "health",
			supported: true,
			ok: true,
			freshness: "live",
		});
		assertRedacted(result);
	});

	test("dispatches load-balanced ping and queue status through their read-only tools", async () => {
		const { calls, control } = recordingControl(({ input }) =>
			input.operation === "ping"
				? okOutcome("ping", { ping: "healthy" })
				: okOutcome("status", { jobStatus: "COMPLETED" }),
		);
		const log: RecordedTool[] = [];
		registerRunpodTools(
			createMockPi(log),
			{
				[QUEUE_NAME]: makeProfile(),
				[LB_NAME]: makeProfile({ endpointType: "load-balanced" }),
			},
			control,
		);

		await runTool(registered(log, "runpod_ping"), { profile: LB_NAME });
		const result = await runTool(registered(log, "runpod_status"), {
			profile: QUEUE_NAME,
			jobId: JOB_ID,
		});

		expect(calls).toEqual([
			{ profile: LB_NAME, input: { operation: "ping" } },
			{ profile: QUEUE_NAME, input: { operation: "status", jobId: JOB_ID } },
		]);
		expect(result.details.operation satisfies RunpodToolOperation).toBe("status");
		expect(result.details.freshness).toBe("live");
	});
});

describe("runpod_pod tool", () => {
	const POD_NAME = "subs";
	const POD_PROFILE = makeProfile({
		endpointType: "pod",
		invokeUrl: undefined,
		pod: { id: "pod_abc123", port: 8000 },
	});

	function podStatusOutcome(): ControlOutcome {
		return {
			ok: true,
			operation: "pod-status",
			pod: {
				id: "pod_abc123",
				name: "qwen-subs",
				status: "RUNNING",
				costPerHour: 1.19,
				uptimeSeconds: 7_200,
				dataCenterId: "US-TX-1",
			},
		};
	}

	test("registers runpod_pod only when a pod profile exists and a probe is wired", () => {
		const log: RecordedTool[] = [];
		registerRunpodTools(createMockPi(log), { [POD_NAME]: POD_PROFILE }, recordingControl(() => okOutcome("ping")).control, async () => ({
			address: "http://45.23.12.1:43210",
			health: "healthy",
		}));
		expect(registeredNames(log)).toContain("runpod_pod");

		const noPodLog: RecordedTool[] = [];
		registerRunpodTools(
			createMockPi(noPodLog),
			{ queue: makeProfile() },
			recordingControl(() => okOutcome("ping")).control,
			async () => ({ address: "http://x", health: "healthy" }),
		);
		expect(registeredNames(noPodLog)).not.toContain("runpod_pod");
	});

	test("reports state, rate, uptime, address, and readiness without key material", async () => {
		const { calls, control } = recordingControl(() => podStatusOutcome());
		const log: RecordedTool[] = [];
		registerRunpodTools(createMockPi(log), { [POD_NAME]: POD_PROFILE }, control, async () => ({
			address: "http://45.23.12.1:43210",
			health: "healthy",
		}));
		const result = await runTool(registered(log, "runpod_pod"), { profile: POD_NAME });

		expect(calls).toEqual([{ profile: POD_NAME, input: { operation: "pod-status" } }]);
		expect(result.isError).not.toBe(true);
		const text = result.content[0]!.text;
		expect(text).toContain("RUNNING");
		expect(text).toContain("$1.19/hr");
		expect(text).toContain("2h 0m");
		expect(text).toContain("US-TX-1");
		expect(text).toContain("http://45.23.12.1:43210");
		expect(text).toContain("healthy");
		expect(text).not.toContain(SECRET_MARKER);
	});

	test("a stopped pod reports the state with the reason and no address", async () => {
		const { control } = recordingControl(() => ({
			ok: true,
			operation: "pod-status",
			pod: {
				id: "pod_abc123",
				name: "qwen-subs",
				status: "EXITED",
				costPerHour: 0,
				uptimeSeconds: null,
				dataCenterId: "US-TX-1",
			},
		}));
		const log: RecordedTool[] = [];
		registerRunpodTools(createMockPi(log), { [POD_NAME]: POD_PROFILE }, control, async () => ({
			health: "unhealthy",
			reason: "runpod provider: pod pod_abc123 is EXITED — start it with /runpod pod start",
		}));
		const result = await runTool(registered(log, "runpod_pod"), { profile: POD_NAME });

		const text = result.content[0]!.text;
		expect(text).toContain("EXITED");
		expect(text).toContain("$0.00/hr");
		expect(text).toContain("readiness: unhealthy");
		expect(text).toContain("/runpod pod start");
		expect(text).not.toContain("address:");
	});

	test("an unknown profile fails with an explicit reason", async () => {
		const log: RecordedTool[] = [];
		registerRunpodTools(createMockPi(log), { [POD_NAME]: POD_PROFILE }, recordingControl(() => podStatusOutcome()).control, async () => ({
			health: "unhealthy",
		}));
		const result = await runTool(registered(log, "runpod_pod"), { profile: "ghost" });

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("No profile matched the supplied profile name.");
	});
});

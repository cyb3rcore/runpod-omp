/**
 * Read-only Runpod operational tools.
 *
 * Models can inspect endpoint health, readiness, and job status, but cannot
 * mutate queue state. Destructive control remains an explicit `/runpod` human
 * command so an inference provider never operates its own control plane.
 */
import { z } from "@oh-my-pi/pi-coding-agent";
import type { LoadBalancedHealth } from "./transport/load-balanced.js";
import type { ControlInput, ControlOutcome } from "./control.js";
import type { EndpointType, Profile } from "./profile-schema.js";

/** The read-only endpoint state a model may inspect. */
export type RunpodToolOperation = "health" | "ping" | "status" | "pod-status";

/** All exposed Runpod tools use OMP's read approval tier. */
export type RunpodToolApproval = "read";

/** Structural stand-in for OMP's custom-tool registration surface. */
export interface ToolRegistrationApi {
	registerTool(tool: RunpodTool): void;
}

/** The injected control-plane dispatcher; this module performs no network I/O. */
export type RunpodControl = (
	profileName: string,
	input: ControlInput,
) => Promise<ControlOutcome>;

/** Result of a pod probe: the resolved worker address (when reachable) + readiness. */
export interface PodProbeResult {
	address?: string;
	health: LoadBalancedHealth;
	/** Why the address/health could not be determined; absent when all good. */
	reason?: string;
}

/** The injected pod probe; performs the network work this module never does. */
export type RunpodPodProbe = (profileName: string) => Promise<PodProbeResult>;

/** Structured, redacted payload every tool result carries. */
export interface RunpodToolDetails {
	profile: string;
	endpointType: EndpointType;
	operation: RunpodToolOperation;
	supported: boolean;
	ok: boolean;
	freshness?: "live";
	detail?: string;
}

/** Result shape every Runpod operational tool resolves to. */
export interface RunpodToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: RunpodToolDetails;
	isError?: boolean;
}

/** A registered read-only Runpod tool. */
export interface RunpodTool {
	name: string;
	approval: RunpodToolApproval;
	description: string;
	parameters: typeof TOOL_PARAMETERS;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		stream: unknown,
		ctx: unknown,
		extra: unknown,
	): Promise<RunpodToolResult>;
}

const TOOL_PARAMETERS = z.object({
	profile: z.string(),
	jobId: z.string().optional(),
});

interface ToolSpec {
	name: string;
	operation: RunpodToolOperation;
	needsJobId: boolean;
}

const QUEUE_READ_TOOLS: readonly ToolSpec[] = [
	{ name: "runpod_health", operation: "health", needsJobId: false },
];

const LB_READ_TOOLS: readonly ToolSpec[] = [
	{ name: "runpod_ping", operation: "ping", needsJobId: false },
];

const ANY_READ_TOOLS: readonly ToolSpec[] = [
	{ name: "runpod_status", operation: "status", needsJobId: true },
];

function describeTool(operation: RunpodToolOperation): string {
	switch (operation) {
		case "health":
			return "Report worker health for a Runpod queue endpoint profile.";
		case "status":
			return "Report the status of a job on a Runpod queue endpoint profile.";
		case "ping":
			return "Probe the readiness of a Runpod load-balanced endpoint profile.";
		case "pod-status":
			return "Report the live state of a Runpod pod profile.";
	}
}

function renderText(details: RunpodToolDetails): string {
	const state = details.ok ? "succeeded" : details.supported ? "failed" : "unsupported";
	let text = `runpod_${details.operation} ${state} for profile "${details.profile}"`;
	if (details.detail) text += `: ${details.detail}`;
	return text;
}

function failureResult(
	profileName: string,
	profile: Profile | undefined,
	operation: RunpodToolOperation,
	detail: string,
): RunpodToolResult {
	const details: RunpodToolDetails = {
		profile: profileName,
		endpointType: profile?.endpointType ?? "queue",
		operation,
		supported: true,
		ok: false,
		detail,
	};
	return { content: [{ type: "text", text: renderText(details) }], details, isError: true };
}

function outcomeResult(
	profileName: string,
	endpointType: EndpointType,
	operation: RunpodToolOperation,
	outcome: ControlOutcome,
): RunpodToolResult {
	if (outcome.ok) {
		const details: RunpodToolDetails = {
			profile: profileName,
			endpointType,
			operation,
			supported: true,
			ok: true,
			freshness: "live",
		};
		return { content: [{ type: "text", text: renderText(details) }], details };
	}

	const details: RunpodToolDetails = {
		profile: profileName,
		endpointType,
		operation,
		supported: outcome.supported,
		ok: false,
		detail: outcome.supported ? outcome.detail : outcome.reason,
	};
	return { content: [{ type: "text", text: renderText(details) }], details, isError: true };
}

function makeTool(
	spec: ToolSpec,
	profiles: Record<string, Profile>,
	control: RunpodControl,
): RunpodTool {
	return {
		name: spec.name,
		approval: "read",
		description: describeTool(spec.operation),
		parameters: TOOL_PARAMETERS,
		async execute(_toolCallId, params, _stream, _ctx, _extra) {
			const profileName = typeof params.profile === "string" ? params.profile : "";
			const profile = profileName === "" ? undefined : profiles[profileName];
			if (profile === undefined) {
				return failureResult(
					profileName,
					undefined,
					spec.operation,
					"No profile matched the supplied profile name.",
				);
			}
			const jobId = typeof params.jobId === "string" ? params.jobId : undefined;
			const input: ControlInput = spec.needsJobId
				? { operation: spec.operation, jobId }
				: { operation: spec.operation };
			return outcomeResult(
				profileName,
				profile.endpointType,
				spec.operation,
				await control(profileName, input),
			);
		},
	};
}

/**
 * Build the read-only `runpod_pod` tool: live pod state via the pod-status
 * control op, plus the resolved worker address and readiness via the injected
 * probe (network lives outside this module). Addresses are public pod data,
 * not secrets; key material never appears.
 */
function makePodTool(
	profiles: Record<string, Profile>,
	control: RunpodControl,
	probe: RunpodPodProbe,
): RunpodTool {
	const render = (details: RunpodToolDetails): string => {
		const state = details.ok ? "succeeded" : details.supported ? "failed" : "unsupported";
		let text = `runpod_pod ${state} for profile "${details.profile}"`;
		if (details.detail) text += `: ${details.detail}`;
		return text;
	};
	return {
		name: "runpod_pod",
		approval: "read",
		description:
			"Report the live state, cost rate, uptime, address, and readiness of a Runpod pod profile.",
		parameters: TOOL_PARAMETERS,
		async execute(_toolCallId, params, _stream, _ctx, _extra) {
			const profileName = typeof params.profile === "string" ? params.profile : "";
			const profile = profileName === "" ? undefined : profiles[profileName];
			if (profile === undefined) {
				const details: RunpodToolDetails = {
					profile: profileName,
					endpointType: "queue",
					operation: "pod-status",
					supported: true,
					ok: false,
					detail: "No profile matched the supplied profile name.",
				};
				return { content: [{ type: "text", text: render(details) }], details, isError: true };
			}
			const outcome = await control(profileName, { operation: "pod-status" });
			if (!outcome.ok || outcome.operation !== "pod-status") {
				const details: RunpodToolDetails = {
					profile: profileName,
					endpointType: profile.endpointType,
					operation: "pod-status",
					supported: outcome.ok ? true : outcome.supported,
					ok: false,
					detail: outcome.ok
						? "unexpected control outcome"
						: outcome.supported
							? outcome.detail
							: outcome.reason,
				};
				return { content: [{ type: "text", text: render(details) }], details, isError: true };
			}
			const pod = outcome.pod;
			const probeResult = await probe(profileName);
			const lines = [
				`runpod_pod status for profile "${profileName}": ${pod.status}`,
				`  cost: $${pod.costPerHour.toFixed(2)}/hr`,
				`  uptime: ${
					pod.uptimeSeconds === null
						? "n/a (not running)"
						: `${Math.floor(pod.uptimeSeconds / 3600)}h ${Math.floor((pod.uptimeSeconds % 3600) / 60)}m`
				}`,
			];
			if (pod.dataCenterId !== null) {
				lines.push(`  data center: ${pod.dataCenterId}`);
			}
			if (probeResult.address !== undefined) {
				lines.push(`  address: ${probeResult.address}`);
			}
			lines.push(`  readiness: ${probeResult.health}`);
			if (probeResult.reason !== undefined) {
				lines.push(`  note: ${probeResult.reason}`);
			}
			const details: RunpodToolDetails = {
				profile: profileName,
				endpointType: profile.endpointType,
				operation: "pod-status",
				supported: true,
				ok: true,
				freshness: "live",
			};
			return { content: [{ type: "text", text: lines.join("\n") }], details };
		},
	};
}

/** Register the fixed, read-only Runpod operational tool set. */
export function registerRunpodTools(
	pi: ToolRegistrationApi,
	profiles: Record<string, Profile>,
	control: RunpodControl,
	probePod?: RunpodPodProbe,
): void {
	const all = Object.values(profiles);
	if (all.some((profile) => profile.endpointType === "queue")) {
		for (const spec of QUEUE_READ_TOOLS) pi.registerTool(makeTool(spec, profiles, control));
	}
	if (all.some((profile) => profile.endpointType === "load-balanced")) {
		for (const spec of LB_READ_TOOLS) pi.registerTool(makeTool(spec, profiles, control));
	}
	if (all.length > 0) {
		for (const spec of ANY_READ_TOOLS) pi.registerTool(makeTool(spec, profiles, control));
	}
	if (probePod !== undefined && all.some((profile) => profile.endpointType === "pod")) {
		pi.registerTool(makePodTool(profiles, control, probePod));
	}
}

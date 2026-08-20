/**
 * Per-request journal for the runpod provider.
 *
 * The journal appends one JSON object per line (JSONL) describing every
 * observable step of a streamSimple turn: the request that went to the
 * worker, each dispatch attempt and its outcome, the replayed event
 * timeline (first-byte latency, chunk cadence), and any error with its
 * cause chain. It is the OMP-side half of the debugging pipeline:
 *
 *   plugin journal  ↔  shim request log (container)  ↔  llama-server log
 *
 * Path: `$RUNPOD_OMP_LOG`, defaulting to `~/.omp/logs/runpod-provider.log.jsonl`.
 * Set `RUNPOD_OMP_LOG=""` to disable. Journal writes are synchronous and
 * fire-and-forget: a journal failure never affects the stream.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Journal {
	record(entry: Record<string, unknown>): void;
}

export interface JournalRecord {
	ts: string;
	kind: string;
	model: string;
	profile: string;
	attempt?: number;
	candidate?: string;
	request?: {
		messages: number;
		tools: number;
		toolNames?: string[];
		maxTokens?: number;
		stream: boolean;
		bodyBytes?: number;
	};
	response?: {
		status?: number;
		textChars?: number;
		reasoningChars?: number;
		toolCalls?: number;
		inputTokens?: number;
		outputTokens?: number;
	};
	events?: Array<{ tMs: number; type: string; chars?: number }>;
	durationMs?: number;
	error?: { message: string; cause?: string };
}

/**
 * Resolve the journal path from the environment. Disabled by default: the
 * journal only writes when `RUNPOD_OMP_LOG` is set to a writable path;
 * an unset or empty value disables it.
 */
export function resolveJournalPath(env = process.env): string | undefined {
	const configured = env.RUNPOD_OMP_LOG;
	if (configured === undefined || configured === "") {
		return undefined;
	}
	return configured;
}

/** Create a journal writing to `path`; a disabled journal when `path` is undefined. */
export function createJournal(path: string | undefined): Journal {
	const enabled = path !== undefined;
	return {
		record(entry: Record<string, unknown>): void {
			if (!enabled) {
				return;
			}
			try {
				mkdirSync(join(path!, ".."), { recursive: true });
				appendFileSync(path!, `${JSON.stringify(entry)}\n`);
			} catch {
				// Journaling is best-effort; never break the stream over it.
			}
		},
	};
}

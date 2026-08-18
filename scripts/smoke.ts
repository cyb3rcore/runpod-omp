/**
 * scripts/smoke.ts — end-to-end verification of the built runpod-omp
 * extension against the real `omp` CLI.
 *
 * Run with:  bun scripts/smoke.ts   (after `bun run build` produced dist/)
 *
 * What it does, entirely under a disposable temp tree (PI_CODING_AGENT_DIR +
 * project dir, both deleted in `finally` regardless of outcome):
 *
 *   1. requires dist/index.js to exist;
 *   2. starts two local fake HTTP servers — a Runpod *queue* endpoint
 *      (answers POST /runsync with a COMPLETED job envelope whose `output` is
 *      an OpenAI-completion object) and a load-balanced endpoint (answers
 *      POST /v1/chat/completions with an OpenAI-completion object) — each on
 *      its own ephemeral port, recording the request path it saw;
 *   3. writes a valid project `.omp/runpod.yml` describing one `queue` profile
 *      (endpointType: queue) and one `load-balanced` profile
 *      (endpointType: load-balanced), each pointing at the matching server;
 *   4. stages the REAL built extension into a minimal consumer skeleton (dist
 *      copied verbatim + only its runtime dep `yaml`; the dev-checkout's
 *      `@oh-my-pi/*` node_modules are deliberately excluded so OMP serves the
 *      host `@oh-my-pi` modules, exactly as in a real consumer install), then
 *      spawns the real `omp` with a clean, scoped env;
 *   5. asserts `omp models --json` registers both native models
 *      `runpod/queue` and `runpod/load-balanced`;
 *   6. runs a short real prompt through each model (`omp -p --no-session
 *      --model …`) and asserts (a) the queue hit POST /runsync and returned
 *      the fake queue response, and (b) the load-balanced model hit
 *      POST /v1/chat/completions and returned the fake LB response — proving
 *      the two transports take genuinely different endpoint paths;
 *   7. the `/runpod` status surface is NOT exercised here: it cannot be
 *      driven reliably through the real CLI non-interactively (the /runpod
 *      slash commands are TUI-interactive), so it is explicitly reported as
 *      not exercised rather than simulated.
 *
 * The script exits non-zero on any failed assertion or setup error, zero on
 * full success. Servers and the temp tree are always disposed; no credential
 * literal is ever printed.
 */

import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify } from "yaml";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");

const EXTENSION_REL = "dist/index.js";
const EXTENSION_PATH = join(PKG_ROOT, EXTENSION_REL);

/**
 * Resolve the `omp` executable the smoke drives. Honors an explicit OMP_BIN
 * override (absolute path or bare name); otherwise resolves `omp` from PATH —
 * which Bun package scripts expose as node_modules/.bin in CI once the dev
 * dependencies are installed. Throws with a clear, non-secret prerequisite
 * message before any temp resource exists if no executable is found.
 */
function resolveOmpBin(): string {
	const explicit = process.env.OMP_BIN?.trim();
	if (explicit) {
		return explicit;
	}
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir === "") {
			continue;
		}
		const candidate = join(dir, "omp");
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// not present or not executable; keep searching
		}
	}
	throw new Error(
		"omp executable not found: set OMP_BIN to its path, or ensure `omp` is on PATH " +
			"(in a Bun package script, node_modules/.bin is on PATH after dev dependencies install)",
	);
}

let OMP_BIN: string;

const QUEUE_MARKER = "QUEUE_SMOKE_OK";
const LB_MARKER = "LB_SMOKE_OK";
const OMP_ARGS_TIMEOUT_MS = 180_000;

function assert(condition: unknown, message: string, capture = ""): asserts condition {
	if (!condition) {
		const detail = capture.trim() === "" ? "" : `\n--- omp capture (trimmed) ---\n${trimCaptured(capture)}\n--- end capture ---`;
		throw new Error(`${message}${detail}`);
	}
}

/** Narrow unknown to a plain record; the smoke's JSON boundary guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trim a captured blob to something reportable without dumping secrets. */
function trimCaptured(text: string, max = 4000): string {
	const cleaned = text.replace(/\u0000/g, "").trim();
	return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}\n… [truncated]`;
}

async function runOmp(args: string[], env: Record<string, string>, cwd: string): Promise<{
	exitCode: number | null;
	stdout: string;
	stderr: string;
}> {
	const proc = Bun.spawn([OMP_BIN, ...args], {
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutP = new Response(proc.stdout).text();
	const stderrP = new Response(proc.stderr).text();

	// Hard deadline: kill on timeout; `clearTimeout` after settle stops the
	// pending timer from keeping this script's event loop alive.
	let timedOut = false;
	const killTimer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, OMP_ARGS_TIMEOUT_MS);

	const [status, stdout, stderr] = await Promise.all([proc.exited, stdoutP, stderrP]);
	clearTimeout(killTimer);

	if (timedOut) {
		throw new Error(`omp timed out after ${OMP_ARGS_TIMEOUT_MS} ms: omp ${args.join(" ")}`);
	}
	return { exitCode: status, stdout, stderr };
}

/** Return the key ExtractRuntimeDeps failure line from omp's extension-load error. */
function extensionLoadFailure(stderr: string, stdout: string): string | null {
	for (const blob of [stderr, stdout]) {
		const lines = blob.split(/\r?\n/);
		for (const line of lines) {
			if (/Failed to load extension/.test(line)) {
				return line.trim();
			}
			if (/Cannot find (module|package)/.test(line)) {
				return line.trim();
			}
		}
	}
	return null;
}

/** Explain a consumer extension-load failure with the actionable root cause. */
function extensionLoadFailureMessage(loadFailure: string): string {
	return (
		`extension failed to load under real omp: ${loadFailure}. ` +
		`This blocks the consumer path — the built dist imports runtime @oh-my-pi/pi-ai ` +
		`subpaths (e.g. /auth-retry, /utils/event-stream) that OMP (${OMP_BIN}) does not ` +
		`provide to extensions; the dev-checkout @oh-my-pi node_modules shadow causes a ` +
		`separate pi-utils/native-addon error, and a consumer skeleton with only yaml still ` +
		`fails on the pi-ai subpaths.`
	);
}

/** Read the first assistant `content` from an openai-completion-shaped value. */
function choiceContent(value: unknown): string | null {
	if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) {
		return null;
	}
	const choice = value.choices[0];
	if (!isRecord(choice) || !isRecord(choice.message)) {
		return null;
	}
	const content = choice.message.content;
	return typeof content === "string" ? content : null;
}

/** Read the `status` of a queue job envelope. */
function jobStatus(value: unknown): unknown {
	return isRecord(value) ? value.status : undefined;
}

/** Read the `output` of a queue job envelope (the worker completion object). */
function jobOutput(value: unknown): unknown {
	return isRecord(value) ? value.output : undefined;
}

/** One row of `omp models --json`; only the two fields the smoke inspects. */
interface ModelRow {
	id: string;
	selector: string | undefined;
}

/** Project an `omp models --json` document onto rows the smoke can assert on. */
function modelRows(value: unknown): ModelRow[] {
	if (!isRecord(value) || !Array.isArray(value.models)) {
		return [];
	}
	const rows: ModelRow[] = [];
	for (const item of value.models) {
		if (!isRecord(item)) {
			continue;
		}
		const id = item.id;
		const selector = item.selector;
		rows.push({
			id: typeof id === "string" ? id : "",
			selector: typeof selector === "string" ? selector : undefined,
		});
	}
	return rows;
}

async function main(): Promise<void> {
	// 0. Prereq: resolve the real omp executable (before any temp resource),
	// then require the built extension to exist.
	OMP_BIN = resolveOmpBin();
	try {
		await readFile(EXTENSION_PATH, "utf8");
	} catch {
		throw new Error(
			`built extension missing at ${EXTENSION_PATH} — run \`bun run build\` before the smoke`,
		);
	}

	// 1. Disposable temp tree.
	const tmproot = await mkdtemp(join(tmpdir(), "runpod-omp-smoke-"));
	const agentDir = join(tmproot, "agent");
	const projDir = join(tmproot, "proj");
	const consumerDir = join(tmproot, "consumer");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(projDir, ".omp"), { recursive: true });
	await mkdir(join(consumerDir, "node_modules"), { recursive: true });

	// 2. Fake servers.
	const queueHits: string[] = [];
	const lbHits: string[] = [];

	const completion = (marker: string) => ({
		id: `chatcmpl-${marker}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: "smoke-fake",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: marker },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
	});

	const queueServer = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			queueHits.push(`${request.method} ${url.pathname}`);
			// Queue transport only ever calls POST /runsync for mode "sync".
			if (request.method === "POST" && url.pathname === "/runsync") {
				return Response.json({
					id: `job-${randomUUID()}`,
					status: "COMPLETED",
					output: completion(QUEUE_MARKER),
				});
			}
			return Response.json(
				{ error: { message: `queue server: unexpected request ${request.method} ${url.pathname}` } },
				{ status: 400 },
			);
		},
	});
	const lbServer = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			lbHits.push(`${request.method} ${url.pathname}`);
			// LB transport POSTs the raw completion body to the LB path (default /v1/chat/completions).
			if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
				return Response.json(completion(LB_MARKER));
			}
			return Response.json(
				{ error: { message: `lb server: unexpected request ${request.method} ${url.pathname}` } },
				{ status: 400 },
			);
		},
	});

	// 3. Valid project config for the queue + load-balanced profiles.
	const queuePort = queueServer.port;
	const lbPort = lbServer.port;
	const profile = (endpointType: "queue" | "load-balanced", url: string, modelId: string, modelName: string) => ({
		endpointType,
		invokeUrl: url,
		model: {
			id: modelId,
			name: modelName,
			contextWindow: 8192,
			maxTokens: 512,
			reasoning: false,
			input: ["text"],
			supportsTools: true,
			supportsVision: false,
		},
		request: { mode: "sync" },
	});
	const document = {
		version: 1,
		profiles: {
			queue: profile("queue", `http://127.0.0.1:${queuePort}`, "meta-llama/llama-3.3-70b-instruct", "Smoke Queue"),
			"load-balanced": profile("load-balanced", `http://127.0.0.1:${lbPort}`, "openai/gpt-4o-mini", "Smoke LB"),
		},
	};
	await writeFile(join(projDir, ".omp", "runpod.yml"), yamlStringify(document));

	// 4. Stage the real built extension into a consumer skeleton.
	await cp(join(PKG_ROOT, "dist"), join(consumerDir, "dist"), { recursive: true });
	// Only the real runtime dependency (yaml) goes into the consumer node_modules;
	// the dev-checkout @oh-my-pi/* must NOT shadow OMP's bundled host modules.
	await cp(join(PKG_ROOT, "node_modules", "yaml"), join(consumerDir, "node_modules", "yaml"), {
		recursive: true,
	});
	const loadedExtension = join(consumerDir, EXTENSION_REL);

	// 5. Clean, scoped environment.
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		RUNPOD_API_KEY: "runpod-omp-smoke-fake-key",
		TERM: "dumb",
	};

	try {
		// ---- Server self-check (independent of omp): the fake endpoints must
		// answer the exact shapes the transport decoders expect. ----
		const queueSelf = await fetch(`http://127.0.0.1:${queuePort}/runsync?wait=1`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		const queueSelfBody: unknown = await queueSelf.json();
		assert(
			jobStatus(queueSelfBody) === "COMPLETED" &&
				choiceContent(jobOutput(queueSelfBody)) === QUEUE_MARKER,
			"queue fake server self-check failed (expected COMPLETED envelope with openai-shaped output)",
		);

		const lbSelf = await fetch(`http://127.0.0.1:${lbPort}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		const lbSelfBody: unknown = await lbSelf.json();
		assert(
			choiceContent(lbSelfBody) === LB_MARKER,
			"lb fake server self-check failed (expected openai-completion body)",
		);

		// ---- 5. Native model registration. ----
		const modelsRes = await runOmp(
			["models", "--no-extensions", "-e", loadedExtension, "--json"],
			env,
			projDir,
		);
		const allOut = `${modelsRes.stdout}\n${modelsRes.stderr}`;
		const loadFailure = extensionLoadFailure(modelsRes.stderr, modelsRes.stdout);
		let parseFailed = false;
		let rows: ModelRow[] = [];
		try {
			rows = modelRows(JSON.parse(modelsRes.stdout) as unknown);
		} catch {
			parseFailed = true;
		}

		assert(loadFailure === null, extensionLoadFailureMessage(loadFailure ?? ""), allOut);
		assert(!parseFailed, "omp models --json did not return a JSON document", allOut);
		const ids = rows.map((row) => row.id).filter((id) => id !== "");
		const selectors = rows
			.map((row) => row.selector)
			.filter((selector): selector is string => selector !== undefined);
		assert(
			ids.includes("queue") && ids.includes("load-balanced"),
			`native runpod models not registered; expected ids "queue" and "load-balanced", got [${ids.join(", ")}]`,
			allOut,
		);
		assert(
			selectors.includes("runpod/queue") && selectors.includes("runpod/load-balanced"),
			`native runpod selectors not registered; expected "runpod/queue" and "runpod/load-balanced"`,
			allOut,
		);

		// ---- 6a. Queue model: POST /runsync + fake queue response. ----
		const queueRes = await runOmp(
			["-p", "--no-session", "--no-tools", "--model", "runpod/queue", "-e", loadedExtension, "reply only"],
			env,
			projDir,
		);
		const queueOut = `${queueRes.stdout}\n${queueRes.stderr}`;
		assert(
			queueHits.some((hit) => hit === "POST /runsync"),
			"queue model did not hit POST /runsync (unexpected endpoint path)",
			queueOut,
		);
		assert(
			queueOut.includes(QUEUE_MARKER),
			`queue model did not return the fake queue response (missing marker "${QUEUE_MARKER}")`,
			queueOut,
		);

		// ---- 6b. Load-balanced model: POST /v1/chat/completions + fake LB response. ----
		const lbRes = await runOmp(
			["-p", "--no-session", "--no-tools", "--model", "runpod/load-balanced", "-e", loadedExtension, "reply only"],
			env,
			projDir,
		);
		const lbOut = `${lbRes.stdout}\n${lbRes.stderr}`;
		assert(
			lbHits.some((hit) => hit === "POST /v1/chat/completions"),
			"load-balanced model did not hit POST /v1/chat/completions (unexpected endpoint path)",
			lbOut,
		);
		assert(
			lbOut.includes(LB_MARKER),
			`load-balanced model did not return the fake LB response (missing marker "${LB_MARKER}")`,
			lbOut,
		);

		// ---- 7. Status surface: not exercised (not CLI-drivable headlessly). ----
		console.log(
			"[smoke] /runpod status surface: not exercised — cannot be driven reliably through the real omp CLI non-interactively (slash commands are TUI-interactive); not simulated.",
		);

		console.log(`[smoke] PASS: queue->/runsync (${QUEUE_MARKER}), load-balanced->/v1/chat/completions (${LB_MARKER})`);
		process.exitCode = 0;
	} finally {
		queueServer.stop(true);
		lbServer.stop(true);
		await rm(tmproot, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(`[smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});

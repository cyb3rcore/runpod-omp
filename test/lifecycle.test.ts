/**
 * Session lifecycle contract tests (test-first, per the approved plan).
 *
 * STATUS LINE — DISABLED. Until an extension-inline-segment API is agreed
 * with OMP upstream (see `src/lifecycle.ts`), the ACTIVE lifecycle contract
 * is deliberately inert with respect to any status line:
 *
 *   `session_start(ctx)`:
 *     - Always records the start time: `state.activeSince = <epoch ms>`.
 *     - Performs NO `ctx.ui` call, starts NO refresher, and writes NO status —
 *       whatever the active model / profile. The operator's default footer
 *       is untouched (no rows above or below).
 *
 *   `session_shutdown(ctx)`:
 *     - Clears LOCAL session state only: `state.activeSince = undefined`,
 *       `state.defaultProfile = undefined`, and
 *       `state.statusRefresherStop = undefined`.
 *     - Performs NO `ctx.ui` call.
 *     - MUST NOT stop/scale/delete/warm/cool any endpoint and MUST NOT call
 *       any control/cost operation.
 *
 * The pre-disable contract (kept as the re-enable spec once an inline-segment
 * API exists) was:
 *     - `session_start(ctx)` with UI present started a refresher (first tick
 *       immediate, then every `intervalMs`, default 60_000; stop stored on
 *       `state.statusRefresherStop`). Each tick RE-RESOLVED the active profile
 *       via `deps.getActiveProfileId(ctx)` (OMP's `ctx.model` is a live
 *       accessor, so a runpod profile selected after `session_start` binds
 *       within one interval); with a profile it wrote
 *       `ctx.ui.setStatus(RUNPOD_STATUS_KEY, await deps.buildStatusText(
 *       profileId))`, with none it wrote `setStatus(RUNPOD_STATUS_KEY,
 *       undefined)`.
 *     - `session_shutdown(ctx)` with UI present cleared
 *       `ctx.ui.setStatus(RUNPOD_STATUS_KEY, undefined)`.
 *
 *   `startStatusRefresher(options)` (exported helper, still shipped): first
 *   tick fires immediately, then on every `intervalMs` (default 60_000); the
 *   returned stop function halts further ticks and drops in-flight updates.
 *   Interval functions are injectable for tests.
 *
 * No real Runpod credentials or network are used: the session context, `pi`,
 * and `deps` are injected doubles per test, and the refresher's interval
 * functions are instrumented to prove scheduling and cleanup.
 */
import { describe, expect, test } from "bun:test";

import { RUNPOD_STATUS_KEY, registerRunpodLifecycle, runpodStatusText, startStatusRefresher } from "../src/lifecycle.js";
import type {
	RunpodLifecycleDeps,
	RunpodSessionContext,
} from "../src/lifecycle.js";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { RunpodExtensionState } from "../src/index.js";

/** The active configured profile id used across the suite. */
const PROFILE_ID = "llama-3-8b";

/** A secret-like value that must never surface in a status line. */
const SECRET_ENDPOINT_URL = "https://runpod-secret-endpoint.example/v1/chat/completions";
/** A secret-like value that must never surface in a status line. */
const SECRET_KEY_REF = "env:RUNPOD_SUPER_SECRET";

/** Let the refresher's immediate (async) tick and any pending microtasks settle. */
async function flushTicks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A record of the ui.setStatus calls a fake context observed. */
interface UiCalls {
	calls: Array<{ key: string; value: string | undefined }>;
}

/** Build a session context double with a recording `setStatus`. */
function uiCtx(hasUI: boolean): { ctx: RunpodSessionContext; ui: UiCalls } {
	const ui: UiCalls = { calls: [] };
	const setStatus = (key: string, value: string | undefined): void => {
		ui.calls.push({ key, value });
	};
	return {
		ctx: { hasUI, ui: hasUI ? { setStatus } : undefined },
		ui,
	};
}

/** A recording ExtensionAPI double that only observes the `on` hook. */
function createMockPi(
	log: { events: Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void | Promise<void> }> },
): ExtensionAPI {
	const pi = {
		logger: {
			debug: (): void => {},
			info: (): void => {},
			warn: (): void => {},
			error: (): void => {},
		},
		on(event: string, handler: (ctx?: RunpodSessionContext) => void | Promise<void>): void {
			log.events.push({ event, handler });
		},
	} as unknown as ExtensionAPI;
	return pi;
}

/** A fresh per-instance runtime state with session-local fields pre-seeded. */
function stateFixture(seeded: boolean): RunpodExtensionState {
	const state: RunpodExtensionState = { profiles: {}, errors: [] };
	if (seeded) {
		state.activeSince = 1_700_000_000_000;
		state.defaultProfile = PROFILE_ID;
	}
	return state;
}

/** Lifecycle deps with an injected profile mapper and a resolving status renderer. */
function depsFixture(
	getActiveProfileId: (ctx: RunpodSessionContext) => string | undefined,
	buildStatusText?: (profileId: string) => Promise<string>,
): RunpodLifecycleDeps {
	return {
		getActiveProfileId,
		buildStatusText: buildStatusText ?? (async () => runpodStatusText(PROFILE_ID)),
	};
}

/** A lifetime guard proving the covered window scheduled no timer. */
function timerGuard(): { armed: boolean; install(): void; restore(): void } {
	let armed = false;
	const original = {
		setTimeout: globalThis.setTimeout,
		setInterval: globalThis.setInterval,
		clearTimeout: globalThis.clearTimeout,
		clearInterval: globalThis.clearInterval,
	};
	// The timer globals are overridden through a structural record so the
	// reassignment needs no runtime check.
	const globals = globalThis as unknown as {
		setTimeout: unknown;
		setInterval: unknown;
		clearTimeout: unknown;
		clearInterval: unknown;
	};
	return {
		get armed() {
			return armed;
		},
		install(): void {
			globals.setTimeout = (..._args: unknown[]) => {
				armed = true;
				throw new Error("runpod lifecycle scheduled setTimeout");
			};
			globals.setInterval = (..._args: unknown[]) => {
				armed = true;
				throw new Error("runpod lifecycle scheduled setInterval");
			};
			globals.clearTimeout = (): unknown => undefined;
			globals.clearInterval = (): unknown => undefined;
			armed = false;
		},
		restore(): void {
			globals.setTimeout = original.setTimeout;
			globals.setInterval = original.setInterval;
			globals.clearTimeout = original.clearTimeout;
			globals.clearInterval = original.clearInterval;
			armed = false;
		},
	};
}

describe("runpodStatusText", () => {
	test("status-bar key is pinned", () => {
		expect(RUNPOD_STATUS_KEY).toBe("runpod");
	});

	test("names the profile and is non-secret", () => {
		const line = runpodStatusText(PROFILE_ID);
		expect(line).toBeTruthy();
		// Names the active profile (strict on profile).
		expect(line).toContain(PROFILE_ID);
		// Never leaks the endpoint url or any key reference (strict on redaction).
		expect(line).not.toContain(SECRET_ENDPOINT_URL);
		expect(line).not.toContain(SECRET_KEY_REF);
	});
});

describe("registerRunpodLifecycle registration", () => {
	test("registers exactly the session_start and session_shutdown hooks", () => {
		const log = { events: [] as Array<{ event: string; handler: unknown }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		registerRunpodLifecycle(pi, state, depsFixture(() => undefined));

		const events = log.events.map((e) => e.event);
		expect(events).toContain("session_start");
		expect(events).toContain("session_shutdown");
		// Only the two lifecycle hooks — never anything else.
		expect(events.sort()).toEqual(["session_shutdown", "session_start"]);
	});

	test("registration itself performs no UI set, no status write, and no timer", () => {
		const log = { events: [] as Array<{ event: string; handler: unknown }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		const guard = timerGuard();
		guard.install();
		try {
			registerRunpodLifecycle(pi, state, depsFixture(() => undefined));
		} finally {
			guard.restore();
		}
		expect(guard.armed).toBe(false);
	});
});

describe("session_start", () => {
	test("runpod active profile: records start time, writes no status (disabled)", async () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		registerRunpodLifecycle(pi, state, depsFixture(() => PROFILE_ID));

		const { ctx, ui } = uiCtx(true);
		const start = log.events.find((e) => e.event === "session_start");
		expect(start).toBeDefined();
		start!.handler(ctx);
		await flushTicks();

		// Records the start time on session start.
		expect(state.activeSince).toEqual(expect.any(Number));
		// Status line disabled: no refresher armed, no status write at all.
		expect(state.statusRefresherStop).toBeUndefined();
		expect(ui.calls).toHaveLength(0);
	});

	test("disabled: deps.buildStatusText is never called (no refresher to render)", async () => {
		let called = false;
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		registerRunpodLifecycle(
			pi,
			state,
			depsFixture(() => PROFILE_ID, async () => {
				called = true;
				return `Runpod profile: ${PROFILE_ID} · est $1.10/hr`;
			}),
		);

		const { ctx, ui } = uiCtx(true);
		const start = log.events.find((e) => e.event === "session_start");
		start!.handler(ctx);
		await flushTicks();

		expect(called).toBe(false);
		expect(ui.calls).toHaveLength(0);
	});

	test("disabled: no runpod profile also writes nothing and arms no refresher", async () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		// The active model is not a runpod profile (or its id is unknown).
		registerRunpodLifecycle(pi, state, depsFixture(() => undefined));

		const { ctx, ui } = uiCtx(true);
		const start = log.events.find((e) => e.event === "session_start");
		start!.handler(ctx);
		await flushTicks();

		expect(state.activeSince).toEqual(expect.any(Number));
		expect(state.statusRefresherStop).toBeUndefined();
		expect(ui.calls).toHaveLength(0);
	});

	test("disabled: a model switch after session_start still writes nothing", async () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		let active: string | undefined;
		registerRunpodLifecycle(pi, state, depsFixture(() => active));

		const { ctx, ui } = uiCtx(true);
		const start = log.events.find((e) => e.event === "session_start")!;
		start.handler(ctx);
		await flushTicks();

		// Mirror a later model pick between ticks.
		active = PROFILE_ID;
		await flushTicks();

		// Still completely inert on the statusline.
		expect(state.statusRefresherStop).toBeUndefined();
		expect(ui.calls).toHaveLength(0);
	});

	test("headless session performs no UI call but still records the start time", () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		registerRunpodLifecycle(pi, state, depsFixture(() => PROFILE_ID));

		const { ctx, ui } = uiCtx(false);
		const start = log.events.find((e) => e.event === "session_start");
		start!.handler(ctx);

		expect(state.activeSince).toEqual(expect.any(Number));
		expect(ui.calls).toHaveLength(0);
	});

	test("defensive: missing ui object on a UI context writes nothing rather than throwing", () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		registerRunpodLifecycle(pi, state, depsFixture(() => PROFILE_ID));

		const ctx: RunpodSessionContext = { hasUI: true, ui: undefined };
		const start = log.events.find((e) => e.event === "session_start");
		expect(() => start!.handler(ctx)).not.toThrow();
		expect(state.activeSince).toEqual(expect.any(Number));
	});
});

describe("session_shutdown", () => {
	test("UI session: clears local session state only, no status clear (disabled)", () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(true);
		registerRunpodLifecycle(pi, state, depsFixture(() => PROFILE_ID));

		const { ctx, ui } = uiCtx(true);
		const shutdown = log.events.find((e) => e.event === "session_shutdown");
		expect(shutdown).toBeDefined();
		shutdown!.handler(ctx);

		// No status-line write while disabled.
		expect(ui.calls).toHaveLength(0);

		// Clears local session state (start time + default profile).
		expect(state.activeSince).toBeUndefined();
		expect(state.defaultProfile).toBeUndefined();

		// Configured profiles are untouched — nothing is stopped/scaled/deleted.
		expect(state.profiles).toBeDefined();
	});

	test("headless shutdown clears local session state with no UI call", () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(true);
		registerRunpodLifecycle(pi, state, depsFixture(() => PROFILE_ID));

		const { ctx, ui } = uiCtx(false);
		const shutdown = log.events.find((e) => e.event === "session_shutdown");
		shutdown!.handler(ctx);

		expect(ui.calls).toHaveLength(0);
		expect(state.activeSince).toBeUndefined();
		expect(state.defaultProfile).toBeUndefined();
	});

	test("shutdown clears local session state and drops any refresher handle", async () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		registerRunpodLifecycle(pi, state, depsFixture(() => PROFILE_ID));

		const { ctx, ui } = uiCtx(true);
		const start = log.events.find((e) => e.event === "session_start");
		const shutdown = log.events.find((e) => e.event === "session_shutdown");

		start!.handler(ctx);
		await flushTicks();
		// While disabled no refresher was ever armed.
		expect(state.statusRefresherStop).toBeUndefined();

		shutdown!.handler(ctx);

		expect(state.statusRefresherStop).toBeUndefined();
		// No status writes happened at all (start nor shutdown).
		expect(ui.calls).toHaveLength(0);
		expect(state.activeSince).toBeUndefined();
		expect(state.defaultProfile).toBeUndefined();
	});
});

describe("startStatusRefresher", () => {
	/** A fake interval pair; returns the scheduled callback and the cleared ids. */
	function fakeInterval(): {
		scheduled: (() => void)[];
		cleared: unknown[];
		setIntervalFn: typeof setInterval;
		clearIntervalFn: typeof clearInterval;
	} {
		const scheduled: (() => void)[] = [];
		const cleared: unknown[] = [];
		const setIntervalFn = ((callback: () => void) => {
			scheduled.push(callback);
			return scheduled.length;
		}) as typeof setInterval;
		const clearIntervalFn = ((id: unknown) => {
			cleared.push(id);
		}) as typeof clearInterval;
		return { scheduled, cleared, setIntervalFn, clearIntervalFn };
	}

	test("fires immediately, then per interval, and stop halts further ticks", async () => {
		const writes: Array<string | undefined> = [];
		const { scheduled, cleared, setIntervalFn, clearIntervalFn } = fakeInterval();

		const stop = startStatusRefresher({
			getText: async () => "line",
			setStatus: (text) => writes.push(text),
			intervalMs: 1000,
			setIntervalFn,
			clearIntervalFn,
		});
		await flushTicks();
		expect(writes).toEqual(["line"]); // immediate first tick

		expect(scheduled).toHaveLength(1);
		scheduled[0]!();
		await flushTicks();
		expect(writes).toEqual(["line", "line"]); // interval tick

		stop();
		scheduled[0]!();
		await flushTicks();
		expect(writes).toEqual(["line", "line"]); // halted
		expect(cleared).toEqual([1]);
	});

	test("undefined getText result is passed through as a clear", async () => {
		const writes: Array<string | undefined> = [];
		const { setIntervalFn, clearIntervalFn } = fakeInterval();

		const stop = startStatusRefresher({
			getText: async () => undefined,
			setStatus: (text) => writes.push(text),
			intervalMs: 1000,
			setIntervalFn,
			clearIntervalFn,
		});
		await flushTicks();
		expect(writes).toEqual([undefined]); // clear signal forwarded

		stop();
	});

	test("stop drops an in-flight update", async () => {
		const writes: Array<string | undefined> = [];
		const { promise, resolve } = Promise.withResolvers<string>();
		const { cleared, setIntervalFn, clearIntervalFn } = fakeInterval();

		const stop = startStatusRefresher({
			getText: () => promise,
			setStatus: (text) => writes.push(text),
			intervalMs: 1000,
			setIntervalFn,
			clearIntervalFn,
		});
		stop();
		resolve("late");
		await flushTicks();
		expect(writes).toEqual([]);
		expect(cleared).toEqual([1]);
	});
});

/**
 * Session lifecycle contract tests (test-first, per the approved plan).
 *
 * These tests fail today because src/lifecycle.ts does not exist yet.
 * Implement the following contract to make them pass:
 *
 * src/lifecycle.ts (a focused, pure registration/helper module — no OMP
 * runtime startup work, no fetch, no timers; the only OMP surface it touches
 * is the `pi.on` session hooks and `ctx.ui.setStatus` at runtime):
 *
 *   - `RUNPOD_STATUS_KEY = "runpod"` (the status-bar key pinned by this suite).
 *   - `runpodStatusText(profileId: string): string` — a pure, adaptive,
 *     NON-SECRET status line naming the profile. It must never contain the
 *     profile's endpoint url or any apiKey/secret bytes (it structurally
 *     cannot: it accepts only the profile id, never the Profile). The exact
 *     copy is free-form — implementations may vary — but it MUST include the
 *     profile id verbatim.
 *   - `registerRunpodLifecycle(pi, state, deps): void` — registers exactly
 *     two session hooks, `session_start` and `session_shutdown`, backed by
 *     `state` (`RunpodExtensionState`) and a minimal `deps`:
 *   - `deps.getActiveProfileId(ctx): string | undefined` — pure mapper
 *     from a session context to the id of the active configured Runpod
 *     profile; returns `undefined` for a non-runpod active model or an
 *     unknown/unconfigured profile id.
 *       - `deps.buildStatusText(profileId): Promise<string>` — renders the
 *         status-line text; never throws.
 *     `registerRunpodLifecycle` itself performs NO UI set, NO status write,
 *     NO timer, and NO control/cost action — it only registers handlers.
 *
 *   `session_start(ctx)`:
 *     - Always records the start time: `state.activeSince = <epoch ms>`.
 *     - When `ctx.hasUI === false` (headless): performs NO `ctx.ui` call and
 *       returns harmlessly.
 *     - When UI is present: starts a status refresher whose FIRST tick fires
 *       immediately, then every `intervalMs` (default 60_000). The stop
 *       function is stored on `state.statusRefresherStop`.
 *       - Each tick RE-RESOLVES the active profile via
 *         `deps.getActiveProfileId(ctx)` — OMP's `ctx.model` is a live
 *         accessor, so a runpod profile selected after `session_start` binds
 *         within one interval.
 *       - When a runpod profile is active the tick calls
 *         `ctx.ui.setStatus(RUNPOD_STATUS_KEY, await deps.buildStatusText(
 *         profileId))` — named profile, no endpoint/key.
 *       - When no runpod profile is active the tick calls
 *         `ctx.ui.setStatus(RUNPOD_STATUS_KEY, undefined)` — clears, never
 *         guesses, never leaks.
 *
 *   `session_shutdown(ctx)`:
 *     - Clears LOCAL session state only: `state.activeSince = undefined`,
 *       `state.defaultProfile = undefined`, and
 *       `state.statusRefresherStop = undefined` (after invoking the stored
 *       stop function, so no further ticks or in-flight updates land).
 *     - When `ctx.hasUI` is true, clears the status bar:
 *       `ctx.ui.setStatus(RUNPOD_STATUS_KEY, undefined)`.
 *     - Headless: no `ctx.ui` call.
 *     - MUST NOT stop/scale/delete/warm/cool any endpoint and MUST NOT call
 *       any control/cost operation.
 *
 *   `startStatusRefresher(options)` (exported helper): first tick fires
 *   immediately, then on every `intervalMs` (default 60_000); the returned
 *   stop function halts further ticks and drops in-flight updates. Interval
 *   functions are injectable for tests.
 *
 * No real Runpod credentials or network are used: the session context, `pi`,
 * and `deps` are injected doubles per test, and the refresher's interval
 * functions are instrumented to prove scheduling and cleanup.
 */
import { describe, expect, test } from "bun:test";

// The value import fails at link time today: src/lifecycle.ts is absent.
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
	test("runpod active profile: sets adaptive status naming the profile, no endpoint/key", async () => {
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

		// The refresher's immediate tick wrote exactly one status line naming
		// the profile; the interval has not fired yet.
		expect(state.statusRefresherStop).toEqual(expect.any(Function));
		expect(ui.calls).toHaveLength(1);
		const [write] = ui.calls;
		expect(write.key).toBe("runpod");
		expect(write.key).toBe(RUNPOD_STATUS_KEY);
		expect(write.value).toEqual(expect.any(String));
		expect(write.value).toContain(PROFILE_ID);
		expect(write.value).not.toContain(SECRET_ENDPOINT_URL);
		expect(write.value).not.toContain(SECRET_KEY_REF);
	});

	test("status text comes from deps.buildStatusText (e.g. with a live estimate)", async () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		registerRunpodLifecycle(
			pi,
			state,
			depsFixture(() => PROFILE_ID, async () => `Runpod profile: ${PROFILE_ID} · est $1.10/hr`),
		);

		const { ctx, ui } = uiCtx(true);
		const start = log.events.find((e) => e.event === "session_start");
		start!.handler(ctx);
		await flushTicks();

		expect(ui.calls).toHaveLength(1);
		expect(ui.calls[0]!.value).toBe(`Runpod profile: ${PROFILE_ID} · est $1.10/hr`);
	});

	test("start with no runpod profile clears the status but arms the refresher", async () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		// The active model is not a runpod profile (or its id is unknown) yet.
		registerRunpodLifecycle(pi, state, depsFixture(() => undefined));

		const { ctx, ui } = uiCtx(true);
		const start = log.events.find((e) => e.event === "session_start");
		start!.handler(ctx);
		await flushTicks();

		expect(state.activeSince).toEqual(expect.any(Number));
		// The refresher is armed regardless of the current profile so a later
		// model switch can bind.
		expect(state.statusRefresherStop).toEqual(expect.any(Function));
		// No profile line is ever written; the tick clears under the pinned key.
		expect(ui.calls).toEqual([{ key: RUNPOD_STATUS_KEY, value: undefined }]);
	});

	test("a runpod profile selected after session_start binds on a later tick", async () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		const scheduled: Array<() => void> = [];
		const cleared: unknown[] = [];
		const setIntervalFn = ((callback: () => void): unknown => {
			scheduled.push(callback);
			return scheduled.length;
		}) as typeof setInterval;
		const clearIntervalFn = ((id: unknown): void => {
			cleared.push(id);
		}) as typeof clearInterval;

		// The active model starts non-runpod, then "switches" to the runpod
		// profile after start — mirroring OMP's live ctx.model accessor.
		let active: string | undefined;
		registerRunpodLifecycle(pi, state, {
			getActiveProfileId: () => active,
			buildStatusText: async () => runpodStatusText(PROFILE_ID),
			refresherOptions: { intervalMs: 1000, setIntervalFn, clearIntervalFn },
		});

		const { ctx, ui } = uiCtx(true);
		const start = log.events.find((e) => e.event === "session_start")!;
		start.handler(ctx);
		await flushTicks();
		// Initial tick: no profile yet -> cleared, nothing shown.
		expect(ui.calls).toEqual([{ key: RUNPOD_STATUS_KEY, value: undefined }]);

		// Model switches to runpod; the next interval tick binds.
		active = PROFILE_ID;
		scheduled[0]!();
		await flushTicks();
		expect(ui.calls).toHaveLength(2);
		expect(ui.calls[1]).toEqual({ key: RUNPOD_STATUS_KEY, value: runpodStatusText(PROFILE_ID) });

		// Switching away again clears on the next tick.
		active = undefined;
		scheduled[0]!();
		await flushTicks();
		expect(ui.calls[2]).toEqual({ key: RUNPOD_STATUS_KEY, value: undefined });
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
	test("UI session: clears the status bar and local session state only", () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(true);
		registerRunpodLifecycle(pi, state, depsFixture(() => PROFILE_ID));

		const { ctx, ui } = uiCtx(true);
		const shutdown = log.events.find((e) => e.event === "session_shutdown");
		expect(shutdown).toBeDefined();
		shutdown!.handler(ctx);

		// Clears the status bar under the pinned key.
		expect(ui.calls).toHaveLength(1);
		expect(ui.calls[0].key).toBe(RUNPOD_STATUS_KEY);
		expect(ui.calls[0].value).toBeUndefined();

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

	test("shutdown stops the active refresher and clears the status", async () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		registerRunpodLifecycle(pi, state, depsFixture(() => PROFILE_ID));

		const { ctx, ui } = uiCtx(true);
		const start = log.events.find((e) => e.event === "session_start");
		const shutdown = log.events.find((e) => e.event === "session_shutdown");

		start!.handler(ctx);
		await flushTicks();
		expect(state.statusRefresherStop).toEqual(expect.any(Function));

		shutdown!.handler(ctx);

		// The stop function was invoked and dropped from state.
		expect(state.statusRefresherStop).toBeUndefined();
		// Start's write plus the shutdown clear — and nothing after.
		expect(ui.calls).toHaveLength(2);
		expect(ui.calls[1]).toEqual({ key: RUNPOD_STATUS_KEY, value: undefined });
		expect(state.activeSince).toBeUndefined();
		expect(state.defaultProfile).toBeUndefined();
	});

	test("an in-flight status update does not land after shutdown", async () => {
		const log = { events: [] as Array<{ event: string; handler: (ctx?: RunpodSessionContext) => void }> };
		const pi = createMockPi(log);
		const state = stateFixture(false);
		let resolveText!: (text: string) => void;
		registerRunpodLifecycle(
			pi,
			state,
			depsFixture(() => PROFILE_ID, () => new Promise<string>((resolve) => { resolveText = resolve; })),
		);

		const { ctx, ui } = uiCtx(true);
		const start = log.events.find((e) => e.event === "session_start");
		const shutdown = log.events.find((e) => e.event === "session_shutdown");

		start!.handler(ctx); // immediate tick is pending on getText
		shutdown!.handler(ctx); // stop the refresher before it resolves
		resolveText("late status text");
		await flushTicks();

		// The stopped refresher dropped the in-flight update; only the shutdown
		// clear is visible (the start tick never landed).
		expect(ui.calls).toEqual([{ key: RUNPOD_STATUS_KEY, value: undefined }]);
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

	test("stop drops an in-flight update", async () => {
		const writes: Array<string | undefined> = [];
		let resolveText!: (text: string) => void;
		const { cleared, setIntervalFn, clearIntervalFn } = fakeInterval();

		const stop = startStatusRefresher({
			getText: () => new Promise<string>((resolve) => { resolveText = resolve; }),
			setStatus: (text) => writes.push(text),
			intervalMs: 1000,
			setIntervalFn,
			clearIntervalFn,
		});
		stop();
		resolveText("late");
		await flushTicks();
		expect(writes).toEqual([]);
		expect(cleared).toEqual([1]);
	});
});

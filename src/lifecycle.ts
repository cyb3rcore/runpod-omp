/**
 * Session lifecycle — runtime cleanup and status, nothing else.
 *
 * This module is a pure registration/helper layer. It performs no OMP runtime
 * startup work, no fetch, no timers, and no control/cost action at
 * registration time. The only OMP surface it touches at runtime is the
 * `pi.on` session hooks and `ctx.ui.setStatus`.
 *
 * The session context is intentionally a reduced structural adapter
 * (`RunpodSessionContext`) rather than the broad OMP `ExtensionContext`: the
 * test doubles and callers drive the hooks with exactly `{ hasUI, ui }`, and
 * the module stays decoupled from the full OMP runtime shape. The real OMP
 * runtime binds these hooks through the same `pi.on` channel.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import type { RunpodExtensionState } from "./index.js";

/** Status-bar key pinned by the lifecycle contract. */
export const RUNPOD_STATUS_KEY = "runpod";

/**
 * Reduced structural view of a session context used by the lifecycle hooks.
 * Only the UI-availability flag and the status write surface are exposed.
 */
export interface RunpodSessionContext {
	/** Whether UI is available (false in print/RPC/headless modes). */
	hasUI: boolean;
	/** UI status writes; absent in headless runs and defensively optional. */
	ui?: {
		setStatus(key: string, value: string | undefined): void;
	};
}

/**
 * Minimal deps the lifecycle needs to map a session context to the active
 * configured Runpod profile id. Returns `undefined` for a non-runpod active
 * model or an unknown/unconfigured profile id.
 */
export interface RunpodLifecycleDeps {
	/**
	 * Map a session context to the id of the active configured Runpod profile.
	 * Called on every refresh tick (not once), so a model selected after
	 * `session_start` binds within one interval. Returns `undefined` for a
	 * non-runpod active model or an unknown/unconfigured profile id.
	 */
	getActiveProfileId(ctx: RunpodSessionContext): string | undefined;
	/**
	 * Render the status-line text for a profile. Never throws: it returns the
	 * profile-only line when the live estimate is unavailable.
	 */
	buildStatusText(profileId: string): Promise<string>;
	/** Optional interval controls passed through to the status refresher (tests). */
	refresherOptions?: RefresherIntervalOptions;
}

/** Interval controls forwarded to {@link startStatusRefresher}; injectable for tests. */
export interface RefresherIntervalOptions {
	intervalMs?: number;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
}

/**
 * A pure, adaptive, non-secret status line naming a profile. It accepts only
 * the profile id, never the Profile object, so it structurally cannot leak an
 * endpoint url or any apiKey/secret bytes.
 */
export function runpodStatusText(profileId: string): string {
	return `Runpod profile: ${profileId}`;
}

/** The `pi.on` surface the lifecycle binds, typed to this module's handlers. */
interface LifecycleHookApi {
	on(
		event: "session_start",
		handler: (ctx?: RunpodSessionContext) => void | Promise<void>,
	): void;
	on(
		event: "session_shutdown",
		handler: (ctx?: RunpodSessionContext) => void | Promise<void>,
	): void;
}

/** Options for {@link startStatusRefresher}; the interval fns are injectable for tests. */
export interface StatusRefresherOptions {
	/**
	 * Resolve the next status text. Returning `undefined` means "no runpod
	 * profile is active" and clears the status line under the pinned key —
	 * the caller's `setStatus` receives `undefined` as a clear signal.
	 */
	getText: () => Promise<string | undefined>;
	setStatus: (text: string | undefined) => void;
	intervalMs?: number;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
}

/**
 * Repeatedly refresh a status line: the first tick fires immediately, then on
 * every interval. Returns a stop function that halts further ticks and drops
 * any in-flight update; safe to call twice. `setStatus` is only ever invoked
 * with a completed `getText` while the refresher is not stopped — including
 * `undefined` for "no status to show", which the sink renders as a clear.
 */
export function startStatusRefresher(options: StatusRefresherOptions): () => void {
	const intervalMs = options.intervalMs ?? 60_000;
	const setIntervalFn = options.setIntervalFn ?? setInterval;
	const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
	let stopped = false;

	const tick = async (): Promise<void> => {
		const text = await options.getText();
		if (stopped) {
			return;
		}
		options.setStatus(text);
	};

	void tick();
	const timer = setIntervalFn(() => {
		void tick();
	}, intervalMs);
	return () => {
		stopped = true;
		clearIntervalFn(timer);
	};
}

/**
 * Register the `session_start` / `session_shutdown` hooks backed by `state`
 * and `deps`. Registration itself performs NO UI set, NO status write, NO
 * timer, and NO control/cost action — it only registers handlers.
 */
export function registerRunpodLifecycle(
	pi: ExtensionAPI,
	state: RunpodExtensionState,
	deps: RunpodLifecycleDeps,
): void {
	const startHandler = (ctx?: RunpodSessionContext): void => {
		// Always record the session start time, whatever the context.
		state.activeSince = Date.now();
		if (ctx === undefined) return;
		if (!ctx.hasUI) return;
		const ui = ctx.ui;
		if (ui === undefined) return;
		// Start the refresher whenever UI is present, then keep it live. Each
		// tick RE-RESOLVES the active profile from the session context — OMP's
		// `ctx.model` is a live accessor, so a runpod profile selected after
		// `session_start` binds within one interval. When no runpod profile is
		// active the tick returns undefined and the sink clears the status
		// line (never guesses, never leaks). The refresher's immediate first
		// tick performs the initial write, and its stop guard prevents an
		// in-flight update from landing after shutdown clears the status.
		state.statusRefresherStop?.();
		state.statusRefresherStop = startStatusRefresher({
			getText: async (): Promise<string | undefined> => {
				const profileId = deps.getActiveProfileId(ctx);
				if (profileId === undefined) {
					return undefined;
				}
				return deps.buildStatusText(profileId);
			},
			setStatus: (text) => ui.setStatus(RUNPOD_STATUS_KEY, text),
			...deps.refresherOptions,
		});
	};

	const shutdownHandler = (ctx?: RunpodSessionContext): void => {
		// Clear LOCAL session state only — configured profiles are untouched.
		state.activeSince = undefined;
		state.defaultProfile = undefined;
		state.statusRefresherStop?.();
		state.statusRefresherStop = undefined;
		if (ctx === undefined) return;
		if (!ctx.hasUI) return;
		ctx.ui?.setStatus(RUNPOD_STATUS_KEY, undefined);
	};

	// Structural adapter: the OMP runtime delivers these hooks as
	// (event, ExtensionContext); we bind a reduced structural view so test
	// doubles can drive them as (ctx).
	const hooks = pi as unknown as LifecycleHookApi;
	hooks.on("session_start", startHandler);
	hooks.on("session_shutdown", shutdownHandler);
}

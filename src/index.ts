/**
 * pi-auto-update
 *
 * Checks for a newer pi release when a session starts and, when one exists,
 * runs `pi update --all` in a detached background process. The update finishes
 * even if the session exits, and the next pi start picks it up.
 */

import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type Config, type UpdateScope } from "./config.ts";
import { acquireLock, appendLog, readState, releaseLock, statePaths, transferLock, writeState, type StatePaths } from "./state.ts";
import { resolvePiLauncher, runPiUpdate, updateArgs, type PiLauncher } from "./updater.ts";
import { fetchLatestRelease, isNewerVersion } from "./version.ts";

const STATUS_KEY = "pi-auto-update";
const USER_AGENT = `pi-auto-update (pi/${VERSION})`;
const COMMAND_USAGE = "Usage: /update [check|force|logs]";

let startupCheckStarted = false;

export default function piAutoUpdate(pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => {
		// "startup" is the first session of this process; /new and /resume reuse it.
		if (event.reason !== "startup" || startupCheckStarted) return;
		startupCheckStarted = true;

		const config = loadConfig(process.env, getAgentDir());
		if (!config.enabled || !config.modes.includes(ctx.mode)) return;

		void runCheck(ctx, config, { automatic: true, force: config.force }).catch((error: unknown) => {
			appendLog(statePaths(config.stateDir).logFile, `auto check failed: ${errorMessage(error)}`);
		});
	});

	pi.registerCommand("update", {
		description: "Check for a newer pi release and run `pi update`",
		handler: async (args, ctx) => {
			const config = loadConfig(process.env, getAgentDir());
			const action = args.trim().toLowerCase();

			if (action === "logs") {
				const paths = statePaths(config.stateDir);
				notify(ctx, `Update log: ${paths.logFile}\nCommand output: ${paths.outputFile}`);
				return;
			}
			if (action === "check") {
				await runCheck(ctx, config, { automatic: false, force: false, checkOnly: true });
				return;
			}
			if (action === "" || action === "now" || action === "force") {
				await runCheck(ctx, config, { automatic: false, force: action === "force" || config.force });
				return;
			}
			notify(ctx, COMMAND_USAGE);
		},
	});
}

interface CheckOptions {
	/** Triggered by session_start rather than by the user. */
	automatic: boolean;
	/** Reinstall even when the installed version is already the latest. */
	force: boolean;
	/** Report the latest version without installing anything. */
	checkOnly?: boolean;
}

async function runCheck(ctx: ExtensionContext, config: Config, options: CheckOptions): Promise<void> {
	const paths = statePaths(config.stateDir);
	const state = readState(paths.stateFile);
	const current = VERSION;

	if (options.automatic) {
		if (isOffline()) {
			log(paths, "offline mode: skipping update check");
			return;
		}
		if (Date.now() - (state.lastCheckAt ?? 0) < config.intervalMs) {
			log(paths, `skipping check (last check ${new Date(state.lastCheckAt ?? 0).toISOString()})`);
			return;
		}
	}

	const launcher = resolvePiLauncher(process.env, process.argv, process.execPath);
	const scope = resolveScope(config.scope, launcher);
	const release = await fetchLatestRelease({
		apiUrl: config.apiUrl,
		npmRegistry: config.npmRegistry,
		packageName: config.packageName,
		userAgent: USER_AGENT,
		timeoutMs: config.checkTimeoutMs,
	});

	writeState(paths.stateFile, {
		...state,
		lastCheckAt: Date.now(),
		latestSeen: release?.version ?? state.latestSeen,
	});

	if (!release) {
		log(paths, "could not resolve the latest release");
		if (!options.automatic) notify(ctx, "Could not check for pi updates (network or registry unavailable).", "warning");
		return;
	}

	const newer = isNewerVersion(release.version, current);
	log(paths, `current ${current}, latest ${release.version}${newer ? " (update available)" : ""}`);

	if (options.checkOnly) {
		notify(ctx, newer ? `pi ${current} → ${release.version} available. Run /update to install.` : `pi ${current} is up to date (latest: ${release.version}).`);
		return;
	}

	if (!newer && !options.force) {
		log(paths, `no update needed (latest ${release.version})`);
		if (!options.automatic) notify(ctx, `pi ${current} is up to date (latest: ${release.version}).`);
		return;
	}

	const target = newer ? release.version : current;
	if (config.dryRun) {
		log(paths, "dry run: not spawning the update");
		notify(ctx, `pi ${current} → ${target}: dry run, update not started (${updateArgs(scope, options.force).join(" ")}).`);
		return;
	}

	await runUpdate(ctx, config, options, { paths, current, latest: release.version, target, scope, launcher });
}

interface UpdateContext {
	paths: StatePaths;
	current: string;
	/** Newest published version, even when the run was forced. */
	latest: string;
	target: string;
	scope: UpdateScope;
	launcher: PiLauncher;
}

async function runUpdate(ctx: ExtensionContext, config: Config, options: CheckOptions, update: UpdateContext): Promise<void> {
	const { paths, current, latest, target, scope, launcher } = update;
	const startedAt = Date.now();
	const commandLine = [launcher.command, ...launcher.prefixArgs, ...updateArgs(scope, options.force)].join(" ");

	if (!acquireLock(paths.lockFile, { staleMs: Math.max(config.updateTimeoutMs, 5 * 60_000) })) {
		const message = `Another pi update is already running (lock: ${paths.lockFile}).`;
		log(paths, message);
		notify(ctx, message, "warning");
		return;
	}

	log(paths, `starting: ${commandLine}`);
	notify(ctx, `pi ${current} → ${target}: running \`${commandLine}\` in the background…`);
	setStatus(ctx, `⬆ pi ${target}…`);

	let result: Awaited<ReturnType<typeof runPiUpdate>>;
	try {
		result = await runPiUpdate({
			command: launcher.command,
			prefixArgs: launcher.prefixArgs,
			scope,
			force: options.force,
			cwd: ctx.cwd,
			outputFile: paths.outputFile,
			timeoutMs: config.updateTimeoutMs,
			onSpawn: (pid) => {
				if (pid !== undefined) transferLock(paths.lockFile, pid);
				log(paths, `update spawned${pid !== undefined ? ` (pid ${pid})` : ""}, output: ${paths.outputFile}`);
			},
		});
	} finally {
		releaseLock(paths.lockFile);
		setStatus(ctx, undefined);
	}

	writeState(paths.stateFile, {
		...readState(paths.stateFile),
		latestSeen: latest,
		lastSeenVersion: target,
		lastRun: {
			startedAt,
			finishedAt: Date.now(),
			fromVersion: current,
			toVersion: target,
			command: commandLine,
			ok: result.ok,
			code: result.code,
			logFile: paths.outputFile,
			...(result.error ? { error: result.error } : {}),
		},
	});

	if (result.ok) {
		log(paths, `update finished in ${formatDuration(result.durationMs)}`);
		notify(ctx, `pi updated to ${target}. Restart pi to use the new version.`);
		return;
	}

	const reason = result.timedOut
		? `timed out after ${formatDuration(result.durationMs)}`
		: result.error
			? result.error
			: `exit code ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`;
	log(paths, `update failed: ${reason}`);
	notify(ctx, `pi update failed (${reason}). See ${paths.outputFile}`, "error");
}

function resolveScope(scope: UpdateScope, launcher: PiLauncher): UpdateScope {
	// Nix and other read-only stores cannot self-update; package updates still work.
	if (launcher.readOnlyInstall && scope === "all") return "extensions";
	return scope;
}

function isOffline(): boolean {
	const value = process.env.PI_OFFLINE?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	} catch {
		// The session may have been replaced while the update was running.
	}
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, text);
	} catch {
		// Status is cosmetic.
	}
}

function log(paths: StatePaths, message: string): void {
	appendLog(paths.logFile, message);
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms / 60_000)}m`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

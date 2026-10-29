/**
 * Locating the pi executable and running `pi update` as a detached process.
 *
 * Detaching matters: npm replaces the running install while a session is open,
 * and the update must finish even when the session exits mid-install.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, extname } from "node:path";
import { closeLogFile, openLogFile } from "./state.ts";
import type { UpdateScope } from "./config.ts";

export interface PiLauncher {
	command: string;
	prefixArgs: string[];
	/** Resolved path of the pi entry point, when known. */
	entryPath?: string;
	/** True when pi runs from a read-only store such as Nix. */
	readOnlyInstall: boolean;
	source: "override" | "exec-path" | "argv" | "path";
}

const NIX_STORE = "/nix/store/";

/**
 * Find how this pi process was started so the update targets the same install,
 * not whatever `pi` happens to resolve to on PATH.
 */
export function resolvePiLauncher(
	env: NodeJS.ProcessEnv = process.env,
	argv: readonly string[] = process.argv,
	execPath: string = process.execPath,
): PiLauncher {
	const override = env.PI_AUTO_UPDATE_COMMAND?.trim();
	if (override) {
		const [command, ...prefixArgs] = splitCommand(override);
		if (command) {
			return { command, prefixArgs, readOnlyInstall: command.includes(NIX_STORE), source: "override" };
		}
	}

	// A compiled pi binary (bun --compile): argv[1] is already a user argument.
	if (/^pi(?:\.exe)?$/i.test(basename(execPath))) {
		return { command: execPath, prefixArgs: [], entryPath: execPath, readOnlyInstall: execPath.includes(NIX_STORE), source: "exec-path" };
	}

	const entry = argv[1] ? resolveEntry(argv[1]) : undefined;
	if (entry) {
		const readOnlyInstall = entry.includes(NIX_STORE);
		if (/\.[cm]?js$/i.test(entry)) {
			return { command: execPath, prefixArgs: [entry], entryPath: entry, readOnlyInstall, source: "argv" };
		}
		if (process.platform === "win32" && /^\.(cmd|bat)$/i.test(extname(entry))) {
			return {
				command: env.ComSpec ?? "cmd.exe",
				prefixArgs: ["/d", "/s", "/c", entry],
				entryPath: entry,
				readOnlyInstall,
				source: "argv",
			};
		}
		if (process.platform !== "win32" && existsSync(entry)) {
			return { command: entry, prefixArgs: [], entryPath: entry, readOnlyInstall, source: "argv" };
		}
	}

	return { command: process.platform === "win32" ? "pi.cmd" : "pi", prefixArgs: [], readOnlyInstall: false, source: "path" };
}

/** `pi update` arguments for the configured scope. */
export function updateArgs(scope: UpdateScope, force: boolean): string[] {
	const args = ["update", scope === "all" ? "--all" : `--${scope}`];
	if (force) args.push("--force");
	return args;
}

export interface UpdateRunOptions {
	command: string;
	prefixArgs: string[];
	scope: UpdateScope;
	force: boolean;
	cwd: string;
	outputFile: string;
	timeoutMs: number;
	/** Called once the child is spawned, with its pid (when available). */
	onSpawn?: (pid: number | undefined) => void;
}

export interface UpdateRunResult {
	ok: boolean;
	code: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	durationMs: number;
	outputFile: string;
	error?: string;
}

export function runPiUpdate(options: UpdateRunOptions): Promise<UpdateRunResult> {
	const args = [...options.prefixArgs, ...updateArgs(options.scope, options.force)];
	const startedAt = Date.now();
	const logFd = (() => {
		try {
			return openLogFile(options.outputFile);
		} catch {
			return undefined;
		}
	})();

	return new Promise<UpdateRunResult>((resolve) => {
		let settled = false;
		let timedOut = false;
		let timeout: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;

		const finish = (result: Omit<UpdateRunResult, "durationMs" | "outputFile">) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			if (logFd !== undefined) closeLogFile(logFd);
			resolve({ ...result, durationMs: Date.now() - startedAt, outputFile: options.outputFile });
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(options.command, args, {
				cwd: existsSync(options.cwd) ? options.cwd : undefined,
				detached: process.platform !== "win32",
				stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
				env: { ...process.env, PI_AUTO_UPDATE_CHILD: "1" },
				windowsHide: true,
			});
		} catch (error) {
			finish({ ok: false, code: null, signal: null, timedOut: false, error: errorMessage(error) });
			return;
		}

		child.once("error", (error) => {
			finish({ ok: false, code: null, signal: null, timedOut, error: errorMessage(error) });
		});
		child.once("exit", (code, signal) => {
			finish({ ok: code === 0, code, signal, timedOut });
		});

		// Do not keep pi's event loop alive for the update.
		child.unref();
		options.onSpawn?.(child.pid);

		timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
			killTimer.unref?.();
		}, options.timeoutMs);
		timeout.unref?.();
	});
}

/** Split a configured command line, honouring single and double quotes. */
export function splitCommand(raw: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (const char of raw) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) parts.push(current);
	return parts;
}

function resolveEntry(candidate: string): string | undefined {
	try {
		if (!existsSync(candidate)) return undefined;
		return realpathSync(candidate);
	} catch {
		return undefined;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

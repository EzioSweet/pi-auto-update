/**
 * Durable bookkeeping for the extension: throttle data, last result, the
 * single-runner lock, and the update log.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface UpdateRun {
	startedAt: number;
	finishedAt?: number;
	fromVersion: string;
	toVersion: string;
	command: string;
	ok: boolean;
	code: number | null;
	logFile: string;
	error?: string;
}

export interface UpdateState {
	/** Epoch ms of the last successful or failed version lookup. */
	lastCheckAt?: number;
	/** Newest version the release endpoint reported. */
	latestSeen?: string;
	/** Version this extension last announced or installed. */
	lastSeenVersion?: string;
	lastRun?: UpdateRun;
}

export interface StatePaths {
	dir: string;
	stateFile: string;
	lockFile: string;
	logFile: string;
	outputFile: string;
}

export function statePaths(dir: string): StatePaths {
	return {
		dir,
		stateFile: join(dir, "pi-auto-update.json"),
		lockFile: join(dir, "pi-auto-update.lock"),
		logFile: join(dir, "pi-auto-update.log"),
		outputFile: join(dir, "pi-auto-update-output.log"),
	};
}

export function readState(path: string): UpdateState {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as UpdateState;
	} catch {
		// Missing or corrupt state is not an error: start fresh.
	}
	return {};
}

export function writeState(path: string, state: UpdateState): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	} catch {
		// State is an optimization; never break a session over it.
	}
}

export interface LockInfo {
	pid: number;
	startedAt: number;
}

const DEFAULT_LOCK_STALE_MS = 40 * 60_000;

/**
 * Create the lock file atomically. A lock is stale when its owner is gone or
 * when it is older than the update timeout, so a crashed run cannot wedge the
 * auto-updater forever.
 */
export function acquireLock(lockFile: string, options: { now?: number; staleMs?: number } = {}): boolean {
	const now = options.now ?? Date.now();
	const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
	try {
		mkdirSync(dirname(lockFile), { recursive: true });
		writeFileSync(lockFile, lockBody(process.pid, now), { encoding: "utf8", flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
	}

	const holder = readLock(lockFile);
	const holderAlive = holder ? isProcessAlive(holder.pid) : false;
	const fresh = holder ? now - holder.startedAt < staleMs : isFreshEnough(lockFile, now, staleMs);
	if (holderAlive && fresh) return false;

	// Stale lock: replace it. Two pi processes racing here both win, which only
	// means a duplicate update, never a wedged lock.
	try {
		writeFileSync(lockFile, lockBody(process.pid, now), "utf8");
		return true;
	} catch {
		return false;
	}
}

/** Hand the lock to the spawned (detached) update process. */
export function transferLock(lockFile: string, pid: number): void {
	try {
		writeFileSync(lockFile, lockBody(pid, Date.now()), "utf8");
	} catch {
		// Keep the old pid; staleness handling still applies.
	}
}

export function releaseLock(lockFile: string): void {
	try {
		rmSync(lockFile, { force: true });
	} catch {
		// Already gone.
	}
}

export function appendLog(path: string, message: string): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const stamp = new Date().toISOString();
		const prefix = `${stamp} [${process.pid}] `;
		const body = message
			.split("\n")
			.map((line) => `${prefix}${line}`)
			.join("\n");
		writeFileSync(path, `${body}\n`, { encoding: "utf8", flag: "a" });
	} catch {
		// Logging must never break a session.
	}
}

/** Open the update log for a spawned process to inherit. */
export function openLogFile(path: string): number {
	mkdirSync(dirname(path), { recursive: true });
	return openSync(path, "a");
}

export function closeLogFile(fd: number): void {
	try {
		closeSync(fd);
	} catch {
		// Ignore.
	}
}

function readLock(lockFile: string): LockInfo | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(lockFile, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const { pid, startedAt } = parsed as Partial<LockInfo>;
		if (typeof pid !== "number" || typeof startedAt !== "number") return undefined;
		return { pid, startedAt };
	} catch {
		return undefined;
	}
}

function lockBody(pid: number, startedAt: number): string {
	return `${JSON.stringify({ pid, startedAt } satisfies LockInfo)}\n`;
}

function isFreshEnough(lockFile: string, now: number, staleMs: number): boolean {
	try {
		return now - statSync(lockFile).mtimeMs < staleMs;
	} catch {
		return false;
	}
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

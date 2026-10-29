import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, readState, releaseLock, statePaths, transferLock, writeState } from "../src/state.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "pi-auto-update-test-"));

test("statePaths keeps every file inside the configured directory", () => {
	const dir = tempDir();
	const paths = statePaths(dir);
	for (const path of [paths.stateFile, paths.lockFile, paths.logFile, paths.outputFile]) {
		assert.ok(path.startsWith(`${dir}/`), path);
	}
});

test("writeState/readState round-trip and tolerate junk", () => {
	const dir = tempDir();
	const { stateFile } = statePaths(dir);
	assert.deepEqual(readState(stateFile), {});

	const state = { lastCheckAt: 1, latestSeen: "1.5.0", lastRun: { ok: true } } as never;
	writeState(stateFile, state);
	assert.deepEqual(readState(stateFile), state);

	writeFileSync(stateFile, "{not json");
	assert.deepEqual(readState(stateFile), {});
});

test("lock is exclusive and released", () => {
	const dir = tempDir();
	const { lockFile } = statePaths(dir);

	assert.equal(acquireLock(lockFile), true);
	assert.equal(acquireLock(lockFile), false);

	transferLock(lockFile, process.pid);
	assert.equal(acquireLock(lockFile), false);

	releaseLock(lockFile);
	assert.equal(acquireLock(lockFile), true);
	releaseLock(lockFile);
});

test("stale lock from a dead process is taken over", () => {
	const dir = tempDir();
	const { lockFile } = statePaths(dir);
	// PID 2^31-1 is not a valid live pid on supported platforms.
	writeFileSync(lockFile, JSON.stringify({ pid: 2_147_483_647, startedAt: Date.now() }));

	assert.equal(acquireLock(lockFile), true);
	releaseLock(lockFile);
});

test("old lock is taken over even when the pid looks alive", () => {
	const dir = tempDir();
	const { lockFile } = statePaths(dir);
	writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60 * 60_000 }));

	assert.equal(acquireLock(lockFile, { staleMs: 30 * 60_000 }), true);
	releaseLock(lockFile);
});

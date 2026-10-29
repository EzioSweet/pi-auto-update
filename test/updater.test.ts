import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePiLauncher, splitCommand, updateArgs } from "../src/updater.ts";

test("updateArgs maps scopes to pi update flags", () => {
	assert.deepEqual(updateArgs("all", false), ["update", "--all"]);
	assert.deepEqual(updateArgs("extensions", false), ["update", "--extensions"]);
	assert.deepEqual(updateArgs("self", true), ["update", "--self", "--force"]);
	assert.deepEqual(updateArgs("models", false), ["update", "--models"]);
});

test("splitCommand honours quotes and collapses whitespace", () => {
	assert.deepEqual(splitCommand("  pi   update  --all "), ["pi", "update", "--all"]);
	assert.deepEqual(splitCommand('node "/opt/my pi/cli.js"'), ["node", "/opt/my pi/cli.js"]);
	assert.deepEqual(splitCommand("'/opt/pi dir/pi' update"), ["/opt/pi dir/pi", "update"]);
	assert.deepEqual(splitCommand("   "), []);
});

test("resolvePiLauncher uses an explicit override", () => {
	const launcher = resolvePiLauncher({ PI_AUTO_UPDATE_COMMAND: 'node "/opt/pi/cli.js"' }, [], "/usr/bin/node");
	assert.deepEqual(launcher, {
		command: "node",
		prefixArgs: ["/opt/pi/cli.js"],
		readOnlyInstall: false,
		source: "override",
	});
});

test("resolvePiLauncher detects a compiled pi binary", () => {
	const launcher = resolvePiLauncher({}, ["/home/me/.local/bin/pi", "--continue"], "/home/me/.local/bin/pi");
	assert.equal(launcher.command, "/home/me/.local/bin/pi");
	assert.deepEqual(launcher.prefixArgs, []);
	assert.equal(launcher.source, "exec-path");
});

test("resolvePiLauncher falls back to PATH when argv has no script", () => {
	const launcher = resolvePiLauncher({}, ["/usr/bin/node", "-e", "x"], "/usr/bin/node");
	assert.equal(launcher.command, process.platform === "win32" ? "pi.cmd" : "pi");
	assert.deepEqual(launcher.prefixArgs, []);
	assert.equal(launcher.source, "path");
});

test("resolvePiLauncher flags read-only installs", () => {
	const launcher = resolvePiLauncher({ PI_AUTO_UPDATE_COMMAND: "/nix/store/abc-pi/bin/pi" }, [], "/usr/bin/node");
	assert.equal(launcher.readOnlyInstall, true);
});

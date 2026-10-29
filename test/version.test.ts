import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, fetchLatestRelease, isNewerVersion } from "../src/version.ts";

test("compareVersions orders releases", () => {
	assert.equal(compareVersions("1.4.0", "1.4.0"), 0);
	assert.ok(compareVersions("1.5.0", "1.4.9")! > 0);
	assert.ok(compareVersions("1.4.10", "1.4.9")! > 0);
	assert.ok(compareVersions("2.0.0", "1.99.99")! > 0);
	assert.ok(compareVersions("1.4.0", "1.4.1")! < 0);
});

test("compareVersions handles prereleases and prefixes", () => {
	assert.ok(compareVersions("1.5.0", "1.5.0-beta.1")! > 0);
	assert.ok(compareVersions("1.5.0-beta.2", "1.5.0-beta.1")! > 0);
	assert.ok(compareVersions("1.5.0-beta.10", "1.5.0-beta.9")! > 0);
	assert.ok(compareVersions("1.5.0-beta", "1.5.0-alpha")! > 0);
	assert.equal(compareVersions("v1.4.0", "1.4.0"), 0);
	assert.equal(compareVersions("1.4.0+build.7", "1.4.0"), 0);
});

test("compareVersions returns undefined for unknown formats", () => {
	assert.equal(compareVersions("2024-10-29", "1.4.0"), undefined);
	assert.equal(compareVersions("nightly", "1.4.0"), undefined);
});

test("isNewerVersion ignores equal and older releases", () => {
	assert.equal(isNewerVersion("1.4.0", "1.4.0"), false);
	assert.equal(isNewerVersion("1.3.9", "1.4.0"), false);
	assert.equal(isNewerVersion("1.4.1", "1.4.0"), true);
});

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("fetchLatestRelease prefers the release endpoint", async () => {
	const seen: string[] = [];
	const release = await fetchLatestRelease({
		apiUrl: "https://pi.dev/api/latest-version",
		npmRegistry: "https://registry.npmjs.org",
		packageName: "@earendil-works/pi-coding-agent",
		userAgent: "test",
		timeoutMs: 1000,
		fetchImpl: async (input) => {
			seen.push(String(input));
			return jsonResponse({ ok: true, version: "9.9.9", packageName: "@earendil-works/pi-coding-agent" });
		},
	});
	assert.deepEqual(seen, ["https://pi.dev/api/latest-version"]);
	assert.equal(release?.version, "9.9.9");
});

test("fetchLatestRelease falls back to the npm registry", async () => {
	const seen: string[] = [];
	const release = await fetchLatestRelease({
		apiUrl: "https://pi.dev/api/latest-version",
		npmRegistry: "https://registry.example.com/",
		packageName: "@earendil-works/pi-coding-agent",
		userAgent: "test",
		timeoutMs: 1000,
		fetchImpl: async (input) => {
			seen.push(String(input));
			if (String(input).includes("pi.dev")) throw new Error("blocked");
			return jsonResponse({ name: "@earendil-works/pi-coding-agent", version: "1.6.0" });
		},
	});
	assert.deepEqual(seen, [
		"https://pi.dev/api/latest-version",
		"https://registry.example.com/@earendil-works/pi-coding-agent/latest",
	]);
	assert.deepEqual(release, { version: "1.6.0", packageName: "@earendil-works/pi-coding-agent" });
});

test("fetchLatestRelease returns undefined when both sources fail", async () => {
	const release = await fetchLatestRelease({
		apiUrl: "https://pi.dev/api/latest-version",
		npmRegistry: "https://registry.npmjs.org",
		packageName: "@earendil-works/pi-coding-agent",
		userAgent: "test",
		timeoutMs: 1000,
		fetchImpl: async () => jsonResponse({ error: "nope" }, 500),
	});
	assert.equal(release, undefined);
});

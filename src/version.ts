/**
 * Release lookup and version comparison. Kept free of pi imports so it can be
 * unit-tested with plain `node --test`.
 */

export interface LatestRelease {
	version: string;
	packageName?: string;
	note?: string;
}

export interface LatestReleaseOptions {
	apiUrl: string;
	npmRegistry: string;
	packageName: string;
	userAgent: string;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
}

/**
 * Compare two semver-ish versions. Returns `undefined` when either side is not
 * a parseable version (for example a date-stamped dev build).
 */
export function compareVersions(left: string, right: string): number | undefined {
	const a = parseVersion(left);
	const b = parseVersion(right);
	if (!a || !b) return undefined;

	for (const key of ["major", "minor", "patch"] as const) {
		if (a[key] !== b[key]) return a[key] - b[key];
	}
	// A release outranks any prerelease of the same version.
	if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
	if (a.prerelease.length === 0) return 1;
	if (b.prerelease.length === 0) return -1;

	for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
		const x = a.prerelease[i];
		const y = b.prerelease[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const xNumeric = /^\d+$/.test(x);
		const yNumeric = /^\d+$/.test(y);
		if (xNumeric && yNumeric) {
			if (Number(x) !== Number(y)) return Number(x) - Number(y);
		} else if (xNumeric !== yNumeric) {
			return xNumeric ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
	const comparison = compareVersions(candidate, current);
	if (comparison === undefined) return candidate.trim() !== current.trim();
	return comparison > 0;
}

/**
 * Ask the release endpoint for the latest published version, falling back to
 * the npm registry when that endpoint is unreachable (mirrors, blocked hosts).
 */
export async function fetchLatestRelease(options: LatestReleaseOptions): Promise<LatestRelease | undefined> {
	const fromApi = await requestRelease(options.apiUrl, options);
	if (fromApi?.version) return fromApi;

	const registry = options.npmRegistry.replace(/\/+$/, "");
	const fromNpm = await requestRelease(`${registry}/${options.packageName}/latest`, options);
	if (fromNpm?.version) return { version: fromNpm.version, packageName: options.packageName };
	return undefined;
}

async function requestRelease(url: string, options: LatestReleaseOptions): Promise<LatestRelease | undefined> {
	const fetchImpl = options.fetchImpl ?? fetch;
	try {
		const response = await fetchImpl(url, {
			headers: { accept: "application/json", "user-agent": options.userAgent },
			signal: AbortSignal.timeout(options.timeoutMs),
		});
		if (!response.ok) return undefined;
		const body: unknown = await response.json();
		if (!isRecord(body)) return undefined;

		const version = typeof body.version === "string" ? body.version.trim() : "";
		if (!version) return undefined;

		const packageName = typeof body.packageName === "string" && body.packageName.trim() ? body.packageName.trim() : undefined;
		const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;
		return { version, ...(packageName ? { packageName } : {}), ...(note ? { note } : {}) };
	} catch {
		return undefined;
	}
}

function parseVersion(raw: string): { major: number; minor: number; patch: number; prerelease: string[] } | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
	if (!match) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ? match[4].split(".") : [],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

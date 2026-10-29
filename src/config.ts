/**
 * Env-driven configuration. Everything is optional; the defaults match the
 * "just keep pi updated" behaviour.
 */

export type UpdateScope = "all" | "self" | "extensions" | "models";

export interface Config {
	/** Master switch (`PI_AUTO_UPDATE=0` turns the extension off). */
	enabled: boolean;
	/** Which `pi update` target to run. */
	scope: UpdateScope;
	/** Skip the startup check if the last check happened less than this ago. */
	intervalMs: number;
	/** Release endpoint that reports the latest published pi version. */
	apiUrl: string;
	/** Registry used as a fallback when the release endpoint is unreachable. */
	npmRegistry: string;
	/** Package name used for the npm fallback. */
	packageName: string;
	/** Timeout for the version lookup. */
	checkTimeoutMs: number;
	/** Timeout for the update process. */
	updateTimeoutMs: number;
	/** Session modes that may auto-update (`tui`, `rpc`, `json`, `print`). */
	modes: string[];
	/** Check and announce, but never spawn the update. */
	dryRun: boolean;
	/** Pass `--force` to reinstall even when the version matches. */
	force: boolean;
	/** Directory for the state, lock, and log files. */
	stateDir: string;
	/** Full command used to invoke pi, overriding launcher detection. */
	commandOverride?: string;
}

const DEFAULT_API_URL = "https://pi.dev/api/latest-version";
const DEFAULT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 10;
const DEFAULT_UPDATE_TIMEOUT_MINUTES = 15;
const DEFAULT_MODES = "tui,rpc";
const VALID_SCOPES: readonly UpdateScope[] = ["all", "self", "extensions", "models"];

export function loadConfig(env: NodeJS.ProcessEnv, defaultStateDir: string): Config {
	const scope = env.PI_AUTO_UPDATE_SCOPE?.trim().toLowerCase();
	const force = readBool(env.PI_AUTO_UPDATE_FORCE, false);

	return {
		enabled: readBool(env.PI_AUTO_UPDATE, true),
		scope: VALID_SCOPES.includes(scope as UpdateScope) ? (scope as UpdateScope) : "all",
		intervalMs: readNumber(env.PI_AUTO_UPDATE_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES, 0) * 60_000,
		apiUrl: readString(env.PI_AUTO_UPDATE_API_URL, DEFAULT_API_URL),
		npmRegistry: readString(env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY, DEFAULT_NPM_REGISTRY).replace(/\/+$/, ""),
		packageName: readString(env.PI_AUTO_UPDATE_PACKAGE, DEFAULT_PACKAGE_NAME),
		checkTimeoutMs: readNumber(env.PI_AUTO_UPDATE_TIMEOUT_SECONDS, DEFAULT_CHECK_TIMEOUT_SECONDS, 1) * 1000,
		updateTimeoutMs: readNumber(env.PI_AUTO_UPDATE_UPDATE_TIMEOUT_MINUTES, DEFAULT_UPDATE_TIMEOUT_MINUTES, 1) * 60_000,
		modes: readString(env.PI_AUTO_UPDATE_MODES, DEFAULT_MODES)
			.split(",")
			.map((mode) => mode.trim().toLowerCase())
			.filter(Boolean),
		dryRun: readBool(env.PI_AUTO_UPDATE_DRY_RUN, false),
		force,
		stateDir: readString(env.PI_AUTO_UPDATE_DIR, defaultStateDir),
		commandOverride: readOptionalString(env.PI_AUTO_UPDATE_COMMAND),
	};
}

function readString(raw: string | undefined, fallback: string): string {
	const value = raw?.trim();
	return value ? value : fallback;
}

function readOptionalString(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	return value ? value : undefined;
}

function readBool(raw: string | undefined, fallback: boolean): boolean {
	const value = raw?.trim().toLowerCase();
	if (!value) return fallback;
	if (["0", "false", "no", "off", "disabled"].includes(value)) return false;
	if (["1", "true", "yes", "on", "enabled"].includes(value)) return true;
	return fallback;
}

function readNumber(raw: string | undefined, fallback: number, min: number): number {
	const value = Number(raw?.trim());
	return Number.isFinite(value) && value >= min ? value : fallback;
}

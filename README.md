# pi-auto-update

A [pi](https://pi.dev) extension that keeps pi up to date without you thinking about it.

When a session starts it asks the release endpoint for the latest published pi version. If that version is newer than the one you are running, it runs **`pi update --all`** in the background, then tells you to restart pi. If you are already current, it does nothing.

```
⬆ pi 1.4.0 → 1.5.0: running `pi update --all` in the background…
```

## Install

From GitHub:

```bash
pi install git:github.com/EzioSweet/pi-auto-update
```

From a local checkout:

```bash
pi install /path/to/pi-auto-update
```

Try it for a single run without touching your settings:

```bash
pi -e /path/to/pi-auto-update
```

## What happens on startup

1. `session_start` fires with reason `startup` (only the first session of the process).
2. The extension compares the running pi version with `https://pi.dev/api/latest-version`, falling back to the npm registry when that host is unreachable or blocked.
3. If a newer release exists, `pi update --all` is spawned as a **detached** process:
   - it keeps running if you exit pi mid-install,
   - it writes full command output to `~/.pi/agent/pi-auto-update-output.log`,
   - a lock file prevents two pi instances from updating at the same time,
   - a stuck install is killed after the configured timeout.
4. When the update finishes you get a notification; restart pi to run the new version.

Checks are throttled (30 minutes by default), so opening several sessions in a row costs one lookup.

## Command

| Command | Description |
|---|---|
| `/update` | Check now and update if a newer release exists |
| `/update check` | Only report the running and latest version |
| `/update force` | Reinstall with `pi update --all --force` |
| `/update logs` | Show where the logs live |

## Configuration

Everything is optional; the defaults do the right thing.

| Variable | Default | Meaning |
|---|---|---|
| `PI_AUTO_UPDATE` | `1` | `0` disables the extension entirely |
| `PI_AUTO_UPDATE_SCOPE` | `all` | `all`, `self`, `extensions`, or `models` (mapped to `pi update --all/--self/--extensions/--models`) |
| `PI_AUTO_UPDATE_INTERVAL_MINUTES` | `30` | Minimum time between startup checks |
| `PI_AUTO_UPDATE_MODES` | `tui,rpc` | Session modes allowed to auto-update (`tui,rpc,json,print`) |
| `PI_AUTO_UPDATE_FORCE` | `0` | Always reinstall, even when the version matches |
| `PI_AUTO_UPDATE_DRY_RUN` | `0` | Report the available update without installing it |
| `PI_AUTO_UPDATE_TIMEOUT_SECONDS` | `10` | Timeout for the version lookup |
| `PI_AUTO_UPDATE_UPDATE_TIMEOUT_MINUTES` | `15` | How long the update may run before it is killed |
| `PI_AUTO_UPDATE_API_URL` | `https://pi.dev/api/latest-version` | Release endpoint |
| `PI_AUTO_UPDATE_PACKAGE` | `@earendil-works/pi-coding-agent` | Package used for the npm fallback |
| `PI_AUTO_UPDATE_COMMAND` | auto-detected | Command used to invoke pi, e.g. `node /opt/pi/cli.js` |
| `PI_AUTO_UPDATE_DIR` | pi agent dir | Where the state, lock, and log files live |

`PI_OFFLINE=1` skips the startup check. On read-only installs (Nix) the self-update is skipped and installed packages are updated instead.

## Files

Written to `~/.pi/agent/` (or `$PI_CODING_AGENT_DIR`):

| File | Purpose |
|---|---|
| `pi-auto-update.json` | Last check time, newest seen version, last run result |
| `pi-auto-update.log` | Timestamped decision log |
| `pi-auto-update-output.log` | Raw output of `pi update` |
| `pi-auto-update.lock` | Prevents concurrent updates |

## Behaviour notes

- The update runs in the directory you started pi in, exactly like running `pi update --all` yourself. Project-local packages are **not** trusted automatically: if the update needs project trust, it fails and the log says why.
- Only `tui` and `rpc` sessions auto-update by default; short-lived `print`/`json` runs are left alone.
- The running process keeps using the version it started with. Restart pi after a notification to pick up the new release.

## Development

```bash
npm install
npm test          # node --test
npm run typecheck # tsc --noEmit
pi -e . --mode json -p "hello"   # smoke test with a session
```

For local experiments, point the extension at a fake release endpoint and a fake pi binary:

```bash
PI_AUTO_UPDATE_MODES=json \
PI_AUTO_UPDATE_API_URL=http://127.0.0.1:8787/latest \
PI_AUTO_UPDATE_COMMAND=/tmp/fake-pi \
PI_AUTO_UPDATE_DIR=/tmp/pi-auto-update-test \
pi -e . --mode json -p "hello"
```

## License

MIT

# Configuration

## Merge order

Later sources override earlier ones, per key:

1. Built-in defaults
2. `domra.json` (committed defaults)
3. `domra.local.json` (gitignored local overrides; see `domra.local.example.json`)
4. `DOMRA_*` environment variables

`domra.json` and `domra.local.json` are read from the working directory (or the `cwd` passed to `loadConfig`). Missing files are ignored.

## Keys

| Key | Type | Default | Environment variable |
|---|---|---|---|
| `roots` | `string[]` | `[]` | `DOMRA_ROOTS` |
| `preload` | `string[]` | `[]` | `DOMRA_PRELOAD` |
| `defaultSolution` | `string \| null` | `null` | `DOMRA_DEFAULT_SOLUTION` |
| `port` | `number` | `5302` | `DOMRA_PORT` |
| `loadWaitSeconds` | `number` | `20` | `DOMRA_LOAD_WAIT_SECONDS` |
| `ignoredFolders` | `string[]` | `["node_modules", ".git", "dist", "build", "out", "coverage"]` | `DOMRA_IGNORED_FOLDERS` |
| `indexPath` | `string \| null` | `null` (= `defaultIndexPath()`) | `DOMRA_INDEX_PATH` |
| `warmUp` | `boolean` | `true` | `DOMRA_WARM_UP` (`true` or `false`) |
| `blobRetentionDays` | `number` | `30` | `DOMRA_BLOB_RETENTION_DAYS` |
| `watch` | `boolean` | `true` | `DOMRA_WATCH` (`true` or `false`) |
| `debounceMs` | `number` | `500` | `DOMRA_DEBOUNCE_MS` |
| `unloadedRefreshSeconds` | `number` | `60` | `DOMRA_UNLOADED_REFRESH_SECONDS` (`0` disables) |
| `unloadedRefreshMaxWaitSeconds` | `number` | `600` | `DOMRA_UNLOADED_REFRESH_MAX_WAIT_SECONDS` (`0` disables) |
| `discoverySweepSeconds` | `number` | `30` | `DOMRA_DISCOVERY_SWEEP_SECONDS` (`0` disables) |
| `gitPath` | `string` | `"git"` | `DOMRA_GIT_PATH` |
| `allowedOrigins` | `string[]` | `[]` | `DOMRA_ALLOWED_ORIGINS` |
| `logDirectory` | `string \| null` | `null` (= `${LOCALAPPDATA ?? homedir}/domra/logs`) | `DOMRA_LOG_DIRECTORY` |
| `logRetainedDays` | `number` | `7` | `DOMRA_LOG_RETAINED_DAYS` (`0` keeps all) |
| `reextractDependents` | `boolean` | `true` | `DOMRA_REEXTRACT_DEPENDENTS` (`true` or `false`) |

- `roots`: directories scanned for tsconfig solutions.
- `preload`: solution names or paths loaded at startup.
- `defaultSolution`: solution used when a tool call does not name one.
- `port`: HTTP port of the MCP endpoint.
- `loadWaitSeconds`: how long a query waits for a loading solution. Unused in Live mode: the server loads solutions synchronously, so a query that names a solution simply blocks until it is loaded.
- `ignoredFolders`: folder names skipped during discovery and watching.
- `indexPath`: SQLite index file of the server (directory created); `null` means `${LOCALAPPDATA ?? homedir}/domra/index.db`; `:memory:` keeps it in memory (tests). An empty string or `null` in the environment means the default.
- `warmUp`: at startup, load, index and unload every solution whose index is not fresh, so queries answer from the index for unloaded solutions.
- `blobRetentionDays`: blobs not used for this long and no longer in any tree are deleted at startup.
- `watch`: watch the roots for file changes and apply them to loaded solutions and the index (see [watcher.md](watcher.md)).
- `debounceMs`: quiet period before a burst of file events becomes one batch; the server uses `max(100, debounceMs)`.
- `unloadedRefreshSeconds`: quiet time after which changes under a solution that is not loaded trigger a load-index-unload refresh; `0` disables the rule.
- `unloadedRefreshMaxWaitSeconds`: longest wait since the first such change before the refresh runs even if changes continue; `0` disables the rule. With both at `0` no refresh ever runs.
- `discoverySweepSeconds`: period of the sweep that forgets registered solutions whose tsconfig no longer exists (new tsconfigs are found by the watcher, see [watcher.md](watcher.md)); `0` disables the sweep.
- `gitPath`: the git executable `review_changes` (and the CLI `review`) runs: a name looked up on `PATH` or an absolute path. Nothing else starts git. When it cannot be started the answer is `review_changes: '{gitPath}' could not be started ({message}); install git or set gitPath in the config`.
- `allowedOrigins`: browser origins (exact, e.g. `https://app.example`) accepted in addition to loopback ones; see [server.md](server.md#origin-check).
- `logDirectory`: directory of the daily log files (see [server.md](server.md#log-file)); `null` means `${LOCALAPPDATA ?? homedir}/domra/logs`. An empty string or `null` in the environment means the default.
- `logRetainedDays`: number of newest `domra-*.clef` files kept; older ones are deleted at startup and at each date change. `0` or less keeps all.
- `reextractDependents`: after a watcher batch changes the declared surface of a project, re-extract the stored documents of the projects that depend on it, in the same and in other loaded solutions (see [watcher.md](watcher.md#re-extracting-dependents)). `false` disables it; dependents then keep stale reference rows until their own files change or the solution is reindexed.

Environment values: numbers are parsed with `Number`; list keys (`roots`, `preload`, `ignoredFolders`, `allowedOrigins`) take a JSON array, e.g. `DOMRA_ROOTS='["C:/src"]'`; for `defaultSolution`, an empty string or `null` means no default.

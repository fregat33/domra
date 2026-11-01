# Server (Live mode)

`node dist/server/index.js` (`npm start`) loads the configuration (`docs/config.md`), starts an HTTP server on `127.0.0.1:{port}` and prints `domra listening on http://127.0.0.1:{port}/mcp` to stderr. `SIGINT`/`SIGTERM` close it. Entry: `src/server/index.ts`; embedding/tests: `startServer(options)` in `src/server/server.ts` returns `{ port, close(), manager, store, jobs }` (`port: 0` picks a free port).

## Startup

The workspace manager discovers solutions under `roots` (honouring `ignoredFolders`), then loads every `preload` entry and `defaultSolution`. Unknown names are a warning on stderr, not fatal. A query naming a solution loads it on demand, synchronously (`loadWaitSeconds` is unused). A query without a solution runs against the loaded solutions; when none is loaded and `defaultSolution` is set, that one is loaded first. Requests are handled one at a time.

## Protocol subset

`POST /mcp` takes one JSON-RPC 2.0 message and always answers `application/json` (no SSE, regardless of `Accept`). The server is stateless.

| Method | Result |
| --- | --- |
| `initialize` | `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "domra", version } }`; the client's `protocolVersion` is echoed when it is `2024-11-05`, `2025-03-26` or `2025-06-18`, else `2025-06-18` |
| `notifications/*` (no `id`) | HTTP 202, empty body |
| `ping` | `{}` |
| `tools/list` | the seventeen tools (name, description, `inputSchema`, `annotations: { readOnlyHint, idempotentHint }`; `readOnlyHint` is `false` for `load_solution`, `reindex` and `forget_solution`, else `true`) |
| `tools/call` | `{ content: [{ type: "text", text }], isError? }` |

Errors: `-32700` invalid JSON, `-32600` batch or missing `jsonrpc`/`method`, `-32601` unknown method, `-32602` bad `tools/call` params. A tool that throws yields `isError: true` with `domra: {tool} failed: {message}` (HTTP 200).

Both `/mcp` and `/health` take the repeatable query parameter `part=<slot dir>`; it selects the view of the request (see [Parts and slots](#parts-and-slots)). A refused `part` makes every `tools/call` answer `isError: true` with the reason as text (HTTP 200); `/health` answers 400; `initialize`, `ping` and `tools/list` are unaffected.

## Origin check

Every request is checked before routing, against DNS rebinding and cross-site requests from a browser: a `Host` header must name `localhost`, `127.0.0.1` or `[::1]` (any port), and an `Origin` header must be an `http`/`https` origin on one of those hosts (any port) or listed exactly in `allowedOrigins`. Local clients (Claude Code, the CLI, the hook) send a loopback `Host` and no `Origin`, so they pass; a missing header is not checked. A refused request gets 403 `text/plain` `Host not allowed: {host}` or `Origin not allowed: {origin}`; the opaque origin `null` is refused.

Other routes: `GET /health` → 200 `text/plain` with the `status` tool text; `GET`/`DELETE /mcp` → 405; anything else → 404.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `status` | none | `Process:`, `Index:` (path and counts), `Jobs:`, `Watcher: {R} roots, {B} batches applied[, last batch HH:MM:SS {F} files], {M} buffered` (or `Watcher: off`; `{M}` = paths held in the debouncer), `Unloaded refresh: ...` (only with the watcher), `Ready: yes` when no job is pending or running and nothing is buffered, else `Ready: no ({N} jobs, {M} buffered)`, `Warm-up:` and the load state of every known solution, each line ending in `HEAD {7 chars}` (`HEAD -` when none recorded) (same text on `/health`) |
| `load_solution` | `solution` | `{name}: {N} projects loaded in {X.X}s, {M} unresolved imports.` or `Unknown solution: {x}. Known: ...`; indexing is queued |
| `forget_solution` | `solution` (full tsconfig path or name) | `Forgot {name} ({path}): {N} projects removed from the index.` or `Unknown solution: {x}. Known: ...`; unloads, unregisters and deletes the solution's index rows. It stays forgotten until `load_solution` with its tsconfig path, a query tool called with the full path of an existing tsconfig (explicit intent registers it again), a create/change event of its `tsconfig.json`, an overflow re-discovery, or a restart. A hint naming a non-existing `.json` path never registers anything: the tool answers `Unknown solution: ...`. Listed last in `tools/list` |
| `reindex` | `solution` (name or `all`), `force?` (false) | `Queued reindex of {N} loaded solutions (force=...).`, `Queued reindex of {name} (force=...).`, `{name} was not loaded; load started, indexing follows automatically.` or `Unknown solution: {x}. Known: ...` |
| `package_drift` | `limit?` (50, consumer lines per package) | per package (by name) `{package}  source {version} ({source solution dir})`, then `  {consumer solution dir}  {consumer project}  {consumed version}` lines (at most `limit`, then `  ... {K} more`), then `Total: {N} consumer projects on a version other than the source. Only solutions indexed at least once are compared.`; without drift `No package version drift: every indexed consumer uses the version its source package currently declares. Only solutions indexed at least once are compared.`; paged (label `package_drift`) |
| `next_page` | `cursor`, `limit?` | the next page of a paged result |
| `search_symbols` | `pattern`, `kind?`, `limit?` (30) | `Live {solution} ({total}):` and one hit line per symbol, paged |
| `go_to_definition` | `symbol`, `solution?` | header and every declaration |
| `get_symbol_info` | `symbol`, `solution?` | signature, modifiers, parameters, docs, first members |
| `list_members` | `type`, `solution?`, `filter?`, `includeInherited?`, `limit?` (200) | members, paged |
| `get_outline` | `target`, `solution?`, `depth?` (2), `includePrivate?` (true), `limit?` (300) | one line per declaration, paged, then `Total: N declarations` |
| `find_references` | `symbol`, `solution?`, `allSolutions?` (true), `kind?`, `scope?` (all), `limit?` (200) | one group per solution `Live {solution}: K references` (or `K of M references (filter)`), hit lines `path:line:col  project  kind  in Type.member`, then `Total: N references` |
| `find_implementations` | `symbol`, `solution?`, `limit?` (200) | implementers, derived types and overrides per solution, then `Total: N` |
| `find_derived_types` | `type`, `solution?`, `limit?` (200) | derived classes / implementing and extending interfaces, transitively, then `Total: N` |
| `get_call_graph` | `symbol`, `solution?`, `direction?` (both), `includeExternal?` (false), `direct?` (false: callers through base or interface members and on overrides are listed too, tagged `via Member`; true keeps the symbol's own), `scope?` (all), `limit?` (100) | one level: group `Callers (N, live, loaded solutions only):` (`N: d direct, k via base or interface members` when `via` callers are listed) and group `Callees (N, source only; ...):`, one line per site, each group paged (label `get_call_graph callers of {name}` / `callees of {name}`); see "Call graph" in the workspace docs |
| `review_changes` | `solution?` (default solution), `base?` (repository default branch), `includeTests?` (true), `limit?` (200) | `Review: {solution}  working tree vs {base} (merge-base {sha7})  N files changed: ...`, then one line per changed file and per changed declaration (each followed by a counts-only impact line: references per solution, live and index with package drift, for removed and signature-changed members; callers for body edits; implementations for added members) and the `Diagnostics on changed files:` block, paged (label `review_changes {solution} vs {base}`), then `Total: S source files, D changed declarations (...), E errors, W warnings`; errors are one `review_changes: ...` line; see "Change review" in the workspace docs |
| `get_diagnostics` | `target`, `solution?`, `minSeverity?` (warning), `limit?` (200) | `Diagnostics for {scope}: E errors, W warnings (compiler only; lint is not run)`, then one `  path:line:col  severity TSnnnn: message` line per diagnostic, paged |

`get_diagnostics` renders the workspace `QueryText` (see "Diagnostics" in the workspace docs). `target` is a `.ts/.tsx/...` file (absolute, or relative to a solution directory) or a project name. Without `solution` the solution registered for the directory of an absolute file path is loaded on demand. A file is re-read from disk before it is analysed, so saved edits show immediately; no build runs.

`review_changes` is the only asynchronous tool (it runs git through `ToolContext.git`, created with `createGit(config.gitPath)`; `startServer({ git })` injects another provider). The solution must already be loaded; it is not loaded on demand.

`find_references`, `find_implementations` and `find_derived_types` render the workspace `GroupedText`: head lines, then per group its header and `items` through the pager (one cursor per group, labelled `find_references {fqName} in {solution}`), then `footer`. The hinted solution is loaded on demand; bad `kind`/`scope` values come back as normal text.

`go_to_definition`, `get_symbol_info`, `list_members` and `get_outline` render the workspace `QueryText`: head lines, `items` through the pager (labelled by the query), then `footer`. Without a `solution` they try the loaded solutions in order and return the first that resolves.

## Index in the server

`startServer` opens the index (`indexPath`, default `defaultIndexPath()`; `:memory:` allowed), runs `gc(blobRetentionDays)` once and keeps `store` and a FIFO `JobQueue` (`src/server/jobs.ts`) on the `ToolContext` and on the returned `RunningServer` (`{ port, close(), manager, store, jobs }`). The queue runs synchronous jobs one at a time, each from `setImmediate`, so requests interleave between jobs; a throwing job is reported through `warn` and the queue continues. `pending`, `lastCompleted` and `idle()` are what `status` and the tests read. Every load (preload, on-demand hint, `load_solution`, through `WorkspaceManager.onLoad`) enqueues `index {solution}` (`indexSolution`; skipped when the solution was unloaded meanwhile).

**Warm-up** (`warmUp`, default true): after the preloads one job per discovered solution that is neither loaded nor `isFresh` loads it, runs `indexSolution` and `manager.unload`s it again, so queries are answered from the index for solutions that are not loaded. `status` shows `Warm-up: {done} of {total} done[, loading {name}]`, then `Warm-up: done, {W} warmed, {S} already fresh`. **Indexed HEAD**: after every job that indexes or reconciles a solution (`index {solution}`, warm-up, `refresh`, and in a `changes` job the solutions that were reconciled or reloaded; at warm-up also the already fresh unloaded ones) the server stores `git rev-parse HEAD` of the solution directory (`GitProvider.head`; null outside git or when git fails, which never fails the job). Git is not asked for solutions a job did not touch. `Ready` is the readiness signal for clients: `yes` means every queued change has been applied and the recorded HEADs are final until the next file event. An unloaded solution's HEAD stays at the HEAD it was last indexed at until its `refresh` job runs (`unloadedRefreshSeconds`). `close()` stops the HTTP server, drains the queue and closes the store.

**Watcher** (`watch`, default true, needs `roots`): started after the preloads. Each debounced batch is queued as a `changes` job that runs `applyChanges`; a timer enqueues `refresh {name}` jobs for due unloaded solutions. `close()` stops the timer and the watcher first. See [watcher.md](watcher.md).

**Index fallback in queries** (`src/server/fallback.ts`; live groups stay exactly as before and come first):

- `search_symbols`: after the live groups `Index {sol} (not loaded, {N}):` with `  {kind} {fqName}  {path}:{line}:{col}` lines (label `search_symbols {pattern} in {sol} (index)`); solutions that are loaded are skipped, and not with a `solution` argument.
- `find_references` (`allSolutions`): `Index {sol}: {N} references (solution not loaded; from index)` or `{K} of {M} references ({filter}; solution not loaded; from index)`, lines `  {path}:{line}:{col}  {project}  {kind}  in {enclosing}` plus `  [stale: file changed since indexed]` when the file changed since it was indexed; `Total:` includes the index groups.
- `find_implementations` / `find_derived_types`: `Index {sol}: {N} (solution not loaded; from index)`, lines `  {relation}  {kind} {fqName}  {path}:{line}:{col}` (`  [stale]` suffix).
- When the symbol is not found live but exactly one declaration with that fully qualified name exists in the index, `find_references`, `find_implementations` and `find_derived_types` use it as the target (head `Symbol: ... / Project: {project} ({sol}, from index) / Defined: ...`).
- Package types (`withPackageSource`): when `go_to_definition` / `get_symbol_info` resolve to a declaration under `node_modules` (a published `.d.ts`), its docId is looked up with `store.findSymbolsByDocId`, keeping hits outside `node_modules`. A hit in a loaded solution answers live from there (the ordinary text, resolved at the hit's `path:line:col`). Otherwise the declaration-file answer stays and gets one line per distinct solution (at most 3) `Source: {path}:{line}  ({project}, {sol}; solution not loaded, load_solution for the live view)`: after the `Declared in declaration file:` positions (go_to_definition), after the `Declared at:` lines (get_symbol_info). Without index hits nothing changes. Twins in loaded solutions are matched by docId (see `docs/workspace.md`), so the `Index {sol}` groups of a package type list every consumer that is indexed.
- **Drift tag** (`src/server/drift.ts`, `driftTagFor`): a `Live {sol}` group of a non-defining solution in `find_references`, `find_implementations` and `find_derived_types`, and an `Index {sol}` group, ends with `  [package {consumed versions}, source is {source versions}]` when the solution consumes the target's package (the docId scope up to the first `/`, two segments for `@scope/name`) in a version other than the one its source project declares (`package.json` version in the index; projects under `node_modules` are not sources). Versions are distinct, sorted and joined with `/`; a group with zero hits adds `; the symbol may not exist in that version` inside the brackets. No source version, no consumer in that solution or equal versions give no tag; the defining solution never has one. The workspace layer only gets a `groupSuffix(solutionPath, hits)` callback. Note that `find_implementations` prints no group for a twin solution without entries, so the zero-hit note shows up on filtered `find_references` groups (`K of M`).
- `get_outline` of a file no loaded solution contains: `Outline: {path}  (Index {sol}, {project}; solution not loaded, decorators not shown, load_solution for the live view[; [stale: file changed since indexed]])`, entries from the stored signatures.
- Not found: the `Tip:` line becomes `Index knows these candidates (pass the fully qualified name, or load_solution for the live view):` and up to 10 lines `  {docId}  {kind}  {path}:{line}  ({sol})` (the tip stays when the index knows nothing). A spec containing `#` is a docId: it resolves live when the owning solution is loaded, otherwise the candidates are the answer (nothing is loaded on behalf of a symbol lookup).

## Argument filter

Runs first on every `tools/call` (`src/server/arguments.ts`). `missing` = required − provided, `unknown` = provided − accepted (sorted).

- exactly one missing and one unknown: the unknown argument is renamed to the missing one;
- otherwise, when `missing` is non-empty: `isError` with `{tool}: missing required argument 'a'.`, plus ` Not accepted: 'x'; the value probably belongs in 'a'.` when there are unknown arguments, plus ` Accepted arguments: a (required), b.`;
- unknown arguments alone pass through;
- wrong types: `{tool}: argument '{name}' must be {integer|string|boolean}.`;
- unknown tool: `Unknown tool: {name}. Tools: ...`.

## Parts and slots

A **slot** is a solution inside a linked git worktree (`git rev-parse --git-dir` differs from `--git-common-dir`, run in the solution directory; computed once per worktree and cached, recomputed when the solution is registered again). Slots are discovered, warmed, watched and indexed like any solution, but they are **private**: no request sees them unless it names them as a **part**.

URL format: `http://localhost:5302/mcp?part=<slot dir>[&part=<slot dir>...]`. Each value is URL-decoded and compared with `pathKey` (case-insensitive on Windows, forward or back slashes).

Visibility of one request:

- visible = all non-private solutions − the **base solutions** of every part + the **solutions of every part**;
- the base solutions of a part are the registered, non-private solutions inside the main checkout of its repository (the parent directory of `git rev-parse --path-format=absolute --git-common-dir` run in the part); the solutions of a part are the registered solutions inside the part directory;
- other slots, also of the same repository, stay invisible; repositories without a part are shown as their base checkout;
- without `part`: all non-private solutions.

The view applies to every tool and every index fallback: live selection, `solution` hints (path, name, substring), absolute-path lookup, cross-solution twins, `search_symbols`, `find_references`, `find_implementations`, `find_derived_types`, `get_call_graph`, `get_outline` (including the index outline), `get_diagnostics`, `review_changes`, `package_drift` (consumers and sources), `status` and `/health` (the solution rows, the `Index:` counts and the `Unloaded refresh:` line follow the view; `Process:`, `Jobs:`, `Watcher:`, `Ready:` and `Warm-up:` stay global; a request without `part` is a view too, so its counts leave out private slots), `load_solution` (an explicit tsconfig path the view may not see is refused with `Unknown solution` and is not registered; a path outside every root and every worktree is visible to everyone), `reindex` and `forget_solution`. A hidden solution named by hint answers `Unknown solution: {x}. Known: ...` (the list shows visible solutions only); an absolute file path inside a hidden solution is not under any visible solution (`No symbol at ...` / `File not found` as for any unknown path). `next_page` cursors are global. Without a `solution` hint in a view with parts, the solutions of the parts are loaded on demand and tried first, then the other visible loaded solutions. The view is built per request; concurrent requests do not share it.

Solution hints match an exact name case-insensitively (after the exact path, before a name fragment; the first fragment match wins for every tool except `forget_solution`). `forget_solution` never forgets a solution the caller did not clearly name: the hint is trimmed (a blank hint answers `Unknown solution`), only visible solutions are candidates, and the candidates are the exact path, else every exact name (case-insensitive), else every name containing the hint. With 2+ candidates nothing is unloaded, unregistered or deleted and the answer is `Ambiguous solution: {hint} matches {Name} ({path}), {Name} ({path}). Use the full path or the exact name.` (candidates sorted by path; `Use the full path.` when every candidate's name equals the hint).

Errors (tool-call result text, `isError: true`):

| Case | Text |
| --- | --- |
| `part` is not inside a linked worktree, or contains no registered solution | `Unknown part: {path}` |
| two parts with the same main checkout | `Two parts of one repository: {a}, {b}` |

Examples (slots at `<slotsRoot>/<repo>/<n>`):

```
http://localhost:5302/mcp?part=D:/slots/shop/1
http://localhost:5302/mcp?part=D:%5Cslots%5Cshop%5C1&part=D:/slots/billing/3
claude mcp add --transport http domra "http://localhost:5302/mcp?part=D:/slots/shop/1"
```

With the first URL an agent sees the `shop` slot 1 and the base checkouts of every other repository (`billing` included); the `shop` main checkout and `shop` slots 2 and 3 are invisible. The second URL has two parts of two different repositories (`shop` slot 1, `billing` slot 3, each from its own main checkout): it replaces the `shop` and `billing` base checkouts by those two slots, and its `Index:` counts cover exactly the visible solutions. Implementation: `src/server/view.ts` (`Slots`, `openView`), `WorkspaceManager.restrict` and `StoreQueries.restrict`.

## Pager

`src/server/pager.ts`. In memory, capacity 128 results, TTL 30 minutes; on store, expired entries are evicted first, then the oldest. A cursor is 10 lowercase hex characters. `appendPage(lines, limit, label)` prints the first `max(1, limit)` lines and, when lines remain, `  ... N more (next_page cursor=...)`. `next_page` prints `Continued: {label}` and the following page (a new cursor when more remain; the old cursor stays valid). An unknown or expired cursor answers `Unknown or expired cursor. Cursors live in memory for 30 minutes; re-run the original query.` The clock and random source are injectable for tests.

## Call log

`src/server/callLog.ts`. Every `tools/call` (also of an unknown tool) writes one line through the `warn` logger, without the `domra: ` prefix:

```
INFO search_symbols pattern="UpgradeCase" limit=20 found=18 client="claude-code 2.1.311" caller="worker/sonnet/t1" part=- 3ms
```

- Tool name, then the arguments as `name=value` in the order received; with no arguments `found=` follows the name after one space.
- Values: strings quoted and cut to 120 characters; numbers and booleans raw; `null`; arrays and objects as JSON text cut to 120, not quoted. A cut appends `…` after the limit; values are cut first, escaped after. Quoting escapes `\`, `"`, CR and LF (`\\`, `\"`, `\r`, `\n`), so a line is always one line. Keys of `[A-Za-z0-9_]{1,120}` are written as is, any other key (also empty) is cut and quoted like a value.
- `found`: lines given to the pager over the call (`0` for an empty result); for `review_changes` the number of changed declarations (the `Total:` footer). `-` for `go_to_definition`, `get_symbol_info`, `next_page`, `status`, `reindex`, `load_solution`, `forget_solution` and unknown tools.
- `client`: `"name version"` from the `clientInfo` of `initialize`, `-` when absent or the name is blank. The server is stateless per request, so it keeps the clientInfo in a map keyed by the `mcp-session-id` header when a request carries one, else a single last-seen value set by every `initialize`. Domra issues no session ids today, so the last-seen value is the normal path (with several clients the value is that of the latest `initialize`).
- `caller`: the first `?caller=` query value, trimmed, cut to 100 characters, quoted; `-` when absent or blank. It changes no result.
- `part`: the `part` query values joined by `;`, quoted; `-` when none.
- The last field is the elapsed time as `Nms`.

A normal line starts with `INFO `. A call whose result has `isError` starts with `WARN ` and ends with ` error=<first line of the text, cut to 199 characters, not quoted>`. A call rejected by the argument filter also writes `WARN Rejected {tool} call with arguments [{keys}]: {problem}` before that line (keys formatted as above, newlines in the problem replaced by spaces). A failure of the log itself never fails the call; tool results are not changed.

## Helper script

```
node scripts/mcp-call.ts <tool> [key=value ...] [--json '{...}'] [--url http://127.0.0.1:5302/mcp]
```

`true`/`false` become booleans, integers become numbers, `--json` is merged last. It POSTs `tools/call`, prints `ERROR: {message}` and exits 1 on a JSON-RPC error, prints `TOOL ERROR:` on its own line before the text when `isError`, then every text content item.

```
node scripts/mcp-call.ts search_symbols pattern=UOC limit=10
node scripts/mcp-call.ts get_outline target=src/shapes.ts solution=single depth=1
```

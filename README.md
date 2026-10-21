# Domra

Persistent, cross-project TypeScript code intelligence for coding agents over MCP. Sibling of Balalaika (C#).

Domra keeps TypeScript solutions loaded in a long-running daemon and answers symbol queries from a content-addressed index.

## Requirements

- Node 24

## Commands

```
npm install
npm run build
npm test
npm start
```

## Connect from Claude Code

Start the daemon (`npm run build && npm start`; it listens on `127.0.0.1:5302`, see [Configuration](docs/config.md)), then:

```
claude mcp add --transport http domra http://localhost:5302/mcp
```

or put this in `.mcp.json`:

```json
{ "mcpServers": { "domra": { "type": "http", "url": "http://localhost:5302/mcp" } } }
```

The daemon keeps a SQLite index (`indexPath`, default `%LOCALAPPDATA%/domra/index.db`) current after every load and, with `warmUp` (default on), indexes the solutions that are not loaded at startup, so symbol queries still answer from the index (`Index {solution}` groups) for solutions that are not loaded. `reindex` refreshes it by hand.

A type declared in a shared package and consumed by other repositories through the published package (`node_modules/<name>/dist/*.d.ts`) has one identity everywhere: its docId is `{package name}/{module path}` with the package's source root (`rootDir`/`outDir`, the `types` directory, or `src`) stripped. `find_references`, `find_implementations` and `find_derived_types` therefore list its usages in every loaded consumer solution live and in the others from the index, and `go_to_definition` on the `.d.ts` declaration jumps to the package's source when the index knows it (a `Source:` line when that solution is not loaded). See [Index](docs/index.md#identity-docid).

`get_call_graph` (CLI `callgraph`) lists one level of callers and callees of a function, method, constructor, accessor or class from the loaded solutions. See [Call graph](docs/workspace.md#call-graph).

`review_changes` (CLI `review`) compares the working tree of a loaded solution with the merge base of a git ref: changed files, changed declarations (`+`, `-`, `~ signature`, `~ header`, `~ body`) with reference, caller and implementation counts, and compiler diagnostics on the changed files. See [Change review](docs/workspace.md#change-review).

The index also records which package versions each project consumes; reference and implementation groups of a consumer on a version other than the source's carry a `[package 1.0.0, source is 1.1.0]` tag, and the `package_drift` tool (CLI: `drift`) lists all drift.

Changes on disk are picked up automatically (edited, added and deleted source files, tsconfig/package changes, branch switches); set `DOMRA_WATCH=false` to disable. See [Watcher](docs/watcher.md).

Call a tool by hand with `node scripts/mcp-call.ts status` (see [Server](docs/server.md)).

## Post-edit diagnostics hook

`scripts/post-edit-diagnostics.ts` is a Claude Code PostToolUse hook: after an edit of a `.ts/.tsx/.mts/.cts` file it calls `get_diagnostics` (errors only) and, if the file has errors, hands them back to Claude. It stays silent otherwise, and when the server is unreachable. Add this to `.claude/settings.json`:

```json
{"hooks":{"PostToolUse":[{"matcher":"Edit|Write|MultiEdit","hooks":[{"type":"command","command":"node C:/path/to/domra/scripts/post-edit-diagnostics.ts","timeout":45}]}]}}
```

`DOMRA_URL` overrides the endpoint (default `http://localhost:5302/mcp`).

## Documentation

- [Design](docs/design.md): architecture and the four layers
- [Configuration](docs/config.md): config files, keys and environment variables
- [Server](docs/server.md): MCP protocol subset, tools, Origin check, parts and slots
- [Workspace](docs/workspace.md): live layer, symbol specs, queries, references, call graph, change review
- [Index](docs/index.md): SQLite index, docIds, package identity and drift
- [Watcher](docs/watcher.md): file-change detection and invalidation
- [CLI](docs/cli.md): index-only CLI commands

## License

[MIT](LICENSE)

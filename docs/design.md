# Domra design

Domra is "Balalaika for TypeScript": a persistent code-intelligence daemon for coding agents over MCP. It mirrors Balalaika's four layers (C#, Roslyn).

## Layers

| Layer | Directory | Responsibility | May import |
|---|---|---|---|
| index | `src/index/` | SQLite index through `node:sqlite` (no native dependencies): content-addressed documents, declarations, references, relations. Files: `store.ts` + `storeQueries.ts` (`IndexStore`), `types.ts`, `docId.ts`, `hash.ts`, `paths.ts`, `ranker.ts` (symbol ranker), `projectKinds.ts`. See [index.md](index.md). **Must never import the `typescript` package.** | nothing from other layers |
| workspace | `src/workspace/` | Discover tsconfig "solutions", load projects through the TypeScript compiler API, resolve symbol specs, run queries, page results, print text. | index |
| watcher | `src/watcher/` | File watching with debounce; applies changes to workspace and index. See [watcher.md](watcher.md). | workspace, index |
| server | `src/server/` | HTTP MCP endpoint (`/mcp`, `/health`), tool declarations only (delegate to workspace), startup/indexing host. Files: `server.ts` (http + JSON-RPC), `tools.ts` (schemas + handlers), `select.ts` (solution selection), `arguments.ts` (argument filter), `pager.ts` (result paging), `status.ts`, `index.ts` (entry). See [server.md](server.md). | workspace, watcher, index |
| cli | `src/cli/` | Command-line entry for developers; may import workspace, index. Never `node:http`, watcher or server. | workspace, index |

## Dependency rule

- `index` imports no other layer.
- `workspace` never imports `watcher`.
- `cli` imports `workspace` and `index` only (no `watcher`, `server` or `node:http`).
- `server` is the only layer that may import all the others.

`test/layers.test.ts` enforces the `typescript` ban in `index` and the `workspace` → `watcher` ban.

## Why not per-session servers

Domra runs as one daemon per machine rather than one server per agent session. Loaded solutions stay in memory across sessions, so the expensive compiler-API load is paid once. The index is content-addressed, so identical documents are shared between solutions and survive restarts. Code that is not currently loaded is still answered from the index.

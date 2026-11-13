# Changelog

## Unreleased

### Added
- A `Stalls:` line in `status` and a `WARN` log line when the event loop of the daemon was blocked for 3 s or more, with the tool calls and jobs that ran.
- Separate log lines for the load time and the index time of each solution.

### Changed
- `get_outline` of a file prints only the property count of an interface or type literal with more than 8 properties (`  N properties omitted`, and the count in the footer); a type target still lists them all.

### Fixed
- A solution discovered by the running daemon (a new tsconfig, for example in a fresh worktree) is indexed in the background and gets its head, instead of staying `registered  head -`.
- A solution whose tsconfig vanished (a removed worktree) is forgotten instead of reloaded or loaded as an empty solution.
- A solution whose project files were written while it was loading is loaded once more, so a half-written file no longer leaves a broken program.

## 0.2.0 - 2026-11-01

Feature parity with balalaika.

### Added
- One log line per tool call, with arguments, found count, client, caller, part and elapsed time.
- A daily rolling structured log file with retention (`logDirectory`, `logRetainedDays`).
- Re-extraction of dependent projects after a declared-surface change (`reextractDependents`).
- Status fields, capability probes and tool annotations.
- Idle eviction of loaded solutions (`idleEvictionMinutes`).
- An optional `solution` argument for `reindex`.
- Watching of the current branch's ref.

### Changed
- `forget_solution` refuses an ambiguous hint, and exact names match case-insensitively.
- A watcher overflow reconciles only the root that overflowed.

### Fixed
- A recreated worktree gets its HEAD watched again.

## 0.1.0 - 2026-10-21

### Added
- A TypeScript MCP server that keeps solutions loaded in a daemon, with live and indexed symbol queries.
- Find references, implementations and derived types across repositories, through the published package that carries a shared type.
- Go to definition, from a package's `.d.ts` declaration to its source.
- Symbol info, members, outlines, call graph and symbol search.
- Compiler diagnostics without a build, and a post-edit diagnostics hook.
- Change review against a git ref, and a report of package version drift.
- A content-addressed SQLite index with warm-up, kept current by a file watcher.
- A command-line interface for the same queries.

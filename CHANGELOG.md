# Changelog

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

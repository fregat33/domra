# CLI additions

The CLI (`scripts/domra-cli.ts`, `src/cli/cli.ts`) is described in `docs/workspace.md` (query commands) and `docs/index.md` (`index`, `index-search`, `index-status`). This file lists commands that read only the index.

## `drift [--db <path>] [--limit n]`

`node scripts/domra-cli.ts drift [--db <path>] [--limit n]` prints the text of the `package_drift` tool (`docs/server.md`) from the index: for every package whose source project declares a `version`, the consumer projects (from `node_modules`) on another version, `--limit` consumer lines per package (default 50), then the `Total:` line. Without drift it prints the "No package version drift" sentence. No root is needed and nothing is loaded; only solutions indexed at least once are compared. `--db` defaults to `defaultIndexPath()`. Exit code 0; a non-positive `--limit` is a usage error (2).

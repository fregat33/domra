# Watcher

`src/watcher/` notices file changes under the configured `roots` and applies them to the loaded solutions and the index without any tool call. It imports `workspace` and `index`; the server owns it. Disable it with `watch: false` (`DOMRA_WATCH=false`).

Files: `classifier.ts` (`classifyChange`), `debounce.ts` (`ChangeDebouncer`), `pending.ts` (`PendingRefreshes`), `watcher.ts` (`RepoWatcher`), `apply.ts` (`applyChanges`).

## Classifier

`classifyChange(path, ignoredFolders)` normalises backslashes and decides in this order:

| Rule | Kind |
| --- | --- |
| a `.git` segment and the rest after it is exactly `HEAD` | `git` |
| a `.git` segment otherwise | `ignored` |
| a segment equal (case-insensitive) to an `ignoredFolders` entry, `.idea` or `.vs` | `ignored` |
| extension `.ts .tsx .mts .cts .js .jsx` | `source` |
| `tsconfig*.json`, `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` | `project` |
| anything else | `ignored` |

## Debounce

`RepoWatcher` watches every existing root with `fs.watch(root, { recursive: true })`, drops `ignored` paths, and feeds the rest to a `ChangeDebouncer`. Before classification an event whose path is an existing directory outside ignored folders goes into the batch's `directories` set instead. Every `add` restarts the quiet timer (`max(100, debounceMs)`); the max-wait timer (`max(3000, 6 * quiet)`) starts at the first `add` of a batch, so a never-quiet stream still flushes. A watcher `error` marks the batch as overflowed, closes the root's watcher and re-creates it once.

**Linked worktrees.** In a linked worktree (or submodule) `<dir>/.git` is a file `gitdir: <path>` and the real `HEAD` lies outside the watched roots. The server calls `RepoWatcher.syncWorktrees` with the directories of the registered solutions (at start, after `load_solution`/`forget_solution`, after a `changes` job that discovered or forgot solutions or overflowed, and after the discovery sweep). For every solution whose repository root (`GitProvider.repoRoot`) holds a `.git` file the watcher watches the git dir (non-recursive, so the atomic replace of `HEAD` is seen) and reports a change of `HEAD` as the path `<repo root>/.git/HEAD`, which classifies as `git`. One watch exists per git dir, shared by the solutions of that worktree, and is closed when no registered solution needs it. Normal repositories are covered by the recursive root watch as before.

## Batch processing (`applyChanges`)

Runs as the `changes` job. Paths are classified again, then:

0. Before anything else, every registered solution whose tsconfig no longer exists is forgotten (`forgetMissing`): unloaded, unregistered, its pending refresh dropped, its `project` rows deleted from the index (children cascade, `symbol_fts` follows by trigger). This covers overflow and git batches too. The same check runs as the `discovery sweep` job every `discoverySweepSeconds` (a solution registered by `load_solution` outside the roots is swept the same way).
1. Appearance, in every batch (git and overflow included), before the reconcile:
   - an `overflowed` batch re-runs `discoverSolutions(roots, ignoredFolders)` and registers every result that is not registered yet (and not referenced by a registered solution);
   - each entry of `directories` (existing directories reported by `fs.watch` outside ignored folders, i.e. a folder moved or renamed into a root, which raises only a directory event) that lies under a root within the depth rule and not inside a registered solution is scanned with `discoverSolutions([dir], ignoredFolders)`; results within the depth rule are registered;
   - a `project` path named exactly `tsconfig.json` that exists, lies under a root at most 6 folders deep with no `ignoredFolders` segment, has no registered owner or an owner in a parent directory (not itself), and is neither listed in the `projects` of a registered solution nor a direct `references` entry of one is registered with `describeSolution`.

   A newly registered solution is not loaded and not warmed, and the batch does not touch its pending refresh. A solution forgotten with `forget_solution` is registered again by such an event for its tsconfig, and by a re-discovery on overflow (a restart-like rescan).
2. An `overflowed` batch counts as a git change and additionally touches every registered, unloaded solution.
3. Any `git` path (or overflow): every loaded solution is reconciled. For each tree entry in the index the file is `stat`ed: missing files are removed from the hosts, roots and index; files whose mtime or size differ are re-read and applied; then each project's tsconfig is re-parsed and listed files that are not yet roots are added. Unloaded registered solutions are touched as pending. The rest of the batch is covered by the reconcile. Afterwards every loaded solution whose tsconfigs (its own and its projects'), `package.json` or lockfiles (in the solution and project directories) differ from the mtime+size recorded at load (`LoadedSolution.projectStamps`, `projectFilesChanged`) is reloaded and re-indexed as in rule 4; the others are not. A `git` path (overflow excluded) additionally enqueues a `refresh <name>` job immediately, without debounce delay, for every registered unloaded solution whose directory is inside the changed repository root (`<repo>/.git/HEAD`, also the synthetic worktree event); that job records HEAD even when the index is fresh. Other unloaded solutions keep the pending behaviour.
4. Other `project` paths: the solution with the longest `dir` prefix is reloaded (once per batch) and re-indexed; an unloaded one is touched as pending; no solution means ignore.
5. `source` paths grouped by owning solution (longest `dir` prefix): unloaded solutions are touched as pending. In a loaded one a missing file is set to `null` in its hosts, dropped from the roots and removed from the index; an existing file is read (retrying `EBUSY`/`EPERM` up to 5 times with `50 * (n + 1)` ms back-off), added as a root of the project with the longest `dir` prefix when no project owns it and that project's tsconfig lists it, and pushed into the hosts when its text differs. Changed documents are then re-extracted with `indexDocuments`.

## Branch refs and worktrees

The classifier only reports `<root>/.git/HEAD` under `.git`, so every extra watcher below reports that synthetic path for its checkout root. `RepoWatcher.syncWorktrees(dirs, repoRootOf)` keeps up to three non-recursive watchers per wanted repository root (`resolveGitHead(root)` in `gitHead.ts` finds the paths):

- `<common>` is `<root>/.git` for a normal repository; for a linked worktree it is `<gitdir>/commondir` resolved against `<gitdir>`, falling back to `<gitdir>/../..`.
- HEAD: only for linked worktrees (a normal root's `.git/HEAD` is already seen by the recursive root watcher); watches `<gitdir>` filtered on `HEAD`.
- Ref: when HEAD is `ref: refs/heads/<branch>`, the loose ref `<common>/refs/heads/<branch>`. If its directory does not exist yet (branch `a/b`, or a branch only in `packed-refs`), the nearest existing directory at or below `<common>/refs/heads` is watched, filtered on the next path segment.
- Packed refs: `<common>/packed-refs` (watched through `<common>`, filtered on the name), for a symbolic HEAD.
- A detached HEAD has no ref or packed-refs watcher. Names are matched in the callback; a null file name counts as a match.
- Every event of these watchers is added as `<root>/.git/HEAD` and re-resolves the targets: a branch switch re-points them, unchanged targets keep their watchers. Two checkouts on one common dir have their own watchers and report their own roots.
- A root that is no longer wanted gets its watchers closed; `close()` closes all. Watcher errors only warn; the failed watcher is dropped and re-created by the next `syncWorktrees`.
- `syncWatch` (which calls `syncWorktrees`) runs after every batch with a `git` path, a non-empty `directories` or an overflow, and after discovery or forgetting. A same-path recreate of a worktree may raise no `error`, so `syncWorktrees` also compares the git dir's identity (`ino` + `birthtimeMs`) stored per root and replaces the watchers when it differs.
- Test helpers: `worktreeHeads` (git dirs with a HEAD watcher) and `refWatchTargets` (sorted `dir/filter` strings).

## Unloaded solutions

`PendingRefreshes` records `first` and `last` change times per solution. A timer (every `clamp(quiet / 4, 1000, 15000)` ms) enqueues `refresh {name}` for solutions with `now - last >= unloadedRefreshSeconds` or `now - first >= unloadedRefreshMaxWaitSeconds` (0 disables a rule). The job skips a solution that was forgotten or loaded meanwhile, or that is `isFresh`; otherwise it loads, indexes and unloads it.

## Status and log lines

```
Watcher: 1 roots, 3 batches applied, last batch 12:30:05 2 files, 0 buffered
Unloaded refresh: demo (1 files, last change 4s ago)
Unloaded refresh: none pending
```

The number of buffered paths is what the debouncer holds and has not yet turned into a `changes` job; `status` also prints `Ready: yes` or `Ready: no ({N} jobs, {M} buffered)` after these lines. `Watcher: off` replaces both when the watcher is off. Log lines (stderr): `domra: Watching {root}`, `domra: watch root missing: {root}`, `domra: watcher error on {root}: {message}`, `domra: Git HEAD changed; reconciling {N} loaded solutions`, `domra: Reconciled {name}: {U} updated, {A} added, {R} removed, {E} extracted in {ms}ms`, `domra: {name}: project file changed, reloaded in {ms}ms`, `domra: {name}: applied {N} file changes, {M} documents re-extracted`, `domra: refreshed {name} in {ms}ms`, `domra: discovered {name} ({path})`, `domra: forgot {name} ({path}): tsconfig is gone, {N} projects removed from the index`.

## Known limits

- Dependents of a changed declared surface are not re-extracted (follow-up); only the changed documents are.
- `fileCount` and `sourceFiles` counters of a loaded solution are not updated when root files are added or removed; they refresh on reload.
- `fs.watch` with `recursive: true` is native on Windows and macOS; on Linux it depends on the Node version (older versions throw or do not support it). Where it fails, `domra: watcher error ...` is logged and no events arrive.
- A tsconfig that appears while the server runs is found through a watcher event for a file named exactly `tsconfig.json`, a directory event (moved or renamed folders; directories inside a registered solution are not scanned) or the re-discovery on overflow. Disappearance is also found by the periodic sweep.

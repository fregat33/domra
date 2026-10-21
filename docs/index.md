# Index layer

The persistent half of Domra: a content-addressed SQLite index of declarations, references and heritage relations per document. It answers queries without loading anything and survives restarts and branch switches. The server wires it in (`reindex`, status lines, warm-up, index fallback in queries): see `docs/server.md`.

| Module | Responsibility |
|---|---|
| `src/index/store.ts` | `IndexStore`: open/schema, FTS5 detection, write API, `gc`, `stats` |
| `src/index/storeQueries.ts` | Read API: `findSymbolsByDocId`, `searchSymbols`, `findReferences`, `countReferencesBySolution`, `findRelations`, `getFileSymbols`, `readExtraction` |
| `src/index/types.ts` | `Extraction`, row and hit types |
| `src/index/docId.ts` | `parseDocId`, `scopeOf`, `makeDocId`, `stripExtension` |
| `src/index/hash.ts` | `contentHash`, `surfaceHash`, `decodeText` |
| `src/index/paths.ts` | `defaultIndexPath()` |
| `src/workspace/extractor.ts` | `extractDocument`, `docIdOf`, `fileScope` (compiler API) |
| `src/workspace/packages.ts` | `packageOf`, `packageModulePath`: package identity of a file |
| `src/workspace/indexer.ts` | `indexSolution`, `indexDocuments`, `removeDocument`, `isFresh`, `isStale` |

`src/index/*` never imports `typescript` or another layer; SQL goes only through `node:sqlite` (`DatabaseSync`, no native dependencies). One `DatabaseSync` per store.

## Identity: docId

`docId = "{scope}#{fqName}"`, `scope = "{packageName}/{modulePath}"`:

- **Package** (`packageOf(path)` in `src/workspace/packages.ts`, cached per directory, package.json and tsconfig reads cached per directory): the nearest directory at or above the file whose `package.json` has a string `name`; under `node_modules` the walk stops at the `node_modules/<name>` (or `node_modules/@scope/<name>`) directory, falling back to those segments as the name. `packageName` is that `name`.
- **Source root**: the first rule that applies, each only when the file's path relative to the package directory starts with `{root}/` (a root of `""` never applies): (1) `dir/tsconfig.json` (`ts.readConfigFile`) `compilerOptions.rootDir`, else `compilerOptions.outDir`; (2) the directory part of the first string among package.json `types`, `typings`, `main`, `module` (`dist/index.d.ts` gives `dist`); (3) `src`; (4) otherwise `""`.
- `modulePath` (`packageModulePath`): the path relative to the package directory with `{sourceRoot}/` stripped, forward slashes, extension stripped (`.ts .tsx .mts .cts .js .jsx` and their `.d.` forms). So a package's source (`libpkg/src/orders.ts`, rootDir `src`) and its published declaration file in any consumer (`webapp/node_modules/acme-contracts/dist/orders.d.ts`, types under `dist`) both give `acme-contracts/orders`: **one docId per declaration across repositories**, which the cross-solution twins and `Index {solution}` groups rely on. A shared package that two solutions include gets the same docId in both as well.
- Without a package: `{projectKey}/{modulePath}` with the owning project's directory name and the path relative to the project directory. The owner is the project whose root files contain the file, else the project whose directory contains it, else the nearest directory upwards with a `package.json` or `tsconfig.json`.
- `fqName` is `fqNameOf` (constructors `Type.constructor`, parameter properties `Type.name`).

**Known limits**: identity follows the file layout, not the compiler's emit. A bundled single-file `dist/index.d.ts` yields `{name}/index#X` while the source is `{name}/{module}#X`, so the two do not match; neither do outputs whose layout differs from the source tree (a `rootDir`/`outDir` the published package does not mirror). Package versions are ignored: every installed version of a package shares the docIds.

Examples: `single-pkg/shapes#Circle.area`, `@mono/core/index#coreGreeting`, `shared-lib/lib#Gadget`, `acme-contracts/orders#OrderPlaced`, `refs-pkg/test/shapes.test#fixture` (outside the source root the path keeps its directory). Default-library files are never indexed and references to them are dropped. `parseDocId` splits at the first `#`: a `#private` member (`Circle.#secret`) keeps its `#` in the fqName, but a scope (module path) containing `#` is not supported, and docIds are not escaped.

The enclosing id of a reference is the docId of the nearest enclosing declaration (the `enclosingOf` stops of find_references), the literal `<top-level>` for top-level statements, and null inside an import/export statement.

**Limitation**: blobs are keyed by content, but docIds contain the module path. Two files with identical content in one project share a blob (and the docIds of the first path), and a renamed file with unchanged content keeps its old docIds until it is re-extracted (`force`).

## Schema (`SCHEMA_VERSION = 2`)

Pragmas: `journal_mode=WAL` (not for `:memory:`), `synchronous=NORMAL`, `foreign_keys=ON`. The schema is created when missing (every table is `CREATE ... IF NOT EXISTS`, so a file written at version 1 gains `package_ref` when it is opened; its projects are stamped 1, which forces one full re-extraction at the next `indexSolution`).

| Table | Columns |
|---|---|
| `project` | `id PK, path UNIQUE NOCASE` (tsconfig, forward slashes), `name, package_name, solution_path NOCASE, version, indexed_schema DEFAULT 0` |
| `blob` | `id PK, project_id → project CASCADE, content_hash, created_at, last_used_at, UNIQUE(project_id, content_hash)` |
| `symbol` | `id PK, blob_id → blob CASCADE, doc_id, kind, name, fq_name, signature, accessibility, containing_doc_id, line, col, end_line`; indexes `doc_id`, `blob_id`, `name NOCASE` |
| `symbol_fts` | `fts5(name, fq_name, content='symbol', content_rowid='id', tokenize='unicode61')` kept in sync by AFTER INSERT / AFTER DELETE triggers on `symbol` |
| `reference` | `id PK, blob_id → blob CASCADE, target_doc_id, kind, line, col, from_doc_id`; indexes `target_doc_id`, `blob_id` |
| `relation` | `id PK, blob_id → blob CASCADE, from_doc_id, to_doc_id, kind`; indexes `to_doc_id`, `blob_id` |
| `tree` | `project_id, path NOCASE, content_hash, mtime, size, seen_at, PK(project_id, path)`; index `(project_id, content_hash)` |
| `excluded_file` | `project_id, path NOCASE, PK(project_id, path)`: source files under the project directory that are not root files |

| `package_ref` | `project_id → project CASCADE, package_name NOCASE, version, PK(project_id, package_name)`; index `package_name`: the packages a project consumes from `node_modules` (several versions of one name are joined with `/`) |

FTS5 is feature-detected at open (`CREATE VIRTUAL TABLE ... USING fts5` in a try; `open(path, { fts: false })` skips it); `store.hasFts` tells. A database created without FTS gets the table and a `rebuild` the first time it is opened with FTS.

**Visibility**: every read joins `blob → tree ON (project_id, content_hash) → project`, so only documents that are current in some project's tree are visible. Switching a branch back to old content makes the old blob visible again without a write.

## Write API

`ensureProject({ path, name, packageName, solutionPath, version })` (upsert on path, returns id), `stampProject(id, schema)`, `getProject(path)`, `getTree(projectId)`, `getTreeEntry`, `setTreeEntry(projectId, path, hash, mtime, size, now?)` (touches the blob's `last_used_at`), `removeTreeEntries(projectId, keepPaths)` (ignoring case; returns the count), `removeTreeEntry`, `hasBlob`, `writeBlob(projectId, hash, extraction, { replace })` (an existing blob is kept unless `replace`, which deletes its rows first so the FTS delete trigger fires), `setExcludedFiles`, `gc(retentionMs, now)` (deletes blobs with `last_used_at < now − retention` that no tree row points to; symbol rows are deleted explicitly first), `transaction(fn)` (BEGIN/COMMIT, rollback on error; nested calls join).

## Read API

Every hit carries `document: { projectId, projectName, projectPath, solutionPath, path, contentHash }`.

- `findSymbolsByDocId(docId)`.
- `searchSymbols(pattern, kind | null, limit)`: `parseQuery`; candidates are the union of (FTS `name : "{name}"*` when `hasFts`), (`name LIKE %name%`), (`name GLOB` over the pattern humps, `humpStarts(name, true)`, ≥ 2 humps, every letter as `[Xx]` and `* ? [` bracketed), each with `LIMIT max(limit*4, 300)`, the optional `kind = ?` and, for every container term, `fq_name LIKE %c% OR path LIKE %c%`; pre-cut order `kindRank`, `length(name)`, `fq_name`. Then in memory: `match(name)` must not be null, `containersMatch` on fqName and the path relative to the solution directory, `isTest = isTestProject(projectName, relative path)`, sort with `compareRecords`, dedupe by solution path and docId (a shared package shows up once per solution), take `limit`. (Container terms are matched against paths too, so FTS is queried for the name term only.)
- `findReferences(targetDocId, limit, { kinds?, scope? })` ordered by path (NOCASE), line, col; `scope` `production`/`tests` uses `isTestProject(projectName, path relative to the solution dir)`. `countReferencesBySolution(targetDocId, filter)` → `Map<solutionPath, { total, kept }>`.
- `findRelations(toDocId, kinds, limit)` with the declaring symbol row of `fromDocId` when present.
- `getFileSymbols(path)` ordered by line, col (first project only when several track the file).
- Packages: `setProjectPackages(projectId, [{ packageName, version }])` replaces the project's set in one transaction; `getPackageSources(name)` are the projects whose own `package.json` has that name; `getPackageConsumers(name)` → `{ projectId, projectPath, projectName, solutionPath, version }` (name ignoring case); `findPackageDrift()` → `{ packageName, sourceVersion, sourceProjectPath, sourceSolutionPath, consumerProjectPath, consumerProjectName, consumerSolutionPath, consumedVersion }` for every consumer whose version differs from a source project's non-null `version` (the source itself excluded), ordered by package name, consumer solution path, consumer project path.
- `readExtraction(projectId, hash)`, `stats()` (row counts of every table: `projects, trackedFiles, blobs, symbols, references, relations`).

## Extraction (`extractDocument(project, sourceFile, checker, { solution?, program? })`)

- **Symbols**: every `fileNameIndex` node except aliases, plus constructors and constructor parameter properties, in source order, deduped by docId (overloads collapse to the first). `kind` = `kindOf` (parameter properties `field`), `name`, `fqName`, `signature` (re-implements the `symbolToString`/`signatureToString` text of `toResolved` in `extractor.ts`), `accessibility` (class members `accessibilityOf`; top-level and namespace declarations `export`/`private` by the outline rule, script files and ambient namespaces `export`; other members `public`), `containingDocId`, 1-based `line`/`col` of the name, `endLine` of the declaration.
- **References**: every `Identifier`/`PrivateIdentifier` that is not the name of a declaration (import/export specifiers are not declarations here, so they give `import` references); `getSymbolAtLocation` → unalias → first declaration; skipped when it is a parameter (parameter properties are kept), a local, a type parameter, a source file or in a default library. `kind`/node from `classifyReference`, `fromDocId` from `enclosingStopOf`; deduped on `(targetDocId, line, col)`.
- **Relations**: class `extends` → `inherits`, `implements` → `implements`, interface `extends` → `inherits`. Members of a class (methods, properties, accessors, parameter properties; `#private` names skipped): `overrides` to the same-named member of every class in the transitive `extends` chain, `implements` to the same-named member of every interface implemented by the class or a base class (and the interfaces they extend). This matches what find_implementations lists live. Default-library targets are dropped.

## Hashing

`contentHash(text)` = SHA-256 of the UTF-8 text, lowercase hex; a leading BOM is ignored (`decodeText(buffer)` strips it too). `surfaceHash(extraction)` = SHA-256 over the sorted lines `S\t{docId}\t{signature}\t{accessibility}` (non-private symbols) and `R\t{from}\t{to}\t{kind}` (relations): positions and references do not change the surface.

## Indexing flow

`indexSolution(store, solution, { force, now, ignoredFolders })` → `{ projectsVisited, documentsVisited, documentsExtracted, documentsReused, treeEntriesRemoved, elapsedMs }`; one transaction per project:

1. `ensureProject` (package name and version from `package.json`); a stamp `0 < indexed_schema < SCHEMA_VERSION` forces re-extraction.
2. `setExcludedFiles`: `.ts .tsx .mts .cts` files under the project directory that are not root files (ignored folders and nested directories with their own `tsconfig.json` skipped).
3. Documents: the project's root files plus program files that no project of the solution owns (the first project reaching them takes them); never default libs or `node_modules`. A file that cannot be `stat`ed is skipped (and so removed from the tree).
4. Fast path: tree entry with the same mtime (ms, truncated) and size and its blob present → reused. Else hash the host snapshot text; extract and `writeBlob({ replace: force })` when forced or the blob is missing; `setTreeEntry`.
5. `removeTreeEntries(keep)`, `setProjectPackages`: for every program source file under `node_modules` whose `packageOf` has a `version`, the package name and version (distinct versions of one name sorted and joined with `/`); `indexDocuments` leaves `package_ref` alone (a project-file change reloads and reindexes). `stampProject(SCHEMA_VERSION)`.

`indexDocuments(store, solution, paths)` re-indexes documents from the current programs (call `host.setFile` first), extracts only missing blobs, sets the tree entries and returns `{ changedProjects, documentsExtracted }`, the projects whose `surfaceHash` changed (a new document counts as a change). `removeDocument(store, solution, path)` drops the tree entry from every project of the solution.

## Freshness and staleness

- `isFresh(store, discoveredSolution, { ignoredFolders })` without loading: every project tsconfig has a project row stamped `SCHEMA_VERSION`, every tree entry exists with the same mtime and size, and every file of `ts.parseJsonConfigFileContent` (no program) is tracked.
- `isStale(document, cache?)`: re-reads the file and compares `contentHash` (read error → stale); results are cached per `path + hash` in the optional map.

## CLI

- `index <root> [--force] [--db <path>] [--solution <hint>]`: loads the solutions, runs `indexSolution` for each and prints `{name}: {projects} projects, {visited} documents, {extracted} extracted, {reused} reused, {removed} removed, {elapsedMs} ms`, then `Index: {dbPath}  P projects, F tracked files, B blobs, S symbols, R references, L relations`.
- `index-search <root> <pattern> [--db] [--kind] [--limit n (30)]`: no loading; `store.searchSymbols`, hits whose solution lies under `<root>`, grouped by solution path (sorted) as `Index {solution dir name} (N):` and `  {kind} {fqName}  {path}:{line}:{col}`; no hits print the `No symbols match` text.
- `index-status [--db]`: the `Index:` line.
- `drift [--db] [--limit n (50)]`: the `package_drift` text of the server (see `docs/server.md`) from the index; no root, nothing is loaded.

The default database is `defaultIndexPath()` = `${LOCALAPPDATA ?? homedir}/domra/index.db`; tests always pass `--db` or use `:memory:`.

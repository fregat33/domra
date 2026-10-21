import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoreQueries } from "./storeQueries.ts";
import type { DriftRow, Extraction, IndexStats, PackageConsumer, PackageRef, ProjectInfo, ProjectRow, TreeEntry } from "./types.ts";

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE COLLATE NOCASE,
  name TEXT,
  package_name TEXT,
  solution_path TEXT COLLATE NOCASE,
  version TEXT,
  indexed_schema INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS blob (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES project(id) ON DELETE CASCADE,
  content_hash TEXT,
  created_at INTEGER,
  last_used_at INTEGER,
  UNIQUE(project_id, content_hash)
);
CREATE TABLE IF NOT EXISTS symbol (
  id INTEGER PRIMARY KEY,
  blob_id INTEGER REFERENCES blob(id) ON DELETE CASCADE,
  doc_id TEXT, kind TEXT, name TEXT, fq_name TEXT, signature TEXT, accessibility TEXT,
  containing_doc_id TEXT, line INTEGER, col INTEGER, end_line INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS symbol_doc_id ON symbol(doc_id);
CREATE INDEX IF NOT EXISTS symbol_blob_id ON symbol(blob_id);
CREATE INDEX IF NOT EXISTS symbol_name ON symbol(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS reference (
  id INTEGER PRIMARY KEY,
  blob_id INTEGER REFERENCES blob(id) ON DELETE CASCADE,
  target_doc_id TEXT, kind TEXT, line INTEGER, col INTEGER, from_doc_id TEXT
);
CREATE INDEX IF NOT EXISTS reference_target ON reference(target_doc_id);
CREATE INDEX IF NOT EXISTS reference_blob_id ON reference(blob_id);
CREATE TABLE IF NOT EXISTS relation (
  id INTEGER PRIMARY KEY,
  blob_id INTEGER REFERENCES blob(id) ON DELETE CASCADE,
  from_doc_id TEXT, to_doc_id TEXT, kind TEXT
);
CREATE INDEX IF NOT EXISTS relation_to ON relation(to_doc_id);
CREATE INDEX IF NOT EXISTS relation_blob_id ON relation(blob_id);
CREATE TABLE IF NOT EXISTS tree (
  project_id INTEGER REFERENCES project(id) ON DELETE CASCADE,
  path TEXT COLLATE NOCASE,
  content_hash TEXT, mtime INTEGER, size INTEGER, seen_at INTEGER,
  PRIMARY KEY(project_id, path)
);
CREATE INDEX IF NOT EXISTS tree_hash ON tree(project_id, content_hash);
CREATE TABLE IF NOT EXISTS excluded_file (
  project_id INTEGER REFERENCES project(id) ON DELETE CASCADE,
  path TEXT COLLATE NOCASE,
  PRIMARY KEY(project_id, path)
);
CREATE TABLE IF NOT EXISTS package_ref (
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  package_name TEXT NOT NULL COLLATE NOCASE,
  version TEXT NOT NULL,
  PRIMARY KEY(project_id, package_name)
);
CREATE INDEX IF NOT EXISTS package_ref_name ON package_ref(package_name);
`;

const FTS = `
CREATE VIRTUAL TABLE symbol_fts USING fts5(name, fq_name, content='symbol', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS symbol_fts_insert AFTER INSERT ON symbol BEGIN
  INSERT INTO symbol_fts(rowid, name, fq_name) VALUES (new.id, new.name, new.fq_name);
END;
CREATE TRIGGER IF NOT EXISTS symbol_fts_delete AFTER DELETE ON symbol BEGIN
  INSERT INTO symbol_fts(symbol_fts, rowid, name, fq_name) VALUES ('delete', old.id, old.name, old.fq_name);
END;
INSERT INTO symbol_fts(symbol_fts) VALUES ('rebuild');
`;

type Row = Record<string, unknown>;

export type OpenOptions = { fts?: boolean };

/**
 * Content-addressed SQLite index: one blob per (project, content hash) holding the symbols,
 * references and relations of a document; the `tree` table says which blob is current for each
 * path, and every read joins through it. One `DatabaseSync` per store.
 */
export class IndexStore extends StoreQueries {
  readonly path: string;

  private constructor(db: DatabaseSync, path: string, hasFts: boolean) {
    super(db, hasFts);
    this.path = path;
  }

  static open(path: string, options: OpenOptions = {}): IndexStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    let hasFts = false;
    if (options.fts ?? true) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'symbol_fts'").get() !== undefined;
      try {
        if (!exists) db.exec(`BEGIN; ${FTS} COMMIT;`);
        hasFts = true;
      } catch {
        if (db.isTransaction) db.exec("ROLLBACK");
      }
    }
    return new IndexStore(db, path, hasFts);
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` inside BEGIN/COMMIT; rolls back and rethrows on error. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- projects ----------------------------------------------------------------------------

  ensureProject(info: ProjectInfo): number {
    const row = this.db
      .prepare(
        `INSERT INTO project(path, name, package_name, solution_path, version) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name, package_name = excluded.package_name,
           solution_path = excluded.solution_path, version = excluded.version
         RETURNING id`,
      )
      .get(info.path, info.name, info.packageName, info.solutionPath, info.version) as Row;
    return Number(row["id"]);
  }

  /** Delete every project owned by the solution tsconfig (children cascade, `symbol_fts` follows by trigger); returns the project count. */
  deleteSolution(solutionPath: string): number {
    return this.transaction(() => {
      const result = this.db.prepare("DELETE FROM project WHERE solution_path = ?").run(solutionPath);
      return Number(result.changes);
    });
  }

  stampProject(id: number, schema: number): void {
    this.db.prepare("UPDATE project SET indexed_schema = ? WHERE id = ?").run(schema, id);
  }

  getProject(path: string): ProjectRow | undefined {
    const row = this.db.prepare("SELECT * FROM project WHERE path = ?").get(path) as Row | undefined;
    if (!row) return undefined;
    return {
      id: Number(row["id"]),
      path: String(row["path"]),
      name: String(row["name"]),
      packageName: (row["package_name"] as string | null) ?? null,
      solutionPath: String(row["solution_path"]),
      version: (row["version"] as string | null) ?? null,
      indexedSchema: Number(row["indexed_schema"] ?? 0),
    };
  }

  // ---- package refs ------------------------------------------------------------------------

  /** Replace the set of packages the project consumes from node_modules. */
  setProjectPackages(projectId: number, refs: readonly PackageRef[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM package_ref WHERE project_id = ?").run(projectId);
      const insert = this.db.prepare("INSERT OR REPLACE INTO package_ref(project_id, package_name, version) VALUES (?, ?, ?)");
      for (const ref of refs) insert.run(projectId, ref.packageName, ref.version);
    });
  }

  /** Projects whose own package.json has this name (the sources of the package), ignoring case. */
  getPackageSources(packageName: string): ProjectRow[] {
    const open = this.visibleIn("solution_path");
    const rows = this.db.prepare(`SELECT path FROM project WHERE package_name = ? AND ${open.sql} ORDER BY path`).all(packageName, ...open.params) as Row[];
    return rows.map((r) => this.getProject(String(r["path"]))!);
  }

  getPackageConsumers(packageName: string): PackageConsumer[] {
    const open = this.visibleIn("p.solution_path");
    const rows = this.db
      .prepare(
        `SELECT p.id, p.path, p.name, p.solution_path, r.version FROM package_ref r JOIN project p ON p.id = r.project_id
         WHERE r.package_name = ? AND ${open.sql} ORDER BY p.solution_path, p.path`,
      )
      .all(packageName, ...open.params) as Row[];
    return rows.map((r) => ({
      projectId: Number(r["id"]), projectPath: String(r["path"]), projectName: String(r["name"]),
      solutionPath: String(r["solution_path"]), version: String(r["version"]),
    }));
  }

  /** Consumers whose version differs from the version a source project (same package name, not the consumer) declares. */
  findPackageDrift(): DriftRow[] {
    const consumers = this.visibleIn("c.solution_path");
    const sources = this.visibleIn("s.solution_path");
    const rows = this.db
      .prepare(
        `SELECT s.package_name AS pkg, s.version AS source_version, s.path AS source_path, s.solution_path AS source_solution,
                c.path AS consumer_path, c.name AS consumer_name, c.solution_path AS consumer_solution, r.version AS consumed
         FROM package_ref r
         JOIN project c ON c.id = r.project_id
         JOIN project s ON s.package_name = r.package_name AND s.version IS NOT NULL AND s.id <> r.project_id AND s.version <> r.version
         WHERE ${consumers.sql} AND ${sources.sql}
         ORDER BY s.package_name COLLATE NOCASE, c.solution_path, c.path`,
      )
      .all(...consumers.params, ...sources.params) as Row[];
    return rows.map((r) => ({
      packageName: String(r["pkg"]), sourceVersion: String(r["source_version"]), sourceProjectPath: String(r["source_path"]),
      sourceSolutionPath: String(r["source_solution"]), consumerProjectPath: String(r["consumer_path"]),
      consumerProjectName: String(r["consumer_name"]), consumerSolutionPath: String(r["consumer_solution"]),
      consumedVersion: String(r["consumed"]),
    }));
  }

  // ---- tree --------------------------------------------------------------------------------

  getTree(projectId: number): Map<string, TreeEntry> {
    const rows = this.db.prepare("SELECT path, content_hash, mtime, size FROM tree WHERE project_id = ?").all(projectId) as Row[];
    return new Map(rows.map((r) => [String(r["path"]), {
      contentHash: String(r["content_hash"]), mtime: Number(r["mtime"]), size: Number(r["size"]),
    }]));
  }

  getTreeEntry(projectId: number, path: string): TreeEntry | undefined {
    const r = this.db.prepare("SELECT content_hash, mtime, size FROM tree WHERE project_id = ? AND path = ?").get(projectId, path) as Row | undefined;
    return r ? { contentHash: String(r["content_hash"]), mtime: Number(r["mtime"]), size: Number(r["size"]) } : undefined;
  }

  /** Make `contentHash` the current content of `path`; touches the blob's `last_used_at`. */
  setTreeEntry(projectId: number, path: string, hash: string, mtime: number, size: number, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO tree(project_id, path, content_hash, mtime, size, seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, path) DO UPDATE SET content_hash = excluded.content_hash, mtime = excluded.mtime,
           size = excluded.size, seen_at = excluded.seen_at`,
      )
      .run(projectId, path, hash, mtime, size, now);
    this.touchBlob(projectId, hash, now);
  }

  /** Remove every tree entry of the project whose path is not in `keepPaths` (ignoring case); returns the count. */
  removeTreeEntries(projectId: number, keepPaths: Iterable<string>, now = Date.now()): number {
    const keep = new Set([...keepPaths].map((p) => p.toLowerCase()));
    let removed = 0;
    for (const path of this.getTree(projectId).keys()) {
      if (keep.has(path.toLowerCase())) continue;
      this.removeTreeEntry(projectId, path, now);
      removed++;
    }
    return removed;
  }

  removeTreeEntry(projectId: number, path: string, now = Date.now()): void {
    const row = this.db.prepare("SELECT content_hash FROM tree WHERE project_id = ? AND path = ?").get(projectId, path) as Row | undefined;
    if (!row) return;
    this.db.prepare("DELETE FROM tree WHERE project_id = ? AND path = ?").run(projectId, path);
    this.touchBlob(projectId, String(row["content_hash"]), now);
  }

  private touchBlob(projectId: number, hash: string, now: number): void {
    this.db.prepare("UPDATE blob SET last_used_at = ? WHERE project_id = ? AND content_hash = ?").run(now, projectId, hash);
  }

  setExcludedFiles(projectId: number, paths: Iterable<string>): void {
    this.db.prepare("DELETE FROM excluded_file WHERE project_id = ?").run(projectId);
    const insert = this.db.prepare("INSERT OR IGNORE INTO excluded_file(project_id, path) VALUES (?, ?)");
    for (const path of paths) insert.run(projectId, path);
  }

  getExcludedFiles(projectId: number): string[] {
    const rows = this.db.prepare("SELECT path FROM excluded_file WHERE project_id = ? ORDER BY path").all(projectId) as Row[];
    return rows.map((r) => String(r["path"]));
  }

  // ---- blobs -------------------------------------------------------------------------------

  private blobId(projectId: number, hash: string): number | undefined {
    const row = this.db.prepare("SELECT id FROM blob WHERE project_id = ? AND content_hash = ?").get(projectId, hash) as Row | undefined;
    return row ? Number(row["id"]) : undefined;
  }

  hasBlob(projectId: number, hash: string): boolean {
    return this.blobId(projectId, hash) !== undefined;
  }

  private clearBlobRows(blobId: number): void {
    for (const table of ["symbol", "reference", "relation"]) this.db.prepare(`DELETE FROM ${table} WHERE blob_id = ?`).run(blobId);
  }

  /** Store the extraction of one document content; an existing blob is kept unless `replace` is set. Returns the blob id. */
  writeBlob(projectId: number, hash: string, extraction: Extraction, options: { replace?: boolean; now?: number } = {}): number {
    const now = options.now ?? Date.now();
    return this.transaction(() => {
      let id = this.blobId(projectId, hash);
      if (id !== undefined) {
        if (!options.replace) return id;
        this.clearBlobRows(id);
      } else {
        const row = this.db
          .prepare("INSERT INTO blob(project_id, content_hash, created_at, last_used_at) VALUES (?, ?, ?, ?) RETURNING id")
          .get(projectId, hash, now, now) as Row;
        id = Number(row["id"]);
      }
      const symbol = this.db.prepare(
        `INSERT INTO symbol(blob_id, doc_id, kind, name, fq_name, signature, accessibility, containing_doc_id, line, col, end_line)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of extraction.symbols) {
        symbol.run(id, s.docId, s.kind, s.name, s.fqName, s.signature, s.accessibility, s.containingDocId, s.line, s.col, s.endLine);
      }
      const reference = this.db.prepare(
        "INSERT INTO reference(blob_id, target_doc_id, kind, line, col, from_doc_id) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const r of extraction.references) reference.run(id, r.targetDocId, r.kind, r.line, r.col, r.fromDocId);
      const relation = this.db.prepare("INSERT INTO relation(blob_id, from_doc_id, to_doc_id, kind) VALUES (?, ?, ?, ?)");
      for (const r of extraction.relations) relation.run(id, r.fromDocId, r.toDocId, r.kind);
      return id;
    });
  }

  /** Delete blobs unused for longer than `retentionMs` that no tree entry points to; returns the count. */
  gc(retentionMs: number, now = Date.now()): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT b.id FROM blob b WHERE b.last_used_at < ? AND NOT EXISTS
             (SELECT 1 FROM tree t WHERE t.project_id = b.project_id AND t.content_hash = b.content_hash)`,
        )
        .all(now - retentionMs) as Row[];
      for (const row of rows) {
        const id = Number(row["id"]);
        this.clearBlobRows(id);
        this.db.prepare("DELETE FROM blob WHERE id = ?").run(id);
      }
      return rows.length;
    });
  }

}

export function formatStats(stats: IndexStats): string {
  return (
    `${stats.projects} projects, ${stats.trackedFiles} tracked files, ${stats.blobs} blobs, ` +
    `${stats.symbols} symbols, ${stats.references} references, ${stats.relations} relations`
  );
}

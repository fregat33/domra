import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { isTestProject } from "./projectKinds.ts";
import type { RankedRecord } from "./ranker.ts";
import { compareRecords, containersMatch, humpStarts, match, parseQuery } from "./ranker.ts";
import type {
  DocumentRow, Extraction, IndexStats, ReferenceFilter, ReferenceHit, RelationHit, SymbolHit, SymbolRow,
} from "./types.ts";

type Row = Record<string, unknown>;

/** Joins that keep only documents in the current tree. */
const VISIBLE = `JOIN blob b ON b.id = x.blob_id
  JOIN tree t ON t.project_id = b.project_id AND t.content_hash = b.content_hash
  JOIN project p ON p.id = b.project_id`;

const DOCUMENT_COLUMNS = `p.id AS project_id, p.name AS project_name, p.path AS project_path,
  p.solution_path AS solution_path, t.path AS doc_path, b.content_hash AS content_hash`;

const SYMBOL_COLUMNS = `x.id AS id, x.doc_id, x.kind, x.name, x.fq_name, x.signature, x.accessibility,
  x.containing_doc_id, x.line, x.col, x.end_line`;

/** SQL equivalent of `kindRank`. */
const KIND_RANK = `CASE x.kind
  WHEN 'class' THEN 0 WHEN 'interface' THEN 0 WHEN 'typeAlias' THEN 0 WHEN 'enum' THEN 0
  WHEN 'function' THEN 0 WHEN 'method' THEN 0 WHEN 'constructor' THEN 0
  WHEN 'property' THEN 1 WHEN 'accessor' THEN 1 WHEN 'field' THEN 2 WHEN 'enumMember' THEN 2 ELSE 3 END`;

function documentOf(r: Row): DocumentRow {
  return {
    projectId: Number(r["project_id"]),
    projectName: String(r["project_name"]),
    projectPath: String(r["project_path"]),
    solutionPath: String(r["solution_path"] ?? ""),
    path: String(r["doc_path"]),
    contentHash: String(r["content_hash"]),
  };
}

function symbolOf(r: Row): SymbolRow {
  return {
    docId: String(r["doc_id"]),
    kind: String(r["kind"]),
    name: String(r["name"]),
    fqName: String(r["fq_name"]),
    signature: String(r["signature"] ?? ""),
    accessibility: String(r["accessibility"] ?? ""),
    containingDocId: (r["containing_doc_id"] as string | null) ?? null,
    line: Number(r["line"]),
    col: Number(r["col"]),
    endLine: Number(r["end_line"] ?? 0),
  };
}

const symbolHit = (r: Row): SymbolHit => ({ ...symbolOf(r), document: documentOf(r) });

/** Path relative to the solution directory (forward slashes), else the path itself. */
export function relativeToSolution(path: string, solutionPath: string): string {
  const dir = solutionPath.slice(0, solutionPath.lastIndexOf("/") + 1);
  return dir !== "" && path.toLowerCase().startsWith(dir.toLowerCase()) ? path.slice(dir.length) : path;
}

const isTestDocument = (d: DocumentRow): boolean => isTestProject(d.projectName, relativeToSolution(d.path, d.solutionPath));

const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Case-insensitive GLOB text: every letter as `[Xx]`, `* ? [` bracketed. */
function globEscape(text: string): string {
  return [...text].map((c) => {
    if (c === "*" || c === "?" || c === "[") return `[${c}]`;
    const lower = c.toLowerCase();
    const upper = c.toUpperCase();
    return lower !== upper ? `[${upper}${lower}]` : c;
  }).join("");
}

const ftsTerm = (term: string): string => `"${term.replace(/"/g, '""')}"*`;

/** Read side of the index store; every query sees only documents in the current tree. */
export class StoreQueries {
  readonly db: DatabaseSync;
  /** True when the FTS5 table exists and is kept in sync. */
  readonly hasFts: boolean;

  /** Solution paths whose rows reads skip (see `restrict`). */
  protected hidden: readonly string[] = [];

  protected constructor(db: DatabaseSync, hasFts: boolean) {
    this.db = db;
    this.hasFts = hasFts;
  }

  /** The same store for reading, with the rows of the given solution paths left out of every query. */
  restrict(hidden: readonly string[]): this {
    const view = Object.create(this) as this;
    view.hidden = hidden;
    return view;
  }

  /** SQL condition (and parameters) that drops the rows of hidden solutions; `column` holds the solution path. */
  protected visibleIn(column: string): { sql: string; params: string[] } {
    if (this.hidden.length === 0) return { sql: "1 = 1", params: [] };
    return { sql: `(${column} IS NULL OR ${column} NOT IN (${this.hidden.map(() => "?").join(", ")}))`, params: [...this.hidden] };
  }

  /** Row counts of the visible solutions; every table joins `project` (directly or through `blob`). */
  stats(): IndexStats {
    const open = this.visibleIn("p.solution_path");
    const count = (from: string): number =>
      Number((this.db.prepare(`SELECT count(*) AS n FROM ${from} WHERE ${open.sql}`).get(...open.params) as Row)["n"]);
    const viaBlob = (table: string): number => count(`${table} x JOIN blob b ON b.id = x.blob_id JOIN project p ON p.id = b.project_id`);
    return {
      projects: count("project p"),
      trackedFiles: count("tree t JOIN project p ON p.id = t.project_id"),
      blobs: count("blob b JOIN project p ON p.id = b.project_id"),
      symbols: viaBlob("symbol"),
      references: viaBlob("reference"),
      relations: viaBlob("relation"),
    };
  }

  findSymbolsByDocId(docId: string): SymbolHit[] {
    const open = this.visibleIn("p.solution_path");
    const rows = this.db
      .prepare(`SELECT ${SYMBOL_COLUMNS}, ${DOCUMENT_COLUMNS} FROM symbol x ${VISIBLE} WHERE x.doc_id = ? AND ${open.sql} ORDER BY t.path, x.line, x.col`)
      .all(docId, ...open.params) as Row[];
    return rows.map(symbolHit);
  }

  /** Ranked symbol search over the current documents (see docs/index.md for the candidate queries). */
  searchSymbols(pattern: string, kind: string | null, limit: number): SymbolHit[] {
    const query = parseQuery(pattern);
    if (query.name === "") return [];
    const cap = Math.max(limit * 4, 300);
    const candidates = new Map<string, Row>();
    const open = this.visibleIn("p.solution_path");
    const base = (where: string, params: SQLInputValue[], join = ""): void => {
      const filters = [where, open.sql];
      const all = [...params, ...open.params];
      for (const container of query.containers) {
        filters.push("(x.fq_name LIKE ? ESCAPE '\\' OR t.path LIKE ? ESCAPE '\\')");
        const like = `%${likeEscape(container)}%`;
        all.push(like, like);
      }
      if (kind !== null) {
        filters.push("x.kind = ?");
        all.push(kind);
      }
      const sql = `SELECT ${SYMBOL_COLUMNS}, ${DOCUMENT_COLUMNS} FROM symbol x ${join} ${VISIBLE}
        WHERE ${filters.join(" AND ")} ORDER BY ${KIND_RANK}, length(x.name), x.fq_name LIMIT ${cap}`;
      for (const row of this.db.prepare(sql).all(...all) as Row[]) {
        candidates.set(`${String(row["id"])}|${String(row["doc_path"])}`, row);
      }
    };
    if (this.hasFts) {
      base("symbol_fts MATCH ?", [`name : ${ftsTerm(query.name)}`], "JOIN symbol_fts ON symbol_fts.rowid = x.id");
    }
    base("x.name LIKE ? ESCAPE '\\'", [`%${likeEscape(query.name)}%`]);
    const humps = humpStarts(query.name, true);
    if (humps.length >= 2) {
      const glob = humps
        .map((start, k) => globEscape(query.name.slice(start, k + 1 < humps.length ? humps[k + 1] : query.name.length).replace(/_+$/, "")))
        .join("*");
      base("x.name GLOB ?", [`*${glob}*`]);
    }
    const ranked: (RankedRecord & { hit: SymbolHit })[] = [];
    for (const row of candidates.values()) {
      const hit = symbolHit(row);
      const quality = match(query.name, hit.name);
      const path = relativeToSolution(hit.document.path, hit.document.solutionPath);
      if (quality === null || !containersMatch(query.containers, { fqName: hit.fqName, path })) continue;
      ranked.push({
        name: hit.name, fqName: hit.fqName, kind: hit.kind, path, offset: hit.line * 100000 + hit.col,
        isTest: isTestProject(hit.document.projectName, path), match: quality, hit,
      });
    }
    ranked.sort(compareRecords);
    const seen = new Set<string>();
    const result: SymbolHit[] = [];
    for (const record of ranked) {
      const key = `${record.hit.document.solutionPath}\0${record.hit.docId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(record.hit);
      if (result.length >= limit) break;
    }
    return result;
  }

  private referenceRows(targetDocId: string, kinds: string[] | undefined): ReferenceHit[] {
    const open = this.visibleIn("p.solution_path");
    const params: SQLInputValue[] = [targetDocId, ...open.params];
    let where = `x.target_doc_id = ? AND ${open.sql}`;
    if (kinds && kinds.length > 0) {
      where += ` AND x.kind IN (${kinds.map(() => "?").join(", ")})`;
      params.push(...kinds);
    }
    const rows = this.db
      .prepare(
        `SELECT x.target_doc_id, x.kind, x.line, x.col, x.from_doc_id, ${DOCUMENT_COLUMNS} FROM reference x ${VISIBLE}
         WHERE ${where} ORDER BY t.path COLLATE NOCASE, x.line, x.col`,
      )
      .all(...params) as Row[];
    return rows.map((r) => ({
      targetDocId: String(r["target_doc_id"]),
      kind: String(r["kind"]),
      line: Number(r["line"]),
      col: Number(r["col"]),
      fromDocId: (r["from_doc_id"] as string | null) ?? null,
      document: documentOf(r),
    }));
  }

  private static keep(hit: ReferenceHit, filter: ReferenceFilter): boolean {
    const scope = filter.scope ?? "all";
    if (scope !== "all" && isTestDocument(hit.document) !== (scope === "tests")) return false;
    return !filter.kinds || filter.kinds.length === 0 || filter.kinds.includes(hit.kind);
  }

  /** References to a docId ordered by path (ignoring case), line, column; `scope` uses `isTestProject`. */
  findReferences(targetDocId: string, limit: number, filter: ReferenceFilter = {}): ReferenceHit[] {
    return this.referenceRows(targetDocId, filter.kinds).filter((h) => StoreQueries.keep(h, filter)).slice(0, limit);
  }

  /** Per solution path: every reference (`total`) and those the filter keeps (`kept`). */
  countReferencesBySolution(targetDocId: string, filter: ReferenceFilter = {}): Map<string, { total: number; kept: number }> {
    const counts = new Map<string, { total: number; kept: number }>();
    for (const hit of this.referenceRows(targetDocId, undefined)) {
      const entry = counts.get(hit.document.solutionPath) ?? { total: 0, kept: 0 };
      entry.total++;
      if (StoreQueries.keep(hit, filter)) entry.kept++;
      counts.set(hit.document.solutionPath, entry);
    }
    return counts;
  }

  /** Relations pointing at `toDocId` with one of `kinds` (all when empty), with the declaring symbol row. */
  findRelations(toDocId: string, kinds: string[], limit: number): RelationHit[] {
    const open = this.visibleIn("p.solution_path");
    const params: SQLInputValue[] = [toDocId, ...open.params];
    let where = `x.to_doc_id = ? AND ${open.sql}`;
    if (kinds.length > 0) {
      where += ` AND x.kind IN (${kinds.map(() => "?").join(", ")})`;
      params.push(...kinds);
    }
    const rows = this.db
      .prepare(
        `SELECT x.from_doc_id AS rel_from, x.to_doc_id AS rel_to, x.kind AS rel_kind, s.doc_id, s.kind, s.name, s.fq_name,
           s.signature, s.accessibility, s.containing_doc_id, s.line, s.col, s.end_line, ${DOCUMENT_COLUMNS}
         FROM relation x ${VISIBLE}
         LEFT JOIN symbol s ON s.id = (SELECT min(id) FROM symbol WHERE blob_id = x.blob_id AND doc_id = x.from_doc_id)
         WHERE ${where} ORDER BY x.kind, x.from_doc_id, t.path COLLATE NOCASE LIMIT ?`,
      )
      .all(...params, limit) as Row[];
    return rows.map((r) => ({
      fromDocId: String(r["rel_from"]),
      toDocId: String(r["rel_to"]),
      kind: String(r["rel_kind"]),
      symbol: r["doc_id"] === null || r["doc_id"] === undefined ? null : symbolOf(r),
      document: documentOf(r),
    }));
  }

  /** Symbols of the current document at `path`, by line and column; the first project only when several track it. */
  getFileSymbols(path: string): SymbolHit[] {
    const open = this.visibleIn("p.solution_path");
    const rows = this.db
      .prepare(`SELECT ${SYMBOL_COLUMNS}, ${DOCUMENT_COLUMNS} FROM symbol x ${VISIBLE} WHERE t.path = ? AND ${open.sql} ORDER BY p.id, x.line, x.col`)
      .all(path, ...open.params) as Row[];
    const first = rows[0]?.["project_id"];
    return rows.filter((r) => r["project_id"] === first).map(symbolHit);
  }

  /** The stored extraction of one blob, or null when the blob does not exist. */
  readExtraction(projectId: number, hash: string): Extraction | null {
    const blob = this.db.prepare("SELECT id FROM blob WHERE project_id = ? AND content_hash = ?").get(projectId, hash) as Row | undefined;
    if (!blob) return null;
    const id = blob["id"] as number;
    const symbols = (this.db.prepare("SELECT * FROM symbol x WHERE blob_id = ? ORDER BY id").all(id) as Row[]).map(symbolOf);
    const references = (this.db.prepare("SELECT * FROM reference WHERE blob_id = ? ORDER BY id").all(id) as Row[]).map((r) => ({
      targetDocId: String(r["target_doc_id"]), kind: String(r["kind"]), line: Number(r["line"]), col: Number(r["col"]),
      fromDocId: (r["from_doc_id"] as string | null) ?? null,
    }));
    const relations = (this.db.prepare("SELECT * FROM relation WHERE blob_id = ? ORDER BY id").all(id) as Row[]).map((r) => ({
      fromDocId: String(r["from_doc_id"]), toDocId: String(r["to_doc_id"]), kind: String(r["kind"]),
    }));
    return { symbols, references, relations };
  }
}

import { basename, dirname, isAbsolute, join } from "node:path";
import type { IndexStore, ReferenceScope, RelationHit, SymbolHit } from "../index/index.ts";
import { parseDocId, TOP_LEVEL } from "../index/index.ts";
import type { Filters, GroupedText, LoadedSolution, QueryText, WorkspaceManager } from "../workspace/index.ts";
import {
  describeFilters, docIdOf, findInSolution, formatNotFound, isStale, normalizePath, pathKey, resolveTargets,
} from "../workspace/index.ts";
import { driftTagFor } from "./drift.ts";
import { isNotFound } from "./select.ts";

type Group = GroupedText["groups"][number];
export type IndexTarget = { docId: string; fqName: string; head: string[] };

const STALE_REFERENCE = "  [stale: file changed since indexed]";
const CANDIDATE_INTRO = "Index knows these candidates (pass the fully qualified name, or load_solution for the live view):";
const MAX_CANDIDATES = 10;
const FILE_TARGET = /\.(ts|tsx|mts|cts|js|jsx)$/i;

/** Name of a solution from its tsconfig path: the directory name. */
export const solutionName = (solutionPath: string): string => basename(dirname(solutionPath));

const loadedKeys = (manager: WorkspaceManager): Set<string> => new Set(manager.loadedSolutions.map((s) => pathKey(s.path)));
const at = (hit: { document: { path: string }; line: number; col: number }): string => `${hit.document.path}:${hit.line}:${hit.col}`;

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

// ---- not found --------------------------------------------------------------------------------

function candidateLines(spec: string, store: IndexStore): string[] {
  const hits = spec.includes("#") ? store.findSymbolsByDocId(spec) : store.searchSymbols(spec, null, MAX_CANDIDATES);
  if (hits.length === 0) return [];
  const lines = hits.slice(0, MAX_CANDIDATES).map(
    (h) => `  ${h.docId}  ${h.kind}  ${h.document.path}:${h.line}  (${solutionName(h.document.solutionPath)})`,
  );
  return [CANDIDATE_INTRO, ...lines];
}

/** Replace the `Tip:` line of a not-found head with the index candidates (the tip stays when there are none). */
export function withCandidates<T extends { head: string[] }>(result: T, spec: string, store: IndexStore | undefined): T {
  const tip = result.head.findIndex((line) => line.startsWith("Tip: "));
  if (!store || tip < 0) return result;
  const lines = candidateLines(spec, store);
  if (lines.length === 0) return result;
  return { ...result, head: [...result.head.slice(0, tip), ...lines, ...result.head.slice(tip + 1)] };
}

/**
 * A spec with `#` is a docId: when the owning solution is loaded it resolves live there (by fqName),
 * otherwise the index candidates are the answer (`unresolved`).
 */
export function prepareSpec(
  manager: WorkspaceManager,
  store: IndexStore | undefined,
  spec: string,
  hint: string | undefined,
): { spec: string; hint: string | undefined } | { unresolved: string[] } {
  const parts = store && spec.includes("#") ? parseDocId(spec) : null;
  const rows = parts ? store!.findSymbolsByDocId(spec) : [];
  if (!parts || rows.length === 0) return { spec, hint };
  const owner = rows.map((r) => manager.resolveSolution(r.document.solutionPath)).find((s) => s !== null);
  if (owner) return { spec: parts.fqName, hint: owner.path };
  return { unresolved: withCandidates({ head: formatNotFound(spec, null, false) }, spec, store).head };
}

// ---- index-only targets -----------------------------------------------------------------------

function signatureHead(hit: SymbolHit): string[] {
  return [
    `Symbol: ${hit.signature}  [${hit.kind}]  ${hit.fqName}`,
    `Project: ${hit.document.projectName} (${solutionName(hit.document.solutionPath)}, from index)`,
    `Defined: ${at(hit)}`,
  ];
}

/** The target of a references/implementations query: the live declaration's docId, else a unique exact name in the index. */
export function targetOf(
  manager: WorkspaceManager,
  store: IndexStore,
  spec: string,
  hint: string | undefined,
): { target: IndexTarget; live: boolean } | null {
  const live = resolveTargets(manager, spec, hint, false, undefined);
  const first = live?.targets[0];
  if (live && first) {
    const docId = docIdOf(first.found.node, first.found.project, first.solution);
    return { target: { docId, fqName: live.resolved.fqName, head: [] }, live: true };
  }
  if (spec.includes("#")) return null;
  const exact = store.searchSymbols(spec, null, 50).filter((h) => h.fqName === spec);
  const ids = new Set(exact.map((h) => h.docId));
  if (ids.size !== 1) return null;
  const hit = exact[0]!;
  return { target: { docId: hit.docId, fqName: hit.fqName, head: signatureHead(hit) }, live: false };
}

// ---- package sources --------------------------------------------------------------------------

const NODE_MODULES = /(^|\/)node_modules\//;
const MAX_SOURCES = 3;

/**
 * go_to_definition / get_symbol_info on a declaration in a published package (under node_modules): the index's
 * source declaration with the same docId answers live when its solution is loaded, else `Source:` lines are added.
 */
export function withPackageSource(
  manager: WorkspaceManager,
  store: IndexStore | undefined,
  run: (solution: LoadedSolution, spec: string) => QueryText,
): (solution: LoadedSolution, spec: string) => QueryText {
  return (solution, spec) => {
    const found = store ? findInSolution(solution, spec) : null;
    if (!store || !found || !NODE_MODULES.test(found.node.getSourceFile().fileName.replace(/\\/g, "/"))) return run(solution, spec);
    const docId = docIdOf(found.node, found.project, solution);
    const hits = store.findSymbolsByDocId(docId).filter((h) => !NODE_MODULES.test(h.document.path));
    for (const hit of hits) {
      const owner = manager.resolveSolution(hit.document.solutionPath);
      if (!owner) continue;
      const live = run(owner, `${hit.document.path}:${hit.line}:${hit.col}`);
      if (!isNotFound(live)) return live;
    }
    const result = run(solution, spec);
    if (hits.length === 0 || isNotFound(result)) return result;
    const bySolution = [...new Map(hits.map((h) => [pathKey(h.document.solutionPath), h])).values()].slice(0, MAX_SOURCES);
    const lines = bySolution.map(
      (h) =>
        `Source: ${h.document.path}:${h.line}  (${h.document.projectName}, ${solutionName(h.document.solutionPath)}; solution not loaded, load_solution for the live view)`,
    );
    if (result.items.length > 0) return { ...result, footer: [...lines, ...(result.footer ? [result.footer] : [])].join("\n") };
    const declared = result.head.reduce((last, line, i) => (line.startsWith("Declared at: ") ? i : last), result.head.length - 1);
    return { ...result, head: [...result.head.slice(0, declared + 1), ...lines, ...result.head.slice(declared + 1)] };
  };
}

// ---- search -----------------------------------------------------------------------------------

export function searchGroups(manager: WorkspaceManager, store: IndexStore, pattern: string, kind: string | null, limit: number): Group[] {
  const loaded = loadedKeys(manager);
  const hits = store.searchSymbols(pattern, kind, Math.max(limit * 4, 300)).filter((h) => !loaded.has(pathKey(h.document.solutionPath)));
  const groups: Group[] = [];
  for (const [path, group] of groupBy(hits, (h) => h.document.solutionPath)) {
    const unique = [...new Map(group.map((h) => [h.docId, h])).values()];
    const name = solutionName(path);
    groups.push({
      header: `Index ${name} (not loaded, ${unique.length}):`,
      label: `search_symbols ${pattern} in ${name} (index)`,
      items: unique.map((h) => `  ${h.kind} ${h.fqName}  ${at(h)}`),
    });
  }
  return groups;
}

// ---- references -------------------------------------------------------------------------------

function enclosingText(fromDocId: string | null): string {
  if (fromDocId === null) return "";
  return `  in ${fromDocId === TOP_LEVEL ? TOP_LEVEL : (parseDocId(fromDocId)?.fqName ?? fromDocId)}`;
}

export function referenceGroups(
  manager: WorkspaceManager,
  store: IndexStore,
  target: IndexTarget,
  filters: Filters,
  limit: number,
): { groups: Group[]; total: number } {
  const loaded = loadedKeys(manager);
  const filter: { kinds?: string[]; scope: ReferenceScope } = { scope: filters.scope };
  if (filters.kinds.size > 0) filter.kinds = [...filters.kinds];
  const counts = store.countReferencesBySolution(target.docId, filter);
  const hits = groupBy(store.findReferences(target.docId, Math.max(limit * 4, 500), filter), (h) => h.document.solutionPath);
  const text = describeFilters(filters);
  const cache = new Map<string, boolean>();
  const groups: Group[] = [];
  let total = 0;
  for (const [path, count] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (loaded.has(pathKey(path))) continue;
    const name = solutionName(path);
    total += count.kept;
    groups.push({
      header:
        `Index ${name}: ` +
        (text === "" ? `${count.kept} references (solution not loaded; from index)` : `${count.kept} of ${count.total} references (${text}; solution not loaded; from index)`) +
        driftTagFor(store, target.docId, path, count.kept),
      label: `find_references ${target.fqName} in ${name} (index)`,
      items: (hits.get(path) ?? []).map(
        (h) =>
          `  ${at(h)}  ${h.document.projectName}  ${h.kind}${enclosingText(h.fromDocId)}${isStale(h.document, cache) ? STALE_REFERENCE : ""}`,
      ),
    });
  }
  return { groups, total };
}

// ---- implementations --------------------------------------------------------------------------

function relationLine(hit: RelationHit, stale: boolean): string {
  const s = hit.symbol;
  const what = s ? `${s.kind} ${s.fqName}  ${at({ document: hit.document, line: s.line, col: s.col })}` : `${parseDocId(hit.fromDocId)?.fqName ?? hit.fromDocId}  ${hit.document.path}`;
  return `  ${hit.kind}  ${what}${stale ? "  [stale]" : ""}`;
}

export function relationGroups(
  manager: WorkspaceManager,
  store: IndexStore,
  target: IndexTarget,
  tool: string,
  limit: number,
): { groups: Group[]; total: number } {
  const loaded = loadedKeys(manager);
  const hits = store.findRelations(target.docId, ["implements", "inherits", "overrides"], Math.max(limit * 4, 500));
  const cache = new Map<string, boolean>();
  const groups: Group[] = [];
  let total = 0;
  for (const [path, group] of groupBy(hits, (h) => h.document.solutionPath)) {
    if (loaded.has(pathKey(path))) continue;
    const unique = [...new Map(group.map((h) => [`${h.kind}|${h.fromDocId}`, h])).values()];
    const name = solutionName(path);
    total += unique.length;
    groups.push({
      header: `Index ${name}: ${unique.length} (solution not loaded; from index)${driftTagFor(store, target.docId, path, unique.length)}`,
      label: `${tool} ${target.fqName} in ${name} (index)`,
      items: unique.map((h) => relationLine(h, isStale(h.document, cache))),
    });
  }
  return { groups, total };
}

// ---- outline ----------------------------------------------------------------------------------

/** Outline of a file from the index when no loaded solution contains it; null when the index has no rows. */
export function indexOutline(
  manager: WorkspaceManager,
  store: IndexStore,
  target: string,
  options: { depth: number; includePrivate: boolean },
): QueryText | null {
  if (!FILE_TARGET.test(target)) return null;
  const paths = isAbsolute(target) ? [normalizePath(target)] : manager.solutions.map((s) => normalizePath(join(s.dir, target)));
  for (const path of paths) {
    const rows = store.getFileSymbols(path);
    const first = rows[0];
    if (!first || loadedKeys(manager).has(pathKey(first.document.solutionPath))) continue;
    const byId = new Map(rows.map((r) => [r.docId, r]));
    const items: string[] = [];
    const hidden = new Set<string>();
    const depth = Math.min(3, Math.max(1, Math.trunc(options.depth) || 2));
    for (const row of rows) {
      let nesting = 0;
      for (let p = row.containingDocId; p !== null && byId.has(p) && nesting < 10; p = byId.get(p)!.containingDocId) nesting++;
      if (row.containingDocId !== null && hidden.has(row.containingDocId)) hidden.add(row.docId);
      else if (!options.includePrivate && row.accessibility === "private") hidden.add(row.docId);
      if (hidden.has(row.docId) || nesting > depth - 1) continue;
      const access = row.accessibility === "private" || row.accessibility === "protected" ? `${row.accessibility} ` : "";
      const span = row.endLine > row.line ? `${row.line}-${row.endLine}` : `${row.line}`;
      items.push(`${" ".repeat(2 + nesting * 2)}${access}${row.kind} ${row.signature}  ${span}`);
    }
    const stale = isStale(first.document) ? "; [stale: file changed since indexed]" : "";
    return {
      head: [
        `Outline: ${path}  (Index ${solutionName(first.document.solutionPath)}, ${first.document.projectName}; solution not loaded, decorators not shown, load_solution for the live view${stale})`,
      ],
      items,
      label: `get_outline ${path}`,
      footer: `Total: ${items.length} declarations`,
    };
  }
  return null;
}

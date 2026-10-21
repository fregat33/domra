import { relative } from "node:path";
import ts from "typescript";
import type { MatchQuality, RankedRecord } from "../index/index.ts";
import { compareRecords, containersMatch, isTestProject, match, parseQuery } from "../index/index.ts";
import { fqNameOf, kindOf, nameNode } from "./declarations.ts";
import type { SymbolKind } from "./declarations.ts";
import { pathKey } from "./discovery.ts";
import type { Position } from "./positions.ts";
import { formatPosition, positionOf, toSlashes } from "./positions.ts";
import { fileNameIndex } from "./resolver.ts";
import type { LoadedSolution } from "./solution.ts";
import { owningProject } from "./solution.ts";
import type { WorkspaceManager } from "./manager.ts";

export const DEFAULT_SEARCH_LIMIT = 30;

export type SearchHit = {
  name: string;
  fqName: string;
  kind: SymbolKind;
  project: string;
  position: Position;
  isTest: boolean;
  match: MatchQuality;
};

export type SearchResult = {
  solution: string;
  /** Number of matching declarations before `limit` was applied. */
  total: number;
  hits: SearchHit[];
};

export type SearchOptions = { kind?: SymbolKind; limit?: number };

export type SearchWorkspaceOptions = SearchOptions & {
  solution?: string;
  /** Called with internal errors; they are reported to stderr when `DOMRA_DEBUG` is set and no callback is given. */
  onError?: (error: unknown, pattern: string) => void;
};

type Entry = { record: RankedRecord; hit: SearchHit };

function isAlias(node: ts.Node): boolean {
  return ts.isImportSpecifier(node) || ts.isExportSpecifier(node) || ts.isImportEqualsDeclaration(node);
}

function isSearchable(program: ts.Program, sourceFile: ts.SourceFile): boolean {
  return (
    !program.isSourceFileDefaultLibrary(sourceFile) &&
    !program.isSourceFileFromExternalLibrary(sourceFile) &&
    !/(^|\/)node_modules\//.test(toSlashes(sourceFile.fileName))
  );
}

/** Rank every named declaration of the solution against `pattern`; hits are sorted and limited. */
export function searchInSolution(
  solution: LoadedSolution,
  pattern: string,
  options: SearchOptions = {},
): SearchResult {
  const query = parseQuery(pattern);
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const entries: Entry[] = [];
  if (query.name !== "") {
    const seen = new Set<string>();
    for (const project of solution.projects) {
      const program = project.service.getProgram();
      if (!program) continue;
      for (const sourceFile of program.getSourceFiles()) {
        if (!isSearchable(program, sourceFile)) continue;
        const relPath = toSlashes(relative(solution.dir, sourceFile.fileName));
        const owner = owningProject(solution, sourceFile.fileName) ?? project;
        const isTest = isTestProject(owner.name, relPath);
        for (const [name, nodes] of fileNameIndex(sourceFile)) {
          const quality = match(query.name, name);
          if (quality === null) continue;
          for (const node of nodes) {
            if (isAlias(node)) continue;
            const kind = kindOf(node);
            if (kind === null || (options.kind !== undefined && kind !== options.kind)) continue;
            const start = node.getStart(sourceFile);
            const key = `${pathKey(sourceFile.fileName)}:${start}`;
            if (seen.has(key)) continue;
            const fqName = fqNameOf(node);
            const record: RankedRecord = { name, fqName, kind, isTest, path: relPath, offset: start, match: quality };
            if (!containersMatch(query.containers, record)) continue;
            seen.add(key);
            const position = positionOf(sourceFile, nameNode(node).getStart(sourceFile));
            entries.push({ record, hit: { name, fqName, kind, project: owner.name, position, isTest, match: quality } });
          }
        }
      }
    }
    entries.sort((a, b) => compareRecords(a.record, b.record));
  }
  return { solution: solution.name, total: entries.length, hits: entries.slice(0, limit).map((e) => e.hit) };
}

/** Search the given solution (by hint) or every loaded solution; solutions without hits are omitted. Never throws. */
export function searchWorkspace(
  manager: WorkspaceManager,
  pattern: string,
  options: SearchWorkspaceOptions = {},
): SearchResult[] {
  const results: SearchResult[] = [];
  try {
    let solutions: LoadedSolution[];
    if (options.solution !== undefined) {
      const found = manager.resolveSolution(options.solution);
      solutions = found ? [found] : [];
    } else {
      solutions = manager.loadedSolutions;
    }
    for (const solution of solutions) {
      const searchOptions: SearchOptions = {};
      if (options.kind !== undefined) searchOptions.kind = options.kind;
      if (options.limit !== undefined) searchOptions.limit = options.limit;
      const result = searchInSolution(solution, pattern, searchOptions);
      if (result.total > 0) results.push(result);
    }
  } catch (error) {
    try {
      if (options.onError) options.onError(error, pattern);
      else if (process.env["DOMRA_DEBUG"]) console.error(`domra: search failed for "${pattern}":`, error);
    } catch {
      // a failing error handler must not make search throw
    }
  }
  return results;
}

/** Balalaika text: a `Live {solution} ({total}):` header per group, one line per hit. */
export function formatSearch(results: SearchResult[], pattern: string): string {
  if (results.every((r) => r.hits.length === 0)) {
    return `No symbols match ${pattern}. Patterns support camel-case humps (e.g. UOC for UpdateOrderCommand).`;
  }
  let text = "";
  for (const result of results) {
    text += `Live ${result.solution} (${result.total}):\n`;
    for (const hit of result.hits) {
      text += `  ${hit.kind} ${hit.fqName}  ${formatPosition(hit.position)}\n`;
    }
  }
  return text;
}

import { isAbsolute } from "node:path";
import type { LoadedSolution, QueryText, WorkspaceManager } from "../workspace/index.ts";
import { formatNotFound, parseSymbolSpec } from "../workspace/index.ts";

export type Selection = { solutions: LoadedSolution[] } | { text: string };

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx)$/i;

export function unknownSolutionText(manager: WorkspaceManager, hint: string): string {
  const names = manager.solutions.map((s) => s.name).sort();
  return `Unknown solution: ${hint}. Known: ${names.join(", ")}`;
}

/** Load `hint` on demand (null when no registered solution matches). */
export function loadHinted(manager: WorkspaceManager, hint: string): LoadedSolution | null {
  try {
    return manager.load(hint);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("unknown solution")) return null;
    throw error;
  }
}

/**
 * The solutions a query runs against: the hinted one (loaded on demand), else the loaded ones, else the default.
 * Without a hint, `first` (tsconfig paths, the parts of a view) are loaded too; the manager lists them first.
 */
export function selectSolutions(
  manager: WorkspaceManager,
  hint: string | undefined,
  defaultSolution: string | null,
  first: readonly string[] = [],
): Selection {
  if (hint !== undefined) {
    if (loadHinted(manager, hint) === null) return { text: unknownSolutionText(manager, hint) };
    const solution = manager.resolveSolution(hint);
    return { solutions: solution ? [solution] : [] };
  }
  for (const path of first) loadHinted(manager, path);
  if (manager.loadedSolutions.length === 0 && defaultSolution !== null) loadHinted(manager, defaultSolution);
  return { solutions: manager.loadedSolutions };
}

export function isNotFound(result: QueryText): boolean {
  const first = result.head[0] ?? "";
  return first.startsWith("Symbol not found") || first.startsWith("No symbol at") || first.endsWith("is not a type.");
}

export function isOutlineFailure(result: QueryText): boolean {
  const first = result.head[0] ?? "";
  return (
    isNotFound(result) || first.startsWith("File not found") || first.includes("is not a type") ||
    first.includes("is not part of")
  );
}

/** Candidate solutions for an outline target: the owner of an absolute file path, else all. */
export function outlineCandidates(manager: WorkspaceManager, solutions: LoadedSolution[], target: string): LoadedSolution[] {
  if (!SOURCE_FILE.test(target) || !isAbsolute(target)) return solutions;
  const owner = manager.findSolutionForPath(target);
  return owner ? [owner] : solutions;
}

/** The first solution whose query succeeds; else the most informative failure. */
export function firstResult(
  solutions: LoadedSolution[],
  spec: string,
  run: (solution: LoadedSolution, spec: string) => QueryText,
  failed: (result: QueryText) => boolean = isNotFound,
): QueryText {
  const results: QueryText[] = [];
  for (const solution of solutions) {
    const result = run(solution, spec);
    if (!failed(result)) return result;
    results.push(result);
  }
  const unknownFile = "The file is not under any loaded solution.";
  const fallback = results.find((r) => r.head[1] !== unknownFile && !r.head[0]?.startsWith("File not found")) ?? results[0];
  return fallback ?? { head: formatNotFound(spec, parseSymbolSpec(spec), false), items: [], label: spec };
}

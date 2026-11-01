import { existsSync } from "node:fs";
import ts from "typescript";
import type { DomraConfig } from "../config.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import type { DiscoveredSolution } from "./discovery.ts";
import { describeSolution, discoverSolutions, normalizePath, pathKey } from "./discovery.ts";
import type { ResolvedSymbol } from "./resolver.ts";
import { resolveInSolution } from "./resolver.ts";
import type { LoadedSolution } from "./solution.ts";
import { loadSolution, owningProject } from "./solution.ts";

export type SolutionStatus = {
  name: string;
  path: string;
  state: "registered" | "loaded";
  projects: string[];
  fileCount: number | null;
  rootFiles: number | null;
  sourceFiles: number | null;
  declarationFiles: number | null;
  unresolved: { relative: number; package: number } | null;
  unresolvedImports: number | null;
  loadMs: number | null;
};

export type ResolveOptions = { solution?: string };

/** A predicate over a solution's tsconfig path and directory. */
export type SolutionFilter = (solution: { path: string; dir: string }) => boolean;

function matchByHint<T extends { name: string; path: string }>(items: T[], hint: string): T | null {
  const key = pathKey(hint);
  return (
    items.find((s) => pathKey(s.path) === key) ??
    items.find((s) => s.name.toLowerCase() === hint.toLowerCase()) ??
    items.find((s) => s.name.toLowerCase().includes(hint.toLowerCase())) ??
    null
  );
}

/** Every item the trimmed hint names: the exact path, else all exact names, else all names containing it (case-insensitive); sorted by path. */
function candidatesByHint<T extends { name: string; path: string }>(items: T[], hint: string): T[] {
  const text = hint.trim();
  if (text === "") return [];
  const key = pathKey(text);
  const lower = text.toLowerCase();
  const byPath = items.filter((s) => pathKey(s.path) === key);
  const found = byPath.length > 0
    ? byPath
    : (() => {
        const exact = items.filter((s) => s.name.toLowerCase() === lower);
        return exact.length > 0 ? exact : items.filter((s) => s.name.toLowerCase().includes(lower));
      })();
  return [...found].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Registered and loaded solutions; loading order is preserved for resolution. */
export class WorkspaceManager {
  private readonly config: Pick<DomraConfig, "roots" | "ignoredFolders">;
  private readonly registered = new Map<string, DiscoveredSolution>();
  private readonly loaded = new Map<string, LoadedSolution>();
  private readonly registry = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames);

  /** Called after a solution was newly loaded (not for an already loaded one). */
  onLoad: ((solution: LoadedSolution) => void) | null = null;

  /** Called after a solution was registered (also when it replaces an earlier registration of the same path). */
  onRegister: ((solution: DiscoveredSolution) => void) | null = null;

  constructor(config: Partial<Pick<DomraConfig, "roots" | "ignoredFolders">> = {}) {
    this.config = {
      roots: config.roots ?? DEFAULT_CONFIG.roots,
      ignoredFolders: config.ignoredFolders ?? DEFAULT_CONFIG.ignoredFolders,
    };
  }

  /** Discover solutions under the configured roots and register them. */
  discover(): DiscoveredSolution[] {
    const found = discoverSolutions(this.config.roots, this.config.ignoredFolders);
    for (const solution of found) this.register(solution);
    return found;
  }

  /** Register a solution by tsconfig path or discovery result. */
  register(solution: DiscoveredSolution | string): DiscoveredSolution {
    const described = typeof solution === "string" ? describeSolution(solution) : solution;
    this.registered.set(pathKey(described.path), described);
    this.onRegister?.(described);
    return described;
  }

  get solutions(): DiscoveredSolution[] {
    return [...this.registered.values()];
  }

  get loadedSolutions(): LoadedSolution[] {
    return [...this.loaded.values()];
  }

  /** Load a registered solution by path, name or name substring (registering a path if needed). */
  load(hint: string): LoadedSolution {
    let solution = matchByHint(this.solutions, hint);
    if (!solution && hint.toLowerCase().endsWith(".json") && existsSync(hint)) solution = this.register(normalizePath(hint));
    if (!solution) throw new Error(`unknown solution: ${hint}`);
    const key = pathKey(solution.path);
    const existing = this.loaded.get(key);
    if (existing) return existing;
    const result = loadSolution(solution, this.registry);
    this.loaded.set(key, result);
    this.onLoad?.(result);
    return result;
  }

  /** Unload and load again (fires `onLoad`). */
  reload(hint: string): LoadedSolution {
    const loaded = this.resolveSolution(hint);
    const target = loaded ? loaded.path : hint;
    this.unload(target);
    return this.load(target);
  }

  /** The registered solution a hint (path, name or name substring) names, loaded or not. */
  findRegistered(hint: string): DiscoveredSolution | null {
    return matchByHint(this.solutions, hint);
  }

  /** Drop a loaded solution and its language services; the registration stays. False when it was not loaded. */
  unload(hint: string): boolean {
    const solution = matchByHint(this.loadedSolutions, hint);
    if (!solution) return false;
    for (const project of solution.projects) project.service.dispose();
    return this.loaded.delete(pathKey(solution.path));
  }

  /** Whether the tsconfig path is registered (exact path, unlike `findRegistered`). */
  isRegistered(path: string): boolean {
    return this.registered.has(pathKey(path));
  }

  /** Unload a solution and drop its registration; null when the hint matches nothing registered. */
  forget(hint: string): DiscoveredSolution | null {
    const solution = matchByHint(this.solutions, hint);
    if (!solution) return null;
    this.unload(solution.path);
    this.registered.delete(pathKey(solution.path));
    return solution;
  }

  /** The visible registered solutions a hint names for forgetting (see `candidatesByHint`); empty for a blank hint or no match. */
  resolveForForget(hint: string): DiscoveredSolution[] {
    return candidatesByHint(this.solutions, hint);
  }

  /** A loaded solution by full path, then exact name, then name substring. */
  resolveSolution(hint: string): LoadedSolution | null {
    return matchByHint(this.loadedSolutions, hint);
  }

  /** The loaded solution owning a file: a project root file first, else the deepest solution dir. */
  findSolutionForPath(path: string): LoadedSolution | null {
    const solutions = this.loadedSolutions;
    const owner = solutions.find((s) => owningProject(s, path) !== undefined);
    if (owner) return owner;
    const key = pathKey(path);
    let best: LoadedSolution | null = null;
    for (const solution of solutions) {
      const dir = pathKey(solution.dir);
      if (key.startsWith(`${dir}/`) && (!best || dir.length > pathKey(best.dir).length)) {
        best = solution;
      }
    }
    return best;
  }

  /**
   * A manager over the same registrations and loaded solutions that shows only those `allows` accepts, the
   * `preferred` ones first among the loaded. Everything else (loading, forgetting, lookups) goes through it.
   */
  restrict(allows: SolutionFilter, preferred: SolutionFilter = () => false): WorkspaceManager {
    const view = Object.create(this) as WorkspaceManager;
    Object.defineProperties(view, {
      solutions: { get: () => this.solutions.filter(allows) },
      loadedSolutions: {
        get: () => {
          const visible = this.loadedSolutions.filter(allows);
          return [...visible.filter(preferred), ...visible.filter((s) => !preferred(s))];
        },
      },
    });
    view.load = (hint) => {
      if (matchByHint(view.solutions, hint) === null) {
        const hidden = this.findRegistered(hint);
        if (hidden || !hint.toLowerCase().endsWith(".json") || !existsSync(hint)) throw new Error(`unknown solution: ${hint}`);
        const described = describeSolution(normalizePath(hint));
        if (!allows(described)) throw new Error(`unknown solution: ${hint}`);
        this.register(described);
      }
      return WorkspaceManager.prototype.load.call(view, hint);
    };
    view.isRegistered = (path) => this.registered.has(pathKey(path)) && allows(this.registered.get(pathKey(path))!);
    view.resolve = (spec, options = {}) => {
      if (options.solution !== undefined) {
        const solution = view.resolveSolution(options.solution);
        return solution ? resolveInSolution(solution, spec) : null;
      }
      for (const solution of view.loadedSolutions) {
        const result = resolveInSolution(solution, spec);
        if (result) return result;
      }
      return null;
    };
    return view;
  }

  status(): SolutionStatus[] {
    return this.solutions.map((solution) => {
      const loaded = this.loaded.get(pathKey(solution.path));
      return {
        name: solution.name,
        path: solution.path,
        state: loaded ? "loaded" : "registered",
        projects: loaded ? loaded.projects.map((p) => p.name) : solution.projects,
        fileCount: loaded?.fileCount ?? null,
        rootFiles: loaded?.rootFiles ?? null,
        sourceFiles: loaded?.sourceFiles ?? null,
        declarationFiles: loaded?.declarationFiles ?? null,
        unresolved: loaded?.unresolved ?? null,
        unresolvedImports: loaded?.unresolvedImports ?? null,
        loadMs: loaded?.loadMs ?? null,
      };
    });
  }

  /**
   * Resolve a symbol spec. With `solution`, only that loaded solution is searched; otherwise
   * every loaded solution in load order, first match wins. Null when unresolved.
   */
  resolve(spec: string, options: ResolveOptions = {}): ResolvedSymbol | null {
    if (options.solution !== undefined) {
      const solution = this.resolveSolution(options.solution);
      return solution ? resolveInSolution(solution, spec) : null;
    }
    for (const solution of this.loaded.values()) {
      const result = resolveInSolution(solution, spec);
      if (result) return result;
    }
    return null;
  }
}

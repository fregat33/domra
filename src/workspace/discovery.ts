import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import ts from "typescript";
import { DEFAULT_CONFIG } from "../config.ts";
import { toSlashes } from "./positions.ts";

export const MAX_DISCOVERY_DEPTH = 6;
const TSCONFIG = "tsconfig.json";

/** A tsconfig.json that is not referenced by another discovered tsconfig. */
export type DiscoveredSolution = {
  /** Name of the directory containing the tsconfig. */
  name: string;
  /** Absolute tsconfig path, forward slashes. */
  path: string;
  /** Absolute directory of the tsconfig, forward slashes. */
  dir: string;
  /** tsconfig paths of the projects: the transitive references, or the solution itself. */
  projects: string[];
};

export function normalizePath(path: string): string {
  return toSlashes(resolve(path));
}

export function pathKey(path: string): string {
  const normalized = normalizePath(path);
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

/** Absolute paths of the tsconfigs listed in `references` of a tsconfig. */
export function readReferences(tsconfigPath: string): string[] {
  const { config } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const references: unknown = config?.references;
  if (!Array.isArray(references)) return [];
  const dir = dirname(tsconfigPath);
  const result: string[] = [];
  for (const reference of references) {
    const refPath: unknown = reference?.path;
    if (typeof refPath !== "string") continue;
    let target = resolve(dir, refPath);
    if (!target.toLowerCase().endsWith(".json")) target = join(target, TSCONFIG);
    result.push(normalizePath(target));
  }
  return result;
}

function collectTsconfigs(dir: string, depth: number, ignored: Set<string>, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (!ignored.has(entry) && depth < MAX_DISCOVERY_DEPTH) {
        collectTsconfigs(full, depth + 1, ignored, out);
      }
    } else if (entry === TSCONFIG) {
      out.push(normalizePath(full));
    }
  }
}

/** Transitive closure of references, in reference order; referenced tsconfigs must exist. */
function projectsOf(tsconfigPath: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>([pathKey(tsconfigPath)]);
  const visit = (path: string): void => {
    for (const ref of readReferences(path)) {
      const key = pathKey(ref);
      if (seen.has(key) || !existsSync(ref)) continue;
      seen.add(key);
      result.push(ref);
      visit(ref);
    }
  };
  visit(tsconfigPath);
  return result.length > 0 ? result : [tsconfigPath];
}

export function describeSolution(tsconfigPath: string): DiscoveredSolution {
  const path = normalizePath(tsconfigPath);
  const dir = toSlashes(dirname(path));
  return { name: basename(dir), path, dir, projects: projectsOf(path) };
}

/**
 * Walk each root to depth 6, skipping ignored folder names, and return every collected
 * tsconfig.json that no other collected tsconfig references, sorted by path.
 */
export function discoverSolutions(
  roots: readonly string[],
  ignoredFolders: readonly string[] = DEFAULT_CONFIG.ignoredFolders,
): DiscoveredSolution[] {
  const ignored = new Set(ignoredFolders);
  const found: string[] = [];
  for (const root of roots) {
    if (existsSync(root)) collectTsconfigs(resolve(root), 0, ignored, found);
  }
  const unique = new Map<string, string>();
  for (const path of found) unique.set(pathKey(path), path);

  const referenced = new Set<string>();
  for (const path of unique.values()) {
    for (const ref of readReferences(path)) referenced.add(pathKey(ref));
  }
  return [...unique.entries()]
    .filter(([key]) => !referenced.has(key))
    .map(([, path]) => describeSolution(path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

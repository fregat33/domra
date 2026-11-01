import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { DEFAULT_CONFIG } from "../config.ts";
import type { DocumentRow, IndexStore } from "../index/index.ts";
import { contentHash, decodeText, SCHEMA_VERSION, surfaceHash } from "../index/index.ts";
import type { DiscoveredSolution } from "./discovery.ts";
import { normalizePath, pathKey } from "./discovery.ts";
import { extractDocument } from "./extractor.ts";
import { packageOf } from "./packages.ts";
import { toSlashes } from "./positions.ts";
import type { LoadedProject, LoadedSolution } from "./solution.ts";

export type IndexOptions = {
  /** Re-extract every document and replace its blob. */
  force?: boolean;
  now?: () => number;
  ignoredFolders?: readonly string[];
};

export type IndexReport = {
  projectsVisited: number;
  documentsVisited: number;
  documentsExtracted: number;
  documentsReused: number;
  treeEntriesRemoved: number;
  elapsedMs: number;
};

const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/i;
const NODE_MODULES = /(^|\/)node_modules\//;

function packageInfo(dir: string): { name: string | null; version: string | null } {
  try {
    const json: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const { name, version } = (json ?? {}) as { name?: unknown; version?: unknown };
    return { name: typeof name === "string" ? name : null, version: typeof version === "string" ? version : null };
  } catch {
    return { name: null, version: null };
  }
}

/** Integer mtime (ms) and size of a file, or null when it cannot be read. */
function statOf(path: string): { mtime: number; size: number } | null {
  try {
    const stat = statSync(path);
    return { mtime: Math.trunc(stat.mtimeMs), size: stat.size };
  } catch {
    return null;
  }
}

/** Source files on disk under the project directory that are not root files (nested projects and ignored folders skipped). */
function excludedFiles(project: LoadedProject, ignored: Set<string>): string[] {
  const result: string[] = [];
  const walk = (dir: string, top: boolean): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (!top && entries.some((e) => e.isFile() && e.name === "tsconfig.json")) return;
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) walk(full, false);
      } else if (SOURCE_FILE.test(entry.name) && !project.fileKeys.has(pathKey(full))) {
        result.push(full);
      }
    }
  };
  walk(project.dir, true);
  return result.sort();
}

/**
 * Documents a project indexes: its root files, plus program files outside node_modules that no
 * project of the solution owns (claimed by the first project reaching them). Default libs never.
 */
function documentsOf(project: LoadedProject, solution: LoadedSolution, program: ts.Program, claimed: Set<string>): ts.SourceFile[] {
  const result: ts.SourceFile[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(sourceFile) || NODE_MODULES.test(toSlashes(sourceFile.fileName))) continue;
    const key = pathKey(sourceFile.fileName);
    if (!project.fileKeys.has(key)) {
      if (claimed.has(key) || solution.projects.some((p) => p.fileKeys.has(key))) continue;
      claimed.add(key);
    }
    result.push(sourceFile);
  }
  return result;
}

/** Packages the program consumes from node_modules with their versions (several versions of one name joined with `/`). */
function consumedPackages(program: ts.Program): { packageName: string; version: string }[] {
  const versions = new Map<string, Set<string>>();
  const seenDirs = new Set<string>();
  for (const sourceFile of program.getSourceFiles()) {
    const path = toSlashes(sourceFile.fileName);
    if (!NODE_MODULES.test(path)) continue;
    const info = packageOf(path);
    if (!info?.version || seenDirs.has(info.dir)) continue;
    seenDirs.add(info.dir);
    const set = versions.get(info.name);
    if (set) set.add(info.version);
    else versions.set(info.name, new Set([info.version]));
  }
  return [...versions].map(([packageName, set]) => ({ packageName, version: [...set].sort().join("/") }));
}

function ensureProject(store: IndexStore, project: LoadedProject, solution: LoadedSolution): number {
  const pkg = packageInfo(project.dir);
  return store.ensureProject({
    path: project.tsconfig, name: project.name, packageName: pkg.name, solutionPath: solution.path, version: pkg.version,
  });
}

/** Index every document of a loaded solution, reusing blobs of unchanged content. One transaction per project. */
export function indexSolution(store: IndexStore, solution: LoadedSolution, options: IndexOptions = {}): IndexReport {
  const started = performance.now();
  const now = options.now ?? Date.now;
  const ignored = new Set(options.ignoredFolders ?? DEFAULT_CONFIG.ignoredFolders);
  const report: IndexReport = {
    projectsVisited: 0, documentsVisited: 0, documentsExtracted: 0, documentsReused: 0, treeEntriesRemoved: 0, elapsedMs: 0,
  };
  const claimed = new Set<string>();
  for (const project of solution.projects) {
    const program = project.service.getProgram();
    if (!program) continue;
    const checker = program.getTypeChecker();
    report.projectsVisited++;
    store.transaction(() => {
      const id = ensureProject(store, project, solution);
      const schema = store.getProject(project.tsconfig)?.indexedSchema ?? 0;
      const force = (options.force ?? false) || (schema > 0 && schema < SCHEMA_VERSION);
      store.setExcludedFiles(id, excludedFiles(project, ignored));
      const tree = new Map([...store.getTree(id)].map(([path, entry]) => [pathKey(path), entry]));
      const keep: string[] = [];
      for (const sourceFile of documentsOf(project, solution, program, claimed)) {
        const path = toSlashes(sourceFile.fileName);
        const stat = statOf(path);
        if (!stat) continue;
        report.documentsVisited++;
        keep.push(path);
        const entry = tree.get(pathKey(path));
        if (!force && entry && entry.mtime === stat.mtime && entry.size === stat.size && store.hasBlob(id, entry.contentHash)) {
          report.documentsReused++;
          store.setTreeEntry(id, path, entry.contentHash, stat.mtime, stat.size, now());
          continue;
        }
        const hash = contentHash(project.host.getText(sourceFile.fileName) ?? sourceFile.text);
        if (force || !store.hasBlob(id, hash)) {
          store.writeBlob(id, hash, extractDocument(project, sourceFile, checker, { solution, program }), { replace: force, now: now() });
          report.documentsExtracted++;
        } else {
          report.documentsReused++;
        }
        store.setTreeEntry(id, path, hash, stat.mtime, stat.size, now());
      }
      report.treeEntriesRemoved += store.removeTreeEntries(id, keep, now());
      store.setProjectPackages(id, consumedPackages(program));
      store.stampProject(id, SCHEMA_VERSION);
    });
  }
  report.elapsedMs = Math.round(performance.now() - started);
  return report;
}

/** Projects of the solution that index `path`: its owners, else the first project whose program contains it. */
function projectsFor(solution: LoadedSolution, path: string): LoadedProject[] {
  const key = pathKey(path);
  const owners = solution.projects.filter((p) => p.fileKeys.has(key));
  if (owners.length > 0) return owners;
  const reaching = solution.projects.find((p) => p.service.getProgram()?.getSourceFile(path) !== undefined);
  return reaching ? [reaching] : [];
}

/**
 * Re-index the given documents from the projects' current programs (call `host.setFile` first).
 * Returns the names of the projects whose public surface (non-private symbols, relations) changed.
 */
export function indexDocuments(
  store: IndexStore,
  solution: LoadedSolution,
  paths: readonly string[],
  options: Pick<IndexOptions, "now"> = {},
): { changedProjects: string[]; documentsExtracted: number } {
  const now = options.now ?? Date.now;
  const changed = new Set<string>();
  let documentsExtracted = 0;
  store.transaction(() => {
    for (const input of paths) {
      const path = normalizePath(input);
      for (const project of projectsFor(solution, path)) {
        const program = project.service.getProgram();
        const sourceFile = program?.getSourceFile(path);
        if (!program || !sourceFile) continue;
        const id = store.getProject(project.tsconfig)?.id ?? ensureProject(store, project, solution);
        const text = project.host.getText(sourceFile.fileName) ?? sourceFile.text;
        const hash = contentHash(text);
        const fileName = toSlashes(sourceFile.fileName);
        const old = store.getTreeEntry(id, fileName);
        if (!store.hasBlob(id, hash)) {
          store.writeBlob(id, hash, extractDocument(project, sourceFile, program.getTypeChecker(), { solution, program }), { now: now() });
          documentsExtracted++;
        }
        const stat = statOf(fileName) ?? { mtime: 0, size: Buffer.byteLength(text, "utf8") };
        store.setTreeEntry(id, fileName, hash, stat.mtime, stat.size, now());
        if (old?.contentHash === hash) continue;
        const before = old ? store.readExtraction(id, old.contentHash) : null;
        const after = store.readExtraction(id, hash);
        if (!before || !after || surfaceHash(before) !== surfaceHash(after)) changed.add(project.name);
      }
    }
  });
  return { changedProjects: [...changed].sort(), documentsExtracted };
}

/**
 * Rewrite the stored extraction of every tracked document of the named projects from their current
 * programs, replacing the blobs even when the content is unchanged (references resolve against the
 * current declarations). Call `host.setFile` first for changes the project has not seen yet.
 */
export function reextractProjects(
  store: IndexStore,
  solution: LoadedSolution,
  projectNames: readonly string[],
  options: Pick<IndexOptions, "now"> = {},
): { projects: number; documents: number } {
  const now = options.now ?? Date.now;
  const names = new Set(projectNames);
  let projects = 0;
  let documents = 0;
  store.transaction(() => {
    for (const project of solution.projects) {
      if (!names.has(project.name)) continue;
      const program = project.service.getProgram();
      if (!program) continue;
      const id = store.getProject(project.tsconfig)?.id ?? ensureProject(store, project, solution);
      const checker = program.getTypeChecker();
      projects++;
      for (const path of store.getTree(id).keys()) {
        const sourceFile = program.getSourceFile(path);
        if (!sourceFile) continue;
        const text = project.host.getText(sourceFile.fileName) ?? sourceFile.text;
        const hash = contentHash(text);
        store.writeBlob(id, hash, extractDocument(project, sourceFile, checker, { solution, program }), { replace: true, now: now() });
        const stat = statOf(path) ?? { mtime: 0, size: Buffer.byteLength(text, "utf8") };
        store.setTreeEntry(id, toSlashes(sourceFile.fileName), hash, stat.mtime, stat.size, now());
        documents++;
      }
    }
  });
  return { projects, documents };
}

/** Drop a deleted document from the tree of every project of the solution. */
export function removeDocument(store: IndexStore, solution: LoadedSolution, path: string): void {
  const fileName = normalizePath(path);
  store.transaction(() => {
    for (const project of solution.projects) {
      const row = store.getProject(project.tsconfig);
      if (row) store.removeTreeEntry(row.id, fileName);
    }
  });
}

/**
 * True when the index is current for a discovered solution without loading it: every project is
 * stamped with SCHEMA_VERSION, every tracked file has the recorded mtime and size, and every file
 * of the project's tsconfig file list is tracked.
 */
export function isFresh(store: IndexStore, solution: DiscoveredSolution, options: Pick<IndexOptions, "ignoredFolders"> = {}): boolean {
  const ignored = new Set(options.ignoredFolders ?? DEFAULT_CONFIG.ignoredFolders);
  for (const tsconfig of solution.projects) {
    const row = store.getProject(tsconfig);
    if (!row || row.indexedSchema !== SCHEMA_VERSION) return false;
    const tree = store.getTree(row.id);
    for (const [path, entry] of tree) {
      const stat = statOf(path);
      if (!stat || stat.mtime !== entry.mtime || stat.size !== entry.size) return false;
    }
    const tracked = new Set([...tree.keys()].map(pathKey));
    const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
    const dir = toSlashes(dirname(tsconfig));
    const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dir, undefined, tsconfig);
    for (const file of parsed.fileNames) {
      if (toSlashes(relative(dir, file)).split("/").some((segment) => ignored.has(segment))) continue;
      if (!tracked.has(pathKey(file))) return false;
    }
  }
  return true;
}

/** True when the document's file no longer has the indexed content (or cannot be read). */
export function isStale(hit: DocumentRow, cache?: Map<string, boolean>): boolean {
  const key = `${hit.path}\n${hit.contentHash}`;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;
  let stale: boolean;
  try {
    stale = contentHash(decodeText(readFileSync(hit.path))) !== hit.contentHash;
  } catch {
    stale = true;
  }
  cache?.set(key, stale);
  return stale;
}

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { IndexStore } from "../index/index.ts";
import type { DiscoveredSolution, LoadedProject, LoadedSolution, WorkspaceManager } from "../workspace/index.ts";
import {
  addRootFile, adoptRootFile, clearPackageCache, describeSolution, discoverSolutions, indexDocuments, indexSolution, MAX_DISCOVERY_DEPTH, normalizePath,
  pathKey, projectFileList, projectFilesChanged, readReferences, removeDocument, removeRootFile,
} from "../workspace/index.ts";
import { classifyChange } from "./classifier.ts";
import type { ChangeBatch } from "./debounce.ts";
import type { PendingRefreshes } from "./pending.ts";

export type ApplyContext = {
  manager: WorkspaceManager;
  store: IndexStore;
  pending: PendingRefreshes;
  ignoredFolders: readonly string[];
  /** Configured roots; without them new tsconfigs are not registered. */
  roots?: readonly string[];
  warn: (message: string) => void;
  now?: () => number;
};

export type ApplyReport = {
  applied: number;
  removed: number;
  added: number;
  reloaded: string[];
  reconciled: string[];
  pendingTouched: string[];
  extracted: number;
  /** tsconfig paths registered because they appeared. */
  discovered: string[];
  /** Names of the solutions forgotten because their tsconfig vanished. */
  forgotten: string[];
};

/** Counters and the paths to re-extract for one loaded solution. */
type Delta = { applied: number; removed: number; added: number; changed: string[] };

const BUSY_CODES = new Set(["EBUSY", "EPERM"]);
const MAX_RETRIES = 5;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** File text; null when the file is gone, undefined when it cannot be read (a warning was issued). */
function readText(path: string, warn: (message: string) => void): string | null | undefined {
  for (let attempt = 0; ; attempt++) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      if (!BUSY_CODES.has(code)) {
        warn(`domra: cannot read ${path}: ${code || String(error)}`);
        return undefined;
      }
      if (attempt >= MAX_RETRIES) {
        warn(`domra: cannot read ${path}: ${code} after ${MAX_RETRIES} retries`);
        return undefined;
      }
      sleep(50 * (attempt + 1));
    }
  }
}

/** The registered solution whose directory is the longest prefix of `path`. */
function solutionFor(manager: WorkspaceManager, path: string): DiscoveredSolution | undefined {
  const key = pathKey(path);
  let best: DiscoveredSolution | undefined;
  for (const solution of manager.solutions) {
    const dir = pathKey(solution.dir);
    if (key.startsWith(`${dir}/`) && (!best || dir.length > pathKey(best.dir).length)) best = solution;
  }
  return best;
}

/** Forget a solution (unload, unregister, drop pending refreshes and index rows); null when the hint matches nothing. */
export function forgetSolution(
  manager: WorkspaceManager, store: IndexStore, pending: PendingRefreshes | null, hint: string,
): { solution: DiscoveredSolution; projectsRemoved: number } | null {
  const solution = manager.forget(hint);
  if (!solution) return null;
  pending?.take(solution.path);
  return { solution, projectsRemoved: store.deleteSolution(solution.path) };
}

/** Forget every registered solution whose tsconfig no longer exists; returns their names. */
export function forgetMissing(
  manager: WorkspaceManager, store: IndexStore, pending: PendingRefreshes | null, warn: (message: string) => void,
): string[] {
  const names: string[] = [];
  for (const solution of manager.solutions) {
    if (existsSync(solution.path)) continue;
    const forgotten = forgetSolution(manager, store, pending, solution.path);
    if (!forgotten) continue;
    names.push(solution.name);
    warn(`domra: forgot ${solution.name} (${solution.path}): tsconfig is gone, ${forgotten.projectsRemoved} projects removed from the index`);
  }
  return names;
}

/** Whether a tsconfig.json path is discoverable like `discoverSolutions` would: under a root, depth <= 6, no ignored segment. */
function discoverable(path: string, roots: readonly string[], ignoredFolders: readonly string[]): boolean {
  const key = pathKey(path);
  const ignored = new Set(ignoredFolders.map((s) => s.toLowerCase()));
  for (const root of roots) {
    const rootKey = pathKey(root);
    if (!key.startsWith(`${rootKey}/`)) continue;
    const dirs = normalizePath(path).slice(normalizePath(root).length + 1).split("/").slice(0, -1);
    if (dirs.length <= MAX_DISCOVERY_DEPTH && !dirs.some((s) => ignored.has(s.toLowerCase()))) return true;
  }
  return false;
}

/** Whether a registered solution lists the tsconfig among its projects or references it directly (it may not exist yet when they were read). */
function isReferenced(manager: WorkspaceManager, key: string): boolean {
  return manager.solutions.some(
    (s) => s.projects.some((p) => pathKey(p) === key) || readReferences(s.path).some((r) => pathKey(r) === key),
  );
}

/** Register a tsconfig.json that appeared; false when it is owned, referenced, missing or outside the discovery rules. */
function registerAppeared(ctx: ApplyContext, path: string): boolean {
  if (basename(path) !== "tsconfig.json" || !ctx.roots || !existsSync(path)) return false;
  const key = pathKey(path);
  const owner = solutionFor(ctx.manager, path);
  if (owner && pathKey(owner.path) === key) return false;
  if (!discoverable(path, ctx.roots, ctx.ignoredFolders)) return false;
  if (isReferenced(ctx.manager, key)) return false;
  const described = describeSolution(path);
  ctx.manager.register(described);
  ctx.warn(`domra: discovered ${described.name} (${described.path})`);
  return true;
}

/** Register the not yet registered, discoverable results of a scan; returns their tsconfig paths. */
function registerScanned(ctx: ApplyContext, found: DiscoveredSolution[]): string[] {
  const registered: string[] = [];
  if (!ctx.roots) return registered;
  for (const solution of found) {
    const key = pathKey(solution.path);
    if (ctx.manager.isRegistered(solution.path) || !discoverable(solution.path, ctx.roots, ctx.ignoredFolders)) continue;
    if (isReferenced(ctx.manager, key)) continue;
    ctx.manager.register(solution);
    ctx.warn(`domra: discovered ${solution.name} (${solution.path})`);
    registered.push(solution.path);
  }
  return registered;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Directories that arrived whole (moved or renamed into a root); those inside a registered solution are skipped. */
function scanDirectories(ctx: ApplyContext, directories: ReadonlySet<string>): string[] {
  if (!ctx.roots) return [];
  const registered: string[] = [];
  for (const dir of directories) {
    if (!isDirectory(dir) || !discoverable(`${normalizePath(dir)}/tsconfig.json`, ctx.roots, ctx.ignoredFolders)) continue;
    if (solutionFor(ctx.manager, `${normalizePath(dir)}/tsconfig.json`)) continue;
    registered.push(...registerScanned(ctx, discoverSolutions([dir], ctx.ignoredFolders)));
  }
  return registered;
}

function projectFor(solution: LoadedSolution, path: string): LoadedProject | undefined {
  const key = pathKey(path);
  let best: LoadedProject | undefined;
  for (const project of solution.projects) {
    const dir = pathKey(project.dir);
    if (key.startsWith(`${dir}/`) && (!best || dir.length > pathKey(best.dir).length)) best = project;
  }
  return best;
}

/** Projects that have the file as a root or in their program. */
function ownersOf(solution: LoadedSolution, path: string): LoadedProject[] {
  const key = pathKey(path);
  return solution.projects.filter((p) => p.fileKeys.has(key) || p.service.getProgram()?.getSourceFile(path) !== undefined);
}

function pushHost(owners: LoadedProject[], path: string, text: string): boolean {
  let changed = false;
  for (const project of owners) {
    if (project.host.getText(path) !== text) {
      project.host.setFile(path, text);
      changed = true;
    }
  }
  return changed;
}

function applyDeleted(ctx: ApplyContext, solution: LoadedSolution, path: string, delta: Delta): void {
  const owners = ownersOf(solution, path);
  if (owners.length === 0) return;
  for (const project of owners) {
    project.host.setFile(path, null);
    removeRootFile(project, path);
  }
  removeDocument(ctx.store, solution, path);
  delta.removed++;
}

function applyPresent(solution: LoadedSolution, path: string, text: string, delta: Delta): void {
  let owners = ownersOf(solution, path);
  let isNew = false;
  if (owners.length === 0) {
    const project = projectFor(solution, path);
    if (!project || !addRootFile(project, path)) return;
    owners = [project];
    isNew = true;
  }
  const differs = pushHost(owners, path, text);
  if (isNew) delta.added++;
  else if (differs) delta.applied++;
  delta.changed.push(path);
}

function applySource(ctx: ApplyContext, solution: LoadedSolution, path: string, delta: Delta): void {
  const text = readText(path, ctx.warn);
  if (text === undefined) return;
  if (text === null) applyDeleted(ctx, solution, path, delta);
  else applyPresent(solution, path, text, delta);
}

function statOf(path: string): { mtime: number; size: number } | null {
  try {
    const stat = statSync(path);
    return { mtime: Math.trunc(stat.mtimeMs), size: stat.size };
  } catch {
    return null;
  }
}

/** Compare every indexed file of the solution by mtime+size, then pick up files newly listed by the tsconfigs. */
function reconcileSolution(ctx: ApplyContext, solution: LoadedSolution): { delta: Delta; extracted: number } {
  const started = performance.now();
  const delta: Delta = { applied: 0, removed: 0, added: 0, changed: [] };
  const seen = new Set<string>();
  for (const project of solution.projects) {
    const row = ctx.store.getProject(project.tsconfig);
    if (!row) continue;
    for (const [path, entry] of ctx.store.getTree(row.id)) {
      const key = pathKey(path);
      if (seen.has(key)) continue;
      seen.add(key);
      const stat = statOf(path);
      if (!stat) applyDeleted(ctx, solution, path, delta);
      else if (stat.mtime !== entry.mtime || stat.size !== entry.size) applySource(ctx, solution, path, delta);
    }
  }
  for (const project of solution.projects) {
    for (const file of projectFileList(project)) {
      if (project.fileKeys.has(pathKey(file))) continue;
      const text = readText(file, ctx.warn);
      if (typeof text !== "string") continue;
      adoptRootFile(project, file);
      pushHost([project], file, text);
      delta.added++;
      delta.changed.push(file);
    }
  }
  const extracted = indexDocuments(ctx.store, solution, delta.changed).documentsExtracted;
  const ms = Math.round(performance.now() - started);
  ctx.warn(
    `domra: Reconciled ${solution.name}: ${delta.applied} updated, ${delta.added} added, ${delta.removed} removed, ${extracted} extracted in ${ms}ms`,
  );
  return { delta, extracted };
}

/**
 * Apply one debounced batch of changed paths to the loaded solutions and the index; changes under
 * solutions that are not loaded are recorded as pending refreshes. Rules are listed in docs/watcher.md.
 */
export function applyChanges(ctx: ApplyContext, batch: ChangeBatch): ApplyReport {
  const now = ctx.now ?? Date.now;
  const report: ApplyReport = {
    applied: 0, removed: 0, added: 0, reloaded: [], reconciled: [], pendingTouched: [], extracted: 0, discovered: [], forgotten: [],
  };
  report.forgotten = forgetMissing(ctx.manager, ctx.store, ctx.pending, ctx.warn);
  const loadedKeys = new Set(ctx.manager.loadedSolutions.map((s) => pathKey(s.path)));
  const touch = (solution: DiscoveredSolution, file: string): void => {
    ctx.pending.touch(solution.path, file, now());
    if (!report.pendingTouched.includes(solution.path)) report.pendingTouched.push(solution.path);
  };
  const appeared = new Set<string>();
  const touchUnloaded = (): void => {
    for (const solution of ctx.manager.solutions) {
      const key = pathKey(solution.path);
      if (!loadedKeys.has(key) && !appeared.has(key)) touch(solution, solution.path);
    }
  };

  const kinds = [...batch.paths].map((path) => ({ path, kind: classifyChange(path, ctx.ignoredFolders) }));
  if (batch.overflowed || kinds.some((k) => k.kind === "git" || k.kind === "project")) clearPackageCache();

  const found: string[] = [];
  if (batch.overflowed && ctx.roots) found.push(...registerScanned(ctx, discoverSolutions(ctx.roots, ctx.ignoredFolders)));
  if (batch.directories) found.push(...scanDirectories(ctx, batch.directories));
  for (const { path, kind } of kinds) {
    if (kind === "project" && registerAppeared(ctx, path)) found.push(normalizePath(path));
  }
  for (const path of found) {
    appeared.add(pathKey(path));
    report.discovered.push(normalizePath(path));
  }

  if (batch.overflowed || kinds.some((k) => k.kind === "git")) {
    const loaded = ctx.manager.loadedSolutions;
    ctx.warn(`domra: Git HEAD changed; reconciling ${loaded.length} loaded solutions`);
    for (const solution of loaded) {
      const { delta, extracted } = reconcileSolution(ctx, solution);
      report.applied += delta.applied;
      report.removed += delta.removed;
      report.added += delta.added;
      report.extracted += extracted;
      report.reconciled.push(solution.name);
    }
    for (const solution of loaded) {
      if (!projectFilesChanged(solution)) continue;
      const started = performance.now();
      const reloaded = ctx.manager.reload(solution.path);
      indexSolution(ctx.store, reloaded, { ignoredFolders: ctx.ignoredFolders });
      report.reloaded.push(reloaded.name);
      ctx.warn(`domra: ${reloaded.name}: project file changed, reloaded in ${Math.round(performance.now() - started)}ms`);
    }
    touchUnloaded();
    return report;
  }

  const reloadedKeys = new Set<string>();
  for (const { path, kind } of kinds) {
    if (kind !== "project" || appeared.has(pathKey(path))) continue;
    const solution = solutionFor(ctx.manager, path);
    if (!solution) continue;
    const key = pathKey(solution.path);
    if (!loadedKeys.has(key)) {
      touch(solution, path);
    } else if (!reloadedKeys.has(key)) {
      reloadedKeys.add(key);
      const started = performance.now();
      const loaded = ctx.manager.reload(solution.path);
      indexSolution(ctx.store, loaded, { ignoredFolders: ctx.ignoredFolders });
      report.reloaded.push(loaded.name);
      ctx.warn(`domra: ${loaded.name}: project file changed, reloaded in ${Math.round(performance.now() - started)}ms`);
    }
  }

  const deltas = new Map<string, { solution: LoadedSolution; delta: Delta }>();
  for (const { path, kind } of kinds) {
    if (kind !== "source") continue;
    const discovered = solutionFor(ctx.manager, path);
    if (!discovered) continue;
    const key = pathKey(discovered.path);
    if (appeared.has(key)) continue;
    if (!loadedKeys.has(key)) {
      touch(discovered, path);
      continue;
    }
    if (reloadedKeys.has(key)) continue;
    const solution = ctx.manager.resolveSolution(discovered.path);
    if (!solution) continue;
    let entry = deltas.get(key);
    if (!entry) {
      entry = { solution, delta: { applied: 0, removed: 0, added: 0, changed: [] } };
      deltas.set(key, entry);
    }
    applySource(ctx, solution, path, entry.delta);
  }
  for (const { solution, delta } of deltas.values()) {
    const extracted = indexDocuments(ctx.store, solution, delta.changed).documentsExtracted;
    report.applied += delta.applied;
    report.removed += delta.removed;
    report.added += delta.added;
    report.extracted += extracted;
    const total = delta.applied + delta.removed + delta.added;
    if (total > 0) ctx.warn(`domra: ${solution.name}: applied ${total} file changes, ${extracted} documents re-extracted`);
  }
  return report;
}

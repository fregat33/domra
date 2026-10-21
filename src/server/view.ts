import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { DiscoveredSolution, WorkspaceManager } from "../workspace/index.ts";
import { normalizePath, pathKey } from "../workspace/index.ts";
import type { ToolContext } from "./tools.ts";

/** What a handler needs to know about the request's parts. */
export type View = {
  /** Normalized directories of the `part` parameters. */
  parts: string[];
  /** Registered solutions inside the parts. */
  partSolutions(): DiscoveredSolution[];
};

type Linked = { main: string } | null;

const inside = (key: string, root: string): boolean => key === root || key.startsWith(`${root}/`);

/** Nearest `.git` entry above `dir`: its path and whether it is a file (a linked worktree or submodule). */
function gitEntry(dir: string): { path: string; isFile: boolean } | null {
  for (let current = normalizePath(dir); ; current = dirname(current)) {
    const path = `${current.replace(/\/$/, "")}/.git`;
    if (existsSync(path)) {
      try {
        return { path, isFile: statSync(path).isFile() };
      } catch {
        return null;
      }
    }
    if (dirname(current) === current) return null;
  }
}

/**
 * Which solutions are private (inside a linked git worktree) and where the main checkout of a worktree is.
 * One `git` process per worktree, cached; a registration drops the entry of its solution.
 */
export class Slots {
  private readonly gitPath: string;
  private readonly byWorktree = new Map<string, Linked>();
  private readonly bySolution = new Map<string, boolean>();

  constructor(gitPath: string, manager: WorkspaceManager) {
    this.gitPath = gitPath;
    manager.onRegister = (solution) => {
      this.bySolution.delete(pathKey(solution.path));
    };
  }

  /** The main checkout when `dir` is inside a linked worktree (`--git-dir` differs from `--git-common-dir`), else null. */
  linked(dir: string): Linked {
    const entry = gitEntry(dir);
    if (entry === null || !entry.isFile) return null;
    const key = pathKey(entry.path);
    if (this.byWorktree.has(key)) return this.byWorktree.get(key)!;
    let result: Linked = null;
    try {
      const out = execFileSync(this.gitPath, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], {
        cwd: dirname(entry.path), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000,
      });
      const [gitDir, common] = out.split(/\r?\n/).map((line) => line.trim());
      if (gitDir && common && pathKey(gitDir) !== pathKey(common)) result = { main: normalizePath(dirname(common)) };
    } catch {
      result = null;
    }
    if (result !== null) this.byWorktree.set(key, result);
    return result;
  }

  isPrivate(solution: { path: string; dir: string }): boolean {
    const key = pathKey(solution.path);
    let known = this.bySolution.get(key);
    if (known === undefined) {
      known = this.linked(solution.dir) !== null;
      this.bySolution.set(key, known);
    }
    return known;
  }
}

/**
 * The context of one request: the manager and the index store show only the solutions the `part` parameters
 * make visible. Text instead of a context when a part is unknown or two parts share a repository.
 */
export function openView(base: ToolContext, parts: string[]): { ctx: ToolContext } | { error: string } {
  const { manager, slots } = base;
  const dirs: string[] = [];
  for (const part of parts) {
    const dir = normalizePath(part);
    if (!dirs.some((d) => pathKey(d) === pathKey(dir))) dirs.push(dir);
  }
  const mains: string[] = [];
  const mainOf: string[] = [];
  for (const dir of dirs) {
    const key = pathKey(dir);
    const linked = slots.linked(dir);
    if (linked === null || !manager.solutions.some((s) => inside(pathKey(s.dir), key))) return { error: `Unknown part: ${dir}` };
    mains.push(pathKey(linked.main));
    mainOf.push(dir);
  }
  for (let i = 0; i < mains.length; i++) {
    const j = mains.indexOf(mains[i]!, i + 1);
    if (j > 0) return { error: `Two parts of one repository: ${mainOf[i]}, ${mainOf[j]}` };
  }
  const partKeys = dirs.map(pathKey);
  const inPart = (s: { dir: string }): boolean => partKeys.some((p) => inside(pathKey(s.dir), p));
  const allows = (s: { path: string; dir: string }): boolean => {
    if (inPart(s)) return true;
    if (slots.isPrivate(s)) return false;
    const key = pathKey(s.dir);
    return !mains.some((m) => inside(key, m));
  };
  const view: View = { parts: dirs, partSolutions: () => manager.solutions.filter(inPart) };
  const hidden = manager.solutions.filter((s) => !allows(s)).map((s) => s.path);
  return {
    ctx: { ...base, manager: manager.restrict(allows, inPart), store: base.store.restrict(hidden), view },
  };
}

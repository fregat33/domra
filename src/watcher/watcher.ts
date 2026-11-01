import type { FSWatcher } from "node:fs";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveGitHead } from "./gitHead.ts";
import { normalizePath, pathKey } from "../workspace/index.ts";
import { classifyChange } from "./classifier.ts";
import { ChangeDebouncer } from "./debounce.ts";
import type { ChangeBatch } from "./debounce.ts";

export type RepoWatcherOptions = {
  roots: readonly string[];
  ignoredFolders: readonly string[];
  quietMs: number;
  maxWaitMs?: number;
  onBatch: (batch: ChangeBatch) => void;
  warn: (message: string) => void;
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

type RefTarget = { dir: string; filter: string; watcher: FSWatcher };

type RootState = {
  root: string;
  event: string;
  gitDir: string;
  /** `ino:birthtimeMs` of the git dir when its watchers were made; a different value means it was recreated. */
  identity: string;
  linked: boolean;
  head: FSWatcher | null;
  ref: RefTarget | null;
  packed: RefTarget | null;
};

function gitDirIdentity(gitDir: string): string {
  try {
    const stat = statSync(gitDir);
    return `${stat.ino}:${stat.birthtimeMs}`;
  } catch {
    return "";
  }
}

/** Nearest existing directory at or below `<common>/refs/heads` on the way to the loose ref, and the name to filter on. */
function refTarget(commonDir: string, looseRef: string): { dir: string; filter: string } | null {
  const heads = normalizePath(join(commonDir, "refs", "heads"));
  let dir = normalizePath(dirname(looseRef));
  while (!isDirectory(dir) && dir !== heads && dir.length > heads.length) dir = normalizePath(dirname(dir));
  if (!isDirectory(dir) || !(dir === heads || dir.startsWith(`${heads}/`))) return null;
  const rest = looseRef.slice(dir.length + 1);
  const filter = rest.split("/")[0];
  return filter ? { dir, filter } : null;
}

/** The git dir a `<root>/.git` file points to (`gitdir: <path>`); null when `.git` is a directory, missing or unreadable. */
function linkedGitDir(root: string): string | null {
  const dotGit = join(root, ".git");
  try {
    if (!statSync(dotGit).isFile()) return null;
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    return match ? normalizePath(resolve(root, match[1]!)) : null;
  } catch {
    return null;
  }
}

/** Recursive `fs.watch` per root; relevant paths go through a debouncer into `onBatch`. */
export class RepoWatcher {
  private readonly options: RepoWatcherOptions;
  private readonly debouncer: ChangeDebouncer;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly roots_ = new Map<string, RootState>();
  private closed = false;

  constructor(options: RepoWatcherOptions) {
    this.options = options;
    this.debouncer = new ChangeDebouncer({
      quietMs: options.quietMs,
      ...(options.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : {}),
      onFlush: options.onBatch,
    });
  }

  /** Watched roots. */
  get roots(): string[] {
    return [...this.watchers.keys()];
  }

  /** Paths held in the debouncer, not yet handed to `onBatch`. */
  get buffered(): number {
    return this.debouncer.buffered;
  }

  /**
   * Watch the real HEAD of every linked worktree (or submodule) that holds one of `dirs`, one watch per git dir; watches of
   * git dirs no solution needs any more are closed. A change of such a HEAD enters the debouncer as `<repo>/.git/HEAD`.
   */
  syncWorktrees(dirs: readonly string[], repoRootOf: (dir: string) => string | null): void {
    if (this.closed) return;
    const wanted = new Map<string, string>();
    for (const dir of dirs) {
      const root = repoRootOf(dir);
      if (root !== null) wanted.set(pathKey(root), normalizePath(root));
    }
    for (const [key, state] of this.roots_) {
      if (wanted.has(key)) continue;
      this.closeState(state);
      this.roots_.delete(key);
    }
    for (const [key, root] of wanted) {
      const info = resolveGitHead(root);
      if (info === null) {
        const old = this.roots_.get(key);
        if (old) this.closeState(old);
        this.roots_.delete(key);
        continue;
      }
      const gitDir = normalizePath(dirname(info.headPath));
      const identity = gitDirIdentity(gitDir);
      let state = this.roots_.get(key);
      if (state && (state.gitDir !== gitDir || state.identity !== identity)) {
        this.closeState(state);
        state = undefined;
      }
      if (!state) {
        state = { root, event: `${root}/.git/HEAD`, gitDir, identity, linked: linkedGitDir(root) !== null, head: null, ref: null, packed: null };
        this.roots_.set(key, state);
      }
      if (state.linked && state.head === null) this.attachHead(state);
      this.repoint(state);
    }
  }

  /** Git dirs whose HEAD is watched because a registered solution lives in a linked worktree. */
  get worktreeHeads(): string[] {
    return [...this.roots_.values()].filter((s) => s.head !== null).map((s) => pathKey(s.gitDir));
  }

  /** Sorted `dir/filter` of every ref and packed-refs watcher. */
  get refWatchTargets(): string[] {
    const out: string[] = [];
    for (const state of this.roots_.values()) {
      for (const target of [state.ref, state.packed]) if (target) out.push(`${target.dir}/${target.filter}`);
    }
    return out.sort();
  }

  private closeState(state: RootState): void {
    state.head?.close();
    state.head = null;
    state.ref?.watcher.close();
    state.ref = null;
    state.packed?.watcher.close();
    state.packed = null;
  }

  private openWatch(dir: string, filter: string | null, onEvent: () => void, onError: () => void): FSWatcher | null {
    try {
      const watcher = watch(dir, (_event, filename) => {
        if (this.closed) return;
        if (filter === null || filename === null || filename === undefined || filename.toString() === filter) onEvent();
      });
      watcher.on("error", (error: Error) => {
        this.options.warn(`domra: watcher error on ${dir}: ${error.message}`);
        watcher.close();
        onError();
      });
      return watcher;
    } catch (error) {
      this.options.warn(`domra: watcher error on ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private attachHead(state: RootState): void {
    if (!existsSync(state.gitDir)) return;
    const watcher = this.openWatch(state.gitDir, "HEAD", () => {
      this.debouncer.add(state.event);
      this.repoint(state);
    }, () => {
      if (state.head === watcher) state.head = null;
      this.debouncer.add(state.event);
    });
    state.head = watcher;
  }

  /** Re-resolve the ref and packed-refs targets of a checkout; unchanged targets keep their watchers. */
  private repoint(state: RootState): void {
    if (this.closed || this.roots_.get(pathKey(state.root)) !== state) return;
    const info = resolveGitHead(state.root);
    const ref = info?.looseRef ? refTarget(info.commonDir, info.looseRef) : null;
    const packed = info?.packedRefs ? { dir: info.commonDir, filter: "packed-refs" } : null;
    for (const slot of ["ref", "packed"] as const) {
      const desired = slot === "ref" ? ref : packed;
      const current = state[slot];
      if (current && desired && current.dir === desired.dir && current.filter === desired.filter) continue;
      current?.watcher.close();
      state[slot] = null;
      if (!desired || !isDirectory(desired.dir)) continue;
      const watcher = this.openWatch(desired.dir, desired.filter, () => {
        this.debouncer.add(state.event);
        this.repoint(state);
      }, () => {
        if (state[slot]?.watcher === watcher) state[slot] = null;
        this.debouncer.add(state.event);
      });
      if (watcher) state[slot] = { ...desired, watcher };
    }
  }

  start(): void {
    for (const root of this.options.roots) {
      if (!existsSync(root)) {
        this.options.warn(`domra: watch root missing: ${root}`);
        continue;
      }
      if (this.attach(root, true)) this.options.warn(`domra: Watching ${root}`);
    }
  }

  close(): void {
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const state of this.roots_.values()) this.closeState(state);
    this.roots_.clear();
    this.debouncer.dispose();
  }

  private attach(root: string, retry: boolean): boolean {
    let watcher: FSWatcher;
    try {
      watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (filename === null || filename === undefined) return;
        const relative = filename.toString();
        const path = normalizePath(join(root, relative));
        const ignored = new Set(this.options.ignoredFolders.map((s) => s.toLowerCase()));
        if (isDirectory(path)) {
          if (!relative.split(/[\\/]/).some((s) => ignored.has(s.toLowerCase()))) this.debouncer.addDirectory(path);
          return;
        }
        if (classifyChange(path, this.options.ignoredFolders) !== "ignored") this.debouncer.add(path);
      });
    } catch (error) {
      this.options.warn(`domra: watcher error on ${root}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    watcher.on("error", (error: Error) => {
      this.options.warn(`domra: watcher error on ${root}: ${error.message}`);
      this.debouncer.markOverflow(root);
      watcher.close();
      this.watchers.delete(root);
      if (retry && !this.closed) this.attach(root, false);
    });
    this.watchers.set(root, watcher);
    return true;
  }
}

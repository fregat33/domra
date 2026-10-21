import type { FSWatcher } from "node:fs";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
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
  private readonly headWatchers = new Map<string, FSWatcher>();
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
    const wanted = new Map<string, { gitDir: string; event: string }>();
    for (const dir of dirs) {
      const root = repoRootOf(dir);
      const gitDir = root === null ? null : linkedGitDir(root);
      if (root !== null && gitDir !== null) wanted.set(pathKey(gitDir), { gitDir, event: `${normalizePath(root)}/.git/HEAD` });
    }
    for (const [key, watcher] of this.headWatchers) {
      if (wanted.has(key)) continue;
      watcher.close();
      this.headWatchers.delete(key);
    }
    for (const [key, { gitDir, event }] of wanted) {
      if (this.headWatchers.has(key) || !existsSync(gitDir)) continue;
      try {
        const watcher = watch(gitDir, (_event, filename) => {
          if (filename?.toString() === "HEAD") this.debouncer.add(event);
        });
        watcher.on("error", (error: Error) => {
          this.options.warn(`domra: watcher error on ${gitDir}: ${error.message}`);
          watcher.close();
          this.headWatchers.delete(key);
          this.debouncer.add(event);
        });
        this.headWatchers.set(key, watcher);
      } catch (error) {
        this.options.warn(`domra: watcher error on ${gitDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Git dirs whose HEAD is watched because a registered solution lives in a linked worktree. */
  get worktreeHeads(): string[] {
    return [...this.headWatchers.keys()];
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
    for (const watcher of this.headWatchers.values()) watcher.close();
    this.headWatchers.clear();
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
      this.debouncer.markOverflow();
      watcher.close();
      this.watchers.delete(root);
      if (retry && !this.closed) this.attach(root, false);
    });
    this.watchers.set(root, watcher);
    return true;
  }
}

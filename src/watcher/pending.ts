import { basename, dirname } from "node:path";

export type PendingEntry = { first: number; last: number; paths: Set<string> };

/** Changes under solutions that are not loaded, waiting for a deferred load-index-unload refresh. */
export class PendingRefreshes {
  private readonly items = new Map<string, PendingEntry>();

  touch(solutionPath: string, filePath: string, now: number = Date.now()): void {
    const entry = this.items.get(solutionPath);
    if (entry) {
      entry.last = now;
      entry.paths.add(filePath);
    } else {
      this.items.set(solutionPath, { first: now, last: now, paths: new Set([filePath]) });
    }
  }

  /** Solutions quiet for `quietMs` or waiting for `maxWaitMs`; a limit of 0 disables that rule. */
  due(now: number, limits: { quietMs: number; maxWaitMs: number }): string[] {
    const result: string[] = [];
    for (const [path, entry] of this.items) {
      const quiet = limits.quietMs > 0 && now - entry.last >= limits.quietMs;
      const waited = limits.maxWaitMs > 0 && now - entry.first >= limits.maxWaitMs;
      if (quiet || waited) result.push(path);
    }
    return result;
  }

  take(solutionPath: string): PendingEntry | undefined {
    const entry = this.items.get(solutionPath);
    this.items.delete(solutionPath);
    return entry;
  }

  entries(): [string, PendingEntry][] {
    return [...this.items];
  }

  /** The status line; `visible` keeps only the entries of solutions the caller may see. */
  statusLine(now: number = Date.now(), visible: (solutionPath: string) => boolean = () => true): string {
    const shown = this.entries().filter(([path]) => visible(path));
    if (shown.length === 0) return "Unloaded refresh: none pending";
    const parts = shown.map(([path, entry]) => {
      const seconds = Math.max(0, Math.round((now - entry.last) / 1000));
      return `${basename(dirname(path))} (${entry.paths.size} files, last change ${seconds}s ago)`;
    });
    return `Unloaded refresh: ${parts.join(", ")}`;
  }
}

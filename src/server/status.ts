import type { WorkspaceManager } from "../workspace/index.ts";
import { indexSolution, pathKey } from "../workspace/index.ts";
import { formatStats } from "../index/index.ts";
import { forgetSolution } from "../watcher/index.ts";
import type { ToolContext } from "./tools.ts";
import { loadHinted, unknownSolutionText } from "./select.ts";

const MB = 1024 * 1024;

function seconds(ms: number | null): string {
  return ((ms ?? 0) / 1000).toFixed(1);
}

const pad = (n: number): string => String(n).padStart(2, "0");

function clock(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function warmUpText(ctx: ToolContext): string {
  const warm = ctx.warmUp;
  if (!warm.ran) return "";
  if (warm.done < warm.total) {
    return `Warm-up: ${warm.done} of ${warm.total} done${warm.current === null ? "" : `, loading ${warm.current}`}\n`;
  }
  const failed = warm.failed ?? [];
  const failures = failed.length > 0 ? `, ${failed.length} failed (${failed.join(", ")})` : "";
  return `Warm-up: done, ${warm.warmed} warmed, ${warm.fresh} already fresh${failures}\n`;
}

/** Start the one-time git probe if it has not started; the result shows in `Git:` of a later `status`. Never throws. */
export function startGitProbe(ctx: ToolContext): void {
  const probe = ctx.gitProbe;
  if (!probe || probe.started) return;
  probe.started = true;
  const git = ctx.git;
  const run = async (): Promise<string> => {
    if (git.version) {
      const result = await git.version();
      return "version" in result ? result.version : `not found (${result.error})`;
    }
    const error = await git.probe();
    return error === null ? "git version unknown" : `not found (${error})`;
  };
  void run().then(
    (line) => void (probe.line = line.split(/\r?\n/)[0] ?? ""),
    (error: unknown) => void (probe.line = `not found (${(error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]})`),
  );
}

function gitText(ctx: ToolContext): string {
  startGitProbe(ctx);
  return `Git: ${ctx.gitProbe?.line ?? "not probed yet"}\n`;
}

/** The pathKeys of the solutions `preload` and `defaultSolution` name. */
export function pinnedKeys(ctx: Pick<ToolContext, "manager" | "pinned">): Set<string> {
  const keys = new Set<string>();
  for (const name of ctx.pinned ?? []) {
    const found = ctx.manager.findRegistered(name);
    if (found) keys.add(pathKey(found.path));
  }
  return keys;
}

function watcherText(ctx: ToolContext): string {
  if (!ctx.watcher || !ctx.pending) return "Watcher: off\n";
  const { batches, lastBatch } = ctx.changes;
  const last = lastBatch ? `, last batch ${clock(lastBatch.at)} ${lastBatch.files} files` : "";
  return `Watcher: ${ctx.watcher.roots.length} roots, ${batches} batches applied${last}, ${ctx.watcher.buffered} buffered\n${ctx.pending.statusLine(Date.now(), (path) => ctx.manager.isRegistered(path))}\n`;
}

function readyText(ctx: ToolContext): string {
  const jobs = ctx.jobs.pending;
  const buffered = ctx.watcher?.buffered ?? 0;
  return jobs === 0 && buffered === 0 ? "Ready: yes\n" : `Ready: no (${jobs} jobs, ${buffered} buffered)\n`;
}

/** Record `git rev-parse HEAD` of the solution's directory; null outside git, when git is unavailable or fails. */
export async function recordHead(ctx: ToolContext, solution: { path: string; dir: string }): Promise<void> {
  let head: string | null = null;
  try {
    head = (await ctx.git.head?.(solution.dir)) ?? null;
  } catch {
    head = null;
  }
  ctx.heads.set(pathKey(solution.path), head);
}

/**
 * Process memory, index counts, job queue, warm-up progress and one line per known solution, sorted by path.
 * Index counts, the unloaded-refresh line and the solution rows follow the view; the other lines are global.
 */
export function statusText(ctx: ToolContext): string {
  const memory = process.memoryUsage();
  let text = `Process: ${Math.round(memory.rss / MB)} MB RSS, heap ${Math.round(memory.heapUsed / MB)} MB\n`;
  text += `Index: ${ctx.store.path}\n  ${formatStats(ctx.store.stats())}\n`;
  const last = ctx.jobs.lastCompleted;
  text += `Jobs: ${ctx.jobs.pending} pending${last ? `, last completed ${clock(last.at)} ${last.name}` : ""}\n`;
  text += watcherText(ctx);
  text += readyText(ctx);
  text += gitText(ctx);
  text += `${warmUpText(ctx)}Solutions:\n`;
  const rows = ctx.manager.status().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const pinned = pinnedKeys(ctx);
  for (const s of rows) {
    const head = ctx.heads.get(pathKey(s.path))?.slice(0, 7) ?? "-";
    if (s.state === "loaded") {
      const used = s.lastUsed === null ? "-" : clock(new Date(s.lastUsed));
      text += `  ${s.name}  loaded${pinned.has(pathKey(s.path)) ? " pinned" : ""}  ${s.projects.length} projects, ${s.sourceFiles ?? 0} source files, loaded in ${seconds(s.loadMs)}s, last used ${used}  head ${head}  ${s.path}\n`;
    } else {
      text += `  ${s.name}  registered  head ${head}  ${s.path}${s.error === null ? "" : `  error: ${s.error}`}\n`;
    }
  }
  return text;
}

export function loadSolutionText(manager: WorkspaceManager, hint: string): string {
  const solution = loadHinted(manager, hint);
  if (solution === null) return unknownSolutionText(manager, hint);
  return `${solution.name}: ${solution.projects.length} projects loaded in ${seconds(solution.loadMs)}s, ${solution.unresolvedImports} unresolved imports.`;
}

export function forgetSolutionText(ctx: ToolContext, hint: string): string {
  const forgotten = forgetSolution(ctx.manager, ctx.store, ctx.pending, hint);
  if (forgotten === null) return unknownSolutionText(ctx.manager, hint);
  if ("ambiguous" in forgotten) {
    const text = hint.trim();
    const list = forgotten.ambiguous.map((s) => `${s.name} (${s.path})`).join(", ");
    const allExact = forgotten.ambiguous.every((s) => s.name.toLowerCase() === text.toLowerCase());
    return `Ambiguous solution: ${text} matches ${list}. ${allExact ? "Use the full path." : "Use the full path or the exact name."}`;
  }
  const { solution, projectsRemoved } = forgotten;
  ctx.syncWatch?.();
  return `Forgot ${solution.name} (${solution.path}): ${projectsRemoved} projects removed from the index.`;
}

/** Queue `index {solution}` for a loaded solution; skipped when it was unloaded meanwhile. */
export function enqueueIndex(ctx: ToolContext, solution: { name: string; path: string }, force = false): void {
  void ctx.jobs.enqueue(`index ${solution.name}`, async () => {
    const loaded = ctx.manager.peekSolution(solution.path);
    if (!loaded) return;
    indexSolution(ctx.store, loaded, { force, ignoredFolders: ctx.ignoredFolders });
    await recordHead(ctx, loaded);
  });
}

/** `hint` blank or absent means the configured default solution; 'all' (any case, trimmed) means every loaded one. */
export function reindexText(ctx: ToolContext, rawHint: string | undefined, force: boolean): string {
  const flag = `(force=${force})`;
  const given = (rawHint ?? "").trim();
  const hint = given === "" ? (ctx.defaultSolution ?? "") : given;
  if (hint === "") return unknownSolutionText(ctx.manager, "");
  if (hint.toLowerCase() === "all") {
    const loaded = ctx.manager.loadedSolutions;
    for (const solution of loaded) enqueueIndex(ctx, solution, force);
    return `Queued reindex of ${loaded.length} loaded solutions ${flag}.`;
  }
  const loaded = ctx.manager.resolveSolution(hint);
  if (loaded) {
    enqueueIndex(ctx, loaded, force);
    return `Queued reindex of ${loaded.name} ${flag}.`;
  }
  const registered = ctx.manager.findRegistered(hint);
  if (registered === null) return unknownSolutionText(ctx.manager, hint);
  void ctx.jobs.enqueue(`load ${registered.name}`, () => {
    if (!ctx.manager.isRegistered(registered.path)) return;
    ctx.manager.load(registered.path);
    if (force) enqueueIndex(ctx, registered, true);
  });
  return `${registered.name} was not loaded; load started, indexing follows automatically.`;
}

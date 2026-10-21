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
  return `Warm-up: done, ${warm.warmed} warmed, ${warm.fresh} already fresh\n`;
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
  text += `${warmUpText(ctx)}Solutions:\n`;
  const rows = ctx.manager.status().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const s of rows) {
    const head = ctx.heads.get(pathKey(s.path))?.slice(0, 7) ?? "-";
    text +=
      s.state === "loaded"
        ? `  ${s.name}  loaded  ${s.projects.length} projects, ${s.sourceFiles ?? 0} source files, loaded in ${seconds(s.loadMs)}s  ${s.path}  HEAD ${head}\n`
        : `  ${s.name}  registered  ${s.path}  HEAD ${head}\n`;
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
  const { solution, projectsRemoved } = forgotten;
  ctx.syncWatch?.();
  return `Forgot ${solution.name} (${solution.path}): ${projectsRemoved} projects removed from the index.`;
}

/** Queue `index {solution}` for a loaded solution; skipped when it was unloaded meanwhile. */
export function enqueueIndex(ctx: ToolContext, solution: { name: string; path: string }, force = false): void {
  void ctx.jobs.enqueue(`index ${solution.name}`, async () => {
    const loaded = ctx.manager.resolveSolution(solution.path);
    if (!loaded) return;
    indexSolution(ctx.store, loaded, { force, ignoredFolders: ctx.ignoredFolders });
    await recordHead(ctx, loaded);
  });
}

export function reindexText(ctx: ToolContext, hint: string, force: boolean): string {
  const flag = `(force=${force})`;
  if (hint === "all") {
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

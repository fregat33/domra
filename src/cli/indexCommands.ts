import type { SymbolHit } from "../index/index.ts";
import { formatStats, IndexStore } from "../index/index.ts";
import type { WorkspaceManager } from "../workspace/index.ts";
import { indexSolution, normalizePath, pathKey } from "../workspace/index.ts";
import { driftLines } from "../server/drift.ts";
import type { CliIo } from "./cli.ts";

function statusLine(store: IndexStore): string {
  return `Index: ${store.path}  ${formatStats(store.stats())}\n`;
}

function withStore<T>(dbPath: string, fn: (store: IndexStore) => T): T {
  const store = IndexStore.open(dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** `index`: index every loaded solution, one line per solution, then the `Index:` line. */
export function indexCommand(manager: WorkspaceManager, dbPath: string, force: boolean, io: CliIo): number {
  return withStore(dbPath, (store) => {
    for (const solution of manager.loadedSolutions) {
      const r = indexSolution(store, solution, { force });
      io.stdout.write(
        `${solution.name}: ${r.projectsVisited} projects, ${r.documentsVisited} documents, ${r.documentsExtracted} extracted, ` +
          `${r.documentsReused} reused, ${r.treeEntriesRemoved} removed, ${r.elapsedMs} ms\n`,
      );
    }
    io.stdout.write(statusLine(store));
    return 0;
  });
}

const solutionName = (solutionPath: string): string => {
  const dir = solutionPath.slice(0, solutionPath.lastIndexOf("/"));
  return dir.slice(dir.lastIndexOf("/") + 1);
};

/** `index-search`: ranked hits of the index under `root`, grouped by solution, without loading anything. */
export function indexSearchCommand(dbPath: string, root: string, pattern: string, kind: string | null, limit: number, io: CliIo): number {
  return withStore(dbPath, (store) => {
    const rootKey = `${pathKey(root).replace(/\/$/, "")}/`;
    const groups = new Map<string, SymbolHit[]>();
    for (const hit of store.searchSymbols(pattern, kind, limit)) {
      const solution = hit.document.solutionPath;
      if (!pathKey(solution).startsWith(rootKey)) continue;
      groups.set(solution, [...(groups.get(solution) ?? []), hit]);
    }
    if (groups.size === 0) {
      io.stdout.write(`No symbols match ${pattern}. Patterns support camel-case humps (e.g. UOC for UpdateOrderCommand).\n`);
      return 0;
    }
    const lines: string[] = [];
    for (const solution of [...groups.keys()].sort((a, b) => (pathKey(a) < pathKey(b) ? -1 : 1))) {
      const hits = groups.get(solution)!;
      lines.push(`Index ${solutionName(normalizePath(solution))} (${hits.length}):`);
      for (const h of hits) lines.push(`  ${h.kind} ${h.fqName}  ${h.document.path}:${h.line}:${h.col}`);
    }
    io.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  });
}

/** `drift`: the `package_drift` text of the index. */
export function driftCommand(dbPath: string, limit: number, io: CliIo): number {
  return withStore(dbPath, (store) => {
    const { items, footer } = driftLines(store.findPackageDrift(), limit);
    io.stdout.write(`${[...items, footer].join("\n")}\n`);
    return 0;
  });
}

/** `index-status`: the `Index:` line. */
export function indexStatusCommand(dbPath: string, io: CliIo): number {
  return withStore(dbPath, (store) => {
    io.stdout.write(statusLine(store));
    return 0;
  });
}

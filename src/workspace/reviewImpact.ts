import ts from "typescript";
import type { SymbolRow } from "../index/index.ts";
import { pathKey } from "./discovery.ts";
import { docIdOf } from "./extractor.ts";
import type { RelationCounts } from "./implementations.ts";
import { relationCounter } from "./implementations.ts";
import type { WorkspaceManager } from "./manager.ts";
import type { Hit, Target } from "./references.ts";
import { gather, resolveTargets } from "./references.ts";
import type { FoundSymbol } from "./resolver.ts";
import type { DeclarationChange } from "./reviewFormat.ts";
import type { LoadedProject, LoadedSolution } from "./solution.ts";

/** Index side of the impact lines; implemented by the server layer (`src/server/reviewIndex.ts`). */
export type ReviewIndex = {
  /** Every indexed solution with at least one reference to the declaration (`tests` = the part in test projects). */
  countReferences(docId: string): Array<{ solutionPath: string; total: number; tests: number }>;
  /** Package drift tag of a consumer group, `""` when there is none. */
  driftTag(docId: string, solutionPath: string, hits: number): string;
};

type NodeMap = ReadonlyMap<string, ts.Node[]>;
type RelationCounter = (found: FoundSymbol) => RelationCounts;

export type ImpactEnv = {
  manager: WorkspaceManager;
  solution: LoadedSolution;
  index: ReviewIndex | undefined;
  /** Language services over the base side, by project. */
  forks: ReadonlyMap<LoadedProject, ts.LanguageService>;
  counters: Map<LoadedSolution, RelationCounter>;
};

/** The file a change belongs to: its project, whether it is a test file and the declaration nodes of both sides. */
export type ImpactFile = { project: LoadedProject; test: boolean; before: NodeMap; after: NodeMap };

const INDENT = "      ";
const CALLABLE = new Set(["method", "function", "constructor", "accessor"]);
const quiet = (): void => {};

/** The class declaration of a constructor (references to a class are its creations), else the node itself. */
const targetOf = (node: ts.Node): ts.Node => (ts.isConstructorDeclaration(node) ? node.parent : node);

function split(hits: number, tests: number): string {
  return tests === 0 ? `${hits}` : `${hits} (${hits - tests} production, ${tests} tests)`;
}

function splitHits(hits: Hit[]): string {
  return split(hits.length, hits.filter((h) => h.isTest).length);
}

/** The other loaded solutions that declare the same symbol, found by name; `row` still exists on the working side. */
function liveTwins(env: ImpactEnv, row: SymbolRow): Target[] {
  return resolveTargets(env.manager, row.fqName, env.solution.name, true, quiet)?.targets.slice(1) ?? [];
}

/** Twins of a symbol that is gone from the reviewed solution: same docId in another loaded solution. */
function removedTwins(env: ImpactEnv, row: SymbolRow): Target[] {
  const twins: Target[] = [];
  for (const other of env.manager.loadedSolutions) {
    if (other === env.solution) continue;
    const target = resolveTargets(env.manager, row.fqName, other.name, false, quiet)?.targets[0];
    if (target && docIdOf(target.found.node, target.found.project, other) === row.docId) twins.push(target);
  }
  return twins;
}

function referencesLine(change: DeclarationChange, env: ImpactEnv, file: ImpactFile): string | undefined {
  const { row } = change;
  const removed = change.kind === "removed";
  const constructor = row.kind === "constructor";
  const node = (removed ? file.before : file.after).get(row.docId)?.[0];
  const checker = (removed ? env.forks.get(file.project) : file.project.service)?.getProgram()?.getTypeChecker();
  if (!node || !checker) return undefined;
  const count = (target: Target, services?: ReadonlyMap<LoadedProject, ts.LanguageService>): Hit[] =>
    gather({ solution: target.solution, found: { ...target.found, node: targetOf(target.found.node) } }, services)
      .filter((h) => h.via === null && (!constructor || h.kind === "creation"));
  const tag = (solution: LoadedSolution, hits: number): string => env.index?.driftTag(row.docId, solution.path, hits) ?? "";
  const live = (solution: LoadedSolution, hits: Hit[]): string => `Live ${solution.name} ${splitHits(hits)}${tag(solution, hits.length)}`;

  const own = count({ solution: env.solution, found: { node, project: file.project, checker } }, removed ? env.forks : undefined);
  const twins = removed ? removedTwins(env, row) : liveTwins(env, row);
  const parts = [removed ? `${live(env.solution, own)} before removal (usages left show as errors below)` : live(env.solution, own)];
  const suffix = removed ? " remaining" : "";
  for (const twin of twins) parts.push(`${live(twin.solution, count(twin))}${suffix}`);

  const loaded = new Set([env.solution, ...twins.map((t) => t.solution)].map((s) => pathKey(s.path)));
  const entries = (env.index?.countReferences(row.docId) ?? []).filter((e) => !loaded.has(pathKey(e.solutionPath)));
  const name = (path: string): string => path.replace(/\\/g, "/").split("/").slice(-2, -1)[0] ?? path;
  entries.sort((a, b) => name(a.solutionPath).toLowerCase().localeCompare(name(b.solutionPath).toLowerCase()));
  for (const e of entries) {
    parts.push(`Index ${name(e.solutionPath)} ${split(e.total, e.tests)}${env.index!.driftTag(row.docId, e.solutionPath, e.total)}${suffix}`);
  }
  return `${INDENT}references: ${parts.join(", ")}`;
}

function callersLine(change: DeclarationChange, env: ImpactEnv, file: ImpactFile): string | undefined {
  const { row } = change;
  const node = file.after.get(row.docId)?.[0];
  const checker = file.project.service.getProgram()?.getTypeChecker();
  if (!node || !checker) return undefined;
  const targets: Target[] = [{ solution: env.solution, found: { node, project: file.project, checker } }, ...liveTwins(env, row)];
  const hits = targets.flatMap((t) =>
    gather({ solution: t.solution, found: { ...t.found, node: targetOf(t.found.node) } })
      .filter((h) => h.kind === "invocation" || h.kind === "creation"));
  const via = hits.filter((h) => h.via !== null).length;
  const tests = hits.filter((h) => h.isTest).length;
  const parts: string[] = [];
  if (via > 0) parts.push(`${hits.length - via} direct, ${via} via base or interface members`);
  if (tests > 0) parts.push(`${hits.length - tests} production, ${tests} tests`);
  return `${INDENT}callers: ${hits.length}${parts.length > 0 ? ` (${parts.join("; ")})` : ""}`;
}

type RelationLine = { label: string; pick: (counts: RelationCounts) => number; always: boolean };

function relationLines(change: DeclarationChange, env: ImpactEnv, file: ImpactFile): string[] {
  const { row } = change;
  const node = file.after.get(row.docId)?.[0];
  const checker = file.project.service.getProgram()?.getTypeChecker();
  if (!node || !checker) return [];
  let wanted: RelationLine[] = [];
  if ((ts.isMethodSignature(node) || ts.isPropertySignature(node)) && ts.isInterfaceDeclaration(node.parent)) {
    wanted = [{ label: "implementations", pick: (c) => c.implements, always: true }];
  } else if (ts.isClassLike(node.parent) && (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Abstract) !== 0) {
    wanted = [{ label: "overrides", pick: (c) => c.overrides, always: true }];
  } else if (ts.isInterfaceDeclaration(node)) {
    wanted = [
      { label: "implementations", pick: (c) => c.implements, always: false },
      { label: "derived types", pick: (c) => c.inherits, always: false },
    ];
  } else if (ts.isClassDeclaration(node)) {
    wanted = [{ label: "derived types", pick: (c) => c.inherits, always: false }];
  }
  if (wanted.length === 0) return [];
  const targets: Target[] = [{ solution: env.solution, found: { node, project: file.project, checker } }, ...liveTwins(env, row)];
  const counts = targets.map((t) => {
    let counter = env.counters.get(t.solution);
    if (!counter) env.counters.set(t.solution, (counter = relationCounter(t.solution)));
    return counter(t.found);
  });
  return wanted
    .map((w) => ({ w, values: counts.map(w.pick) }))
    .filter(({ w, values }) => w.always || values.some((v) => v > 0))
    .map(({ w, values }) => `${INDENT}${w.label}: ${targets.map((t, i) => `Live ${t.solution.name} ${values[i]}`).join(", ")}`);
}

/** The impact lines of one declaration change (counts only); empty when there is nothing to say. Never throws. */
export function impactOf(change: DeclarationChange, env: ImpactEnv, file: ImpactFile): string[] {
  try {
    const { row } = change;
    if (row.accessibility === "private") return [];
    if (change.kind === "removed" || change.kind === "signature") return [referencesLine(change, env, file)].filter((l) => l !== undefined);
    if (change.kind === "body") {
      if (file.test || !CALLABLE.has(row.kind)) return [];
      return [callersLine(change, env, file)].filter((l) => l !== undefined);
    }
    return change.kind === "added" ? relationLines(change, env, file) : [];
  } catch {
    return [];
  }
}

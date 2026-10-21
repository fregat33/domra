import { basename, relative } from "node:path";
import ts from "typescript";
import type { RelationRow, SymbolRow } from "../index/index.ts";
import { isTestProject, parseDocId } from "../index/index.ts";
import { pathKey } from "./discovery.ts";
import { syncOwners } from "./diagnostics.ts";
import type { QueryText } from "./display.ts";
import { docIdOf, extractDocument } from "./extractor.ts";
import type { ChangedFile, GitProvider } from "./git.ts";
import type { WorkspaceManager } from "./manager.ts";
import { toSlashes } from "./positions.ts";
import { fileNameIndex } from "./resolver.ts";
import type { DeclarationChange, DiagnosticEntry, SourceReview, Status } from "./reviewFormat.ts";
import {
  decoratorNames, diagnosticEntry, diagnosticLines, MAX_LISTED_DECLARATIONS, normalizedText, sourceLines,
} from "./reviewFormat.ts";
import type { ImpactEnv, ImpactFile, ReviewIndex } from "./reviewImpact.ts";
import { impactOf } from "./reviewImpact.ts";
import type { LoadedProject, LoadedSolution } from "./solution.ts";
import { owningProject, SnapshotHost } from "./solution.ts";

export type ReviewOptions = {
  /** Solution hint; defaults to `defaultSolution`, then the first loaded solution. */
  solution?: string;
  /** Git ref to compare with; default `git.defaultBase`. */
  base?: string;
  /** False hides the lines of files in test projects (they still count). Default true. */
  includeTests?: boolean;
  limit?: number;
  git: GitProvider;
  defaultSolution?: string | null;
  /** Reference counts of solutions that are not loaded, from the index; without it only live counts are printed. */
  index?: ReviewIndex;
};

type Side = { symbols: SymbolRow[]; relations: RelationRow[]; nodes: Map<string, ts.Node[]> };

/** A changed source file before analysis; `baseText` is the merge-base text (null for added files). */
type SourceFile = { path: string; status: Status; project: LoadedProject; baseText: string | null };

const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx)$/i;
const PROJECT_FILE = /^(tsconfig.*\.json|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const HEADER_KINDS = new Set(["class", "interface", "enum", "typeAlias", "namespace", "module"]);
const EMPTY: Side = { symbols: [], relations: [], nodes: new Map() };

const isUnder = (path: string, dir: string): boolean => pathKey(path).startsWith(`${pathKey(dir)}/`);
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function fail(text: string): QueryText {
  return { head: [`review_changes: ${text}`], items: [], label: "review_changes" };
}

function inProgram(project: LoadedProject, path: string): boolean {
  return project.service.getProgram()?.getSourceFile(path) !== undefined;
}

/** The project whose live program contains the file (root owner first); for files gone from disk the root owner or the deepest project directory. */
function sourceOwner(solution: LoadedSolution, path: string, deleted: boolean): LoadedProject | undefined {
  const root = owningProject(solution, path);
  if (root && inProgram(root, path)) return root;
  const live = solution.projects.find((p) => inProgram(p, path));
  if (live || !deleted) return live;
  return root ?? solution.projects.filter((p) => isUnder(path, p.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
}

/** Declaration nodes of a file by docId, as `extractDocument` walks them (overloads and merged declarations share a docId). */
function nodesByDocId(sourceFile: ts.SourceFile, project: LoadedProject, solution: LoadedSolution): Map<string, ts.Node[]> {
  const map = new Map<string, ts.Node[]>();
  const add = (node: ts.Node): void => {
    const id = docIdOf(node, project, solution);
    const list = map.get(id);
    if (list) list.push(node);
    else map.set(id, [node]);
  };
  const nodes: ts.Node[] = [];
  for (const list of fileNameIndex(sourceFile).values()) {
    for (const node of list) {
      if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node) || ts.isImportEqualsDeclaration(node)) continue;
      nodes.push(node);
      if (!ts.isClassDeclaration(node)) continue;
      for (const ctor of node.members.filter(ts.isConstructorDeclaration)) {
        nodes.push(ctor, ...ctor.parameters.filter((p) => ts.isParameterPropertyDeclaration(p, ctor)));
      }
    }
  }
  nodes.sort((a, b) => a.getStart(sourceFile) - b.getStart(sourceFile)).forEach(add);
  return map;
}

function sideOf(project: LoadedProject, solution: LoadedSolution, program: ts.Program | undefined, path: string, fork: boolean): Side {
  const sourceFile = program?.getSourceFile(path);
  if (!program || !sourceFile) return EMPTY;
  const context = fork ? { solution, program } : { solution };
  const { symbols, relations } = extractDocument(project, sourceFile, program.getTypeChecker(), context);
  return { symbols, relations, nodes: nodesByDocId(sourceFile, project, solution) };
}

const textOf = (side: Side, docId: string): string => (side.nodes.get(docId) ?? []).map(normalizedText).join(" ");

/** `+ implements X`, `- inherits Y`, `+ @Tag` ... of a type whose header changed. */
function headerDelta(before: Side, after: Side, docId: string): string {
  const relations = (side: Side): Set<string> =>
    new Set(side.relations.filter((r) => r.fromDocId === docId).map((r) => `${r.kind} ${parseDocId(r.toDocId)?.fqName ?? r.toDocId}`));
  const decorators = (side: Side): Set<string> => new Set((side.nodes.get(docId) ?? []).flatMap(decoratorNames));
  const parts: string[] = [];
  for (const [of, other] of [[relations(after), relations(before)], [decorators(after), decorators(before)]] as const) {
    for (const item of of) if (!other.has(item)) parts.push(`+ ${item}`);
    for (const item of other) if (!of.has(item)) parts.push(`- ${item}`);
  }
  return parts.length > 0 ? parts.join("; ") : "(heritage or type parameters)";
}

function diffDeclarations(before: Side, after: Side): DeclarationChange[] {
  const old = new Map(before.symbols.map((row) => [row.docId, row]));
  const changes: DeclarationChange[] = [];
  const push = (change: Omit<DeclarationChange, "surface">): void => {
    changes.push({ ...change, surface: change.kind !== "body" && change.row.accessibility !== "private" });
  };
  for (const row of after.symbols) {
    const was = old.get(row.docId);
    if (!was) push({ kind: "added", row });
    else if (was.signature !== row.signature || was.accessibility !== row.accessibility) push({ kind: "signature", row, before: was });
    else if (textOf(before, row.docId) !== textOf(after, row.docId)) {
      if (HEADER_KINDS.has(row.kind)) push({ kind: "header", row, before: was, delta: headerDelta(before, after, row.docId) });
      else push({ kind: "body", row, before: was });
    }
  }
  const now = new Set(after.symbols.map((row) => row.docId));
  for (const row of before.symbols) if (!now.has(row.docId)) push({ kind: "removed", row });
  return changes.sort((a, b) => a.row.line - b.row.line || a.row.col - b.row.col || compareText(a.row.docId, b.row.docId));
}

/** A language service over the base side: the live snapshots with every changed source file put back to its merge-base text. */
function forkService(project: LoadedProject, sources: SourceFile[]): ts.LanguageService {
  const host = new SnapshotHost(project.parsed, project.dir);
  host.copyFrom(project.host);
  for (const file of sources) {
    host.setFile(file.path, file.status === "added" ? null : file.baseText);
    if (file.status === "deleted" && file.project === project) host.addRoot(file.path);
  }
  return ts.createLanguageService(host, ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames));
}

/**
 * Compare the working tree of a loaded solution with merge-base(base, HEAD): changed files, changed declarations
 * and compiler diagnostics on the changed files. The base side is analysed on forked language services; the live
 * services only receive the disk text of changed files. Never throws.
 */
export async function reviewChangesText(manager: WorkspaceManager, options: ReviewOptions): Promise<QueryText> {
  try {
    const name = options.solution ?? options.defaultSolution ?? manager.loadedSolutions[0]?.name;
    if (name === undefined) return fail("No solution loaded; call load_solution first.");
    const solution = manager.resolveSolution(name);
    if (!solution) {
      if (manager.findRegistered(name)) return fail(`${name} is not loaded; call load_solution first.`);
      const known = manager.loadedSolutions.map((s) => s.name).join(", ");
      return { head: [`Unknown solution: ${name}. Known: ${known}`], items: [], label: "review_changes" };
    }
    const { git } = options;
    const probe = await git.probe();
    if (probe !== null) return fail(probe);
    const root = git.repoRoot(solution.dir);
    if (root === null) return fail(`${solution.path} is not inside a git repository.`);
    const base = options.base ?? (await git.defaultBase(root));
    if (base === null) {
      return fail(
        `No default branch found in ${root}: origin/HEAD is not set and none of main, master, develop, dev exists. Pass a branch, tag or commit as base.`,
      );
    }
    const changes = await git.changes(root, base);
    if ("error" in changes) return fail(changes.error);

    const files = [...changes.files].sort((a, b) => compareText(a.path.toLowerCase(), b.path.toLowerCase()));
    syncOwners(solution, files.filter((f) => f.status !== "deleted" && SOURCE_EXTENSION.test(f.path)).map((f) => f.path));
    const projectFiles: ChangedFile[] = [];
    const otherFiles: ChangedFile[] = [];
    const sources: SourceFile[] = [];
    let outside = 0;
    for (const file of files) {
      if (!isUnder(file.path, solution.dir)) outside++;
      else if (PROJECT_FILE.test(basename(file.path))) projectFiles.push(file);
      else {
        const project = SOURCE_EXTENSION.test(file.path) ? sourceOwner(solution, file.path, file.status === "deleted") : undefined;
        if (!project) otherFiles.push(file);
        else {
          const status = file.status === "deleted" && inProgram(project, file.path) ? "modified" : file.status;
          const rel = toSlashes(relative(root, file.path));
          const baseText = status === "added" ? null : await git.show(root, changes.mergeBase, rel);
          sources.push({ path: file.path, status: baseText === null && status === "modified" ? "added" : status, project, baseText });
        }
      }
    }
    return analyse(manager, solution, { base, mergeBase: changes.mergeBase, includeTests: options.includeTests !== false, index: options.index },
      { projectFiles, otherFiles, sources, outside });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

type Classified = { projectFiles: ChangedFile[]; otherFiles: ChangedFile[]; sources: SourceFile[]; outside: number };

function analyse(
  manager: WorkspaceManager,
  solution: LoadedSolution,
  run: { base: string; mergeBase: string; includeTests: boolean; index: ReviewIndex | undefined },
  classified: Classified,
): QueryText {
  const { projectFiles, otherFiles, outside } = classified;
  const forks = new Map<LoadedProject, ts.LanguageService>();
  const reviews: SourceReview[] = [];
  const diagnostics: DiagnosticEntry[] = [];
  const pending: Array<{ review: SourceReview; file: ImpactFile }> = [];
  try {
    for (const file of classified.sources) {
      if (!forks.has(file.project)) forks.set(file.project, forkService(file.project, classified.sources));
    }
    for (const file of classified.sources) {
      const forkProgram = forks.get(file.project)!.getProgram();
      if (file.status === "deleted" && !forkProgram?.getSourceFile(file.path)) {
        otherFiles.push({ path: file.path, status: file.status });
        continue;
      }
      const liveProgram = file.project.service.getProgram();
      const before = file.status === "added" ? EMPTY : sideOf(file.project, solution, forkProgram, file.path, true);
      const after = file.status === "deleted" ? EMPTY : sideOf(file.project, solution, liveProgram, file.path, false);
      const declarations = (file.status === "deleted" ? before : after).symbols.length;
      const rel = toSlashes(relative(solution.dir, file.path));
      const hidden = !run.includeTests && isTestProject(file.project.name, rel);
      const review: SourceReview = { path: file.path, status: file.status, changes: diffDeclarations(before, after), declarations, hidden };
      reviews.push(review);
      const summary = file.status !== "modified" && declarations > MAX_LISTED_DECLARATIONS;
      if (!hidden && !summary) {
        pending.push({ review, file: { project: file.project, test: isTestProject(file.project.name, rel), before: before.nodes, after: after.nodes } });
      }
      if (file.status === "deleted") continue;
      const service = file.project.service;
      for (const d of [...service.getSyntacticDiagnostics(file.path), ...service.getSemanticDiagnostics(file.path)]) {
        const entry = diagnosticEntry(d);
        if (entry) diagnostics.push(entry);
      }
    }
    // the base-side reference count of a removed declaration needs every project of the solution
    if (pending.some((p) => p.review.changes.some((c) => c.kind === "removed" && c.row.accessibility !== "private"))) {
      for (const project of solution.projects) {
        if (!forks.has(project)) forks.set(project, forkService(project, classified.sources));
      }
    }
    const env: ImpactEnv = { manager, solution, index: run.index, forks, counters: new Map() };
    for (const { review, file } of pending) {
      for (const change of review.changes) {
        const impact = impactOf(change, env, file);
        if (impact.length > 0) change.impact = impact;
      }
    }
  } finally {
    for (const service of forks.values()) service.dispose();
  }
  otherFiles.sort((a, b) => compareText(a.path.toLowerCase(), b.path.toLowerCase()));

  const shown = reviews.filter((r) => !r.hidden);
  const large = (r: SourceReview): boolean => r.status !== "modified" && r.declarations > MAX_LISTED_DECLARATIONS;
  const found = diagnosticLines(diagnostics);
  const items = [
    ...projectFiles.map((f) => `${f.path}  ${f.status}  (project file, not analysed; run reindex force=true if a package version changed)`),
    ...otherFiles.map((f) => `${f.path}  ${f.status}  (not a source file of the solution)`),
    ...shown.filter(large).flatMap(sourceLines),
    ...shown.filter((r) => !large(r)).flatMap(sourceLines),
    ...found.lines,
  ];
  const all = reviews.flatMap((r) => r.changes);
  const surface = all.filter((c) => c.surface).length;
  const total = reviews.length + projectFiles.length + otherFiles.length;
  let head =
    `Review: ${solution.name}  working tree vs ${run.base} (merge-base ${run.mergeBase.slice(0, 7)})  ` +
    `${total} files changed: ${reviews.length} source, ${projectFiles.length} project, ${otherFiles.length} other`;
  const hidden = reviews.length - shown.length;
  if (hidden > 0) head += `; ${hidden} in test projects hidden (includeTests=true shows them)`;
  if (outside > 0) head += `; ${outside} outside the solution ignored`;
  return {
    head: [head],
    items,
    label: `review_changes ${solution.name} vs ${run.base}`,
    footer:
      `Total: ${reviews.length} source files, ${all.length} changed declarations (${surface} surface, ${all.length - surface} body-only or private), ` +
      `${found.errors} errors, ${found.warnings} warnings`,
  };
}

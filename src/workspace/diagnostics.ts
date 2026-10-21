import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import ts from "typescript";
import { normalizePath, pathKey } from "./discovery.ts";
import type { QueryText } from "./display.ts";
import type { WorkspaceManager } from "./manager.ts";
import { positionOf, toSlashes } from "./positions.ts";
import type { LoadedProject, LoadedSolution } from "./solution.ts";

export type DiagnosticsOptions = {
  /** Solution hint (name, path or substring); inferred from the file path when a file is given. */
  solution?: string;
  /** `error`, `warning` (default) or `info`/`information`, case-insensitive. */
  minSeverity?: string;
  /** Receives the message of an unexpected failure (the result is then an error text). */
  onError?: (error: unknown) => void;
};

type Severity = "error" | "warning" | "info";
type Entry = { severity: Severity; path: string; line: number; col: number; text: string };

const FILE_TARGET = /\.(ts|tsx|mts|cts|js|jsx)$/i;
const NODE_MODULES = /(^|\/)node_modules\//;
const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function severityOf(diagnostic: ts.Diagnostic): Severity {
  if (diagnostic.category === ts.DiagnosticCategory.Error) return "error";
  return diagnostic.category === ts.DiagnosticCategory.Warning ? "warning" : "info";
}

function parseMinSeverity(text: string | undefined): Severity {
  const value = text?.trim().toLowerCase();
  if (value === "error") return "error";
  return value === "info" || value === "information" ? "info" : "warning";
}

function failure(message: string, label: string): QueryText {
  return { head: [message], items: [], label };
}

/** Absolute path of a file target: as given, else against the hinted solution, the loaded solutions, the cwd. */
function resolveFile(manager: WorkspaceManager, target: string, hint: string | undefined): string {
  if (isAbsolute(target)) return normalizePath(target);
  const hinted = hint === undefined ? null : manager.resolveSolution(hint);
  if (hinted) return normalizePath(resolve(hinted.dir, target));
  for (const solution of manager.loadedSolutions) {
    const candidate = resolve(solution.dir, target);
    if (existsSync(candidate)) return normalizePath(candidate);
  }
  return normalizePath(resolve(process.cwd(), target));
}

function entryOf(diagnostic: ts.Diagnostic): Entry & { key: string } {
  const severity = severityOf(diagnostic);
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const head = `${severity} TS${diagnostic.code}: ${message}`;
  const file = diagnostic.file;
  if (!file || diagnostic.start === undefined) {
    return { severity, path: "", line: 0, col: 0, text: `  ${head}`, key: `${diagnostic.code}||${message}` };
  }
  const position = positionOf(file, diagnostic.start);
  return {
    severity,
    path: position.path,
    line: position.line,
    col: position.col,
    text: `  ${position.path}:${position.line}:${position.col}  ${head}`,
    key: `${diagnostic.code}|${position.path}|${diagnostic.start}|${message}`,
  };
}

function compareEntries(a: Entry, b: Entry): number {
  const path = a.path.toLowerCase();
  const other = b.path.toLowerCase();
  return (
    RANK[a.severity] - RANK[b.severity] || (path < other ? -1 : path > other ? 1 : 0) || a.line - b.line || a.col - b.col
  );
}

function render(diagnostics: ts.Diagnostic[], min: Severity, scope: string): QueryText {
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const diagnostic of diagnostics) {
    const entry = entryOf(diagnostic);
    if (RANK[entry.severity] > RANK[min] || seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
  }
  entries.sort(compareEntries);
  const errors = entries.filter((e) => e.severity === "error").length;
  const warnings = entries.filter((e) => e.severity === "warning").length;
  return {
    head: [`Diagnostics for ${scope}: ${errors} errors, ${warnings} warnings (compiler only; lint is not run)`],
    items: entries.map((e) => e.text),
    label: `get_diagnostics ${scope}`,
  };
}

/** Projects whose program contains any of `paths`, with the text of each file on disk pushed into its owners' hosts. */
export function syncOwners(solution: LoadedSolution, paths: string[]): LoadedProject[] {
  const all = new Set<LoadedProject>();
  for (const path of paths) {
    const owners = solution.projects.filter((p) => p.service.getProgram()?.getSourceFile(path) !== undefined);
    let text: string | undefined;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = undefined;
    }
    for (const project of owners) {
      all.add(project);
      if (text !== undefined && project.host.getText(path) !== text) project.host.setFile(path, text);
    }
  }
  return [...all];
}

function fileDiagnostics(manager: WorkspaceManager, target: string, options: DiagnosticsOptions, min: Severity): QueryText {
  const path = resolveFile(manager, target, options.solution);
  const label = `get_diagnostics ${path}`;
  const hinted = options.solution === undefined ? null : manager.resolveSolution(options.solution);
  const solution = manager.findSolutionForPath(path) ?? hinted;
  if (!solution) return failure(`No loaded solution contains ${path}`, label);
  const owners = syncOwners(solution, [path]);
  if (owners.length === 0) {
    return failure(
      `${path} is not part of ${solution.name}. New files are picked up on save; otherwise check the project globs.`,
      label,
    );
  }
  const diagnostics: ts.Diagnostic[] = [];
  for (const project of owners) {
    diagnostics.push(...project.service.getSyntacticDiagnostics(path), ...project.service.getSemanticDiagnostics(path));
    if (min === "info") diagnostics.push(...project.service.getSuggestionDiagnostics(path));
  }
  return render(diagnostics, min, path);
}

function projectDiagnostics(manager: WorkspaceManager, target: string, options: DiagnosticsOptions, min: Severity): QueryText {
  const label = `get_diagnostics ${target}`;
  const hinted = options.solution === undefined ? null : manager.resolveSolution(options.solution);
  const solution = hinted ?? manager.loadedSolutions[0];
  if (!solution) return failure("No solution loaded.", label);
  const lower = target.toLowerCase();
  const dirKey = pathKey(target);
  const projects = solution.projects.filter((p) => p.name.toLowerCase() === lower || pathKey(p.dir) === dirKey);
  if (projects.length === 0) {
    const names = solution.projects.map((p) => p.name).join(", ");
    return failure(`No project named ${target} in ${solution.name}. Projects: ${names}`, label);
  }
  const diagnostics: ts.Diagnostic[] = [];
  for (const project of projects) {
    const program = project.service.getProgram();
    if (!program) continue;
    const found = [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ];
    for (const diagnostic of found) {
      const file = diagnostic.file;
      if (file && (program.isSourceFileDefaultLibrary(file) || NODE_MODULES.test(toSlashes(file.fileName)))) continue;
      diagnostics.push(diagnostic);
    }
  }
  return render(diagnostics, min, projects.map((p) => p.name).join(", "));
}

/**
 * Compiler diagnostics of a file or a project from the live programs, no build. A file is first
 * synced from disk, so saved edits show immediately. Never throws.
 */
export function diagnosticsText(manager: WorkspaceManager, target: string, options: DiagnosticsOptions = {}): QueryText {
  try {
    const min = parseMinSeverity(options.minSeverity);
    return FILE_TARGET.test(target)
      ? fileDiagnostics(manager, target, options, min)
      : projectDiagnostics(manager, target, options, min);
  } catch (error) {
    options.onError?.(error);
    const message = error instanceof Error ? error.message : String(error);
    return failure(`get_diagnostics failed: ${message}`, `get_diagnostics ${target}`);
  }
}

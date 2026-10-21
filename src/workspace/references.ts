import { isAbsolute, relative } from "node:path";
import ts from "typescript";
import { isTestProject } from "../index/index.ts";
import { fqNameOf, nameNode } from "./declarations.ts";
import { normalizePath, pathKey } from "./discovery.ts";
import type { GroupedText } from "./display.ts";
import { docIdOf } from "./extractor.ts";
import { formatHeader, formatNotFound } from "./display.ts";
import { toSlashes } from "./positions.ts";
import type { FoundSymbol, ResolvedSymbol } from "./resolver.ts";
import { findInSolution, toResolved } from "./resolver.ts";
import type { LoadedProject, LoadedSolution } from "./solution.ts";
import { owningProject } from "./solution.ts";
import { parseSymbolSpec } from "./symbolSpec.ts";
import type { WorkspaceManager } from "./manager.ts";

const KINDS = ["usage", "invocation", "creation", "base", "decorator", "import"] as const;
type RefKind = (typeof KINDS)[number];
export type { RefKind };
export type Scope = "all" | "production" | "tests";

export type FindReferencesOptions = {
  solution?: string;
  /** Include the twins of the symbol in the other loaded solutions (default true). */
  allSolutions?: boolean;
  /** Comma-separated usage kinds to keep. */
  kind?: string;
  /** `all` (default), `production` or `tests`. */
  scope?: string;
  onError?: (error: unknown, spec: string) => void;
  /** Text appended to the header of every group except the defining solution's: `(solution path, hits)`. */
  groupSuffix?: (solutionPath: string, hits: number) => string;
};

/** A declaration found in one loaded solution. */
export type Target = { solution: LoadedSolution; found: FoundSymbol };

export const NODE_MODULES =/(^|\/)node_modules\//;

export function reportError(error: unknown, spec: string, onError: FindReferencesOptions["onError"]): void {
  try {
    if (onError) onError(error, spec);
    else if (process.env["DOMRA_DEBUG"]) console.error(`domra: query failed for "${spec}":`, error);
  } catch {
    // a failing error handler must not make a query throw
  }
}

export function notFoundHead(manager: WorkspaceManager, spec: string): string[] {
  const parsed = parseSymbolSpec(spec);
  let known = manager.loadedSolutions.length > 0;
  if (parsed?.kind === "position" && isAbsolute(parsed.path)) known = manager.findSolutionForPath(normalizePath(parsed.path)) !== null;
  return formatNotFound(spec, parsed, known);
}

/**
 * The defining solution (the hinted one, else the first loaded solution that resolves the spec) and,
 * when `twins` is set, the same declaration in every other loaded solution: same file, or the same docId
 * (a package's source and its published declaration file under another solution's node_modules).
 */
export function resolveTargets(
  manager: WorkspaceManager,
  spec: string,
  hint: string | undefined,
  twins: boolean,
  onError: FindReferencesOptions["onError"],
): { resolved: ResolvedSymbol; targets: Target[] } | null {
  const options = onError ? { onError } : {};
  const hinted = hint === undefined ? null : manager.resolveSolution(hint);
  const candidates = hint === undefined ? manager.loadedSolutions : hinted ? [hinted] : [];
  for (const solution of candidates) {
    const found = findInSolution(solution, spec, options);
    if (!found) continue;
    const resolved = toResolved(found, solution);
    const targets: Target[] = [{ solution, found }];
    if (twins) {
      const key = pathKey(found.node.getSourceFile().fileName);
      let docId: string | undefined;
      for (const other of manager.loadedSolutions) {
        if (other === solution) continue;
        const twin = findInSolution(other, resolved.fqName, options);
        if (!twin) continue;
        const same = pathKey(twin.node.getSourceFile().fileName) === key ||
          docIdOf(twin.node, twin.project, other) === (docId ??= docIdOf(found.node, found.project, solution));
        if (same) targets.push({ solution: other, found: twin });
      }
    }
    return { resolved, targets };
  }
  return null;
}

// ---- classification -------------------------------------------------------------------------

function tokenAt(sourceFile: ts.SourceFile, offset: number): ts.Node {
  let node: ts.Node = sourceFile;
  for (;;) {
    const child: ts.Node | undefined = ts.forEachChild(node, (c) =>
      c.getStart(sourceFile) <= offset && offset < c.getEnd() ? c : undefined);
    if (!child) return node;
    node = child;
  }
}

function isDecoratorOperand(node: ts.Node): boolean {
  for (let current = node, parent = node.parent; parent; current = parent, parent = parent.parent) {
    if (ts.isDecorator(parent)) return true;
    if (!((ts.isCallExpression(parent) || ts.isPropertyAccessExpression(parent)) && parent.expression === current)) return false;
  }
  return false;
}

function isImportLike(node: ts.Node): boolean {
  return (
    ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node) ||
    ts.isExportSpecifier(node) || ts.isImportEqualsDeclaration(node)
  );
}

/** Kind of the reference at `token` and the node to take the enclosing declaration from. */
export function classifyReference(token: ts.Node): { kind: RefKind; node: ts.Node } {
  let node = token;
  let parent = node.parent;
  if (!parent) return { kind: "usage", node };
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isQualifiedName(parent) && parent.right === node)) {
    node = parent;
    parent = parent.parent;
  }
  let kind: RefKind = "usage";
  if (isDecoratorOperand(node)) kind = "decorator";
  else if (parent && ((ts.isCallExpression(parent) && parent.expression === node) || (ts.isTaggedTemplateExpression(parent) && parent.tag === node))) kind = "invocation";
  else if (parent && ts.isNewExpression(parent) && parent.expression === node) kind = "creation";
  else if (parent && ts.isExpressionWithTypeArguments(parent) && parent.parent && ts.isHeritageClause(parent.parent)) kind = "base";
  else if (isImportLike(node) || (parent && isImportLike(parent))) kind = "import";
  return { kind, node };
}

function isStop(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) || ts.isAccessor(node) || ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) || ts.isEnumMember(node) || ts.isVariableDeclaration(node) ||
    ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name !== undefined) ||
    ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
    ts.isModuleDeclaration(node)
  );
}

/** The nearest named enclosing declaration (a stop), and whether an import/export statement was crossed. */
export function enclosingStopOf(node: ts.Node): { stop: ts.Node | null; inImport: boolean } {
  let inImport = false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isImportEqualsDeclaration(parent)) inImport = true;
    if (!isStop(parent)) continue;
    if (fqNameOf(parent) !== "") return { stop: parent, inImport };
  }
  return { stop: null, inImport };
}

/** Fully qualified name of the enclosing declaration, `<top-level>`, or null inside an import/export statement. */
export function enclosingOf(node: ts.Node): string | null {
  const { stop, inImport } = enclosingStopOf(node);
  if (stop) return fqNameOf(stop);
  return inImport ? null : "<top-level>";
}

// ---- gathering ------------------------------------------------------------------------------

/** `via` is null for usages that bind to the declaration itself, else the name of the base/interface member or override they bind to. */
export type Hit = { path: string; line: number; col: number; project: string; kind: RefKind; enclosing: string | null; isTest: boolean; via: string | null };

const declarationKey = (d: ts.Node): string => `${pathKey(d.getSourceFile().fileName)}:${(ts.getNameOfDeclaration(d as ts.Declaration) ?? d).getStart()}`;

/** The symbol of the type (class or interface) that declares a member, or undefined for anything else. */
function containingType(decl: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const parent = decl.parent;
  if (!parent || !(ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent)) || !parent.name) return undefined;
  return checker.getSymbolAtLocation(parent.name);
}

/** Whether `sub` extends or implements `sup` (transitively, by declared heritage; not structurally). */
function inherits(sub: ts.Symbol, sup: ts.Symbol, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): boolean {
  if (sub === sup) return true;
  if (seen.has(sub)) return false;
  seen.add(sub);
  for (const d of sub.declarations ?? []) {
    if (!ts.isClassLike(d) && !ts.isInterfaceDeclaration(d)) continue;
    for (const clause of d.heritageClauses ?? []) {
      for (const type of clause.types) {
        const base = checker.getTypeAtLocation(type.expression).symbol;
        if (base && inherits(base, sup, checker, seen)) return true;
      }
    }
  }
  return false;
}

/** Every non-definition reference of the declaration, found through each project whose program contains it. */
export function gather({ solution, found }: Target, services?: ReadonlyMap<LoadedProject, ts.LanguageService>): Hit[] {
  const file = found.node.getSourceFile().fileName;
  const position = nameNode(found.node).getStart();
  const identity = ts.isConstructorDeclaration(found.node) && found.node.parent.name ? found.node.parent.name : nameNode(found.node);
  const hits = new Map<string, Hit>();
  for (const project of solution.projects) {
    const service = services?.get(project) ?? project.service;
    const program = service.getProgram();
    const targetFile = program?.getSourceFile(file);
    if (!program || !targetFile) continue;
    const checker = program.getTypeChecker();
    let symbol = checker.getSymbolAtLocation(tokenAt(targetFile, identity.getStart()));
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const own = new Set((symbol?.declarations ?? []).map(declarationKey));
    const targetType = symbol?.declarations?.[0] ? containingType(symbol.declarations[0], checker) : undefined;
    for (const group of service.findReferences(file, position) ?? []) {
      let via: string | null = null;
      // no symbol at the name node: keep every group, as before the per-declaration rule
      if (symbol && !own.has(`${pathKey(group.definition.fileName)}:${group.definition.textSpan.start}`)) {
        const defFile = program.getSourceFile(group.definition.fileName);
        const token = defFile ? tokenAt(defFile, group.definition.textSpan.start) : undefined;
        let groupSymbol = token ? checker.getSymbolAtLocation(token) : undefined;
        if (groupSymbol && groupSymbol.flags & ts.SymbolFlags.Alias) groupSymbol = checker.getAliasedSymbol(groupSymbol);
        if (token && groupSymbol !== symbol) {
          const declaration = token.parent;
          const groupType = containingType(declaration, checker);
          if (!targetType || !groupType) continue;
          if (!inherits(targetType, groupType, checker) && !inherits(groupType, targetType, checker)) continue;
          via = fqNameOf(declaration);
        } else if (!token) continue;
      }
      for (const ref of group.references) {
        if (ref.isDefinition) continue;
        // the declaration name of a family member arrives as a plain reference of its own group
        if (via !== null && ref.textSpan.start === group.definition.textSpan.start && pathKey(ref.fileName) === pathKey(group.definition.fileName)) continue;
        const sourceFile = program.getSourceFile(ref.fileName);
        if (!sourceFile || program.isSourceFileDefaultLibrary(sourceFile) || NODE_MODULES.test(toSlashes(ref.fileName))) continue;
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(ref.textSpan.start);
        const key = `${pathKey(ref.fileName)}:${line}:${character}`;
        if (hits.has(key)) continue;
        const { kind, node } = classifyReference(tokenAt(sourceFile, ref.textSpan.start));
        const owner = owningProject(solution, ref.fileName) ?? project;
        hits.set(key, {
          path: toSlashes(ref.fileName), line: line + 1, col: character + 1, project: owner.name, kind,
          enclosing: enclosingOf(node), isTest: isTestProject(owner.name, toSlashes(relative(solution.dir, ref.fileName))), via,
        });
      }
    }
  }
  return [...hits.values()];
}

// ---- filters --------------------------------------------------------------------------------

export type Filters = { kinds: Set<RefKind>; scope: Scope };

export function parseFilters(kind: string | undefined, scope: string | undefined): Filters | string {
  const kinds = new Set<RefKind>();
  for (const part of (kind ?? "").split(",").map((p) => p.trim().toLowerCase()).filter((p) => p !== "")) {
    if (!(KINDS as readonly string[]).includes(part)) {
      return `find_references: unknown kind '${part}'. Accepted: ${KINDS.join(", ")}; several are comma-separated.`;
    }
    kinds.add(part as RefKind);
  }
  const text = (scope ?? "").trim().toLowerCase();
  if (text !== "" && !["all", "production", "tests", "test"].includes(text)) {
    return `find_references: unknown scope '${text}'. Accepted: all, production, tests.`;
  }
  return { kinds, scope: text === "test" ? "tests" : text === "" ? "all" : (text as Scope) };
}

export function describeFilters({ kinds, scope }: Filters): string {
  const parts: string[] = [];
  if (kinds.size > 0) parts.push(`kind=${KINDS.filter((k) => kinds.has(k)).join(",")}`);
  if (scope !== "all") parts.push(`scope=${scope}`);
  return parts.join("; ");
}

export function compareHits(a: Hit, b: Hit): number {
  const pa = a.path.toLowerCase();
  const pb = b.path.toLowerCase();
  return pa < pb ? -1 : pa > pb ? 1 : a.line - b.line || a.col - b.col;
}

/** Every usage of a symbol, one group per solution that contains it. Never throws. */
export function findReferencesText(manager: WorkspaceManager, spec: string, options: FindReferencesOptions = {}): GroupedText {
  const filters = parseFilters(options.kind, options.scope);
  if (typeof filters === "string") return { head: [filters], groups: [], footer: "" };
  const allSolutions = options.allSolutions ?? true;
  const notFound = (): GroupedText => ({ head: notFoundHead(manager, spec), groups: [], footer: "Total: 0 references" });
  try {
    const target = resolveTargets(manager, spec, options.solution, allSolutions, options.onError);
    if (!target) return notFound();
    const filter = describeFilters(filters);
    const groups: GroupedText["groups"] = [];
    let total = 0;
    for (const [index, t] of target.targets.entries()) {
      const all = gather(t).filter((h) => h.via === null);
      const kept = all
        .filter((h) => (filters.scope === "all" || h.isTest === (filters.scope === "tests")) && (filters.kinds.size === 0 || filters.kinds.has(h.kind)))
        .sort(compareHits);
      total += kept.length;
      groups.push({
        header:
          `Live ${t.solution.name}: ${filter === "" ? `${kept.length} references` : `${kept.length} of ${all.length} references (${filter})`}` +
          (index > 0 ? (options.groupSuffix?.(t.solution.path, kept.length) ?? "") : ""),
        label: `find_references ${target.resolved.fqName} in ${t.solution.name}`,
        items: kept.map((h) => `  ${h.path}:${h.line}:${h.col}  ${h.project}  ${h.kind}${h.enclosing === null ? "" : `  in ${h.enclosing}`}`),
      });
    }
    const footer =
      `Total: ${total} references${filter === "" ? "" : ` (${filter})`}` +
      (allSolutions ? "" : " (defining solution only; pass allSolutions=true to include other solutions)");
    return { head: formatHeader(target.resolved), groups, footer };
  } catch (error) {
    reportError(error, spec, options.onError);
    return notFound();
  }
}

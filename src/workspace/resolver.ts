import { isAbsolute, resolve } from "node:path";
import ts from "typescript";
import type { SymbolKind } from "./declarations.ts";
import {
  collectNamedDeclarations,
  declarationName,
  declarationsOnLine,
  fqNameOf,
  kindOf,
  lineRank,
  nameCategory,
  nameNode,
  nodeAt,
} from "./declarations.ts";
import { normalizePath, pathKey } from "./discovery.ts";
import type { Position } from "./positions.ts";
import { offsetOf, positionOf } from "./positions.ts";
import type { LoadedProject, LoadedSolution } from "./solution.ts";
import { owningProject } from "./solution.ts";
import type { NameSpec, PositionSpec, SymbolSpec } from "./symbolSpec.ts";
import { normalizeType, parseSymbolSpec } from "./symbolSpec.ts";

export type ResolvedSymbol = {
  name: string;
  fqName: string;
  kind: SymbolKind;
  /** Solution name. */
  solution: string;
  /** Name of the project that owns the declaring file (or the project it was found through). */
  project: string;
  position: Position;
  isDeclarationFile: boolean;
  signature: string;
};

/** A declaration node together with the project (and so the checker) it was found through. */
export type FoundSymbol = {
  node: ts.Node;
  project: LoadedProject;
  checker: ts.TypeChecker;
  kind?: SymbolKind;
};
type Found = FoundSymbol;

const fileIndexes = new WeakMap<ts.SourceFile, Map<string, ts.Node[]>>();
const programIndexes = new WeakMap<ts.Program, Map<string, ts.Node[]>>();

/**
 * Bare-name index of one source file, cached for the lifetime of the `ts.SourceFile` object.
 * The language service reuses unchanged source files across programs, so lib, node_modules and
 * untouched sources are walked once, not once per program.
 */
export function fileNameIndex(sourceFile: ts.SourceFile): Map<string, ts.Node[]> {
  let index = fileIndexes.get(sourceFile);
  if (!index) {
    index = new Map();
    collectNamedDeclarations(sourceFile, index);
    fileIndexes.set(sourceFile, index);
  }
  return index;
}

/** Per-program index: the per-file indexes merged. */
function nameIndex(program: ts.Program): Map<string, ts.Node[]> {
  let index = programIndexes.get(program);
  if (!index) {
    index = new Map();
    for (const sourceFile of program.getSourceFiles()) {
      for (const [name, nodes] of fileNameIndex(sourceFile)) {
        const list = index.get(name);
        if (list) list.push(...nodes);
        else index.set(name, [...nodes]);
      }
    }
    programIndexes.set(program, index);
  }
  return index;
}

function programOf(project: LoadedProject): ts.Program | undefined {
  return project.service.getProgram();
}

function primaryDeclaration(symbol: ts.Symbol): ts.Node | undefined {
  return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

function unalias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function symbolOf(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const name = (node as ts.NamedDeclaration).name;
  if (name) return checker.getSymbolAtLocation(name);
  if (ts.isSourceFile(node)) return checker.getSymbolAtLocation(node);
  if (ts.isConstructorDeclaration(node)) return checker.getSymbolAtLocation(node.parent.name ?? node.parent);
  return undefined;
}

/** Follow import aliases and re-exports to the original declaration. */
function normalize(node: ts.Node, checker: ts.TypeChecker): ts.Node {
  if (
    ts.isImportSpecifier(node) ||
    ts.isExportSpecifier(node) ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isImportClause(node) ||
    ts.isNamespaceImport(node)
  ) {
    const symbol = symbolOf(node, checker);
    const target = symbol && primaryDeclaration(unalias(symbol, checker));
    return target ?? node;
  }
  return node;
}

function fileKey(node: ts.Node): string {
  return `${pathKey(node.getSourceFile().fileName)}:${node.getStart()}`;
}

export function toResolved(found: Found, solution: LoadedSolution): ResolvedSymbol {
  const { node, checker } = found;
  const sourceFile = node.getSourceFile();
  const kind = found.kind ?? kindOf(node) ?? "variable";
  const owner = owningProject(solution, sourceFile.fileName) ?? found.project;
  const isCtor = kind === "constructor";
  const classNode = ts.isClassLike(node) ? node : ts.isConstructorDeclaration(node) ? node.parent : undefined;
  const symbol = symbolOf(isCtor && classNode ? classNode : node, checker);
  const symbolText = symbol ? checker.symbolToString(symbol) : (declarationName(node) ?? "");

  let signature = symbolText;
  if (isCtor && classNode) {
    const declared = ts.isConstructorDeclaration(node) ? checker.getSignatureFromDeclaration(node) : undefined;
    const sig = declared ?? (symbol && checker.getTypeOfSymbol(symbol).getConstructSignatures()[0]);
    signature = `new ${symbolText}${sig ? checker.signatureToString(sig) : "()"}`;
  } else if (ts.isFunctionLike(node)) {
    const sig = checker.getSignatureFromDeclaration(node as ts.SignatureDeclaration);
    if (sig) signature = `${symbolText}${checker.signatureToString(sig)}`;
  }

  const name = isCtor ? "constructor" : (declarationName(node) ?? symbolText);
  let fqName = fqNameOf(node);
  if (isCtor && !ts.isConstructorDeclaration(node)) fqName = `${fqName}.constructor`;
  return {
    name,
    fqName,
    kind,
    solution: solution.name,
    project: owner.name,
    position: positionOf(sourceFile, nameNode(node).getStart(sourceFile)),
    isDeclarationFile: sourceFile.isDeclarationFile,
    signature,
  };
}

// ---- parameter lists -------------------------------------------------------------------

function parametersMatch(node: ts.Node, params: string[], checker: ts.TypeChecker): boolean {
  if (!ts.isFunctionLike(node)) return false;
  const declared = node.parameters.filter(
    (p) => !(ts.isIdentifier(p.name) && p.name.text === "this"),
  );
  if (declared.length !== params.length) return false;
  return declared.every((p, i) => {
    if (p.type !== undefined && normalizeType(p.type.getText()) === params[i]) return true;
    return normalizeType(checker.typeToString(checker.getTypeAtLocation(p))) === params[i];
  });
}

function constructorsOf(found: Found): Found[] {
  if (!ts.isClassLike(found.node)) return [];
  return found.node.members
    .filter(ts.isConstructorDeclaration)
    .map((ctor) => ({ ...found, node: ctor, kind: "constructor" as const }));
}

/** First candidate whose signature matches `params`; else the first candidate. */
function preferParams(candidates: Found[], params: string[] | null): Found | undefined {
  if (params !== null) {
    for (const candidate of candidates) {
      if (parametersMatch(candidate.node, params, candidate.checker)) return candidate;
      const ctor = constructorsOf(candidate).find((c) => parametersMatch(c.node, params, c.checker));
      if (ctor) return ctor;
    }
  }
  return candidates[0];
}

// ---- names -------------------------------------------------------------------------------

/** A candidate with its sort keys computed once. */
type Ranked = {
  found: Found;
  isExternal: number;
  category: number;
  isDecl: number;
  fqLength: number;
  file: string;
  start: number;
};

function rank(found: Found, isExternal = false): Ranked {
  const sourceFile = found.node.getSourceFile();
  return {
    found,
    isExternal: isExternal ? 1 : 0,
    category: nameCategory(kindOf(found.node) ?? "variable"),
    isDecl: sourceFile.isDeclarationFile ? 1 : 0,
    fqLength: fqNameOf(found.node).length,
    file: sourceFile.fileName,
    start: found.node.getStart(),
  };
}

function compareRanked(a: Ranked, b: Ranked): number {
  if (a.isExternal !== b.isExternal) return a.isExternal - b.isExternal;
  if (a.category !== b.category) return a.category - b.category;
  if (a.isDecl !== b.isDecl) return a.isDecl - b.isDecl;
  if (a.fqLength !== b.fqLength) return a.fqLength - b.fqLength;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.start - b.start;
}

/** Files named `name` (extension stripped), as module candidates for `shapes.Circle`. */
function moduleCandidates(solution: LoadedSolution, name: string): Found[] {
  const seen = new Set<string>();
  const result: Found[] = [];
  for (const project of solution.projects) {
    const program = programOf(project);
    if (!program) continue;
    const checker = program.getTypeChecker();
    for (const sourceFile of program.getSourceFiles()) {
      if (program.isSourceFileDefaultLibrary(sourceFile) || program.isSourceFileFromExternalLibrary(sourceFile)) continue;
      const base = sourceFile.fileName.slice(sourceFile.fileName.lastIndexOf("/") + 1).replace(/(\.d)?\.[cm]?[jt]sx?$/, "");
      if (base !== name || !ts.isExternalModule(sourceFile)) continue;
      const key = pathKey(sourceFile.fileName);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ node: sourceFile, project, checker });
    }
  }
  return result.map((found) => rank(found)).sort(compareRanked).map((r) => r.found);
}

/** Every declaration named `name` in the solution's programs, aliases normalised, ranked. */
function candidatesByName(solution: LoadedSolution, name: string): Found[] {
  const seen = new Set<string>();
  const result: Ranked[] = [];
  for (const project of solution.projects) {
    const program = programOf(project);
    if (!program) continue;
    const checker = program.getTypeChecker();
    for (const declaration of nameIndex(program).get(name) ?? []) {
      const node = normalize(declaration, checker);
      if (kindOf(node) === null) continue;
      const key = fileKey(node);
      if (seen.has(key)) continue;
      seen.add(key);
      const sourceFile = node.getSourceFile();
      const isExternal =
        program.isSourceFileDefaultLibrary(sourceFile) ||
        program.isSourceFileFromExternalLibrary(sourceFile) ||
        sourceFile.fileName.includes("/node_modules/");
      result.push(rank({ node, project, checker }, isExternal));
    }
  }
  return result.sort(compareRanked).map((r) => r.found);
}

function memberSymbol(
  symbol: ts.Symbol,
  name: string,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const flags = symbol.flags;
  if (flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) {
    const exported = checker.getExportsOfModule(symbol).find((s) => s.name === name);
    if (exported) return exported;
  }
  if (flags & ts.SymbolFlags.Enum) {
    const member = symbol.exports?.get(ts.escapeLeadingUnderscores(name));
    if (member) return member;
  }
  if (flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) {
    const member = checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(symbol), name);
    if (member) return member;
  }
  if (flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Class)) {
    return checker.getPropertyOfType(checker.getTypeOfSymbol(symbol), name);
  }
  return undefined;
}

/** Walk `rest` from `start`; null when a part cannot be resolved. */
function walkQualified(start: Found, rest: string[], params: string[] | null): Found | null {
  const { checker } = start;
  const startSymbol = symbolOf(start.node, checker);
  if (!startSymbol) return null;
  let symbol = unalias(startSymbol, checker);
  for (let i = 0; i < rest.length; i++) {
    const part = rest[i]!;
    const last = i === rest.length - 1;
    const member = memberSymbol(symbol, part, checker);
    const isClass = (symbol.flags & ts.SymbolFlags.Class) !== 0;
    if (last && isClass && (part === "constructor" || (part === symbol.name && !member))) {
      const classNode = symbol.declarations?.find(ts.isClassLike);
      if (!classNode) return null;
      const classFound: Found = { ...start, node: classNode };
      const ctors = constructorsOf(classFound);
      if (ctors.length === 0) return { ...classFound, kind: "constructor" };
      return preferParams(ctors, params) ?? null;
    }
    if (!member) return null;
    symbol = unalias(member, checker);
  }
  const declarations = (symbol.declarations ?? []).map((node) => ({ ...start, node }));
  const primary = primaryDeclaration(symbol);
  declarations.sort((a, b) => (a.node === primary ? -1 : b.node === primary ? 1 : 0));
  return preferParams(declarations, params) ?? null;
}

function resolveName(solution: LoadedSolution, spec: NameSpec): Found | null {
  const [first, ...rest] = spec.parts;
  const candidates = candidatesByName(solution, first!);
  if (rest.length === 0) return preferParams(candidates, spec.params) ?? null;
  for (const candidate of [...candidates, ...moduleCandidates(solution, first!)]) {
    const found = walkQualified(candidate, rest, spec.params);
    if (found) return found;
  }
  return null;
}

// ---- positions ---------------------------------------------------------------------------

function declarationAt(sourceFile: ts.SourceFile, offset: number, checker: ts.TypeChecker): ts.Node | null {
  const token = nodeAt(sourceFile, offset);
  if (!token) return null;
  if (token.kind === ts.SyntaxKind.ConstructorKeyword && ts.isConstructorDeclaration(token.parent)) {
    return token.parent;
  }
  if (!ts.isIdentifier(token) && !ts.isPrivateIdentifier(token)) return null;
  const parent = token.parent;
  if ((parent as ts.NamedDeclaration).name === token && kindOf(parent) !== null) return parent;
  const symbol = checker.getSymbolAtLocation(token);
  return symbol ? (primaryDeclaration(unalias(symbol, checker)) ?? null) : null;
}

function firstReferenceOnLine(sourceFile: ts.SourceFile, line: number, checker: ts.TypeChecker): ts.Node | null {
  let result: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (result) return;
    const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
    const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
    if (startLine > line || endLine < line) return;
    if (ts.isIdentifier(node) && startLine === line) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaration = symbol && primaryDeclaration(unalias(symbol, checker));
      if (declaration) result = declaration;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function resolvePosition(solution: LoadedSolution, spec: PositionSpec): Found | null {
  const absolute = normalizePath(isAbsolute(spec.path) ? spec.path : resolve(solution.dir, spec.path));
  const owner = owningProject(solution, absolute);
  const projects = owner ? [owner, ...solution.projects.filter((p) => p !== owner)] : solution.projects;
  for (const project of projects) {
    const program = programOf(project);
    const sourceFile = program?.getSourceFile(absolute);
    if (!program || !sourceFile) continue;
    const checker = program.getTypeChecker();
    let node: ts.Node | null;
    if (spec.col !== null) {
      const offset = offsetOf(sourceFile, spec.line, spec.col);
      if (offset === null) return null;
      node = declarationAt(sourceFile, offset, checker);
      if (!node && offset > 0) node = declarationAt(sourceFile, offset - 1, checker);
    } else {
      if (spec.line > sourceFile.getLineStarts().length) return null;
      const declarations = declarationsOnLine(sourceFile, spec.line - 1);
      declarations.sort((a, b) => lineRank(a) - lineRank(b) || a.getStart() - b.getStart());
      node = declarations[0] ?? firstReferenceOnLine(sourceFile, spec.line - 1, checker);
    }
    return node ? { node: normalize(node, checker), project, checker } : null;
  }
  return null;
}

export type ResolveInSolutionOptions = {
  /** Called with internal errors; they are reported to stderr when `DOMRA_DEBUG` is set and no callback is given. */
  onError?: (error: unknown, spec: string) => void;
};

function reportError(error: unknown, spec: SymbolSpec | string, options: ResolveInSolutionOptions): void {
  const text = typeof spec === "string" ? spec : JSON.stringify(spec);
  try {
    if (options.onError) options.onError(error, text);
    else if (process.env["DOMRA_DEBUG"]) console.error(`domra: resolve failed for "${text}":`, error);
  } catch {
    // a failing error handler must not make resolve throw
  }
}

/** Find the declaration a spec points to within one loaded solution; null when it does not resolve. Never throws. */
export function findInSolution(
  solution: LoadedSolution,
  spec: SymbolSpec | string,
  options: ResolveInSolutionOptions = {},
): FoundSymbol | null {
  const parsed = typeof spec === "string" ? parseSymbolSpec(spec) : spec;
  if (!parsed) return null;
  try {
    return parsed.kind === "position" ? resolvePosition(solution, parsed) : resolveName(solution, parsed);
  } catch (error) {
    reportError(error, spec, options);
    return null;
  }
}

/** Resolve a spec within one loaded solution; null when it does not resolve. Never throws. */
export function resolveInSolution(
  solution: LoadedSolution,
  spec: SymbolSpec | string,
  options: ResolveInSolutionOptions = {},
): ResolvedSymbol | null {
  const found = findInSolution(solution, spec, options);
  if (!found) return null;
  try {
    return toResolved(found, solution);
  } catch (error) {
    reportError(error, spec, options);
    return null;
  }
}

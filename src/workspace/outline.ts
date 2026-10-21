import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import ts from "typescript";
import { fqNameOf, kindOf } from "./declarations.ts";
import { normalizePath } from "./discovery.ts";
import type { QueryText } from "./display.ts";
import { accessibilityOf, compactOf, declaredType, formatNotFound } from "./display.ts";
import { toSlashes } from "./positions.ts";
import type { ResolveInSolutionOptions } from "./resolver.ts";
import { findInSolution, toResolved } from "./resolver.ts";
import type { LoadedProject, LoadedSolution } from "./solution.ts";
import { parseSymbolSpec } from "./symbolSpec.ts";

export type OutlineOptions = ResolveInSolutionOptions & {
  /** 1..3 (clamped), default 2. */
  depth?: number;
  /** Default true; false hides private declarations and everything under them. */
  includePrivate?: boolean;
};

type Entry = { node: ts.Node; span: ts.Node; nesting: number };
type Walk = { max: number; includePrivate: boolean; checker: ts.TypeChecker; out: Entry[] };

const FILE_TARGET = /\.(ts|tsx|mts|cts|js|jsx)$/i;
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function isTypeNode(node: ts.Node): boolean {
  return (
    ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node) || ts.isTypeAliasDeclaration(node)
  );
}

// ---- entries --------------------------------------------------------------------------------

/** Declarations nested directly under a declaration, in source order. */
function childrenOf(node: ts.Node): ts.Node[] {
  if (ts.isClassLike(node)) {
    return node.members.flatMap((m): ts.Node[] =>
      ts.isConstructorDeclaration(m)
        ? [m, ...m.parameters.filter((p) => ts.isParameterPropertyDeclaration(p, m))]
        : [m],
    );
  }
  if (ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) return [...node.members];
  if (ts.isTypeAliasDeclaration(node)) return ts.isTypeLiteralNode(node.type) ? [...node.type.members] : [];
  if (ts.isModuleDeclaration(node) && node.body) {
    if (ts.isModuleBlock(node.body)) return [...node.body.statements];
    if (ts.isModuleDeclaration(node.body)) return [node.body];
  }
  return [];
}

function accessibilityText(node: ts.Node, span: ts.Node): string {
  if (ts.isParameter(node) || ts.isClassLike(node.parent)) {
    const accessibility = accessibilityOf(node);
    return accessibility === "public" ? "" : accessibility;
  }
  const container = span.parent;
  if (container && (ts.isSourceFile(container) || ts.isModuleBlock(container))) {
    return hasModifier(span, ts.SyntaxKind.ExportKeyword) ? "" : "private";
  }
  return "";
}

function declare(node: ts.Node, nesting: number, walk: Walk, force = false): void {
  if (ts.isVariableStatement(node)) {
    for (const declarator of node.declarationList.declarations) addEntry(declarator, node, nesting, walk, force);
    return;
  }
  if (ts.isIndexSignatureDeclaration(node)) return;
  if (kindOf(node) === null) return;
  addEntry(node, node, nesting, walk, force);
}

function addEntry(node: ts.Node, span: ts.Node, nesting: number, walk: Walk, force: boolean): void {
  if (!force && !walk.includePrivate && accessibilityText(node, span) === "private") return;
  walk.out.push({ node, span, nesting });
  if (nesting < walk.max) for (const child of childrenOf(node)) declare(child, nesting + 1, walk);
}

// ---- entry text -----------------------------------------------------------------------------

function heritageOf(node: ts.Node): string {
  if (!ts.isClassLike(node) && !ts.isInterfaceDeclaration(node)) return "";
  const texts = (node.heritageClauses ?? []).flatMap((c) => c.types.map((t) => collapse(t.getText())));
  return texts.length > 0 ? ` : ${texts.join(", ")}` : "";
}

function decoratorText(decorator: ts.Decorator): string {
  const { expression } = decorator;
  if (!ts.isCallExpression(expression)) return `[${expression.getText()}]`;
  const first = expression.arguments[0];
  const name = expression.expression.getText();
  return first && ts.isStringLiteralLike(first) ? `[${name}(${JSON.stringify(first.text)})]` : `[${name}]`;
}

/**
 * `compactOf`, except that a variable's type is printed without an enclosing declaration, so an
 * import alias in scope (`import { Circle as Round }`) does not replace the declared type name.
 */
function compactText(node: ts.Node, checker: ts.TypeChecker): string {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return compactOf(node, checker);
  const type = checker.typeToString(declaredType(node, checker), undefined, ts.TypeFormatFlags.NoTruncation);
  return `${node.name.text}: ${type}`;
}

function entryLine(entry: Entry, checker: ts.TypeChecker): string {
  const { node, span, nesting } = entry;
  const sourceFile = node.getSourceFile();
  const parts: string[] = [];
  const accessibility = accessibilityText(node, span);
  if (accessibility) parts.push(accessibility);
  if (ts.isClassLike(node.parent) && hasModifier(node, ts.SyntaxKind.StaticKeyword)) parts.push("static");
  parts.push(ts.isParameter(node) ? "field" : kindOf(node)!, compactText(node, checker));
  let text = parts.join(" ") + heritageOf(node);
  const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  if (decorators.length > 0) text += `  ${decorators.map(decoratorText).join(" ")}`;
  const start = sourceFile.getLineAndCharacterOfPosition(span.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(span.getEnd()).line + 1;
  return `${" ".repeat(2 + nesting * 2)}${text}  ${start === end ? start : `${start}-${end}`}`;
}

// ---- targets --------------------------------------------------------------------------------

function programFile(project: LoadedProject, path: string): { sourceFile: ts.SourceFile; checker: ts.TypeChecker } | undefined {
  const program = project.service.getProgram();
  const sourceFile = program?.getSourceFile(path);
  return program && sourceFile ? { sourceFile, checker: program.getTypeChecker() } : undefined;
}

function projectsOf(solution: LoadedSolution, path: string): LoadedProject[] {
  return solution.projects.filter((p) => programFile(p, path) !== undefined);
}

function fileOutline(solution: LoadedSolution, target: string, depth: number, includePrivate: boolean): QueryText {
  const label = (path: string): string => `get_outline ${path}`;
  const path = normalizePath(isAbsolute(target) ? target : resolve(solution.dir, toSlashes(target)));
  const projects = projectsOf(solution, path);
  const first = projects[0];
  const file = first && programFile(first, path);
  if (!first || !file) {
    const head = existsSync(path)
      ? `${path} is not part of ${solution.name}. New files are picked up on save; otherwise check the project globs.`
      : `File not found: ${target}. Pass an absolute path, or a path relative to a solution directory.`;
    return { head: [head], items: [], label: label(path) };
  }
  const walk: Walk = { max: depth - 1, includePrivate, checker: file.checker, out: [] };
  for (const statement of file.sourceFile.statements) declare(statement, 0, walk);
  return {
    head: [`Outline: ${path}  (Live ${solution.name}, ${projects.map((p) => p.name).join(", ")})`],
    items: walk.out.map((e) => entryLine(e, file.checker)),
    label: label(path),
    footer: `Total: ${walk.out.length} declarations`,
  };
}

/** The type a declaration is, or belongs to as a member; null when it is neither. */
function typeTargetOf(node: ts.Node): ts.Node | null {
  let target = node;
  if (ts.isParameter(node) && ts.isParameterPropertyDeclaration(node, node.parent)) target = node.parent.parent;
  else if (
    ts.isConstructorDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) ||
    ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isAccessor(node) || ts.isEnumMember(node)
  ) {
    target = ts.isTypeLiteralNode(node.parent) ? node.parent.parent : node.parent;
  }
  return isTypeNode(target) ? target : null;
}

function typeOutline(solution: LoadedSolution, spec: string, depth: number, includePrivate: boolean, options: ResolveInSolutionOptions): QueryText {
  const found = findInSolution(solution, spec, options);
  if (!found) {
    const parsed = parseSymbolSpec(spec);
    return { head: formatNotFound(spec, parsed, true), items: [], label: `get_outline ${spec}` };
  }
  const target = typeTargetOf(found.node);
  if (!target) {
    const { kind, fqName } = toResolved(found, solution);
    return {
      head: [`${spec} resolved to ${kind} ${fqName}, which is not a type; pass a file path instead.`],
      items: [],
      label: `get_outline ${fqName}`,
    };
  }
  const { checker } = found;
  const name = (target as ts.NamedDeclaration).name;
  let symbol = name ? checker.getSymbolAtLocation(name) : undefined;
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const decls = (symbol?.declarations ?? [target]).filter(isTypeNode);
  const byFile = new Map<string, ts.Node[]>();
  for (const decl of decls) {
    const file = decl.getSourceFile().fileName;
    byFile.set(file, [...(byFile.get(file) ?? []), decl]);
  }
  const items: string[] = [];
  let count = 0;
  for (const file of [...byFile.keys()].sort()) {
    const project = projectsOf(solution, file)[0] ?? found.project;
    items.push(`  ${toSlashes(file)}  (${project.name})`);
    const walk: Walk = { max: depth, includePrivate, checker, out: [] };
    for (const decl of byFile.get(file)!.sort((a, b) => a.getStart() - b.getStart())) declare(decl, 1, walk, true);
    items.push(...walk.out.map((e) => entryLine(e, checker)));
    count += walk.out.length;
  }
  const fqName = fqNameOf(target);
  return {
    head: [`Outline: ${kindOf(target)} ${fqName}  (Live ${solution.name})`],
    items,
    label: `get_outline ${fqName}`,
    footer: `Total: ${count} declarations`,
  };
}

/** One line per declaration of a file or type (see docs/workspace.md, "Outline"); never throws. */
export function outline(solution: LoadedSolution, target: string, options: OutlineOptions = {}): QueryText {
  const depth = Math.min(3, Math.max(1, Math.trunc(options.depth ?? 2) || 2));
  const includePrivate = options.includePrivate ?? true;
  try {
    return FILE_TARGET.test(target)
      ? fileOutline(solution, target, depth, includePrivate)
      : typeOutline(solution, target, depth, includePrivate, options);
  } catch (error) {
    try {
      if (options.onError) options.onError(error, target);
      else if (process.env["DOMRA_DEBUG"]) console.error(`domra: outline failed for "${target}":`, error);
    } catch {
      // a failing error handler must not make a query throw
    }
    const parsed = parseSymbolSpec(target);
    return { head: formatNotFound(target, parsed, true), items: [], label: `get_outline ${target}` };
  }
}

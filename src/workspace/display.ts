import ts from "typescript";
import { declarationName } from "./declarations.ts";
import { formatPosition } from "./positions.ts";
import type { ResolvedSymbol } from "./resolver.ts";
import type { SymbolSpec } from "./symbolSpec.ts";

const NO_TRUNCATION = ts.TypeFormatFlags.NoTruncation;

/** Text of a query result; the server pages `items` and appends cursors after `footer`. */
export type QueryText = { head: string[]; items: string[]; label: string; footer?: string };

/** The three header lines shared by every symbol query. */
export function formatHeader(resolved: ResolvedSymbol): string[] {
  const where = resolved.isDeclarationFile ? `${resolved.solution}, declaration file` : resolved.solution;
  return [
    `Symbol: ${resolved.signature}  [${resolved.kind}]  ${resolved.fqName}`,
    `Project: ${resolved.project} (${where})`,
    `Defined: ${formatPosition(resolved.position)}`,
  ];
}

export function formatNotFound(spec: string, parsed: SymbolSpec | null, solutionKnown: boolean): string[] {
  if (parsed?.kind !== "position") {
    return [
      `Symbol not found in any loaded solution: ${spec}`,
      "Tip: use search_symbols to find the exact name, or load_solution if the owning solution is not loaded yet.",
    ];
  }
  return [
    `No symbol at ${spec}`,
    solutionKnown
      ? "Point the column at an identifier, or omit the column to take the first declaration or reference on that line."
      : "The file is not under any loaded solution.",
  ];
}

/** `head`, the first `limit` items, an overflow line, then `footer` (no trailing LF after it). */
export function formatQueryText(text: QueryText, limit: number): string {
  const lines = [...text.head, ...text.items.slice(0, limit)];
  if (text.items.length > limit) lines.push(`  ... ${text.items.length - limit} more`);
  return lines.map((line) => `${line}\n`).join("") + (text.footer ?? "");
}

/** Text of a result with one item list per solution; the server pages every group's `items`. */
export type GroupedText = {
  head: string[];
  groups: { header: string; label: string; items: string[] }[];
  footer: string;
};

/** `head`, then per group its header, the first `limit` items and an overflow line, then `footer`. */
export function formatGroupedText(text: GroupedText, limit: number): string {
  const lines = [...text.head];
  for (const group of text.groups) {
    lines.push(group.header, ...group.items.slice(0, limit));
    if (group.items.length > limit) lines.push(`  ... ${group.items.length - limit} more`);
  }
  return lines.map((line) => `${line}\n`).join("") + text.footer;
}

// ---- compact member text ----------------------------------------------------------------

function nameText(node: ts.Node): string {
  const name = declarationName(node);
  if (name !== undefined) return name;
  const raw = (node as ts.NamedDeclaration).name;
  return raw ? raw.getText() : "";
}

/** Declared type of a parameter/property/variable, else the checker's type of the declaration. */
export function declaredType(node: ts.Node, checker: ts.TypeChecker): ts.Type {
  const typeNode = (node as { type?: ts.TypeNode }).type;
  if (typeNode && !ts.isAccessor(node)) return checker.getTypeFromTypeNode(typeNode);
  const name = (node as ts.NamedDeclaration).name;
  const symbol = name && checker.getSymbolAtLocation(name);
  return symbol ? checker.getTypeOfSymbol(symbol) : checker.getTypeAtLocation(node);
}

export function typeText(type: ts.Type, at: ts.Node, checker: ts.TypeChecker): string {
  return checker.typeToString(type, at, NO_TRUNCATION);
}

/** `p: T`, `p?: T`, `...p: T`, with ` = initializer` when present. */
export function parameterText(param: ts.ParameterDeclaration, checker: ts.TypeChecker): string {
  const rest = param.dotDotDotToken ? "..." : "";
  const optional = param.questionToken && !param.initializer ? "?" : "";
  const initializer = param.initializer ? ` = ${param.initializer.getText()}` : "";
  return `${rest}${param.name.getText()}${optional}: ${typeText(declaredType(param, checker), param, checker)}${initializer}`;
}

function typeParametersOf(node: ts.Node): string {
  const params = (node as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters;
  return params && params.length > 0 ? `<${params.map((p) => p.name.text).join(", ")}>` : "";
}

/** One-line member text without modifiers or accessibility. */
export function compactOf(node: ts.Node, checker: ts.TypeChecker): string {
  if (ts.isEnumMember(node)) {
    const value = checker.getConstantValue(node);
    return value === undefined ? nameText(node) : `${nameText(node)} = ${JSON.stringify(value)}`;
  }
  if (
    ts.isFunctionLike(node) &&
    !ts.isAccessor(node) &&
    !ts.isIndexSignatureDeclaration(node) &&
    !ts.isFunctionTypeNode(node) &&
    !ts.isConstructorTypeNode(node)
  ) {
    const isCtor = ts.isConstructorDeclaration(node) || ts.isConstructSignatureDeclaration(node);
    const params = node.parameters.map((p) => parameterText(p, checker)).join(", ");
    const signature = checker.getSignatureFromDeclaration(node);
    const returns =
      isCtor || !signature ? "" : `: ${typeText(checker.getReturnTypeOfSignature(signature), node, checker)}`;
    return `${isCtor ? "constructor" : nameText(node)}(${params})${returns}`;
  }
  if (
    ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isVariableDeclaration(node) ||
    ts.isParameter(node) || ts.isAccessor(node) || ts.isPropertyAssignment(node)
  ) {
    const optional = (node as { questionToken?: ts.Node }).questionToken ? "?" : "";
    return `${nameText(node)}${optional}: ${typeText(declaredType(node, checker), node, checker)}`;
  }
  return `${nameText(node)}${typeParametersOf(node)}`;
}

// ---- modifiers --------------------------------------------------------------------------

const MODIFIER_ORDER: [ts.SyntaxKind, string][] = [
  [ts.SyntaxKind.StaticKeyword, "static"],
  [ts.SyntaxKind.AbstractKeyword, "abstract"],
  [ts.SyntaxKind.ReadonlyKeyword, "readonly"],
  [ts.SyntaxKind.AsyncKeyword, "async"],
  [ts.SyntaxKind.OverrideKeyword, "override"],
  [ts.SyntaxKind.DeclareKeyword, "declare"],
  [ts.SyntaxKind.ExportKeyword, "export"],
  [ts.SyntaxKind.DefaultKeyword, "default"],
];

function isClassMember(node: ts.Node): boolean {
  if (ts.isParameter(node)) return ts.isParameterPropertyDeclaration(node, node.parent);
  return ts.isClassLike(node.parent);
}

/** Accessibility of a class member: `public` unless `private`/`protected` is written or the name is `#x`. */
export function accessibilityOf(node: ts.Node): "public" | "private" | "protected" {
  const name = (node as ts.NamedDeclaration).name;
  if (name && ts.isPrivateIdentifier(name)) return "private";
  const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
  if (flags & ts.ModifierFlags.Private) return "private";
  if (flags & ts.ModifierFlags.Protected) return "protected";
  return "public";
}

export function modifiersOf(node: ts.Node): string[] {
  const holder = ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)
    ? node.parent.parent
    : node;
  const kinds = new Set<ts.SyntaxKind>((ts.canHaveModifiers(holder) ? (ts.getModifiers(holder) ?? []) : []).map((m) => m.kind));
  const result: string[] = [];
  if (isClassMember(node)) result.push(accessibilityOf(node));
  for (const [kind, text] of MODIFIER_ORDER) if (kinds.has(kind)) result.push(text);
  return result;
}

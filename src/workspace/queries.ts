import { isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import type { SymbolKind } from "./declarations.ts";
import { declarationName, fqNameOf, kindOf, nameNode } from "./declarations.ts";
import { normalizePath, pathKey } from "./discovery.ts";
import type { QueryText } from "./display.ts";
import {
  accessibilityOf, compactOf, declaredType, formatHeader, formatNotFound, modifiersOf, typeText,
} from "./display.ts";
import { formatPosition, positionOf, toSlashes } from "./positions.ts";
import type { FoundSymbol, ResolvedSymbol, ResolveInSolutionOptions } from "./resolver.ts";
import { findInSolution, toResolved } from "./resolver.ts";
import type { LoadedSolution } from "./solution.ts";
import { owningProject } from "./solution.ts";
import { parseSymbolSpec } from "./symbolSpec.ts";

/** Default page size of the item list of every query. */
export const DEFAULT_LIMIT = 200;
const MAX_INFO_MEMBERS = 60;

export type ListMembersOptions = ResolveInSolutionOptions & {
  filter?: string;
  includeInherited?: boolean;
  /** Page size the caller formats with (`formatQueryText`); default {@link DEFAULT_LIMIT}. */
  limit?: number;
};

type Target = { found: FoundSymbol; resolved: ResolvedSymbol; decls: ts.Node[] };

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

function symbolOf(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const name = (node as ts.NamedDeclaration).name;
  const symbol = name ? checker.getSymbolAtLocation(name) : ts.isSourceFile(node) ? checker.getSymbolAtLocation(node) : undefined;
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function sourceOrder(a: ts.Node, b: ts.Node): number {
  const fa = a.getSourceFile().fileName;
  const fb = b.getSourceFile().fileName;
  return fa === fb ? nameNode(a).getStart() - nameNode(b).getStart() : fa < fb ? -1 : 1;
}

/** Deduplicated by position, sorted by path then offset. */
function sortedUnique(nodes: ts.Node[]): ts.Node[] {
  const seen = new Map<string, ts.Node>();
  for (const node of nodes) seen.set(`${pathKey(node.getSourceFile().fileName)}:${nameNode(node).getStart()}`, node);
  return [...seen.values()].sort(sourceOrder);
}

function at(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  return formatPosition(positionOf(sourceFile, nameNode(node).getStart(sourceFile)));
}

function classOfConstructor(found: FoundSymbol): ts.ClassLikeDeclaration | undefined {
  const { node } = found;
  if (ts.isConstructorDeclaration(node)) return node.parent;
  return found.kind === "constructor" && ts.isClassLike(node) ? node : undefined;
}

function declarationsOf(found: FoundSymbol): ts.Node[] {
  const cls = classOfConstructor(found);
  if (cls) {
    const ctors = cls.members.filter(ts.isConstructorDeclaration);
    return sortedUnique(ctors.length > 0 ? ctors : [cls]);
  }
  return sortedUnique(symbolOf(found.node, found.checker)?.declarations ?? [found.node]);
}

function reportError(error: unknown, spec: string, options: ResolveInSolutionOptions): void {
  try {
    if (options.onError) options.onError(error, spec);
    else if (process.env["DOMRA_DEBUG"]) console.error(`domra: query failed for "${spec}":`, error);
  } catch {
    // a failing error handler must not make a query throw
  }
}

function fileKnown(solution: LoadedSolution, spec: ReturnType<typeof parseSymbolSpec>): boolean {
  if (spec?.kind !== "position") return true;
  const path = normalizePath(isAbsolute(spec.path) ? spec.path : resolve(solution.dir, spec.path));
  return owningProject(solution, path) !== undefined || pathKey(path).startsWith(`${pathKey(solution.dir)}/`);
}

/** Resolve, build, and turn every failure into the not-found text. */
function query(
  tool: string,
  solution: LoadedSolution,
  spec: string,
  options: ResolveInSolutionOptions,
  build: (target: Target) => QueryText,
): QueryText {
  const parsed = parseSymbolSpec(spec);
  try {
    const found = findInSolution(solution, spec, options);
    if (found) {
      return build({ found, resolved: toResolved(found, solution), decls: declarationsOf(found) });
    }
  } catch (error) {
    reportError(error, spec, options);
  }
  return { head: formatNotFound(spec, parsed, fileKnown(solution, parsed)), items: [], label: `${tool} ${spec}` };
}

// ---- go_to_definition -----------------------------------------------------------------------

export function definition(solution: LoadedSolution, spec: string, options: ResolveInSolutionOptions = {}): QueryText {
  return query("go_to_definition", solution, spec, options, ({ resolved, decls }) => {
    const inDeclarationFile = decls.every((d) => d.getSourceFile().isDeclarationFile);
    return {
      head: [...formatHeader(resolved), inDeclarationFile ? "Declared in declaration file:" : "Declared in source:"],
      items: decls.map((d) => `  ${at(d)}`),
      label: `go_to_definition ${resolved.fqName}`,
    };
  });
}

// ---- members --------------------------------------------------------------------------------

function isListedMember(node: ts.Node): boolean {
  return (
    ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) || ts.isAccessor(node)
  );
}

function moduleMembers(decl: ts.ModuleDeclaration): ts.Node[] {
  const body = decl.body;
  if (!body) return [];
  if (ts.isModuleDeclaration(body)) return [body];
  if (!ts.isModuleBlock(body)) return [];
  let ambient = decl.getSourceFile().isDeclarationFile;
  for (let p: ts.Node | undefined = decl; p && !ambient; p = p.parent) {
    ambient = hasModifier(p, ts.SyntaxKind.DeclareKeyword);
  }
  return body.statements
    .filter((s) => ambient || hasModifier(s, ts.SyntaxKind.ExportKeyword))
    .flatMap((s): ts.Node[] => (ts.isVariableStatement(s) ? [...s.declarationList.declarations] : [s]))
    .filter((s) => kindOf(s) !== null);
}

/** Declared members of every declaration of a type, in source order; nothing inherited. */
function ownMembers(decls: ts.Node[], checker: ts.TypeChecker): ts.Node[] {
  const out: ts.Node[] = [];
  for (const decl of decls) {
    if (ts.isClassLike(decl) || ts.isInterfaceDeclaration(decl)) {
      for (const member of decl.members) {
        if (ts.isConstructorDeclaration(member)) {
          out.push(member, ...member.parameters.filter((p) => ts.isParameterPropertyDeclaration(p, member)));
        } else if (isListedMember(member)) out.push(member);
      }
    } else if (ts.isEnumDeclaration(decl)) out.push(...decl.members);
    else if (ts.isModuleDeclaration(decl)) out.push(...moduleMembers(decl));
    else if (ts.isTypeAliasDeclaration(decl)) {
      if (ts.isTypeLiteralNode(decl.type)) out.push(...decl.type.members.filter(isListedMember));
      else {
        const props = checker.getPropertiesOfType(checker.getTypeFromTypeNode(decl.type));
        for (const prop of props) if (prop.declarations?.[0]) out.push(prop.declarations[0]);
      }
    }
  }
  return out;
}

/** The type a declaration is, or belongs to as a member; null when it is neither. */
function typeTargetOf(node: ts.Node, checker: ts.TypeChecker): ts.Node | null {
  let target: ts.Node = node;
  if (ts.isParameter(node) && ts.isParameterPropertyDeclaration(node, node.parent)) target = node.parent.parent;
  else if (ts.isConstructorDeclaration(node)) target = node.parent;
  else if (isListedMember(node) || ts.isEnumMember(node)) {
    target = ts.isTypeLiteralNode(node.parent) ? node.parent.parent : node.parent;
  }
  if (ts.isClassLike(target) || ts.isInterfaceDeclaration(target) || ts.isEnumDeclaration(target)) return target;
  if (ts.isModuleDeclaration(target)) return target;
  if (ts.isTypeAliasDeclaration(target)) {
    const flags = checker.getTypeFromTypeNode(target.type).flags;
    return flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection) ? target : null;
  }
  return null;
}

type Listed = { node: ts.Node; from?: string; depth: number };

/** Members of base classes/interfaces (breadth first), skipping names a nearer type already declares. */
function inheritedMembers(symbol: ts.Symbol, own: ts.Node[], checker: ts.TypeChecker): Listed[] {
  if (!(symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface))) return [];
  const keyOf = (n: ts.Node): string => `${hasModifier(n, ts.SyntaxKind.StaticKeyword)}:${declarationName(n)}`;
  const taken = new Set(own.map(keyOf));
  const seen = new Set<ts.Symbol>([symbol]);
  const queue: ts.Type[] = [checker.getDeclaredTypeOfSymbol(symbol)];
  const result: Listed[] = [];
  for (let i = 0; i < queue.length; i++) {
    for (const base of checker.getBaseTypes(queue[i] as ts.InterfaceType)) {
      const baseSymbol = base.getSymbol();
      if (!baseSymbol || seen.has(baseSymbol)) continue;
      seen.add(baseSymbol);
      queue.push(checker.getDeclaredTypeOfSymbol(baseSymbol));
      const decls = (baseSymbol.declarations ?? []).filter((d) => ts.isClassLike(d) || ts.isInterfaceDeclaration(d));
      const from = decls[0] ? fqNameOf(decls[0]) : baseSymbol.name;
      const members = ownMembers(decls, checker).filter((m) => !ts.isConstructorDeclaration(m));
      const fresh = members.filter((m) => !taken.has(keyOf(m)));
      for (const m of members) taken.add(keyOf(m));
      for (const node of fresh) result.push({ node, from, depth: queue.length - 1 });
    }
  }
  return result;
}

function memberKind(node: ts.Node): SymbolKind {
  return ts.isParameter(node) ? "field" : (kindOf(node) ?? "variable");
}

function kindRank(kind: SymbolKind): number {
  if (kind === "field" || kind === "property") return 0;
  return kind === "accessor" ? 1 : kind === "constructor" ? 2 : kind === "method" ? 3 : 4;
}

function memberLine(m: Listed, checker: ts.TypeChecker): string {
  const isStatic = hasModifier(m.node, ts.SyntaxKind.StaticKeyword) ? "static " : "";
  const from = m.from ? `  [from ${m.from}]` : "";
  return `  ${accessibilityOf(m.node)} ${isStatic}${memberKind(m.node)} ${compactOf(m.node, checker)}${from}`;
}

export function listMembers(solution: LoadedSolution, spec: string, options: ListMembersOptions = {}): QueryText {
  return query("list_members", solution, spec, options, ({ found }) => {
    const { checker } = found;
    const target = typeTargetOf(found.node, checker);
    if (!target) return { head: [`${spec} is not a type.`], items: [], label: `list_members ${spec}` };
    const symbol = symbolOf(target, checker);
    const decls = sortedUnique(symbol?.declarations ?? [target]);
    const own = ownMembers(decls, checker);
    let members: Listed[] = own.map((node) => ({ node, depth: 0 }));
    if (options.includeInherited && symbol) members.push(...inheritedMembers(symbol, own, checker));
    const filter = options.filter?.toLowerCase();
    if (filter) members = members.filter((m) => (declarationName(m.node) ?? "").toLowerCase().includes(filter));
    const sortKey = (m: Listed): [number, number, number, string, number] => [
      accessibilityOf(m.node) === "public" ? 0 : 1,
      kindRank(memberKind(m.node)),
      m.depth,
      declarationName(m.node) ?? "",
      m.node.getStart(),
    ];
    members.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || (ka[3] < kb[3] ? -1 : ka[3] > kb[3] ? 1 : 0) || ka[4] - kb[4];
    });
    const fqName = fqNameOf(target);
    return {
      head: [`${kindOf(target)} ${fqName}  ${at(decls[0] ?? target)}`, `${members.length} members`],
      items: members.map((m) => memberLine(m, checker)),
      label: `list_members ${fqName}`,
    };
  });
}

// ---- get_symbol_info ------------------------------------------------------------------------

function namespacesOf(node: ts.Node): string {
  const names: string[] = [];
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isModuleDeclaration(p) && ts.isIdentifier(p.name)) names.unshift(p.name.text);
  }
  return names.join(".");
}

function containingTypeOf(node: ts.Node): ts.Node | undefined {
  if (ts.isParameter(node) && ts.isParameterPropertyDeclaration(node, node.parent)) return node.parent.parent;
  const parent = node.parent;
  if (!parent || !(isListedMember(node) || ts.isConstructorDeclaration(node) || ts.isEnumMember(node))) return undefined;
  return ts.isTypeLiteralNode(parent) ? parent.parent : parent;
}

function heritageTexts(decls: ts.Node[], token: ts.SyntaxKind): string[] {
  return decls.flatMap((d) =>
    ts.isClassLike(d) || ts.isInterfaceDeclaration(d)
      ? (d.heritageClauses ?? []).filter((c) => c.token === token).flatMap((c) => c.types.map((t) => collapse(t.getText())))
      : [],
  );
}

function signatureLines(node: ts.Node, kind: SymbolKind, symbol: ts.Symbol | undefined, checker: ts.TypeChecker): string[] {
  const isCtor = kind === "constructor";
  const type = symbol && checker.getTypeOfSymbol(symbol);
  const signatures = type ? checker.getSignaturesOfType(type, isCtor ? ts.SignatureKind.Construct : ts.SignatureKind.Call) : [];
  return signatures.flatMap((signature, i) => {
    const lines = signatures.length > 1 ? [`Overload ${i + 1}:`] : [];
    lines.push(`Returns: ${typeText(checker.getReturnTypeOfSignature(signature), node, checker)}`);
    for (const param of signature.getParameters()) {
      const decl = param.valueDeclaration;
      if (decl && ts.isParameter(decl)) {
        const init = decl.initializer ? ` = ${decl.initializer.getText()}` : "";
        lines.push(`Parameter: ${typeText(declaredType(decl, checker), decl, checker)} ${param.name}${decl.questionToken ? "?" : ""}${init}`);
      } else lines.push(`Parameter: ${typeText(checker.getTypeOfSymbol(param), node, checker)} ${param.name}`);
    }
    return lines;
  });
}

function constantOf(node: ts.Node, checker: ts.TypeChecker): string | undefined {
  if (ts.isEnumMember(node)) {
    const value = checker.getConstantValue(node);
    return value === undefined ? undefined : JSON.stringify(value);
  }
  if (!ts.isVariableDeclaration(node) || !(ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const)) return undefined;
  const type = declaredType(node, checker);
  if (type.isStringLiteral()) return JSON.stringify(type.value);
  if (type.isNumberLiteral()) return String(type.value);
  return type.flags & ts.TypeFlags.BooleanLiteral ? checker.typeToString(type) : undefined;
}

function docLines(symbol: ts.Symbol, checker: ts.TypeChecker): string[] {
  const summary = collapse(ts.displayPartsToString(symbol.getDocumentationComment(checker)));
  const lines = summary ? [`  summary: ${summary}`] : [];
  for (const tag of symbol.getJsDocTags(checker)) {
    const parts = tag.text ?? [];
    const named = parts[0]?.kind === "parameterName";
    const text = collapse(ts.displayPartsToString(named ? parts.slice(1) : parts));
    lines.push(`  ${tag.name}${named ? ` ${parts[0]!.text}` : ""}: ${text}`.trimEnd());
  }
  return lines.length > 0 ? ["Docs:", ...lines] : [];
}

export function symbolInfo(solution: LoadedSolution, spec: string, options: ResolveInSolutionOptions = {}): QueryText {
  return query("get_symbol_info", solution, spec, options, ({ found, resolved, decls }) => {
    const { node, checker } = found;
    const { kind } = resolved;
    const cls = classOfConstructor(found);
    const symbol = symbolOf(cls ?? node, checker);
    const lines = [`Signature: ${resolved.signature}`, `Kind: ${kind}`, `Name: ${resolved.fqName}`];
    const modifiers = ts.isConstructorDeclaration(node) || !cls ? modifiersOf(node) : ["public"];
    if (modifiers.length > 0) lines.push(`Modifiers: ${modifiers.join(" ")}`);
    const namespaces = namespacesOf(node);
    if (namespaces) lines.push(`Namespace: ${namespaces}`);
    const first = decls[0] ?? node;
    lines.push(`Module: ${toSlashes(relative(solution.dir, first.getSourceFile().fileName))}`);
    const container = containingTypeOf(node);
    if (container) lines.push(`Containing type: ${fqNameOf(container)}`);
    lines.push(formatHeader(resolved)[1]!);
    for (const d of decls) lines.push(`Declared at: ${at(d)}`);
    if (kind === "class") {
      const extendsText = heritageTexts(decls, ts.SyntaxKind.ExtendsKeyword);
      if (extendsText.length > 0) lines.push(`Extends: ${extendsText.join(", ")}`);
      const implementsText = heritageTexts(decls, ts.SyntaxKind.ImplementsKeyword);
      if (implementsText.length > 0) lines.push(`Implements: ${implementsText.join(", ")}`);
    } else if (kind === "interface") {
      const extendsText = heritageTexts(decls, ts.SyntaxKind.ExtendsKeyword);
      if (extendsText.length > 0) lines.push(`Extends: ${extendsText.join(", ")}`);
    }
    const generic = kind === "constructor" ? undefined : decls.find((d) => (d as ts.ClassDeclaration).typeParameters?.length);
    if (generic) lines.push(`Type parameters: ${(generic as ts.ClassDeclaration).typeParameters!.map((p) => p.name.text).join(", ")}`);
    if (kind === "function" || kind === "method" || kind === "constructor") {
      lines.push(...signatureLines(node, kind, symbol, checker));
    } else if (["property", "field", "variable", "parameter", "accessor"].includes(kind)) {
      lines.push(`Type: ${typeText(declaredType(node, checker), node, checker)}`);
      const accessors: string[] = (symbol?.declarations ?? []).filter(ts.isAccessor).map((d) => (ts.isGetAccessor(d) ? "get" : "set"));
      if (accessors.length > 0) lines.push(`Accessors: ${["get", "set"].filter((a) => accessors.includes(a)).join(" ")}`);
    }
    const constant = constantOf(node, checker);
    if (constant !== undefined) lines.push(`Constant: ${constant}`);
    const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
    if (decorators.length > 0) {
      const names = decorators.map((d) => (ts.isCallExpression(d.expression) ? d.expression.expression : d.expression).getText());
      lines.push(`Decorators: ${names.join(", ")}`);
    }
    if (symbol && !cls) lines.push(...docLines(symbol, checker));
    if (!cls && typeTargetOf(node, checker) === node) {
      const members = ownMembers(decls, checker);
      lines.push(`Members (${members.length}):`);
      for (const m of members.slice(0, MAX_INFO_MEMBERS)) lines.push(`  ${compactOf(m, checker)}`);
      if (members.length > MAX_INFO_MEMBERS) lines.push("  ... use list_members for the full list");
    }
    return { head: lines, items: [], label: `get_symbol_info ${resolved.fqName}` };
  });
}

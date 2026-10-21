import { relative } from "node:path";
import ts from "typescript";
import { isTestProject } from "../index/index.ts";
import { fqNameOf, nameNode } from "./declarations.ts";
import type { GroupedText } from "./display.ts";
import { formatHeader } from "./display.ts";
import { docIdOf } from "./extractor.ts";
import { formatPosition, positionOf, toSlashes } from "./positions.ts";
import type { Hit, Target } from "./references.ts";
import { compareHits, gather, NODE_MODULES, notFoundHead, parseFilters, reportError, resolveTargets } from "./references.ts";
import type { FoundSymbol, ResolvedSymbol } from "./resolver.ts";
import type { LoadedSolution } from "./solution.ts";
import { owningProject } from "./solution.ts";
import type { WorkspaceManager } from "./manager.ts";

export type CallGraphOptions = {
  solution?: string;
  /** `both` (default), `callers` or `callees`, ignoring case; anything else means `both`. */
  direction?: string;
  includeExternal?: boolean;
  /** `all` (default), `production` or `tests`. */
  scope?: string;
  /** Lines per list (default 100); the lists are returned whole and the renderer pages them. */
  limit?: number;
  /** Keep only the callers that bind to the symbol itself, dropping the `via` callers (default false). */
  direct?: boolean;
  groupSuffix?: (solutionPath: string, hits: number) => string;
  onError?: (error: unknown, spec: string) => void;
};

const NOT_A_FUNCTION = "get_call_graph needs a function, method, constructor, accessor or class; use find_references for types and values.";

type FnNode = ts.FunctionLikeDeclaration;
type CallNode = ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression;
type Callee = { fqName: string; where: string; calledAt: string; file: string; offset: number; docId: string; production: boolean; test: boolean };

function functionOf(node: ts.Node): FnNode | null {
  if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer) {
    let init: ts.Expression = node.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    return ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init : null;
  }
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isAccessor(node)) return node;
  return null;
}

/** The function-like declarations whose bodies are the callees of the root; `null` when the root is not callable. */
function bodiesOf(found: FoundSymbol): FnNode[] | null {
  const { node, checker } = found;
  if (ts.isClassLike(node)) return node.members.filter(ts.isConstructorDeclaration);
  if (ts.isConstructorDeclaration(node)) return node.parent.members.filter(ts.isConstructorDeclaration);
  if (ts.isMethodSignature(node)) return [];
  const own = functionOf(node);
  if (!own) return null;
  const decls = checker.getSymbolAtLocation(nameNode(node))?.declarations ?? [node];
  return decls.filter((d) => d.kind === node.kind).map(functionOf).filter((f): f is FnNode => f !== null);
}

/** A named declaration for a signature declaration (a variable for its arrow function), or null for anonymous ones. */
function named(decl: ts.Node | undefined): ts.Node | null {
  if (!decl) return null;
  let node = decl;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && (ts.isVariableDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent))) node = node.parent;
  if (ts.isCallSignatureDeclaration(node) || ts.isConstructSignatureDeclaration(node) || ts.isIndexSignatureDeclaration(node)) return null;
  return fqNameOf(node) === "" ? null : node;
}

function calleeDeclaration(node: CallNode, checker: ts.TypeChecker): ts.Node | null {
  const direct = named(checker.getResolvedSignature(node)?.declaration);
  if (direct) return direct;
  const expression = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
  const target = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  let symbol = expression.kind === ts.SyntaxKind.SuperKeyword ? checker.getTypeAtLocation(expression).symbol : checker.getSymbolAtLocation(target);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return named(symbol?.declarations?.[0]);
}

function callSites(body: ts.Node): CallNode[] {
  const sites: CallNode[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) sites.push(node);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return sites;
}

function siteToken(node: CallNode): ts.Node {
  const expression = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
  return ts.isPropertyAccessExpression(expression) ? expression.name : expression;
}

function collectCallees(found: FoundSymbol, solution: LoadedSolution, bodies: FnNode[], includeExternal: boolean): Callee[] {
  const program = found.project.service.getProgram();
  const seen = new Set<string>();
  const callees: Callee[] = [];
  for (const fn of bodies) {
    if (!fn.body) continue;
    for (const site of callSites(fn.body)) {
      const decl = calleeDeclaration(site, found.checker);
      if (!decl) continue;
      const file = decl.getSourceFile();
      const isLib = program?.isSourceFileDefaultLibrary(file) ?? false;
      const external = isLib || NODE_MODULES.test(toSlashes(file.fileName));
      if (external && !includeExternal) continue;
      const docId = docIdOf(decl, found.project, solution);
      if (seen.has(docId)) continue;
      seen.add(docId);
      const token = siteToken(site);
      const sourceFile = token.getSourceFile();
      const owner = owningProject(solution, file.fileName) ?? found.project;
      callees.push({
        fqName: fqNameOf(decl),
        where: external ? (isLib ? "(lib)" : "(declaration file)") : formatPosition(positionOf(file, decl.getStart(file))),
        calledAt: formatPosition(positionOf(sourceFile, token.getStart(sourceFile))),
        file: sourceFile.fileName,
        offset: token.getStart(sourceFile),
        docId,
        production: external,
        test: !external && isTestProject(owner.name, toSlashes(relative(solution.dir, file.fileName))),
      });
    }
  }
  callees.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.offset - b.offset));
  return callees;
}

function countText(kept: number, all: number, scope: string): string {
  return scope === "all" ? `${kept}` : `${kept} of ${all}, scope=${scope}`;
}

function callersGroup(targets: Target[], resolved: ResolvedSymbol, scope: string, options: CallGraphOptions): GroupedText["groups"][number] {
  const rows: string[] = [];
  const twinRows: { path: string; count: number }[] = [];
  let all = 0;
  let via = 0;
  for (const [index, t] of targets.entries()) {
    const sites = gather(t).filter((h: Hit) => (h.kind === "invocation" || h.kind === "creation") && (options.direct !== true || h.via === null));
    all += sites.length;
    const kept = sites.filter((h) => scope === "all" || h.isTest === (scope === "tests")).sort(compareHits);
    for (const h of kept) {
      rows.push(`  ${h.enclosing ?? "<top-level>"}  ${h.path}:${h.line}:${h.col}  ${t.solution.name}${h.via === null ? "" : `  via ${h.via}`}`);
      if (h.via !== null) via++;
    }
    if (index > 0 && kept.length > 0) twinRows.push({ path: t.solution.path, count: kept.length });
  }
  const suffix = twinRows.map((t) => options.groupSuffix?.(t.path, t.count) ?? "").join("");
  const count = countText(rows.length, all, scope);
  return {
    header: `Callers (${via === 0 ? count : `${count}: ${rows.length - via} direct, ${via} via base or interface members`}, live, loaded solutions only):${suffix}`,
    label: `get_call_graph callers of ${resolved.name}`,
    items: rows,
  };
}

function calleesGroup(found: FoundSymbol, solution: LoadedSolution, resolved: ResolvedSymbol, scope: string, options: CallGraphOptions): GroupedText["groups"][number] {
  const includeExternal = options.includeExternal ?? false;
  const label = `get_call_graph callees of ${resolved.name}`;
  const header = (text: string): string =>
    includeExternal ? `Callees (${text}):` : `Callees (${text}, source only; includeExternal=true adds node_modules and lib calls):`;
  if (found.node.getSourceFile().isDeclarationFile) {
    return { header: header("0"), label, items: ["  (declaration file; no source body to walk)"] };
  }
  const bodies = bodiesOf(found) ?? [];
  const all = collectCallees(found, solution, bodies, includeExternal);
  const kept = all.filter((c) => scope === "all" || c.production || c.test === (scope === "tests"));
  return {
    header: header(countText(kept.length, all.length, scope)),
    label,
    items: kept.map((c) => `  ${c.fqName}  ${c.where}  called at ${c.calledAt}`),
  };
}

/** One level of callers and callees of a function-like symbol. Never throws. */
export function getCallGraphText(manager: WorkspaceManager, spec: string, options: CallGraphOptions = {}): GroupedText {
  const filters = parseFilters(undefined, options.scope);
  if (typeof filters === "string") return { head: [filters.replace(/^find_references:/, "get_call_graph:")], groups: [], footer: "" };
  try {
    const target = resolveTargets(manager, spec, options.solution, true, options.onError);
    if (!target) return { head: notFoundHead(manager, spec), groups: [], footer: "" };
    const { resolved, targets } = target;
    const root = targets[0]!;
    if (bodiesOf(root.found) === null) {
      return { head: [`${spec} resolved to ${resolved.kind} ${resolved.fqName}. ${NOT_A_FUNCTION}`], groups: [], footer: "" };
    }
    const direction = (options.direction ?? "both").toLowerCase();
    const groups: GroupedText["groups"] = [];
    if (direction !== "callees") groups.push(callersGroup(targets, resolved, filters.scope, options));
    if (direction !== "callers") groups.push(calleesGroup(root.found, root.solution, resolved, filters.scope, options));
    return { head: formatHeader(resolved), groups, footer: "" };
  } catch (error) {
    reportError(error, spec, options.onError);
    return { head: notFoundHead(manager, spec), groups: [], footer: "" };
  }
}

import ts from "typescript";
import { declarationName, fqNameOf, kindOf, nameNode } from "./declarations.ts";
import { pathKey } from "./discovery.ts";
import type { GroupedText } from "./display.ts";
import { formatHeader } from "./display.ts";
import type { WorkspaceManager } from "./manager.ts";
import { formatPosition, positionOf, toSlashes } from "./positions.ts";
import { notFoundHead, reportError, resolveTargets } from "./references.ts";
import type { FoundSymbol } from "./resolver.ts";
import type { LoadedSolution } from "./solution.ts";

export type FindImplementationsOptions = {
  solution?: string;
  /** find_derived_types: the target must be a class or interface. */
  typesOnly?: boolean;
  onError?: (error: unknown, spec: string) => void;
  /** Text appended to the header of every group except the defining solution's: `(solution path, hits)`. */
  groupSuffix?: (solutionPath: string, hits: number) => string;
};

type TypeDecl = ts.ClassDeclaration | ts.InterfaceDeclaration;
type Relation = "implements" | "inherits" | "overrides";
type Edge = { child: string; via: "extends" | "implements" };
type Graph = { types: Map<string, TypeDecl>; children: Map<string, Edge[]> };
type Entry = { relation: Relation; node: ts.Node; key: string };

const NODE_MODULES = /(^|\/)node_modules\//;
const RELATION_ORDER: Relation[] = ["implements", "inherits", "overrides"];

const isTypeDecl = (node: ts.Node): node is TypeDecl => ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node);
const keyOf = (node: ts.Node): string => `${pathKey(node.getSourceFile().fileName)}:${node.getStart()}`;

function parentDeclarations(expression: ts.Expression, checker: ts.TypeChecker): TypeDecl[] {
  let symbol = checker.getTypeAtLocation(expression).getSymbol();
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return (symbol?.declarations ?? []).filter(isTypeDecl);
}

/** Heritage edges of every class and interface declared in the solution's programs. */
function buildGraph(solution: LoadedSolution): Graph {
  const graph: Graph = { types: new Map(), children: new Map() };
  const visit = (statements: readonly ts.Statement[], checker: ts.TypeChecker): void => {
    for (const statement of statements) {
      if (ts.isModuleDeclaration(statement) && statement.body) {
        visit(ts.isModuleBlock(statement.body) ? statement.body.statements : [statement.body as ts.ModuleDeclaration], checker);
        continue;
      }
      if (!isTypeDecl(statement)) continue;
      const key = keyOf(statement);
      if (graph.types.has(key)) continue;
      graph.types.set(key, statement);
      for (const clause of statement.heritageClauses ?? []) {
        const via = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
        for (const type of clause.types) {
          for (const parent of parentDeclarations(type.expression, checker)) {
            const edges = graph.children.get(keyOf(parent));
            if (edges) edges.push({ child: key, via });
            else graph.children.set(keyOf(parent), [{ child: key, via }]);
          }
        }
      }
    }
  };
  for (const project of solution.projects) {
    const program = project.service.getProgram();
    if (!program) continue;
    const checker = program.getTypeChecker();
    for (const sourceFile of program.getSourceFiles()) {
      if (program.isSourceFileDefaultLibrary(sourceFile) || program.isSourceFileFromExternalLibrary(sourceFile)) continue;
      if (NODE_MODULES.test(toSlashes(sourceFile.fileName))) continue;
      visit(sourceFile.statements, checker);
    }
  }
  return graph;
}

/** Declarations reached from `roots` (excluded) over child edges that `accept` takes, transitively. */
function descendants(graph: Graph, roots: string[], accept: (edge: Edge, child: TypeDecl) => boolean): string[] {
  const seen = new Set(roots);
  const queue = [...roots];
  const found: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    for (const edge of graph.children.get(queue[i]!) ?? []) {
      const child = graph.types.get(edge.child);
      if (!child || seen.has(edge.child) || !accept(edge, child)) continue;
      seen.add(edge.child);
      queue.push(edge.child);
      found.push(edge.child);
    }
  }
  return found;
}

const classExtends = (edge: Edge, child: TypeDecl): boolean => edge.via === "extends" && ts.isClassDeclaration(child);
const interfaceExtends = (edge: Edge, child: TypeDecl): boolean => edge.via === "extends" && ts.isInterfaceDeclaration(child);

/** Every declaration of the type the node declares (merged declarations included). */
function typeKeys(node: TypeDecl, checker: ts.TypeChecker): string[] {
  const symbol = node.name && checker.getSymbolAtLocation(node.name);
  const declarations = symbol?.declarations?.filter(isTypeDecl) ?? [node];
  return declarations.map(keyOf);
}

/** Classes implementing the interface directly, through derived interfaces or through base classes. */
function implementers(graph: Graph, interfaces: string[]): string[] {
  const all = [...interfaces, ...descendants(graph, interfaces, interfaceExtends)];
  const direct = all.flatMap((key) => (graph.children.get(key) ?? []).filter((e) => e.via === "implements").map((e) => e.child));
  return [...new Set([...direct, ...descendants(graph, direct, classExtends)])];
}

function isMember(node: ts.Node): boolean {
  return (
    ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) || ts.isAccessor(node) ||
    (ts.isParameter(node) && ts.isParameterPropertyDeclaration(node, node.parent))
  );
}

function membersNamed(type: TypeDecl, name: string): ts.Node[] {
  const own: ts.Node[] = [...type.members];
  const ctor = type.members.find(ts.isConstructorDeclaration);
  if (ctor) own.push(...ctor.parameters.filter((p) => ts.isParameterPropertyDeclaration(p, ctor)));
  return own.filter((m) => isMember(m) && declarationName(m) === name);
}

function entriesFor(graph: Graph, node: ts.Node, checker: ts.TypeChecker): Entry[] {
  const entries: Entry[] = [];
  const add = (relation: Relation, nodes: ts.Node[]): void => {
    for (const n of nodes) entries.push({ relation, node: n, key: keyOf(nameNode(n)) });
  };
  const declarations = (keys: string[]): TypeDecl[] => keys.flatMap((k) => graph.types.get(k) ?? []);
  if (isTypeDecl(node)) {
    const keys = typeKeys(node, checker);
    if (ts.isInterfaceDeclaration(node)) {
      add("implements", declarations(implementers(graph, keys)));
      add("inherits", declarations(descendants(graph, keys, interfaceExtends)));
    } else {
      add("inherits", declarations(descendants(graph, keys, classExtends)));
    }
    return entries;
  }
  const container = ts.isParameter(node) ? node.parent.parent : node.parent;
  const name = declarationName(node);
  if (!isMember(node) || !container || !isTypeDecl(container) || name === undefined || name.startsWith("#")) return entries;
  const keys = typeKeys(container, checker);
  if (ts.isInterfaceDeclaration(container)) {
    for (const type of declarations(implementers(graph, keys))) add("implements", membersNamed(type, name));
  } else {
    for (const type of declarations(descendants(graph, keys, classExtends))) add("overrides", membersNamed(type, name));
  }
  return entries;
}

export type RelationCounts = { implements: number; inherits: number; overrides: number };

/** Relation counts of declarations of one solution; the heritage graph is built once per call. */
export function relationCounter(solution: LoadedSolution): (found: FoundSymbol) => RelationCounts {
  const graph = buildGraph(solution);
  return (found) => {
    const counts: RelationCounts = { implements: 0, inherits: 0, overrides: 0 };
    for (const entry of entriesFor(graph, found.node, found.checker)) counts[entry.relation]++;
    return counts;
  };
}

function lineOf(entry: Entry): string {
  const sourceFile = entry.node.getSourceFile();
  const position = positionOf(sourceFile, nameNode(entry.node).getStart(sourceFile));
  return `  ${entry.relation}  ${kindOf(entry.node) ?? "variable"} ${fqNameOf(entry.node)}  ${formatPosition(position)}`;
}

const ordinal = (a: string, b: string): number => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);

/** Implementers, derived types and overrides of a type or member across loaded solutions. Never throws. */
export function findImplementationsText(
  manager: WorkspaceManager,
  spec: string,
  options: FindImplementationsOptions = {},
): GroupedText {
  const tool = options.typesOnly ? "find_derived_types" : "find_implementations";
  const notFound = (): GroupedText => ({ head: notFoundHead(manager, spec), groups: [], footer: "Total: 0" });
  try {
    const target = resolveTargets(manager, spec, options.solution, true, options.onError);
    if (!target) return notFound();
    const { resolved } = target;
    if (options.typesOnly && !isTypeDecl(target.targets[0]!.found.node)) {
      return { head: [`${spec} resolved to a ${resolved.kind}, not a type. Use find_implementations for members.`], groups: [], footer: "Total: 0" };
    }
    const groups: GroupedText["groups"] = [];
    const shown = new Set<string>();
    let total = 0;
    for (const [index, { solution, found }] of target.targets.entries()) {
      const entries = entriesFor(buildGraph(solution), found.node, found.checker)
        .filter((e) => !shown.has(e.key))
        .sort((a, b) =>
          RELATION_ORDER.indexOf(a.relation) - RELATION_ORDER.indexOf(b.relation) ||
          ordinal(fqNameOf(a.node), fqNameOf(b.node)) || ordinal(a.node.getSourceFile().fileName, b.node.getSourceFile().fileName));
      if (entries.length === 0 && index > 0) continue;
      for (const entry of entries) shown.add(entry.key);
      total += entries.length;
      groups.push({
        header: `Live ${solution.name}: ${entries.length}${index > 0 ? (options.groupSuffix?.(solution.path, entries.length) ?? "") : ""}`,
        label: `${tool} ${resolved.fqName} in ${solution.name}`,
        items: entries.map(lineOf),
      });
    }
    return { head: formatHeader(resolved), groups, footer: `Total: ${total}` };
  } catch (error) {
    reportError(error, spec, options.onError);
    return notFound();
  }
}

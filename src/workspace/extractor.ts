import { existsSync } from "node:fs";
import { dirname, relative } from "node:path";
import ts from "typescript";
import type { Extraction, ReferenceRow, RelationRow, SymbolRow } from "../index/index.ts";
import { makeDocId, scopeOf, TOP_LEVEL } from "../index/index.ts";
import { declarationName, fqNameOf, isLocal, kindOf, nameNode } from "./declarations.ts";
import { pathKey } from "./discovery.ts";
import { accessibilityOf } from "./display.ts";
import { packageModulePath, packageOf } from "./packages.ts";
import { toSlashes } from "./positions.ts";
import { classifyReference, enclosingStopOf } from "./references.ts";
import { fileNameIndex } from "./resolver.ts";
import type { LoadedProject, LoadedSolution } from "./solution.ts";
import { owningProject, projectName } from "./solution.ts";

/** Optional context: the solution decides which project owns a file (and so its docId scope). */
export type ExtractContext = { solution?: LoadedSolution; program?: ts.Program };

type TypeDecl = ts.ClassDeclaration | ts.InterfaceDeclaration;

const isTypeDecl = (node: ts.Node): node is TypeDecl => ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node);
const isParameterProperty = (node: ts.Node): node is ts.ParameterDeclaration =>
  ts.isParameter(node) && ts.isParameterPropertyDeclaration(node, node.parent);

// ---- docIds ---------------------------------------------------------------------------------

const scopes = new WeakMap<LoadedProject, Map<string, string>>();

const isUnder = (path: string, dir: string): boolean => pathKey(path).startsWith(`${pathKey(dir)}/`);

/** Directory and key of the project a non-node_modules file belongs to. */
function ownerOf(path: string, project: LoadedProject, solution: LoadedSolution | undefined): { dir: string; key: string } {
  const owner = solution ? owningProject(solution, path) : undefined;
  if (owner) return { dir: owner.dir, key: owner.name };
  if (project.fileKeys.has(pathKey(path)) || isUnder(path, project.dir)) return { dir: project.dir, key: project.name };
  const containing = (solution?.projects ?? []).filter((p) => isUnder(path, p.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
  if (containing) return { dir: containing.dir, key: containing.name };
  for (let dir = toSlashes(dirname(path)); ; dir = toSlashes(dirname(dir))) {
    if (existsSync(`${dir}/package.json`) || existsSync(`${dir}/tsconfig.json`)) return { dir, key: projectName(dir) };
    if (dirname(dir) === dir || toSlashes(dirname(dir)) === dir) return { dir: project.dir, key: project.name };
  }
}

/**
 * docId scope of a file: `{package name}/{module path in package}` (source root stripped, see `packageOf`),
 * the same for a package's source and its published declaration files; without a package `{projectKey}/{modulePath}`.
 */
export function fileScope(fileName: string, project: LoadedProject, solution?: LoadedSolution): string {
  let cache = scopes.get(project);
  if (!cache) scopes.set(project, (cache = new Map()));
  const path = toSlashes(fileName);
  const key = `${solution?.path ?? ""}|${pathKey(path)}`;
  let scope = cache.get(key);
  if (scope === undefined) {
    const info = packageOf(path);
    if (info) scope = scopeOf(info.name, packageModulePath(info, path));
    else {
      const owner = ownerOf(path, project, solution);
      scope = scopeOf(owner.key, toSlashes(relative(owner.dir, path)));
    }
    cache.set(key, scope);
  }
  return scope;
}

/** `{scope}#{fqName}` of a declaration node. */
export function docIdOf(node: ts.Node, project: LoadedProject, solution?: LoadedSolution): string {
  return makeDocId(fileScope(node.getSourceFile().fileName, project, solution), fqNameOf(node));
}

// ---- helpers --------------------------------------------------------------------------------

function isDefaultLib(sourceFile: ts.SourceFile, project: LoadedProject, program: ts.Program | undefined): boolean {
  if (program?.isSourceFileDefaultLibrary(sourceFile)) return true;
  const libDir = toSlashes(dirname(ts.getDefaultLibFilePath(project.host.options)));
  return pathKey(dirname(sourceFile.fileName)) === pathKey(libDir) && /\/lib\.[^/]*\.d\.ts$/i.test(toSlashes(sourceFile.fileName));
}

/** The same text `toResolved` gives as `signature`. */
function signatureOf(node: ts.Node, checker: ts.TypeChecker): string {
  const isCtor = ts.isConstructorDeclaration(node);
  const target = isCtor ? node.parent : node;
  const name = (target as ts.NamedDeclaration).name;
  const symbol = name ? checker.getSymbolAtLocation(name) : undefined;
  const text = symbol ? checker.symbolToString(symbol) : (declarationName(node) ?? "");
  if (isCtor) {
    const sig = checker.getSignatureFromDeclaration(node) ?? (symbol && checker.getTypeOfSymbol(symbol).getConstructSignatures()[0]);
    return `new ${text}${sig ? checker.signatureToString(sig) : "()"}`;
  }
  if (ts.isFunctionLike(node)) {
    const sig = checker.getSignatureFromDeclaration(node as ts.SignatureDeclaration);
    if (sig) return `${text}${checker.signatureToString(sig)}`;
  }
  return text;
}

/** A namespace in a declaration file or under a `declare` namespace/module: its declarations are implicitly exported. */
function isAmbient(module: ts.ModuleDeclaration): boolean {
  if (module.getSourceFile().isDeclarationFile) return true;
  for (let node: ts.Node | undefined = module; node && !ts.isSourceFile(node); node = node.parent) {
    if (ts.isModuleDeclaration(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return false;
}

/** Class-member accessibility, `export`/`private` at the top level and in namespaces, else `public`. */
function accessibilityText(node: ts.Node): string {
  if (isParameterProperty(node) || ts.isClassLike(node.parent)) return accessibilityOf(node);
  const span = ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) ? node.parent.parent : node;
  const container = span.parent;
  if (!container || !(ts.isSourceFile(container) || ts.isModuleBlock(container))) return "public";
  if (ts.isSourceFile(container) && !ts.isExternalModule(container)) return "export";
  if (ts.isModuleBlock(container) && isAmbient(container.parent)) return "export";
  const modifiers = ts.canHaveModifiers(span) ? (ts.getModifiers(span) ?? []) : [];
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ? "export" : "private";
}

/** Nearest enclosing class, interface, enum, namespace, type alias or variable that names the owner. */
function containerOf(node: ts.Node): ts.Node | null {
  const start = isParameterProperty(node) ? node.parent.parent : node.parent;
  for (let parent: ts.Node | undefined = start; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if (
      (ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent) || ts.isEnumDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) || (ts.isModuleDeclaration(parent) && ts.isIdentifier(parent.name)) ||
        (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))) &&
      declarationName(parent) !== undefined
    ) {
      return parent;
    }
  }
  return null;
}

/** Non-alias declarations of the file in source order, plus constructors and constructor parameter properties. */
function declarationsOf(sourceFile: ts.SourceFile): ts.Node[] {
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
  return nodes.sort((a, b) => a.getStart(sourceFile) - b.getStart(sourceFile));
}

function heritageTargets(type: ts.ExpressionWithTypeArguments, checker: ts.TypeChecker): TypeDecl[] {
  let symbol = checker.getTypeAtLocation(type.expression).getSymbol();
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return (symbol?.declarations ?? []).filter(isTypeDecl);
}

function heritage(decl: TypeDecl, token: ts.SyntaxKind, checker: ts.TypeChecker): TypeDecl[] {
  return (decl.heritageClauses ?? []).filter((c) => c.token === token).flatMap((c) => c.types.flatMap((t) => heritageTargets(t, checker)));
}

/** Breadth-first closure over `next`, excluding the roots. */
function closure(roots: TypeDecl[], next: (decl: TypeDecl) => TypeDecl[]): TypeDecl[] {
  const seen = new Set<ts.Node>(roots);
  const queue = [...roots];
  const found: TypeDecl[] = [];
  for (let i = 0; i < queue.length; i++) {
    for (const decl of next(queue[i]!)) {
      if (seen.has(decl)) continue;
      seen.add(decl);
      queue.push(decl);
      found.push(decl);
    }
  }
  return found;
}

function isMember(node: ts.Node): boolean {
  return (
    ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) || ts.isAccessor(node) || isParameterProperty(node)
  );
}

function membersOf(type: TypeDecl): ts.Node[] {
  const own: ts.Node[] = [...type.members];
  const ctor = type.members.find(ts.isConstructorDeclaration);
  if (ctor) own.push(...ctor.parameters.filter((p) => ts.isParameterPropertyDeclaration(p, ctor)));
  return own.filter(isMember);
}

// ---- extraction -----------------------------------------------------------------------------

/** Symbols, references and heritage relations of one source file, keyed by docId. */
export function extractDocument(
  project: LoadedProject,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  context: ExtractContext = {},
): Extraction {
  const { solution } = context;
  const program = context.program ?? project.service.getProgram();
  const docId = (node: ts.Node): string => docIdOf(node, project, solution);
  const external = (node: ts.Node): boolean => isDefaultLib(node.getSourceFile(), project, program);
  const lineCol = (node: ts.Node): { line: number; col: number } => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: line + 1, col: character + 1 };
  };

  const symbols = new Map<string, SymbolRow>();
  const relations = new Map<string, RelationRow>();
  const relate = (from: string, to: ts.Node, kind: string): void => {
    if (external(to)) return;
    const row = { fromDocId: from, toDocId: docId(to), kind };
    relations.set(`${row.fromDocId}\n${row.toDocId}\n${kind}`, row);
  };

  const declarations = declarationsOf(sourceFile);
  for (const node of declarations) {
    const id = docId(node);
    if (symbols.has(id)) continue;
    const container = containerOf(node);
    symbols.set(id, {
      docId: id,
      kind: isParameterProperty(node) ? "field" : (kindOf(node) ?? "variable"),
      name: declarationName(node) ?? "",
      fqName: fqNameOf(node),
      signature: signatureOf(node, checker),
      accessibility: accessibilityText(node),
      containingDocId: container ? docId(container) : null,
      ...lineCol(nameNode(node)),
      endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
    });
  }

  for (const decl of declarations.filter(isTypeDecl)) {
    const from = docId(decl);
    const isClass = ts.isClassDeclaration(decl);
    for (const target of heritage(decl, ts.SyntaxKind.ExtendsKeyword, checker)) relate(from, target, "inherits");
    for (const target of heritage(decl, ts.SyntaxKind.ImplementsKeyword, checker)) relate(from, target, "implements");
    if (!isClass) continue;
    const bases = closure([decl], (d) => (ts.isClassDeclaration(d) ? heritage(d, ts.SyntaxKind.ExtendsKeyword, checker) : []))
      .filter(ts.isClassDeclaration);
    const direct = [decl, ...bases].flatMap((d) => heritage(d, ts.SyntaxKind.ImplementsKeyword, checker));
    const interfaces = [...new Set([...direct, ...closure(direct, (d) => heritage(d, ts.SyntaxKind.ExtendsKeyword, checker))])];
    for (const member of membersOf(decl)) {
      const name = declarationName(member);
      if (name === undefined || name.startsWith("#")) continue;
      const memberId = docId(member);
      for (const base of bases) {
        for (const target of membersOf(base)) if (declarationName(target) === name) relate(memberId, target, "overrides");
      }
      for (const type of interfaces) {
        for (const target of membersOf(type)) if (declarationName(target) === name) relate(memberId, target, "implements");
      }
    }
  }

  return { symbols: [...symbols.values()], references: referencesOf(sourceFile, checker, docId, external, lineCol), relations: [...relations.values()] };
}

function referencesOf(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  docId: (node: ts.Node) => string,
  external: (node: ts.Node) => boolean,
  lineCol: (node: ts.Node) => { line: number; col: number },
): ReferenceRow[] {
  const references = new Map<string, ReferenceRow>();
  const target = (identifier: ts.Node): ts.Node | undefined => {
    let symbol = checker.getSymbolAtLocation(identifier);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.declarations?.[0];
    if (!declaration || ts.isSourceFile(declaration) || ts.isTypeParameterDeclaration(declaration)) return undefined;
    if (ts.isParameter(declaration) && !isParameterProperty(declaration)) return undefined;
    if (!isParameterProperty(declaration) && isLocal(declaration)) return undefined;
    if (kindOf(declaration) === null || external(declaration)) return undefined;
    return declaration;
  };
  const add = (identifier: ts.Identifier | ts.PrivateIdentifier): void => {
    const parent = identifier.parent;
    if ((parent as ts.NamedDeclaration).name === identifier && kindOf(parent) !== null) return;
    const declaration = target(identifier);
    if (!declaration) return;
    const targetDocId = docId(declaration);
    if (targetDocId.endsWith("#")) return;
    const { kind, node } = classifyReference(identifier);
    const { stop, inImport } = enclosingStopOf(node);
    const row = { targetDocId, kind, ...lineCol(identifier), fromDocId: stop ? docId(stop) : inImport ? null : TOP_LEVEL };
    references.set(`${targetDocId}\n${row.line}\n${row.col}`, row);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) add(node);
    else ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...references.values()];
}

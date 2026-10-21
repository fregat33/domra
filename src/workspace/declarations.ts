import ts from "typescript";

export type SymbolKind =
  | "class"
  | "interface"
  | "typeAlias"
  | "enum"
  | "enumMember"
  | "function"
  | "method"
  | "property"
  | "field"
  | "variable"
  | "parameter"
  | "namespace"
  | "module"
  | "constructor"
  | "accessor";

/** Kind of a declaration node; null for nodes that are not declarations Domra reports. */
export function kindOf(node: ts.Node): SymbolKind | null {
  switch (node.kind) {
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
      return "class";
    case ts.SyntaxKind.InterfaceDeclaration:
      return "interface";
    case ts.SyntaxKind.TypeAliasDeclaration:
      return "typeAlias";
    case ts.SyntaxKind.EnumDeclaration:
      return "enum";
    case ts.SyntaxKind.EnumMember:
      return "enumMember";
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
      return "function";
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
    case ts.SyntaxKind.CallSignature:
    case ts.SyntaxKind.IndexSignature:
      return "method";
    case ts.SyntaxKind.PropertyDeclaration:
      return "field";
    case ts.SyntaxKind.PropertySignature:
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.ShorthandPropertyAssignment:
      return "property";
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return "accessor";
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.BindingElement:
      return "variable";
    case ts.SyntaxKind.Parameter:
    case ts.SyntaxKind.TypeParameter:
      return "parameter";
    case ts.SyntaxKind.ModuleDeclaration:
      return ts.isStringLiteral((node as ts.ModuleDeclaration).name) ? "module" : "namespace";
    case ts.SyntaxKind.SourceFile:
      return "module";
    case ts.SyntaxKind.Constructor:
    case ts.SyntaxKind.ConstructSignature:
      return "constructor";
    default:
      return null;
  }
}

/** True when the node sits inside a function-like body (a local declaration). */
export function isLocal(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent) || ts.isClassStaticBlockDeclaration(parent)) return true;
    if (ts.isSourceFile(parent) || ts.isModuleBlock(parent)) return false;
  }
  return false;
}

/**
 * Rank of a declaration on a line (position specs without a column), lower is better:
 * types 0, functions/methods/accessors 1, properties/fields/variables 2, other 3,
 * parameters and locals 4.
 */
export function lineRank(node: ts.Node): number {
  const kind = kindOf(node);
  if (kind === null) return 5;
  if (kind === "parameter") return 4;
  if (kind === "class" || kind === "interface" || kind === "typeAlias" || kind === "enum") {
    return 0;
  }
  if (isLocal(node)) return 4;
  if (kind === "function" || kind === "method" || kind === "accessor" || kind === "constructor") {
    return 1;
  }
  if (kind === "property" || kind === "field" || kind === "variable") return 2;
  return 3;
}

/**
 * Category for bare-name resolution, lower wins: types 0, functions 1,
 * variables and namespaces 2, members 3.
 */
export function nameCategory(kind: SymbolKind): number {
  switch (kind) {
    case "class":
    case "interface":
    case "typeAlias":
    case "enum":
      return 0;
    case "function":
      return 1;
    case "variable":
    case "namespace":
    case "module":
      return 2;
    default:
      return 3;
  }
}

/** Identifier-like name of a declaration, or undefined. */
export function declarationName(node: ts.Node): string | undefined {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const name = (node as ts.NamedDeclaration).name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** The node to report the position of: the declaration name if it has one. */
export function nameNode(node: ts.Node): ts.Node {
  const name = (node as ts.NamedDeclaration).name;
  if (name) return name;
  if (ts.isConstructorDeclaration(node)) {
    return node.getChildren().find((c) => c.kind === ts.SyntaxKind.ConstructorKeyword) ?? node;
  }
  return node;
}

/** Dotted chain of enclosing namespaces/classes/interfaces/enums plus the declaration's name. */
export function fqNameOf(node: ts.Node): string {
  const parts: string[] = [];
  const own = declarationName(node);
  if (own !== undefined) parts.push(own);
  for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if (
      ts.isClassLike(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      (ts.isModuleDeclaration(parent) && ts.isIdentifier(parent.name)) ||
      (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    ) {
      const name = declarationName(parent);
      if (name !== undefined) parts.unshift(name);
    }
  }
  return parts.join(".");
}

function isIndexedDeclaration(node: ts.Node): boolean {
  switch (node.kind) {
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.InterfaceDeclaration:
    case ts.SyntaxKind.TypeAliasDeclaration:
    case ts.SyntaxKind.EnumDeclaration:
    case ts.SyntaxKind.EnumMember:
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.PropertySignature:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.VariableDeclaration:
      return true;
    case ts.SyntaxKind.ModuleDeclaration:
      return ts.isIdentifier((node as ts.ModuleDeclaration).name);
    // Renamed aliases (`import { a as b }`, `export { a as b }`) are indexed under the new
    // name and normalised to the original declaration by the resolver.
    case ts.SyntaxKind.ImportSpecifier:
    case ts.SyntaxKind.ExportSpecifier:
      return (node as ts.ImportSpecifier | ts.ExportSpecifier).propertyName !== undefined;
    case ts.SyntaxKind.ImportEqualsDeclaration:
      return true;
    default:
      return false;
  }
}

/**
 * Map of name → non-local named declarations in a source file. Function bodies are not
 * entered; namespaces, classes, interfaces, enums and type literals are.
 */
export function collectNamedDeclarations(
  sourceFile: ts.SourceFile,
  out: Map<string, ts.Node[]>,
): void {
  const visit = (node: ts.Node): void => {
    if (isIndexedDeclaration(node)) {
      const name = declarationName(node);
      if (name !== undefined) {
        const list = out.get(name);
        if (list) list.push(node);
        else out.set(name, [node]);
      }
    }
    if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer) return;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** All declaration nodes whose name (or constructor keyword) starts on a 0-based line. */
export function declarationsOnLine(sourceFile: ts.SourceFile, line: number): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const startLine = sourceFile.getLineAndCharacterOfPosition(start).line;
    const endLine = sourceFile.getLineAndCharacterOfPosition(end).line;
    if (startLine > line || endLine < line) return;
    if (kindOf(node) !== null && !ts.isSourceFile(node) && !ts.isArrowFunction(node) &&
      !ts.isFunctionExpression(node) && !ts.isClassExpression(node)) {
      const named = nameNode(node);
      const nameLine = sourceFile.getLineAndCharacterOfPosition(named.getStart(sourceFile)).line;
      if (nameLine === line && (named !== node || ts.isConstructorDeclaration(node))) {
        result.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

/** Innermost token-level node covering `offset`. */
export function nodeAt(sourceFile: ts.SourceFile, offset: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    for (const child of node.getChildren(sourceFile)) {
      if (child.getStart(sourceFile) <= offset && offset < child.getEnd()) {
        found = child;
        visit(child);
        return;
      }
    }
  };
  visit(sourceFile);
  return found;
}

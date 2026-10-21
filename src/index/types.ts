/** Rows of one extracted document and the hits the store returns. Plain data, no TypeScript. */

export type SymbolRow = {
  docId: string;
  kind: string;
  name: string;
  fqName: string;
  signature: string;
  /** `public`/`protected`/`private` for class members, `export`/`private` for top-level and namespace declarations. */
  accessibility: string;
  /** docId of the enclosing class, interface, enum, namespace or type-literal owner; null at the top level. */
  containingDocId: string | null;
  /** 1-based position of the declaration name. */
  line: number;
  col: number;
  /** 1-based last line of the declaration. */
  endLine: number;
};

export type ReferenceRow = {
  targetDocId: string;
  /** `usage`, `invocation`, `creation`, `base`, `decorator` or `import`. */
  kind: string;
  line: number;
  col: number;
  /** docId of the enclosing declaration, `<top-level>`, or null inside an import/export statement. */
  fromDocId: string | null;
};

export type RelationRow = {
  fromDocId: string;
  toDocId: string;
  /** `inherits`, `implements` or `overrides`. */
  kind: string;
};

export type Extraction = { symbols: SymbolRow[]; references: ReferenceRow[]; relations: RelationRow[] };

/** The current document a hit was read from. */
export type DocumentRow = {
  projectId: number;
  projectName: string;
  /** tsconfig path of the project, forward slashes. */
  projectPath: string;
  solutionPath: string;
  /** Absolute path of the document, forward slashes. */
  path: string;
  contentHash: string;
};

export type SymbolHit = SymbolRow & { document: DocumentRow };

export type ReferenceHit = ReferenceRow & { document: DocumentRow };

export type RelationHit = {
  fromDocId: string;
  toDocId: string;
  kind: string;
  /** The declaring symbol row of `fromDocId` in the same document, when present. */
  symbol: SymbolRow | null;
  document: DocumentRow;
};

export type ProjectInfo = {
  /** tsconfig path, forward slashes. */
  path: string;
  name: string;
  packageName: string | null;
  solutionPath: string;
  version: string | null;
};

export type ProjectRow = ProjectInfo & { id: number; indexedSchema: number };

/** A package version a project consumes from node_modules. */
export type PackageRef = { packageName: string; version: string };

export type PackageConsumer = {
  projectId: number;
  projectPath: string;
  projectName: string;
  solutionPath: string;
  version: string;
};

/** A consumer project whose consumed version differs from the version the source project declares. */
export type DriftRow = {
  packageName: string;
  sourceVersion: string;
  sourceProjectPath: string;
  sourceSolutionPath: string;
  consumerProjectPath: string;
  consumerProjectName: string;
  consumerSolutionPath: string;
  consumedVersion: string;
};

export type TreeEntry ={ contentHash: string; mtime: number; size: number };

export type IndexStats = {
  projects: number;
  trackedFiles: number;
  blobs: number;
  symbols: number;
  references: number;
  relations: number;
};

export type ReferenceScope = "all" | "production" | "tests";

export type ReferenceFilter = { kinds?: string[]; scope?: ReferenceScope };

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import ts from "typescript";
import type { DiscoveredSolution } from "./discovery.ts";
import { normalizePath, pathKey } from "./discovery.ts";
import { toSlashes } from "./positions.ts";

type Snapshot = { version: number; text: string };

/**
 * LanguageServiceHost that serves file contents from an in-memory snapshot map. Files are
 * read from disk once on first use; `setFile` replaces the in-memory text without touching disk.
 */
export class SnapshotHost implements ts.LanguageServiceHost {
  private readonly snapshots = new Map<string, Snapshot | null>();
  private readonly roots: string[];
  private projectVersion = 0;
  readonly dir: string;
  readonly options: ts.CompilerOptions;
  readonly projectReferences: readonly ts.ProjectReference[] | undefined;

  constructor(parsed: ts.ParsedCommandLine, dir: string) {
    this.roots = parsed.fileNames.map(toSlashes);
    this.dir = dir;
    this.options = parsed.options;
    this.projectReferences = parsed.projectReferences;
  }

  private entry(fileName: string): Snapshot | null {
    const key = pathKey(fileName);
    let snapshot = this.snapshots.get(key);
    if (snapshot === undefined) {
      const text = ts.sys.readFile(fileName);
      snapshot = text === undefined ? null : { version: 0, text };
      this.snapshots.set(key, snapshot);
    }
    return snapshot;
  }

  /** Current text of a file (in-memory snapshot, else disk), or undefined when it does not exist. */
  getText(fileName: string): string | undefined {
    return this.entry(fileName)?.text;
  }

  /** Replace (or create) a file in memory; `null` marks it deleted. */
  setFile(fileName: string, text: string | null): void {
    const key = pathKey(fileName);
    const previous = this.snapshots.get(key);
    const version = (previous?.version ?? 0) + 1;
    this.snapshots.set(key, text === null ? null : { version, text });
    this.projectVersion++;
  }

  /** Append a root file (no duplicates by pathKey). */
  addRoot(fileName: string): void {
    const key = pathKey(fileName);
    if (this.roots.some((root) => pathKey(root) === key)) return;
    this.roots.push(toSlashes(fileName));
    this.projectVersion++;
  }

  /** Take over every snapshot and the root list of `other` (for a forked host; `other` is not changed). */
  copyFrom(other: SnapshotHost): void {
    for (const [key, snapshot] of other.snapshots) this.snapshots.set(key, snapshot);
    this.roots.splice(0, this.roots.length, ...other.roots);
    this.projectVersion++;
  }

  /** Stop listing a root file; its snapshot is left alone. */
  removeRoot(fileName: string): void {
    const key = pathKey(fileName);
    const index = this.roots.findIndex((root) => pathKey(root) === key);
    if (index < 0) return;
    this.roots.splice(index, 1);
    this.projectVersion++;
  }

  getProjectVersion(): string {
    return String(this.projectVersion);
  }
  getScriptFileNames(): string[] {
    return this.roots;
  }
  getScriptVersion(fileName: string): string {
    return String(this.entry(fileName)?.version ?? 0);
  }
  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    const snapshot = this.entry(fileName);
    return snapshot ? ts.ScriptSnapshot.fromString(snapshot.text) : undefined;
  }
  getCurrentDirectory(): string {
    return this.dir;
  }
  getCompilationSettings(): ts.CompilerOptions {
    return this.options;
  }
  getDefaultLibFileName(options: ts.CompilerOptions): string {
    return ts.getDefaultLibFilePath(options);
  }
  getProjectReferences(): readonly ts.ProjectReference[] | undefined {
    return this.projectReferences;
  }
  /** Cross-project imports resolve to the referenced project's sources, not to its build output. */
  useSourceOfProjectReferenceRedirect(): boolean {
    return true;
  }
  useCaseSensitiveFileNames(): boolean {
    return ts.sys.useCaseSensitiveFileNames;
  }
  fileExists(fileName: string): boolean {
    const snapshot = this.snapshots.get(pathKey(fileName));
    return snapshot !== undefined ? snapshot !== null : ts.sys.fileExists(fileName);
  }
  readFile(fileName: string): string | undefined {
    return this.entry(fileName)?.text;
  }
  readDirectory(
    path: string,
    extensions?: readonly string[],
    exclude?: readonly string[],
    include?: readonly string[],
    depth?: number,
  ): string[] {
    return ts.sys.readDirectory(path, extensions, exclude, include, depth);
  }
  directoryExists(directoryName: string): boolean {
    return ts.sys.directoryExists(directoryName);
  }
  getDirectories(directoryName: string): string[] {
    return ts.sys.getDirectories(directoryName);
  }
  realpath(path: string): string {
    return ts.sys.realpath ? ts.sys.realpath(path) : path;
  }
}

export type LoadedProject = {
  name: string;
  /** Absolute tsconfig path, forward slashes. */
  tsconfig: string;
  dir: string;
  /** Root file names of the project (forward slashes). */
  fileNames: string[];
  /** pathKey of every root file, for ownership checks. */
  fileKeys: Set<string>;
  host: SnapshotHost;
  service: ts.LanguageService;
  /** The parsed tsconfig the host was created from (for forked hosts). */
  parsed: ts.ParsedCommandLine;
  /** Number of root files (`fileNames.length`). */
  rootFiles: number;
  /** Non-declaration program files outside node_modules (roots plus everything they import). */
  sourceFiles: number;
  /** Declaration program files outside node_modules, excluding default libs. */
  declarationFiles: number;
  /** Unresolved specifiers over all source files: `relative` = not a bare package name. */
  unresolved: { relative: number; package: number };
  /** `unresolved.relative + unresolved.package`. */
  unresolvedImports: number;
  /** tsconfig read/parse errors, flattened. */
  diagnostics: string[];
};

export type LoadedSolution = {
  name: string;
  path: string;
  dir: string;
  projects: LoadedProject[];
  fileCount: number;
  rootFiles: number;
  sourceFiles: number;
  declarationFiles: number;
  unresolved: { relative: number; package: number };
  unresolvedImports: number;
  loadMs: number;
  /** mtime+size (`mtime:size`, null when absent) of the project files at load time, by path; see `projectFilesChanged`. */
  projectStamps: Map<string, string | null>;
};

const PACKAGE_FILES = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

function stampOf(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${Math.trunc(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return null;
  }
}

/** The tsconfigs, package.json and lockfiles that shape a solution: its own tsconfig plus those of its projects and their directories. */
function projectFilePaths(solution: DiscoveredSolution, projects: readonly { tsconfig: string; dir: string }[]): string[] {
  const paths = new Set<string>([solution.path]);
  for (const project of projects) paths.add(project.tsconfig);
  for (const dir of new Set([solution.dir, ...projects.map((p) => p.dir)])) {
    for (const name of PACKAGE_FILES) paths.add(`${toSlashes(dir)}/${name}`);
  }
  return [...paths];
}

function stampProjectFiles(solution: DiscoveredSolution, projects: readonly { tsconfig: string; dir: string }[]): Map<string, string | null> {
  return new Map(projectFilePaths(solution, projects).map((path) => [path, stampOf(path)]));
}

/** Whether a tsconfig, package.json or lockfile of the loaded solution changed (or appeared, or vanished) since it was loaded. */
export function projectFilesChanged(solution: LoadedSolution): boolean {
  for (const [path, stamp] of solution.projectStamps) {
    if (stampOf(path) !== stamp) return true;
  }
  return false;
}

/** `name` from package.json in the project directory, else the directory name. */
export function projectName(dir: string): string {
  const packageJson = join(dir, "package.json");
  if (existsSync(packageJson)) {
    try {
      const name: unknown = JSON.parse(readFileSync(packageJson, "utf8"))?.name;
      if (typeof name === "string" && name !== "") return name;
    } catch {
      // fall back to the directory name
    }
  }
  return basename(dir);
}

function flatten(diagnostics: readonly ts.Diagnostic[]): string[] {
  return diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

function moduleSpecifiers(sourceFile: ts.SourceFile): ts.Expression[] {
  const result: ts.Expression[] = [];
  const visit = (statements: readonly ts.Statement[]): void => {
    for (const statement of statements) {
      if (ts.isImportDeclaration(statement)) {
        result.push(statement.moduleSpecifier);
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
        result.push(statement.moduleSpecifier);
      } else if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference)
      ) {
        result.push(statement.moduleReference.expression);
      } else if (
        ts.isModuleDeclaration(statement) &&
        statement.body &&
        ts.isModuleBlock(statement.body)
      ) {
        visit(statement.body.statements);
      }
    }
  };
  visit(sourceFile.statements);
  return result;
}

const NODE_MODULES = /(^|\/)node_modules\//;
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx"];

function matchesPathsKey(key: string, specifier: string): boolean {
  const star = key.indexOf("*");
  if (star < 0) return key === specifier;
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  return (
    specifier.length >= prefix.length + suffix.length &&
    specifier.startsWith(prefix) &&
    specifier.endsWith(suffix)
  );
}

/** A non-relative specifier that `paths` or `baseUrl` is meant to handle is not a package name. */
function isMappedSpecifier(specifier: string, options: ts.CompilerOptions): boolean {
  if (options.paths && Object.keys(options.paths).some((key) => matchesPathsKey(key, specifier))) {
    return true;
  }
  if (typeof options.baseUrl === "string") {
    const target = join(options.baseUrl, specifier.split("/")[0] ?? "");
    return SOURCE_EXTENSIONS.some((ext) => ts.sys.fileExists(target + ext)) ||
      ts.sys.directoryExists(target);
  }
  return false;
}

export type ProgramMetrics = {
  sourceFiles: number;
  declarationFiles: number;
  unresolved: { relative: number; package: number };
};

/**
 * One pass over `program.getSourceFiles()`: counts source and declaration files outside
 * `node_modules`, and the module specifiers of every source file that do not resolve.
 */
export function measureProgram(program: ts.Program): ProgramMetrics {
  const checker = program.getTypeChecker();
  const options = program.getCompilerOptions();
  const metrics: ProgramMetrics = {
    sourceFiles: 0,
    declarationFiles: 0,
    unresolved: { relative: 0, package: 0 },
  };
  for (const sourceFile of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(sourceFile)) continue;
    if (NODE_MODULES.test(toSlashes(sourceFile.fileName))) continue;
    if (sourceFile.isDeclarationFile) {
      metrics.declarationFiles++;
      continue;
    }
    metrics.sourceFiles++;
    for (const specifier of moduleSpecifiers(sourceFile)) {
      if (checker.getSymbolAtLocation(specifier)) continue;
      const text = ts.isStringLiteralLike(specifier) ? specifier.text : "";
      const bare = !/^[./]/.test(text) && !isMappedSpecifier(text, options);
      if (bare) metrics.unresolved.package++;
      else metrics.unresolved.relative++;
    }
  }
  return metrics;
}

function parseTsconfig(tsconfig: string, dir: string): { read: ReturnType<typeof ts.readConfigFile>; parsed: ts.ParsedCommandLine } {
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dir, undefined, tsconfig);
  return { read, parsed };
}

export function loadProject(tsconfigPath: string, registry: ts.DocumentRegistry): LoadedProject {
  const tsconfig = normalizePath(tsconfigPath);
  const dir = toSlashes(dirname(tsconfig));
  const { read, parsed } = parseTsconfig(tsconfig, dir);
  const diagnostics = read.error ? flatten([read.error]) : [];
  diagnostics.push(
    ...flatten(parsed.errors.filter((e) => e.category === ts.DiagnosticCategory.Error)),
  );
  const host = new SnapshotHost(parsed, dir);
  const service = ts.createLanguageService(host, registry);
  const fileNames = host.getScriptFileNames();
  const fileKeys = new Set(fileNames.map(pathKey));
  const program = service.getProgram();
  const metrics = program ? measureProgram(program) : undefined;
  const unresolved = metrics?.unresolved ?? { relative: 0, package: 0 };
  return {
    name: projectName(dir),
    tsconfig,
    dir,
    fileNames,
    fileKeys,
    host,
    service,
    parsed,
    rootFiles: fileNames.length,
    sourceFiles: metrics?.sourceFiles ?? 0,
    declarationFiles: metrics?.declarationFiles ?? 0,
    unresolved,
    unresolvedImports: unresolved.relative + unresolved.package,
    diagnostics,
  };
}

export function loadSolution(
  solution: DiscoveredSolution,
  registry: ts.DocumentRegistry = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames),
): LoadedSolution {
  const started = performance.now();
  const projects = solution.projects.map((path) => loadProject(path, registry));
  return {
    name: solution.name,
    path: solution.path,
    dir: solution.dir,
    projects,
    fileCount: projects.reduce((sum, p) => sum + p.fileNames.length, 0),
    rootFiles: projects.reduce((sum, p) => sum + p.rootFiles, 0),
    sourceFiles: projects.reduce((sum, p) => sum + p.sourceFiles, 0),
    declarationFiles: projects.reduce((sum, p) => sum + p.declarationFiles, 0),
    unresolved: {
      relative: projects.reduce((sum, p) => sum + p.unresolved.relative, 0),
      package: projects.reduce((sum, p) => sum + p.unresolved.package, 0),
    },
    unresolvedImports: projects.reduce((sum, p) => sum + p.unresolvedImports, 0),
    loadMs: Math.round(performance.now() - started),
    projectStamps: stampProjectFiles(solution, projects),
  };
}

/**
 * Add `path` as a root file when the project's tsconfig (re-parsed from disk) lists it.
 * `fileCount` and `sourceFiles` counters of the loaded solution are not updated.
 */
export function addRootFile(project: LoadedProject, path: string): boolean {
  const key = pathKey(path);
  if (!projectFileList(project).some((name) => pathKey(name) === key)) return false;
  adoptRootFile(project, path);
  return true;
}

/** Files the project's tsconfig lists right now (re-parsed from disk), forward slashes. */
export function projectFileList(project: LoadedProject): string[] {
  return parseTsconfig(project.tsconfig, project.dir).parsed.fileNames.map(toSlashes);
}

/** Make `path` a root file of the project without consulting the tsconfig. */
export function adoptRootFile(project: LoadedProject, path: string): void {
  const key = pathKey(path);
  const name = toSlashes(normalizePath(path));
  project.host.addRoot(name);
  if (!project.fileNames.some((existing) => pathKey(existing) === key)) project.fileNames.push(name);
  project.fileKeys.add(key);
}

/** Drop `path` from the root files of the project; false when it was not a root. */
export function removeRootFile(project: LoadedProject, path: string): boolean {
  const key = pathKey(path);
  if (!project.fileKeys.delete(key)) return false;
  project.host.removeRoot(path);
  const index = project.fileNames.findIndex((existing) => pathKey(existing) === key);
  if (index >= 0) project.fileNames.splice(index, 1);
  return true;
}

/** The project whose root files include `fileName`, if any. */
export function owningProject(
  solution: LoadedSolution,
  fileName: string,
): LoadedProject | undefined {
  const key = pathKey(fileName);
  return solution.projects.find((p) => p.fileKeys.has(key));
}

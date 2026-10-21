import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { GroupedText, LoadedSolution, QueryText, SymbolKind } from "../workspace/index.ts";
import {
  createGit, DEFAULT_LIMIT, definition, diagnosticsText, findImplementationsText, findReferencesText, formatGroupedText, formatNotFound,
  formatQueryText, formatSearch, getCallGraphText, listMembers, outline, parseSymbolSpec, reviewChangesText, searchWorkspace, symbolInfo,
  WorkspaceManager,
} from "../workspace/index.ts";
import { defaultIndexPath, IndexStore } from "../index/index.ts";
import { reviewIndexFor } from "../server/reviewIndex.ts";
import { parseArgs, parsePositiveInt, UsageError } from "./args.ts";
import { driftCommand, indexCommand, indexSearchCommand, indexStatusCommand } from "./indexCommands.ts";

export type CliIo = {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
};

const SYMBOL_KINDS: readonly SymbolKind[] = [
  "class", "interface", "typeAlias", "enum", "enumMember", "function", "method", "property",
  "field", "variable", "parameter", "namespace", "module", "constructor", "accessor",
];

const USAGE = `usage: node scripts/domra-cli.ts <command> <root> [args] [options]

commands:
  status <root>                 one line per solution, then a total
  search <root> <pattern>       search symbols (camel-case humps supported)
  resolve <root> <spec>         resolve a symbol spec to its header (symbol, project, definition)
  definition <root> <spec>      header plus every declaration of the symbol
  info <root> <spec>            signature, modifiers, parameters, docs and members
  members <root> <spec>         members of a type (class, interface, enum, namespace, type alias)
  outline <root> <target>       one line per declaration of a file (path) or a type (symbol spec)
  references <root> <spec>      every usage of a symbol with kind and enclosing member
  implementations <root> <spec> implementers, derived types and overrides of a type or member
  derived <root> <spec>         types deriving from a class or interface, transitively
  callgraph <root> <spec>       one level of callers and callees of a function, method, constructor, accessor or class
  diagnostics <root> <target>   compiler diagnostics of a file (path) or a project (name), no build
  review <root>                 changed files and declarations of the working tree vs the merge base of a git ref
  index <root>                  load and index every solution into the SQLite index
  index-search <root> <pattern> search the index without loading anything
  index-status                  counts of the index
  drift                         consumer projects on a package version other than the source's (from the index)
  help                         show this text

options:
  --solution <hint>             load/query only the solution matching path, name or substring
  --kind <SymbolKind>           search: only this kind (${SYMBOL_KINDS.join(", ")})
                                references: usage kinds, comma-separated (usage, invocation, creation, base,
                                decorator, import)
  --scope <s>                   references, callgraph: all (default), production or tests
  --direction <d>               callgraph: both (default), callers or callees
  --include-external            callgraph: include callees declared in node_modules or the default libs
  --direct                      callgraph: list only callers that bind to the symbol itself (no 'via' callers)
  --defining-only               references: skip the other loaded solutions
  --limit <n>                   search: maximum hits per solution; definition/info/members: maximum items;
                                references/implementations/derived: maximum items per solution
                                (positive integer); drift: maximum consumer lines per package (default 50)
  --filter <text>               members: only members whose name contains the text (ignoring case)
  --inherited                   members: include members inherited from base types
  --min-severity <s>            diagnostics: error, warning (default) or info
  --depth <1..3>               outline: nesting levels to list (default 2, clamped)
  --no-private                  outline: hide private declarations
  --base <ref>                  review: branch, tag or commit to compare with (default: the repository's default branch)
  --git <path>                  review: git executable (default: DOMRA_GIT_PATH, else git on the PATH)
  --no-tests                    review: hide the files of test projects (they still count)
  --db <path>                   index commands: index database (default %LOCALAPPDATA%/domra/index.db)
  --force                       index: re-extract every document
  --verbose                     print diagnostics to stderr
`;

const COMMANDS = [
  "status", "search", "resolve", "definition", "info", "members", "outline", "references", "implementations", "derived",
  "callgraph", "diagnostics", "review", "index", "index-search", "index-status", "drift",
];
const DRIFT_LIMIT = 50;
const REVIEW_LIMIT = 200;
const CALLGRAPH_LIMIT = 100;
const DIAGNOSTICS_LIMIT = 200;
const OUTLINE_LIMIT = 300;
const SEARCH_LIMIT = 30;

/** An error that maps to a specific exit code with a plain message. */
class CliError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

function required(positionals: string[], index: number, name: string): string {
  const value = positionals[index];
  if (value === undefined) throw new UsageError(`missing required argument '${name}'`);
  return value;
}

function withNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function load(manager: WorkspaceManager, hint: string | undefined, verbose: boolean, io: CliIo): void {
  const started = performance.now();
  manager.discover();
  if (hint !== undefined) {
    try {
      manager.load(hint);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("unknown solution")) {
        throw new CliError(`no solution matches '${hint}'`, 1);
      }
      throw error;
    }
  } else {
    for (const solution of manager.solutions) manager.load(solution.path);
  }
  if (verbose) {
    const count = manager.loadedSolutions.length;
    io.stderr.write(`loaded ${count} solution(s) in ${Math.round(performance.now() - started)} ms\n`);
  }
}

function cell(value: number | null): string {
  return value === null ? "-" : String(value);
}

function statusText(manager: WorkspaceManager): string {
  const rows = manager.status();
  const lines = rows.map((s) =>
    [
      s.name,
      s.state,
      `projects=${s.projects.length > 0 ? s.projects.join(",") : "-"}`,
      `rootFiles=${cell(s.rootFiles)}`,
      `sourceFiles=${cell(s.sourceFiles)}`,
      `unresolved=${s.unresolved ? `${s.unresolved.relative}/${s.unresolved.package}` : "-"}`,
      `loadMs=${cell(s.loadMs)}`,
    ].join("  "),
  );
  lines.push(`Total: ${rows.length} solution(s)`);
  return `${lines.join("\n")}\n`;
}

function isNotFound(result: QueryText): boolean {
  const first = result.head[0] ?? "";
  return first.startsWith("Symbol not found") || first.startsWith("No symbol at") || first.endsWith("is not a type.");
}

function isOutlineFailure(result: QueryText): boolean {
  const first = result.head[0] ?? "";
  return (
    isNotFound(result) || first.startsWith("File not found") || first.includes("is not a type") ||
    first.includes("is not part of")
  );
}

/** The first loaded solution (or the hinted one) whose query finds the spec; else the best not-found text. */
function firstResult(
  manager: WorkspaceManager,
  hint: string | undefined,
  spec: string,
  run: (solution: LoadedSolution, spec: string) => QueryText,
  failed: (result: QueryText) => boolean = isNotFound,
  candidates: LoadedSolution[] = manager.loadedSolutions,
): QueryText {
  const hinted = hint === undefined ? null : manager.resolveSolution(hint);
  const solutions = hint === undefined ? candidates : hinted ? [hinted] : [];
  const results: QueryText[] = [];
  for (const solution of solutions) {
    const result = run(solution, spec);
    if (!failed(result)) return result;
    results.push(result);
  }
  const unknownFile = "The file is not under any loaded solution.";
  const fallback =
    results.find((r) => r.head[1] !== unknownFile && !r.head[0]?.startsWith("File not found")) ?? results[0];
  return fallback ?? { head: formatNotFound(spec, parseSymbolSpec(spec), false), items: [], label: spec };
}

function isGroupedFailure(result: GroupedText): boolean {
  const first = result.head[0] ?? "";
  return (
    first.startsWith("Symbol not found") || first.startsWith("No symbol at") || first.startsWith("find_references:") ||
    first.startsWith("get_call_graph:") || first.includes("get_call_graph needs") || first.includes("not a type")
  );
}

async function reviewCommand(
  manager: WorkspaceManager, options: Map<string, string>, noTests: boolean, limit: number, dbPath: string, io: CliIo,
): Promise<number> {
  // an existing index adds the counts of solutions that are not loaded; a missing one is not created
  const store = existsSync(dbPath) ? IndexStore.open(dbPath) : null;
  try {
    const result = await reviewChangesText(manager, {
      solution: options.get("solution"), base: options.get("base"), includeTests: !noTests,
      git: createGit(options.get("git") || process.env["DOMRA_GIT_PATH"] || undefined),
      ...(store ? { index: reviewIndexFor(store) } : {}),
    });
    io.stdout.write(withNewline(formatQueryText(result, limit)));
    const first = result.head[0] ?? "";
    return first.startsWith("review_changes:") || first.startsWith("Unknown solution") ? 1 : 0;
  } finally {
    store?.close();
  }
}

/** Every command returns its exit code; `review` (which runs git) returns it asynchronously. */
function execute(argv: string[], io: CliIo): number | Promise<number> {
  const { positionals, options, verbose, inherited, noPrivate, definingOnly, force, includeExternal, direct, noTests } = parseArgs(argv);
  const command = positionals[0];
  if (command === undefined || command === "help") {
    io.stdout.write(USAGE);
    return 2;
  }
  if (!COMMANDS.includes(command)) throw new UsageError(`unknown command '${command}'`);
  const dbPath = options.get("db") ?? defaultIndexPath();
  if (command === "index-status") return indexStatusCommand(dbPath, io);
  if (command === "drift") {
    const text = options.get("limit");
    const max = text === undefined ? DRIFT_LIMIT : parsePositiveInt(text);
    if (max === null) throw new UsageError("--limit must be a positive integer");
    return driftCommand(dbPath, max, io);
  }
  const root = required(positionals, 1, "root");
  const argument =
    command === "search" || command === "index-search" ? required(positionals, 2, "pattern")
    : command === "status" || command === "index" || command === "review" ? undefined
    : command === "outline" || command === "diagnostics" ? required(positionals, 2, "target")
    : required(positionals, 2, "spec");

  const limitText = options.get("limit");
  const limit = limitText === undefined ? undefined : parsePositiveInt(limitText);
  if (limit === null) throw new UsageError("--limit must be a positive integer");
  const depthText = options.get("depth");
  if (depthText !== undefined && !/^[0-9]+$/.test(depthText)) throw new UsageError("--depth must be an integer (1..3)");
  const depth = depthText === undefined ? undefined : Math.min(3, Math.max(1, Number(depthText)));
  const kindText = options.get("kind");
  const isSearch = command === "search" || command === "index-search";
  if (isSearch && kindText !== undefined && !SYMBOL_KINDS.includes(kindText as SymbolKind)) {
    throw new UsageError(`--kind must be one of: ${SYMBOL_KINDS.join(", ")}`);
  }
  const kind = kindText as SymbolKind | undefined;
  const solution = options.get("solution");
  if (command === "index-search") return indexSearchCommand(dbPath, root, argument!, kind ?? null, limit ?? SEARCH_LIMIT, io);

  const manager = new WorkspaceManager({ roots: [root] });
  load(manager, solution, verbose, io);

  if (command === "status") {
    io.stdout.write(statusText(manager));
    return 0;
  }
  if (command === "index") return indexCommand(manager, dbPath, force, io);
  if (command === "review") return reviewCommand(manager, options, noTests, limit ?? REVIEW_LIMIT, dbPath, io);
  if (command === "search") {
    const results = searchWorkspace(manager, argument!, { solution, kind, limit });
    io.stdout.write(withNewline(formatSearch(results, argument!)));
    return 0;
  }
  if (command === "diagnostics") {
    const result = diagnosticsText(manager, argument!, { solution, minSeverity: options.get("min-severity") });
    io.stdout.write(formatQueryText(result, limit ?? DIAGNOSTICS_LIMIT));
    return result.head[0]?.startsWith("Diagnostics for") ? 0 : 1;
  }
  if (command === "callgraph") {
    const result = getCallGraphText(manager, argument!, {
      solution, direction: options.get("direction"), includeExternal, direct, scope: options.get("scope"),
    });
    io.stdout.write(withNewline(formatGroupedText(result, limit ?? CALLGRAPH_LIMIT)));
    return isGroupedFailure(result) ? 1 : 0;
  }
  if (command === "references" || command === "implementations" || command === "derived") {
    const result =
      command === "references"
        ? findReferencesText(manager, argument!, {
            solution, allSolutions: !definingOnly, kind: kindText, scope: options.get("scope"),
          })
        : findImplementationsText(manager, argument!, { solution, typesOnly: command === "derived" });
    io.stdout.write(withNewline(formatGroupedText(result, limit ?? DEFAULT_LIMIT)));
    return isGroupedFailure(result) ? 1 : 0;
  }
  if (command === "resolve") {
    const result = firstResult(manager, solution, argument!, definition);
    const failed = isNotFound(result);
    io.stdout.write(`${(failed ? result.head : result.head.slice(0, 3)).join("\n")}\n`);
    return failed ? 1 : 0;
  }
  if (command === "outline") {
    const isFile = /\.(ts|tsx|mts|cts|js|jsx)$/i.test(argument!);
    const owner = isFile && isAbsolute(argument!) ? manager.findSolutionForPath(argument!) : null;
    const runOutline = (s: LoadedSolution, target: string): QueryText =>
      outline(s, target, { depth, includePrivate: !noPrivate });
    const result = firstResult(manager, solution, argument!, runOutline, isOutlineFailure, owner ? [owner] : undefined);
    io.stdout.write(formatQueryText(result, limit ?? OUTLINE_LIMIT));
    return isOutlineFailure(result) ? 1 : 0;
  }
  const run =
    command === "definition" ? definition
    : command === "info" ? symbolInfo
    : (s: LoadedSolution, spec: string) =>
        listMembers(s, spec, { filter: options.get("filter"), includeInherited: inherited });
  const result = firstResult(manager, solution, argument!, run);
  io.stdout.write(formatQueryText(result, limit ?? DEFAULT_LIMIT));
  return isNotFound(result) ? 1 : 0;
}

function report(error: unknown, io: CliIo): number {
  try {
    if (error instanceof UsageError) {
      io.stderr.write(`domra-cli: ${error.message}\n${USAGE}`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`domra-cli: ${message}\n`);
    return error instanceof CliError ? error.code : 1;
  } catch {
    return 1;
  }
}

/**
 * Run the CLI; returns the exit code and never throws. `review` finishes after this returns 0: its output is
 * written when git is done and its exit code is then set on `process.exitCode`. Use `runCliAsync` to await it.
 */
export function runCli(argv: string[], io: CliIo): number {
  try {
    const code = execute(argv, io);
    if (typeof code === "number") return code;
    void code.then(
      (result) => (process.exitCode = result),
      (error: unknown) => (process.exitCode = report(error, io)),
    );
    return 0;
  } catch (error) {
    return report(error, io);
  }
}

/** Run the CLI and wait for every command, `review` included; resolves to the exit code and never rejects. */
export async function runCliAsync(argv: string[], io: CliIo): Promise<number> {
  try {
    return await execute(argv, io);
  } catch (error) {
    return report(error, io);
  }
}

import { isAbsolute } from "node:path";
import type { InputSchema, PropertySchema } from "./arguments.ts";
import type { Pager } from "./pager.ts";
import type { IndexStore } from "../index/index.ts";
import type { GitProvider, GroupedText, LoadedSolution, QueryText, SymbolKind, WorkspaceManager } from "../workspace/index.ts";
import {
  DEFAULT_LIMIT, definition, diagnosticsText, findImplementationsText, findReferencesText, formatPosition, formatSearch, getCallGraphText, listMembers,
  outline, parseFilters, describeFilters, reviewChangesText, searchWorkspace, symbolInfo,
} from "../workspace/index.ts";
import {
  indexOutline, prepareSpec, referenceGroups, relationGroups, searchGroups, targetOf, withCandidates, withPackageSource,
} from "./fallback.ts";
import type { IndexTarget } from "./fallback.ts";
import { driftLines, driftTagFor } from "./drift.ts";
import { reviewIndexFor } from "./reviewIndex.ts";
import type { PendingRefreshes, RepoWatcher } from "../watcher/index.ts";
import type { JobQueue, WarmUpState } from "./jobs.ts";
import {
  firstResult, isOutlineFailure, loadHinted, outlineCandidates, selectSolutions,
} from "./select.ts";
import { forgetSolutionText, loadSolutionText, reindexText, statusText } from "./status.ts";
import type { Slots, View } from "./view.ts";

export type ToolContext = {
  manager: WorkspaceManager;
  pager: Pager;
  defaultSolution: string | null;
  store: IndexStore;
  jobs: JobQueue;
  warmUp: WarmUpState;
  ignoredFolders: string[];
  watcher: RepoWatcher | null;
  pending: PendingRefreshes | null;
  /** Batches applied by the `changes` job, for `status`. */
  changes: { batches: number; lastBatch: { at: Date; files: number } | null };
  /** Git for `review_changes` and the HEAD record. */
  git: GitProvider;
  /** `git rev-parse HEAD` read after the last job that indexed or reconciled a solution, by pathKey of its tsconfig; null outside git. */
  heads: Map<string, string | null>;
  /** Re-resolve which linked-worktree HEADs the watcher follows after solutions were registered or forgotten. */
  syncWatch?: () => void;
  /** Which solutions are private (inside a linked worktree). */
  slots: Slots;
  /** Set on the per-request context: the parts of the request URL. */
  view?: View;
  /** Set on the per-request context: lines given to the pager over the call (the call log's `found`). */
  found?: number;
};

/** A page of `lines` through the shared pager, counted in the per-call `found`. */
function page(ctx: ToolContext, lines: string[], limit: number, label: string): string {
  ctx.found = (ctx.found ?? 0) + lines.length;
  return ctx.pager.appendPage(lines, limit, label);
}

type Args = Record<string, unknown>;

const DRIFT_PAGE = 200;

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: InputSchema;
  idempotent: boolean;
  handler: (args: Args, ctx: ToolContext) => string | Promise<string>;
};

const SYMBOL_DESCRIPTION =
  "Symbol to look up: a fully qualified name (Ns.Type, Type.member, Type.method(string, number)), a bare type/member name (source first), or a source position 'path/File.ts:line:col' (1-based; omit :col to take the first declaration on the line). Positions are what every hit line prints.";
const SOLUTION_DESCRIPTION =
  "Solution (tsconfig directory name) to resolve in. Defaults to loaded solutions, then the configured default.";

const solutionProperty: PropertySchema = { type: "string", description: SOLUTION_DESCRIPTION };

function schema(properties: Record<string, PropertySchema>, required: string[]): InputSchema {
  return { type: "object", properties, required };
}

/** The solutions a query runs against; in a view the part solutions are loaded first when nothing names one. */
function select(ctx: ToolContext, hint: string | undefined): ReturnType<typeof selectSolutions> {
  return selectSolutions(ctx.manager, hint, ctx.defaultSolution, ctx.view?.partSolutions().map((s) => s.path));
}

function str(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function num(args: Args, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" ? value : fallback;
}

function bool(args: Args, key: string, fallback: boolean): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

/** head lines, then the paged items with a cursor trailer, then the footer. */
function renderQuery(result: QueryText, limit: number, ctx: ToolContext): string {
  const head = result.head.map((line) => `${line}\n`).join("");
  return head + page(ctx, result.items, limit, result.label) + (result.footer ?? "");
}

/** head lines, then per group its header and paged items, then the footer. */
function renderGrouped(result: GroupedText, limit: number, ctx: ToolContext): string {
  let text = result.head.map((line) => `${line}\n`).join("");
  for (const group of result.groups) {
    text += `${group.header}\n${page(ctx, group.items, limit, group.label)}`;
  }
  return text + result.footer;
}

/** Not-found text of a docId spec whose owning solution is not loaded. */
function unresolvedText(head: string[], footer: string, limit: number, ctx: ToolContext): string {
  return renderGrouped({ head, groups: [], footer }, limit, ctx);
}

/** Run a grouped query after loading the hinted (or default) solution; unknown hints become plain text. */
function groupedQuery(
  run: (args: Args, ctx: ToolContext, spec: string, hint: string | undefined) => GroupedText,
  specKey: string,
  footerOnMiss: string,
  defaultLimit = 200,
): ToolDefinition["handler"] {
  return (args, ctx) => {
    const limit = num(args, "limit", defaultLimit);
    const spec = str(args, specKey)!;
    const prep = prepareSpec(ctx.manager, ctx.store, spec, str(args, "solution"));
    if ("unresolved" in prep) return unresolvedText(prep.unresolved, footerOnMiss, limit, ctx);
    const selection = select(ctx, prep.hint);
    if ("text" in selection) return selection.text;
    return renderGrouped(withCandidates(run(args, ctx, prep.spec, prep.hint), spec, ctx.store), limit, ctx);
  };
}

function symbolQuery(
  run: (solution: LoadedSolution, spec: string) => QueryText,
  specKey: string,
  limitOf: (args: Args) => number,
): ToolDefinition["handler"] {
  return (args, ctx) => {
    const spec = str(args, specKey)!;
    const prep = prepareSpec(ctx.manager, ctx.store, spec, str(args, "solution"));
    if ("unresolved" in prep) return renderQuery({ head: prep.unresolved, items: [], label: spec }, limitOf(args), ctx);
    const selection = select(ctx, prep.hint);
    if ("text" in selection) return selection.text;
    const result = firstResult(selection.solutions, prep.spec, run);
    return renderQuery(withCandidates(result, spec, ctx.store), limitOf(args), ctx);
  };
}

function searchSymbols(args: Args, ctx: ToolContext): string {
  const pattern = str(args, "pattern")!;
  const hint = str(args, "solution");
  const selection = select(ctx, hint);
  if ("text" in selection) return selection.text;
  const kind = str(args, "kind") as SymbolKind | undefined;
  const limit = num(args, "limit", 30);
  const results = searchWorkspace(ctx.manager, pattern, { solution: hint, kind, limit: Number.MAX_SAFE_INTEGER });
  const indexed = hint === undefined ? searchGroups(ctx.manager, ctx.store, pattern, kind ?? null, limit) : [];
  if (results.length === 0 && indexed.length === 0) return formatSearch(results, pattern);
  let text = "";
  for (const result of results) {
    const lines = result.hits.map((hit) => `  ${hit.kind} ${hit.fqName}  ${formatPosition(hit.position)}`);
    text += `Live ${result.solution} (${result.total}):\n`;
    text += page(ctx, lines, limit, `search_symbols ${pattern} in ${result.solution}`);
  }
  for (const group of indexed) text += `${group.header}\n${page(ctx, group.items, limit, group.label)}`;
  return text;
}

function getOutline(args: Args, ctx: ToolContext): string {
  const target = str(args, "target")!;
  const limit = num(args, "limit", 300);
  const prep = prepareSpec(ctx.manager, ctx.store, target, str(args, "solution"));
  if ("unresolved" in prep) return renderQuery({ head: prep.unresolved, items: [], label: `get_outline ${target}` }, limit, ctx);
  const selection = select(ctx, prep.hint);
  if ("text" in selection) return selection.text;
  const options = { depth: num(args, "depth", 2), includePrivate: bool(args, "includePrivate", true) };
  const candidates = outlineCandidates(ctx.manager, selection.solutions, prep.spec);
  const result = firstResult(candidates, prep.spec, (s, t) => outline(s, t, options), isOutlineFailure);
  if (isOutlineFailure(result)) {
    const fromIndex = indexOutline(ctx.manager, ctx.store, target, options);
    if (fromIndex) return renderQuery(fromIndex, limit, ctx);
  }
  return renderQuery(withCandidates(result, target, ctx.store), limit, ctx);
}

/** `Total: N...` footer with the index groups' count added to N. */
function addTotal(footer: string, extra: number): string {
  return footer.replace(/^Total: (\d+)/, (_m, n: string) => `Total: ${Number(n) + extra}`);
}

/** Drift tag for the group headers of a live query; the target's docId is resolved on first use. */
function suffixOf(ctx: ToolContext, spec: string, hint: string | undefined): (solutionPath: string, hits: number) => string {
  let docId: string | null | undefined;
  return (solutionPath, hits) => {
    docId ??= targetOf(ctx.manager, ctx.store, spec, hint)?.target.docId ?? null;
    return docId === null ? "" : driftTagFor(ctx.store, docId, solutionPath, hits);
  };
}

function findReferences(args: Args, ctx: ToolContext, spec: string, hint: string | undefined): GroupedText {
  const allSolutions = bool(args, "allSolutions", true);
  const kind = str(args, "kind");
  const scope = str(args, "scope");
  const live = findReferencesText(ctx.manager, spec, { solution: hint, allSolutions, kind, scope, groupSuffix: suffixOf(ctx, spec, hint) });
  const filters = parseFilters(kind, scope);
  if (!allSolutions || typeof filters === "string") return live;
  const found = targetOf(ctx.manager, ctx.store, spec, hint);
  if (!found) return live;
  const extra = referenceGroups(ctx.manager, ctx.store, found.target, filters, num(args, "limit", 200));
  if (found.live) return { ...live, groups: [...live.groups, ...extra.groups], footer: addTotal(live.footer, extra.total) };
  const filter = describeFilters(filters);
  return {
    head: found.target.head,
    groups: extra.groups,
    footer: `Total: ${extra.total} references${filter === "" ? "" : ` (${filter})`}`,
  };
}

function findImplementations(typesOnly: boolean, tool: string) {
  return (args: Args, ctx: ToolContext, spec: string, hint: string | undefined): GroupedText => {
    const live = findImplementationsText(ctx.manager, spec, {
      solution: hint, groupSuffix: suffixOf(ctx, spec, hint), ...(typesOnly ? { typesOnly } : {}),
    });
    if ((live.head[0] ?? "").includes(", not a type.")) return live;
    const found = targetOf(ctx.manager, ctx.store, spec, hint);
    if (!found) return live;
    const extra = relationGroups(ctx.manager, ctx.store, found.target as IndexTarget, tool, num(args, "limit", 200));
    if (found.live) return { ...live, groups: [...live.groups, ...extra.groups], footer: addTotal(live.footer, extra.total) };
    return { head: found.target.head, groups: extra.groups, footer: `Total: ${extra.total}` };
  };
}

function getCallGraph(args: Args, ctx: ToolContext, spec: string, hint: string | undefined): GroupedText {
  return getCallGraphText(ctx.manager, spec, {
    solution: hint, direction: str(args, "direction"), includeExternal: bool(args, "includeExternal", false),
    direct: bool(args, "direct", false), scope: str(args, "scope"), limit: num(args, "limit", 100), groupSuffix: suffixOf(ctx, spec, hint),
  });
}

async function reviewChanges(args: Args, ctx: ToolContext): Promise<string> {
  const limit = num(args, "limit", 200);
  const result = await reviewChangesText(ctx.manager, {
    solution: str(args, "solution"), base: str(args, "base"), includeTests: bool(args, "includeTests", true), limit,
    git: ctx.git, defaultSolution: ctx.defaultSolution, index: reviewIndexFor(ctx.store),
  });
  const text = renderQuery(result, limit, ctx);
  // review_changes counts changed declarations (the footer's number), not the lines it prints
  ctx.found = Number(/, (\d+) changed declarations/.exec(result.footer ?? "")?.[1] ?? 0);
  return text;
}

/** Load the registered solution whose directory contains an absolute file path, when none loaded owns it yet. */
function loadOwner(manager: WorkspaceManager, target: string): void {
  if (!/\.(ts|tsx|mts|cts|js|jsx)$/i.test(target) || !isAbsolute(target)) return;
  if (manager.findSolutionForPath(target) !== null) return;
  const key = target.replace(/\\/g, "/").toLowerCase();
  const owner = manager.solutions
    .filter((s) => key.startsWith(`${s.dir.toLowerCase()}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  if (owner) loadHinted(manager, owner.path);
}

function getDiagnostics(args: Args, ctx: ToolContext): string {
  const target = str(args, "target")!;
  const hint = str(args, "solution");
  if (hint === undefined) loadOwner(ctx.manager, target);
  const selection = select(ctx, hint);
  if ("text" in selection) return selection.text;
  const result = diagnosticsText(ctx.manager, target, { solution: hint, minSeverity: str(args, "minSeverity") });
  return renderQuery(result, num(args, "limit", 200), ctx);
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "status",
    description: "Server status: memory, index counts, background jobs, file watcher and pending refreshes, and the load state of every known solution.",
    inputSchema: schema({}, []),
    idempotent: false,
    handler: (_args, ctx) => statusText(ctx),
  },
  {
    name: "load_solution",
    description: "Load a solution into memory so that live queries are available for it.",
    inputSchema: schema(
      { solution: { type: "string", description: "Solution (tsconfig directory name) to load." } },
      ["solution"],
    ),
    idempotent: true,
    handler: (args, ctx) => {
      const result = loadSolutionText(ctx.manager, str(args, "solution")!);
      ctx.syncWatch?.();
      return result;
    },
  },
  {
    name: "reindex",
    description:
      "Re-walk a loaded solution (or 'all') and refresh the index. Use force=true to re-extract every file even when its content hash is unchanged.",
    inputSchema: schema(
      {
        solution: { type: "string", description: "Solution name, or 'all'." },
        force: { type: "boolean", description: "Re-extract unchanged files too.", default: false },
      },
      ["solution"],
    ),
    idempotent: true,
    handler: (args, ctx) => reindexText(ctx, str(args, "solution")!, bool(args, "force", false)),
  },
  {
    name: "package_drift",
    description:
      "List consumer projects whose version of a package differs from the version its source project declares (from the index; only solutions indexed at least once are compared).",
    inputSchema: schema({ limit: { type: "integer", description: "Maximum consumer lines per package.", default: 50 } }, []),
    idempotent: true,
    handler: (args, ctx) => {
      const { items, footer } = driftLines(ctx.store.findPackageDrift(), num(args, "limit", 50));
      return renderQuery({ head: [], items, label: "package_drift", footer }, DRIFT_PAGE, ctx);
    },
  },
  {
    name: "next_page",
    description:
      "Continue a result that ended with '... N more (next_page cursor=...)'. Returns the next page of the same query without re-running it.",
    inputSchema: schema(
      {
        cursor: { type: "string", description: "The cursor printed in the '... N more (next_page cursor=...)' trailer." },
        limit: {
          type: "integer",
          description: "Lines on this page and the pages after it (default: the limit of the original call).",
        },
      },
      ["cursor"],
    ),
    idempotent: false,
    handler: (args, ctx) =>
      ctx.pager.take(str(args, "cursor")!, typeof args["limit"] === "number" ? args["limit"] : undefined) ??
      "Unknown or expired cursor. Cursors live in memory for 30 minutes; re-run the original query.",
  },
  {
    name: "search_symbols",
    description:
      "Find symbols by name pattern across loaded solutions. Supports prefixes and camel-case humps (UOC -> UpdateOrderCommand). Use this to discover the exact name before calling the other tools; each hit is 'kind Type.member  path:line:col' and the position is a valid symbol argument.",
    inputSchema: schema(
      {
        pattern: {
          type: "string",
          description:
            "Required. The name or camel-hump pattern to search for (this is the only search argument; there is no 'query' or 'name').",
        },
        kind: {
          type: "string",
          description:
            "Optional kind filter: class, interface, typeAlias, enum, enumMember, function, method, property, field, variable, namespace, constructor, accessor.",
        },
        limit: { type: "integer", description: "Maximum hits per solution.", default: 30 },
      },
      ["pattern"],
    ),
    idempotent: true,
    handler: searchSymbols,
  },
  {
    name: "go_to_definition",
    description:
      "Where a symbol is declared: path:line:col of every declaration (overloads, merged interfaces and namespaces are all listed).",
    inputSchema: schema({ symbol: { type: "string", description: SYMBOL_DESCRIPTION }, solution: solutionProperty }, ["symbol"]),
    idempotent: true,
    handler: (args, ctx) => symbolQuery(withPackageSource(ctx.manager, ctx.store, definition), "symbol", () => DEFAULT_LIMIT)(args, ctx),
  },
  {
    name: "get_symbol_info",
    description:
      "Signature, kind, modifiers, module/namespace, containing type, project, heritage, type parameters, parameters, decorators, JSDoc and (for types) the first members.",
    inputSchema: schema({ symbol: { type: "string", description: SYMBOL_DESCRIPTION }, solution: solutionProperty }, ["symbol"]),
    idempotent: true,
    handler: (args, ctx) => symbolQuery(withPackageSource(ctx.manager, ctx.store, symbolInfo), "symbol", () => DEFAULT_LIMIT)(args, ctx),
  },
  {
    name: "list_members",
    description:
      "Members of a type with accessibility, kind and compact signature. Optional name filter and inherited members.",
    inputSchema: schema(
      {
        type: { type: "string", description: SYMBOL_DESCRIPTION },
        solution: solutionProperty,
        filter: { type: "string", description: "Case-insensitive substring filter on member name." },
        includeInherited: {
          type: "boolean",
          description: "Include members declared on base types.",
          default: false,
        },
        limit: { type: "integer", description: "Maximum members listed.", default: 200 },
      },
      ["type"],
    ),
    idempotent: true,
    handler: (args, ctx) =>
      symbolQuery(
        (s, spec) =>
          listMembers(s, spec, {
            filter: str(args, "filter"),
            includeInherited: bool(args, "includeInherited", false),
            limit: num(args, "limit", 200),
          }),
        "type",
        (a) => num(a, "limit", 200),
      )(args, ctx),
  },
  {
    name: "get_outline",
    description:
      "Map of a file or a type without reading it: one line per declaration in source order, indented by nesting, with kind, compact signature, decorators and the line span. Call it before reading a file longer than about 100 lines, then read only the span you need.",
    inputSchema: schema(
      {
        target: {
          type: "string",
          description:
            "A .ts/.tsx file path (absolute, or relative to a solution directory), or any symbol spec that resolves to a type (name, path:line:col).",
        },
        solution: solutionProperty,
        depth: {
          type: "integer",
          description:
            "1 = types only; 2 = types with their members and nested types (default); 3 = also the nested types' members.",
          default: 2,
        },
        includePrivate: {
          type: "boolean",
          description: "Include private members and non-exported declarations (default true).",
          default: true,
        },
        limit: { type: "integer", description: "Maximum lines; the rest is reachable with next_page.", default: 300 },
      },
      ["target"],
    ),
    idempotent: true,
    handler: getOutline,
  },
  {
    name: "find_references",
    description:
      "Find every usage of a symbol across loaded solutions. One 'path:line:col  project  kind  in Type.member' line per hit: kind is usage, invocation, creation, base, decorator or import, and 'in' names the enclosing member or type, so a handler, a caller and a test are told apart without opening the file. Filter with kind (who instantiates, extends, decorates, calls) and scope (production or tests); group lines then read 'K of M references'.",
    inputSchema: schema(
      {
        symbol: { type: "string", description: SYMBOL_DESCRIPTION },
        solution: solutionProperty,
        allSolutions: {
          type: "boolean",
          description: "Search every loaded solution (default true). False limits to the defining solution.",
          default: true,
        },
        kind: {
          type: "string",
          description:
            "Keep only these usage kinds: usage, invocation, creation, base, decorator, import; several comma-separated (e.g. 'creation,base'). Default: every kind.",
        },
        scope: {
          type: "string",
          description:
            "all (default), production (no test projects) or tests (test projects only). A test project has a Test/Tests hump in its name or a test folder in its path.",
        },
        limit: { type: "integer", description: "Maximum hits listed per solution.", default: 200 },
      },
      ["symbol"],
    ),
    idempotent: true,
    handler: groupedQuery(findReferences, "symbol", "Total: 0 references"),
  },
  {
    name: "find_implementations",
    description:
      "For an interface: implementing classes and derived interfaces. For a class: derived classes. For a member: implementations and overrides. Across loaded solutions.",
    inputSchema: schema(
      {
        symbol: { type: "string", description: SYMBOL_DESCRIPTION },
        solution: solutionProperty,
        limit: { type: "integer", description: "Maximum hits listed per solution.", default: 200 },
      },
      ["symbol"],
    ),
    idempotent: true,
    handler: groupedQuery(findImplementations(false, "find_implementations"), "symbol", "Total: 0"),
  },
  {
    name: "find_derived_types",
    description:
      "Types deriving from a class or implementing / extending an interface, transitively, across loaded solutions.",
    inputSchema: schema(
      {
        type: { type: "string", description: SYMBOL_DESCRIPTION },
        solution: solutionProperty,
        limit: { type: "integer", description: "Maximum hits listed per solution.", default: 200 },
      },
      ["type"],
    ),
    idempotent: true,
    handler: groupedQuery(findImplementations(true, "find_derived_types"), "type", "Total: 0"),
  },
  {
    name: "get_call_graph",
    description:
      "One level of callers and callees of a function, method, constructor, accessor or class. Callers come from the reference search across loaded solutions; callees are the calls and object creations in the symbol's own body. Lines are 'Type.member  path:line:col'; pass a line's position back as the symbol to walk further. Callers include dispatch through base and interface members, tagged 'via'; pass direct=true for the symbol's own callers only.",
    inputSchema: schema(
      {
        symbol: { type: "string", description: SYMBOL_DESCRIPTION },
        solution: { type: "string", description: "Solution name to resolve the symbol in. Defaults to the loaded solutions." },
        direction: { type: "string", description: "both (default), callers or callees." },
        direct: {
          type: "boolean",
          description:
            "true lists only callers that bind to the symbol itself; by default calls through a base or interface member and calls on overrides or implementations are listed too, tagged 'via Member'.",
          default: false,
        },
        includeExternal: {
          type: "boolean",
          description: "Include callees declared in node_modules or the default libs.",
          default: false,
        },
        scope: {
          type: "string",
          description:
            "all (default), production or tests: keep callers declared in, and callees declared in, production or test projects only. An external callee counts as production.",
        },
        limit: { type: "integer", description: "Maximum lines per list; the rest is reachable with next_page.", default: 100 },
      },
      ["symbol"],
    ),
    idempotent: true,
    handler: groupedQuery(getCallGraph, "symbol", "", 100),
  },
  {
    name: "review_changes",
    description:
      "Start a branch review here, then read the diff. Compares the working tree of a loaded solution with the merge base of a git ref: one line per changed file, then per changed declaration '+ added', '- removed', '~ signature' or '~ body' with a spec the other tools accept, reference counts per solution (live and index, with package drift) for removed and signature-changed members, caller counts for body edits, and compiler diagnostics on the changed files. Counts only; follow up with find_references or get_call_graph on a printed spec.",
    inputSchema: schema(
      {
        solution: {
          type: "string",
          description: "Solution name to review. Must be loaded; call load_solution first. Defaults to the configured default solution.",
        },
        base: {
          type: "string",
          description:
            "Git ref (branch, tag or commit) to compare with. Default: the repository's default branch (origin/HEAD, else main, master, develop, dev). The comparison is merge-base(base, HEAD) against the working tree, so uncommitted edits count.",
        },
        includeTests: {
          type: "boolean",
          description: "false hides files of test projects and says how many were hidden.",
          default: true,
        },
        limit: {
          type: "integer",
          description: "Maximum file, declaration and diagnostic lines; the rest is reachable with next_page.",
          default: 200,
        },
      },
      [],
    ),
    idempotent: true,
    handler: reviewChanges,
  },
  {
    name: "get_diagnostics",
    description:
      "Compiler diagnostics from the live program, without running a build. Target is a .ts/.tsx file path or a project name. Reflects saved-to-disk edits immediately.",
    inputSchema: schema(
      {
        target: {
          type: "string",
          description:
            "Absolute path to a .ts/.tsx file (or relative to a solution directory), or a project name (package.json name or directory name).",
        },
        solution: {
          type: "string",
          description: "Solution the project belongs to; inferred from the file path when a file is given.",
        },
        minSeverity: { type: "string", description: "Minimum severity: error, warning (default) or info." },
        limit: { type: "integer", description: "Maximum diagnostics listed.", default: 200 },
      },
      ["target"],
    ),
    idempotent: true,
    handler: getDiagnostics,
  },
  {
    name: "forget_solution",
    description:
      "Forget a registered solution: unload it, unregister it and delete its rows from the index. It stays forgotten until load_solution with its tsconfig path, a change of its tsconfig file, or a restart.",
    inputSchema: schema(
      { solution: { type: "string", description: "Solution: full tsconfig path or directory name." } },
      ["solution"],
    ),
    idempotent: true,
    handler: (args, ctx) => forgetSolutionText(ctx, str(args, "solution")!),
  },
];

/** Load the configured preload and default solutions; unknown names are reported through `warn`. */
export function preloadSolutions(manager: WorkspaceManager, names: string[], warn: (message: string) => void): void {
  for (const name of names) {
    try {
      if (loadHinted(manager, name) === null) warn(`domra: unknown solution '${name}' (preload/defaultSolution)`);
    } catch (error) {
      warn(`domra: failed to load '${name}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

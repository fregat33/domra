import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DomraConfig } from "../config.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import { defaultIndexPath, IndexStore } from "../index/index.ts";
import type { GitProvider } from "../workspace/index.ts";
import { createGit, indexSolution, isFresh, pathKey, WorkspaceManager } from "../workspace/index.ts";
import { applyChanges, classifyChange, forgetMissing, PendingRefreshes, RepoWatcher } from "../watcher/index.ts";
import { checkArguments } from "./arguments.ts";
import { callerOf, clientOf, countsFound, formatCallLine, formatRejected } from "./callLog.ts";
import { JobQueue } from "./jobs.ts";
import { defaultLogDirectory, LogFile } from "./logFile.ts";
import type { WarmUpState } from "./jobs.ts";
import { Pager } from "./pager.ts";
import { preloadSolutions, TOOLS } from "./tools.ts";
import type { ToolContext } from "./tools.ts";
import { enqueueIndex, recordHead, statusText } from "./status.ts";
import { openView, Slots } from "./view.ts";

/** `git` replaces the git provider built from `gitPath` (tests inject a fake). */
export type ServerOptions = Partial<DomraConfig> & { warn?: (message: string) => void; git?: GitProvider };

export type RunningServer = {
  port: number;
  close(): Promise<void>;
  manager: WorkspaceManager;
  store: IndexStore;
  jobs: JobQueue;
  watcher: RepoWatcher | null;
  pending: PendingRefreshes | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tools that change the registered solutions, what is loaded or the index. */
const MUTATING_TOOLS = new Set(["forget_solution", "load_solution", "reindex"]);

const SUPPORTED_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const VERSION: string = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/** The context of one request, or why its `part` parameters were refused. */
type Opened = ReturnType<typeof openView>;

type JsonRpcId = string | number | null;
type Reply = { status: number; type: string; body: string };

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function text(status: number, body: string): Reply {
  return { status, type: "text/plain; charset=utf-8", body };
}

function json(value: unknown): Reply {
  return { status: 200, type: "application/json", body: JSON.stringify(value) };
}

function rpcFailure(id: JsonRpcId, code: number, message: string): Reply {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the call log needs besides the call itself. */
type CallEnv = {
  warn: (message: string) => void;
  caller: string | null;
  parts: string[];
  sessionId: string | undefined;
  clients: Clients;
};

/** `clientInfo` of `initialize`: by `mcp-session-id` when the request carries one, else the last one seen. */
type Clients = { bySession: Map<string, string | null>; last: string | null };

async function callTool(params: unknown, opened: Opened, env: CallEnv): Promise<unknown> {
  const rejectRpc = (tool: string | null, message: string): never => {
    try {
      env.warn(tool === null ? `WARN Rejected ? call with arguments []: ${message}` : formatRejected(tool, {}, message));
    } catch {
      // a call log failure never fails the call
    }
    throw new RpcError(-32602, message);
  };
  if (!isObject(params) || typeof params["name"] !== "string") {
    const raw = isObject(params) ? params["name"] : undefined;
    return rejectRpc(typeof raw === "string" ? raw : null,"Invalid params: name is required");
  }
  const name = params["name"];
  const rawArgs = params["arguments"];
  if (rawArgs !== undefined && !isObject(rawArgs)) return rejectRpc(name, "Invalid params: arguments must be an object");
  const started = performance.now();
  const tool = TOOLS.find((t) => t.name === name);
  const counted = countsFound(name, tool !== undefined);
  if (!("error" in opened)) opened.ctx.found = 0;
  const log = (result: { content: { text: string }[]; isError?: boolean }): void => {
    try {
      const client = env.sessionId !== undefined && env.clients.bySession.has(env.sessionId)
        ? env.clients.bySession.get(env.sessionId)!
        : env.clients.last;
      const error = result.isError ? (result.content[0]?.text ?? "") : undefined;
      env.warn(formatCallLine({
        tool: name, args: rawArgs, found: counted ? ("error" in opened ? 0 : opened.ctx.found ?? 0) : null, client,
        caller: env.caller, parts: env.parts, elapsedMs: performance.now() - started, ...(error === undefined ? {} : { error }),
      }));
    } catch {
      // a call log failure never fails the call
    }
  };
  const fail = (message: string) => {
    const result = { content: [{ type: "text", text: message }], isError: true };
    log(result);
    return result;
  };
  if ("error" in opened) return fail(opened.error);
  const checked = checkArguments(TOOLS, name, rawArgs ?? {});
  if (!checked.ok) {
    try {
      env.warn(formatRejected(name, rawArgs ?? {}, checked.text));
    } catch {
      // ignored
    }
    return fail(checked.text);
  }
  try {
    const result = { content: [{ type: "text", text: await tool!.handler(checked.args, opened.ctx) }] };
    log(result);
    return result;
  } catch (error) {
    return fail(`domra: ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function dispatch(method: string, params: unknown, opened: Opened, env: CallEnv): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const client = clientOf(params);
      if (env.sessionId !== undefined) env.clients.bySession.set(env.sessionId, client);
      else env.clients.last = client;
      const requested = isObject(params) ? params["protocolVersion"] : undefined;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION;
      return { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "domra", version: VERSION } };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !MUTATING_TOOLS.has(t.name), idempotentHint: t.idempotent },
        })),
      };
    case "tools/call":
      return callTool(params, opened, env);
    default:
      throw new RpcError(-32601, "Method not found");
  }
}

async function handleMessage(body: string, opened: Opened, env: CallEnv): Promise<Reply> {
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return rpcFailure(null, -32700, "Parse error");
  }
  if (Array.isArray(message)) return rpcFailure(null, -32600, "Invalid Request: batches are not supported");
  if (!isObject(message) || message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string") {
    return rpcFailure(null, -32600, "Invalid Request");
  }
  const method = message["method"];
  const rawId = message["id"];
  if (rawId === undefined) return { status: 202, type: "text/plain; charset=utf-8", body: "" };
  const id: JsonRpcId = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
  try {
    return json({ jsonrpc: "2.0", id, result: await dispatch(method, message["params"], opened, env) });
  } catch (error) {
    if (error instanceof RpcError) return rpcFailure(id, error.code, error.message);
    return rpcFailure(id, -32603, error instanceof Error ? error.message : "Internal error");
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHost(host: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Why a request is refused, or null. Against DNS rebinding the `Host` must be a loopback name; a browser `Origin`
 * must be a loopback origin (any port) or listed in `allowedOrigins`. Requests without these headers pass.
 */
export function refusedOrigin(headers: IncomingMessage["headers"], allowedOrigins: readonly string[]): string | null {
  const host = headers.host;
  if (host !== undefined && !isLoopbackHost(host)) return `Host not allowed: ${host}`;
  const origin = headers.origin;
  if (origin === undefined || allowedOrigins.includes(origin)) return null;
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  } catch {
    // "null" and other opaque origins are refused
  }
  return `Origin not allowed: ${origin}`;
}

async function route(
  request: IncomingMessage, ctx: ToolContext, allowedOrigins: readonly string[], warn: (message: string) => void, clients: Clients,
): Promise<Reply> {
  const refused = refusedOrigin(request.headers, allowedOrigins);
  if (refused) return text(403, refused);
  const url = new URL(request.url ?? "/", "http://localhost");
  const opened = (): Opened => openView(ctx, url.searchParams.getAll("part"));
  if (url.pathname === "/mcp") {
    if (request.method !== "POST") return text(405, "Method Not Allowed");
    const header = request.headers["mcp-session-id"];
    const parts = url.searchParams.getAll("part").filter((p) => p.trim() !== "");
    const env: CallEnv = {
      warn, caller: callerOf(url.searchParams.getAll("caller")), parts, clients,
      sessionId: typeof header === "string" && header !== "" ? header : undefined,
    };
    return handleMessage(await readBody(request), opened(), env);
  }
  if (url.pathname === "/health") {
    if (request.method !== "GET") return text(405, "Method Not Allowed");
    const view = opened();
    return "error" in view ? text(400, view.error) : text(200, statusText(view.ctx));
  }
  return text(404, "Not Found");
}

/** Start the MCP server on 127.0.0.1; `port: 0` picks a free port. */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const config = { ...DEFAULT_CONFIG, ...options };
  const stderr = (message: string): void => void process.stderr.write(`${message}\n`);
  const logFile = options.warn !== undefined && options.logDirectory == null
    ? null
    : new LogFile(config.logDirectory ?? defaultLogDirectory(), config.logRetainedDays, stderr);
  const sink = options.warn ?? stderr;
  const warn = logFile === null ? sink : (message: string): void => {
    sink(message);
    logFile.write(message);
  };
  const manager = new WorkspaceManager({ roots: config.roots, ignoredFolders: config.ignoredFolders });
  manager.discover();
  const store = IndexStore.open(config.indexPath ?? defaultIndexPath());
  try {
    store.gc(config.blobRetentionDays * DAY_MS);
  } catch (error) {
    warn(`domra: index gc failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const jobs = new JobQueue(warn);
  const warmUp: WarmUpState = { ran: false, total: 0, done: 0, current: null, warmed: 0, fresh: 0 };
  const ctx: ToolContext = {
    manager, pager: new Pager(), defaultSolution: config.defaultSolution, store, jobs, warmUp,
    ignoredFolders: config.ignoredFolders, watcher: null, pending: null, changes: { batches: 0, lastBatch: null },
    git: options.git ?? createGit(config.gitPath), heads: new Map(), slots: new Slots(config.gitPath, manager),
  };
  let warming = false;
  manager.onLoad = (solution) => {
    if (!warming) enqueueIndex(ctx, solution);
  };
  /** Load a solution without the automatic index job, index it, and unload it again. */
  const loadIndexUnload = (path: string): void => {
    warming = true;
    let loaded;
    try {
      loaded = manager.load(path);
    } finally {
      warming = false;
    }
    indexSolution(store, loaded, { ignoredFolders: config.ignoredFolders });
    manager.unload(path);
  };
  const names = [...config.preload];
  if (config.defaultSolution !== null && !names.includes(config.defaultSolution)) names.push(config.defaultSolution);
  preloadSolutions(manager, names, warn);
  if (config.warmUp) {
    warmUp.ran = true;
    for (const solution of manager.solutions) {
      const loaded = manager.resolveSolution(solution.path) !== null;
      if (loaded || isFresh(store, solution, { ignoredFolders: config.ignoredFolders })) {
        warmUp.fresh++;
        if (!loaded) void jobs.enqueue(`head ${solution.name}`, () => recordHead(ctx, solution));
        continue;
      }
      warmUp.total++;
      void jobs.enqueue(`warm-up ${solution.name}`, async () => {
        warmUp.current = solution.name;
        try {
          if (!manager.isRegistered(solution.path) || manager.resolveSolution(solution.path) !== null) return;
          loadIndexUnload(solution.path);
          await recordHead(ctx, solution);
          warmUp.warmed++;
        } finally {
          warmUp.done++;
          warmUp.current = null;
        }
      });
    }
  }

  let refreshTimer: NodeJS.Timeout | null = null;
  if (config.watch && config.roots.length > 0) {
    const pending = new PendingRefreshes();
    const quietMs = Math.max(100, config.debounceMs);
    const queued = new Set<string>();
    /** Queue a refresh job for an unloaded solution; it records HEAD on every path and re-indexes only a stale index. */
    const enqueueRefresh = (path: string): void => {
      const solution = manager.findRegistered(path);
      if (!solution) {
        pending.take(path);
        return;
      }
      const key = pathKey(solution.path);
      if (queued.has(key)) return;
      queued.add(key);
      void jobs.enqueue(`refresh ${solution.name}`, async () => {
        queued.delete(key);
        pending.take(solution.path);
        if (!manager.isRegistered(solution.path) || manager.resolveSolution(solution.path) !== null) return;
        if (isFresh(store, solution, { ignoredFolders: config.ignoredFolders })) {
          await recordHead(ctx, solution);
          return;
        }
        const started = performance.now();
        loadIndexUnload(solution.path);
        await recordHead(ctx, solution);
        warn(`domra: refreshed ${solution.name} in ${Math.round(performance.now() - started)}ms`);
      });
    };
    const watcher = new RepoWatcher({
      roots: config.roots, ignoredFolders: config.ignoredFolders, quietMs, warn,
      onBatch: (batch) => {
        void jobs.enqueue("changes", async () => {
          const report = applyChanges({ manager, store, pending, ignoredFolders: config.ignoredFolders, roots: config.roots, warn }, batch);
          ctx.changes.batches++;
          ctx.changes.lastBatch = { at: new Date(), files: batch.paths.size };
          const hasGit = [...batch.paths].some((p) => classifyChange(p, config.ignoredFolders) === "git");
          if (batch.overflowed || hasGit || (batch.directories?.size ?? 0) > 0 || report.discovered.length > 0 || report.forgotten.length > 0) ctx.syncWatch?.();
          const touched = new Set([...report.reconciled, ...report.reloaded]);
          for (const solution of manager.solutions) {
            if (touched.has(solution.name)) await recordHead(ctx, solution);
          }
          const repoKeys: string[] = [];
          for (const path of batch.paths) {
            if (classifyChange(path, config.ignoredFolders) === "git") repoKeys.push(pathKey(path.replace(/[\\/]\.git[\\/]HEAD$/i, "")));
          }
          if (repoKeys.length > 0) {
            for (const solution of manager.solutions) {
              const dir = pathKey(solution.dir);
              if (manager.resolveSolution(solution.path) !== null) continue;
              if (repoKeys.some((root) => dir === root || dir.startsWith(`${root}/`))) enqueueRefresh(solution.path);
            }
          }
        });
      },
    });
    ctx.watcher = watcher;
    ctx.pending = pending;
    ctx.syncWatch = () => {
      for (const key of ctx.heads.keys()) {
        if (!manager.solutions.some((s) => pathKey(s.path) === key)) ctx.heads.delete(key);
      }
      watcher.syncWorktrees(manager.solutions.map((s) => s.dir), (dir) => ctx.git.repoRoot(dir));
    };
    watcher.start();
    ctx.syncWatch();
    const limits = {
      quietMs: config.unloadedRefreshSeconds * 1000,
      maxWaitMs: config.unloadedRefreshMaxWaitSeconds * 1000,
    };
    if (limits.quietMs > 0 || limits.maxWaitMs > 0) {
      const period = Math.min(15000, Math.max(1000, quietMs / 4));
      refreshTimer = setInterval(() => {
        for (const path of pending.due(Date.now(), limits)) enqueueRefresh(path);
      }, period);
      refreshTimer.unref();
    }
  }

  let sweepTimer: NodeJS.Timeout | null = null;
  if (config.discoverySweepSeconds > 0) {
    sweepTimer = setInterval(() => {
      if (!manager.solutions.some((s) => !existsSync(s.path))) return;
      void jobs.enqueue("discovery sweep", () => {
        forgetMissing(manager, store, ctx.pending, warn);
        ctx.syncWatch?.();
      });
    }, config.discoverySweepSeconds * 1000);
    sweepTimer.unref();
  }

  const clients: Clients = { bySession: new Map(), last: null };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    route(request, ctx, config.allowedOrigins, warn, clients)
      .catch((error: unknown) => rpcFailure(null, -32603, error instanceof Error ? error.message : "Internal error"))
      .then((reply) => {
        response.writeHead(reply.status, { "Content-Type": reply.type, ...(reply.status === 405 ? { Allow: "POST" } : {}) });
        response.end(reply.body);
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    manager,
    store,
    jobs,
    watcher: ctx.watcher,
    pending: ctx.pending,
    close: async () => {
      if (refreshTimer) clearInterval(refreshTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      ctx.watcher?.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await jobs.idle();
      store.close();
      logFile?.close();
    },
  };
}

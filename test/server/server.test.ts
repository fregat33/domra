import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { request as httpRequest } from "node:http";
import { refusedOrigin, startServer } from "../../src/server/server.ts";
import type { RunningServer } from "../../src/server/server.ts";
import { TOOLS } from "../../src/server/tools.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { DIAG, REFS, SEARCH, SINGLE } from "../workspace/projects.ts";

let fixture: Fixture;
let server: RunningServer;
let url: string;
let nextId = 1;

before(async () => {
  fixture = writeFixture({ ...SEARCH, ...SINGLE, ...REFS, ...DIAG });
  const started = performance.now();
  server = await startServer({
    roots: [fixture.root], preload: ["demo"], port: 0, indexPath: ":memory:", warn: () => {},
  });
  url = `http://127.0.0.1:${server.port}/mcp`;
  await server.jobs.idle();
  console.log(`server.test: warm-up and indexing took ${Math.round(performance.now() - started)} ms`);
});

after(async () => {
  await server.close();
  fixture.remove();
});

type Rpc = { result?: any; error?: { code: number; message: string } };

async function post(body: string): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

async function rpc(method: string, params?: unknown): Promise<Rpc> {
  const response = await post(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  return (await response.json()) as Rpc;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const reply = await rpc("tools/call", { name, arguments: args });
  assert.ok(reply.result, JSON.stringify(reply));
  return { text: reply.result.content[0].text as string, isError: reply.result.isError === true };
}

const TRAILER = /  \.\.\. (\d+) more \(next_page cursor=([0-9a-f]{10})\)\n$/;

test("protocol basics", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-03-26" });
  assert.equal(init.result.serverInfo.name, "domra");
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.ok(init.result.capabilities.tools);
  assert.equal((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion, "2025-06-18");
  const notification = await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
  assert.deepEqual((await rpc("ping")).result, {});
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(url, { method: "DELETE" })).status, 405);
  assert.equal((await rpc("bogus/method")).error?.code, -32601);
  assert.equal((await (await post("{nope")).json() as Rpc).error?.code, -32700);
  assert.equal((await (await post("[]")).json() as Rpc).error?.code, -32600);
  assert.equal((await (await post("{}")).json() as Rpc).error?.code, -32600);
  const missing = await fetch(`http://127.0.0.1:${server.port}/other`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("content-type") ?? "", /^text\/plain/);
});

test("tools/list returns the seventeen tools in order", async () => {
  const { tools } = (await rpc("tools/list")).result;
  assert.deepEqual(
    tools.map((t: { name: string }) => t.name),
    [
      "status", "load_solution", "reindex", "package_drift", "next_page", "search_symbols", "go_to_definition", "get_symbol_info",
      "list_members", "get_outline", "find_references", "find_implementations", "find_derived_types", "get_call_graph",
      "review_changes", "get_diagnostics", "forget_solution",
    ],
  );
  const required = Object.fromEntries(tools.map((t: any) => [t.name, t.inputSchema.required]));
  assert.deepEqual(required, {
    status: [], load_solution: ["solution"], forget_solution: ["solution"], reindex: ["solution"], package_drift: [], next_page: ["cursor"], search_symbols: ["pattern"],
    go_to_definition: ["symbol"], get_symbol_info: ["symbol"], list_members: ["type"], get_outline: ["target"],
    find_references: ["symbol"], find_implementations: ["symbol"], find_derived_types: ["type"],
    get_call_graph: ["symbol"], review_changes: [], get_diagnostics: ["target"],
  });
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.annotations.readOnlyHint, !["forget_solution", "load_solution", "reindex"].includes(t.name));
  }
});

test("search_symbols and paging", async () => {
  const retry = await call("search_symbols", { pattern: "Retry" });
  assert.ok(retry.text.startsWith("Live demo (2):"), retry.text);
  assert.ok(retry.text.includes("class RetryPolicy"));

  const upload = await call("search_symbols", { pattern: "Upload", limit: 1 });
  const hitLines = upload.text.split("\n").filter((l) => l.startsWith("  ") && !l.includes("..."));
  assert.equal(hitLines.length, 1);
  const trailer = TRAILER.exec(upload.text);
  assert.ok(trailer, upload.text);
  assert.equal(trailer[1], "4");

  const next = await call("next_page", { cursor: trailer[2]! });
  assert.ok(next.text.startsWith("Continued: search_symbols Upload in demo\n"), next.text);
  assert.equal(next.text.split("\n").filter((l) => /^ {2}\w+ /.test(l)).length, 1);
  assert.equal(TRAILER.exec(next.text)?.[1], "3");

  const unknown = await call("next_page", { cursor: "zzzz" });
  assert.equal(
    unknown.text,
    "Unknown or expired cursor. Cursors live in memory for 30 minutes; re-run the original query.",
  );
});

test("argument filter over the wire", async () => {
  const remapped = await call("search_symbols", { query: "Retry" });
  assert.ok(remapped.text.startsWith("Live demo (2):"));
  const missing = await call("search_symbols", {});
  assert.equal(missing.isError, true);
  assert.equal(
    missing.text,
    "search_symbols: missing required argument 'pattern'. Accepted arguments: pattern (required), kind, limit.",
  );
  const unknownTool = await call("nope", {});
  assert.equal(unknownTool.isError, true);
});

test("reindex", async () => {
  const all = await call("reindex", { solution: "all" });
  assert.equal(all.text, "Queued reindex of 1 loaded solutions (force=false).");
  const demo = await call("reindex", { solution: "demo", force: true });
  assert.equal(demo.text, "Queued reindex of demo (force=true).");
  const unloaded = await call("reindex", { solution: "single", force: true });
  assert.equal(unloaded.text, "single was not loaded; load started, indexing follows automatically.");
  await server.jobs.idle();
  assert.match((await call("status", {})).text, /^ {2}single {2}loaded {2}/m);
  const unknown = await call("reindex", { solution: "nope" });
  assert.equal(unknown.text, "Unknown solution: nope. Known: demo, diag, refs, single");
});

test("symbol queries load a solution on demand", async () => {
  const definition = await call("go_to_definition", { symbol: "Circle", solution: "single" });
  assert.ok(definition.text.startsWith("Symbol: "), definition.text);
  assert.ok(definition.text.includes("Declared in source:"));

  const info = await call("get_symbol_info", { symbol: "Circle", solution: "single" });
  assert.ok(info.text.includes("Kind: class"), info.text);

  const members = await call("list_members", { type: "Circle", solution: "single", limit: 1 });
  assert.equal(TRAILER.exec(members.text)?.[1], "2", members.text);

  const flat = await call("get_outline", { target: "src/shapes.ts", solution: "single", depth: 1 });
  const lines = flat.text.trimEnd().split("\n");
  assert.equal(lines[lines.length - 1], "Total: 8 declarations");

  const paged = await call("get_outline", { target: "src/shapes.ts", solution: "single", limit: 5 });
  assert.ok(/\.\.\. \d+ more \(next_page cursor=[0-9a-f]{10}\)\nTotal: \d+ declarations$/.test(paged.text), paged.text);
});

test("find_references, find_implementations and find_derived_types", async () => {
  const refs = await call("find_references", { symbol: "Circle", solution: "refs", limit: 2 });
  assert.equal(refs.isError, false);
  assert.ok(refs.text.startsWith("Symbol: "), refs.text);
  const lines = refs.text.split("\n");
  const group = lines.indexOf("Live refs: 7 references");
  assert.ok(group > 0, refs.text);
  assert.match(lines[group + 1]!, /^ {2}\S+:\d+:\d+ {2}refs-pkg {2}\w+/);
  assert.match(lines[group + 2]!, /^ {2}\S+:\d+:\d+ {2}refs-pkg {2}\w+/);
  assert.match(lines[group + 3]!, /^ {2}\.\.\. 5 more \(next_page cursor=[0-9a-f]{10}\)$/);
  assert.ok(refs.text.endsWith("\nTotal: 7 references"), refs.text);

  const derived = await call("find_derived_types", { type: "Base", solution: "refs" });
  assert.ok(derived.text.endsWith("Total: 3"), derived.text);
  assert.equal(derived.text.split("\n").filter((l) => l.startsWith("  inherits  class ")).length, 3);

  const impl = await call("find_implementations", { symbol: "Shape.area", solution: "refs" });
  assert.ok(impl.text.includes("Live refs: 4\n"), impl.text);
  assert.ok(impl.text.endsWith("Total: 4"), impl.text);

  const bad = await call("find_references", { symbol: "Circle", kind: "nope" });
  assert.equal(bad.isError, false);
  assert.equal(
    bad.text,
    "find_references: unknown kind 'nope'. Accepted: usage, invocation, creation, base, decorator, import; several are comma-separated.\n",
  );
});

test("get_diagnostics", async () => {
  const bad = fixture.path("diag/src/bad.ts");
  const absolute = await call("get_diagnostics", { target: bad });
  assert.equal(absolute.isError, false);
  assert.ok(absolute.text.startsWith("Diagnostics for "), absolute.text);
  assert.ok(absolute.text.includes("2 errors"), absolute.text);

  const paged = await call("get_diagnostics", { target: "src/bad.ts", solution: "diag", limit: 1 });
  const lines = paged.text.split("\n");
  assert.equal(lines.filter((l) => /^ {2}\S+:\d+:\d+ {2}error TS/.test(l)).length, 1, paged.text);
  assert.match(lines[lines.length - 2]!, /^ {2}\.\.\. 1 more \(next_page cursor=[0-9a-f]{10}\)$/);
});

test("status, health and load_solution", async () => {
  await server.jobs.idle();
  const status = await call("status", {});
  assert.ok(status.text.includes("Solutions:"));
  assert.ok(status.text.includes("Watcher: "), status.text);
  assert.ok(status.text.includes("Unloaded refresh: "), status.text);
  assert.ok(status.text.includes("Index: :memory:\n"), status.text);
  assert.match(status.text, /^ {2}\d+ projects, \d+ tracked files, \d+ blobs, \d+ symbols, \d+ references, \d+ relations$/m);
  assert.ok(status.text.includes("Jobs: 0 pending"), status.text);
  assert.ok(status.text.includes("Warm-up: done, "), status.text);
  assert.ok(/^ {2}demo {2}loaded {2}/m.test(status.text), status.text);
  const health = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get("content-type") ?? "", /^text\/plain/);
  assert.ok((await health.text()).includes("Solutions:"));

  const unknown = await call("load_solution", { solution: "nope" });
  assert.equal(unknown.text, "Unknown solution: nope. Known: demo, diag, refs, single");
  const loaded = await call("load_solution", { solution: "demo" });
  assert.match(loaded.text, /^demo: 1 projects loaded in \d+\.\ds, \d+ unresolved imports\.$/);
});

test("a throwing handler becomes a tool error", async () => {
  const tool = TOOLS.find((t) => t.name === "status")!;
  const original = tool.handler;
  tool.handler = () => {
    throw new Error("boom");
  };
  try {
    const result = await call("status", {});
    assert.equal(result.isError, true);
    assert.equal(result.text, "domra: status failed: boom");
  } finally {
    tool.handler = original;
  }
});

/** Raw request, so `Host` can be set (fetch forbids it). */
function rawPost(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "ping" });
    const request = httpRequest(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("loopback Host and Origin pass, foreign ones get 403", async () => {
  assert.equal(await rawPost({}), 200);
  assert.equal(await rawPost({ Host: `localhost:${server.port}`, Origin: "http://localhost:3000" }), 200);
  assert.equal(await rawPost({ Origin: "http://127.0.0.1:8080" }), 200);
  assert.equal(await rawPost({ Origin: "http://[::1]" }), 200);
  assert.equal(await rawPost({ Host: `evil.example:${server.port}` }), 403);
  assert.equal(await rawPost({ Origin: "https://evil.example" }), 403);
  assert.equal(await rawPost({ Origin: "null" }), 403);
});

test("allowedOrigins admits listed origins only", () => {
  assert.equal(refusedOrigin({ origin: "https://app.example" }, ["https://app.example"]), null);
  assert.equal(refusedOrigin({ origin: "https://other.example" }, ["https://app.example"]), "Origin not allowed: https://other.example");
  assert.equal(refusedOrigin({ host: "evil.example", origin: "https://app.example" }, ["https://app.example"]), "Host not allowed: evil.example");
});

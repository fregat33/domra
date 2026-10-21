import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "../../src/server/server.ts";
import type { RunningServer } from "../../src/server/server.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { REFS } from "../workspace/projects.ts";

let fixture: Fixture;
let server: RunningServer;
let nextId = 1;

before(async () => {
  fixture = writeFixture(REFS);
  server = await startServer({ roots: [fixture.root], preload: ["refs"], watch: false, port: 0, indexPath: ":memory:", warn: () => {} });
  await server.jobs.idle();
});

after(async () => {
  await server.close();
  fixture.remove();
});

async function rpc(method: string, params?: unknown): Promise<{ result: any }> {
  const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return (await response.json()) as { result: any };
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  return (await rpc("tools/call", { name, arguments: args })).result.content[0].text as string;
}

test("get_call_graph is listed right after find_derived_types", async () => {
  const names = (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name) as string[];
  assert.equal(names.length, 17);
  assert.equal(names[names.indexOf("find_derived_types") + 1], "get_call_graph");
});

test("get_call_graph prints the header and both groups", async () => {
  const text = await call("get_call_graph", { symbol: "total" });
  assert.match(text, /^Symbol: .*\n/);
  assert.ok(text.includes("\nProject: refs-pkg (refs)\n"), text);
  assert.match(text, /\nDefined: .*main\.ts:3:\d+\n/);
  assert.ok(text.includes("\nCallers (1, live, loaded solutions only):\n  Holder.run  "), text);
  assert.ok(text.includes("\nCallees (1, source only; includeExternal=true adds node_modules and lib calls):\n  Shape.area  "), text);
});

test("get_call_graph tags via callers; direct=true keeps the symbol's own", async () => {
  const tools = (await rpc("tools/list")).result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
  assert.ok("direct" in tools.find((t) => t.name === "get_call_graph")!.inputSchema.properties);
  const all = await call("get_call_graph", { symbol: "Circle.area", direction: "callers" });
  assert.ok(all.includes("\nCallers (3: 1 direct, 2 via base or interface members, live, loaded solutions only):\n"), all);
  const direct = await call("get_call_graph", { symbol: "Circle.area", direction: "callers", direct: true });
  assert.ok(direct.includes("\nCallers (1, live, loaded solutions only):\n  Holder.big  "), direct);
});

test("get_call_graph pages a list with next_page", async () => {
  const text = await call("get_call_graph", { symbol: "total", limit: 1, includeExternal: true });
  assert.ok(text.includes("\nCallees (2):\n"), text);
  const more = /  \.\.\. 1 more \(next_page cursor=([0-9a-f]{10})\)\n/.exec(text);
  assert.ok(more, text);
  const next = await call("next_page", { cursor: more![1] });
  assert.ok(next.startsWith("Continued: get_call_graph callees of total"), next);
  assert.ok(next.includes("Shape.area"), next);
});

test("get_call_graph on an unknown symbol returns the not-found text", async () => {
  const text = await call("get_call_graph", { symbol: "nothing_here" });
  assert.ok(text.startsWith("Symbol not found in any loaded solution: nothing_here"), text);
});

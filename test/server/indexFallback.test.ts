import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { startServer } from "../../src/server/server.ts";
import type { RunningServer } from "../../src/server/server.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { SEARCH, SHARED, SINGLE } from "../workspace/projects.ts";

let fixture: Fixture;
let server: RunningServer;
let nextId = 1;

before(async () => {
  fixture = writeFixture({ ...SEARCH, ...SINGLE, ...SHARED });
  server = await startServer({
    roots: [fixture.root], preload: ["appA"], warmUp: true, indexPath: ":memory:", port: 0, warn: () => {},
  });
  await server.jobs.idle();
});

after(async () => {
  await server.close();
  fixture.remove();
});

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const reply = (await response.json()) as { result: { content: { text: string }[] } };
  return reply.result.content[0]!.text;
}

test("search_symbols appends index groups for unloaded solutions", async () => {
  const retry = await call("search_symbols", { pattern: "Retry" });
  assert.ok(retry.includes("Index demo (not loaded, 2):\n"), retry);
  assert.ok(retry.includes("  class RetryPolicy  "), retry);
  assert.ok(!retry.includes("Live "), retry);

  const gadget = await call("search_symbols", { pattern: "Gadget" });
  assert.ok(gadget.includes("Live appA ("), gadget);
  const group = gadget.slice(gadget.indexOf("Index appB (not loaded, "));
  assert.ok(group.startsWith("Index appB (not loaded, "), gadget);
  const lines = group.split("\n").filter((l) => l.startsWith("  "));
  assert.equal(new Set(lines).size, lines.length, group);
  assert.ok(lines.some((l) => l.startsWith("  class Gadget  ")), group);
});

test("find_references adds index groups, scope filter and stale markers", async () => {
  const refs = await call("find_references", { symbol: "Gadget" });
  const lib = `${fixture.root}/shared/src/lib.ts`;
  // a.ts (import, creation) and lib.ts (return type, creation) are live in appA; appB's tree holds lib.ts only
  assert.ok(refs.includes("\nLive appA: 4 references\n"), refs);
  assert.ok(refs.includes("\nIndex appB: 2 references (solution not loaded; from index)\n"), refs);
  assert.ok(refs.includes(`\n  ${lib}:2:31  app-b  usage  in makeGadget\n`), refs);
  assert.ok(refs.includes(`\n  ${lib}:2:51  app-b  creation  in makeGadget\n`), refs);
  assert.ok(refs.endsWith("\nTotal: 6 references"), refs);

  const scoped = await call("find_references", { symbol: "Gadget", scope: "production" });
  assert.ok(
    scoped.includes("\nIndex appB: 2 of 2 references (scope=production; solution not loaded; from index)\n"),
    scoped,
  );
  assert.ok(scoped.endsWith("\nTotal: 6 references (scope=production)"), scoped);

  writeFileSync(lib, `// changed\nexport class Gadget { spin(): number { return 2; } }\nexport function makeGadget(): Gadget { return new Gadget(); }\n`);
  const stale = await call("find_references", { symbol: "Gadget" });
  const indexLines = stale.split("\n").filter((l) => l.startsWith("  ") && l.includes("lib.ts"));
  assert.ok(indexLines.some((l) => l.endsWith("  [stale: file changed since indexed]")), stale);
});

test("find_implementations from the index, not-found candidates and docId specs", async () => {
  const impl = await call("find_implementations", { symbol: "Shape" });
  assert.ok(impl.includes("Index single: 1 (solution not loaded; from index)\n"), impl);
  assert.ok(impl.includes("  implements  class Circle  "), impl);
  assert.ok(impl.endsWith("Total: 1"), impl);

  const nothing = await call("go_to_definition", { symbol: "NoSuch" });
  assert.ok(nothing.includes("Tip: "), nothing);

  const circle = await call("go_to_definition", { symbol: "Circle" });
  const lines = circle.split("\n");
  assert.equal(lines[0], "Symbol not found in any loaded solution: Circle");
  assert.equal(lines[1], "Index knows these candidates (pass the fully qualified name, or load_solution for the live view):");
  const shapes = `${fixture.root}/single/src/shapes.ts`;
  assert.ok(lines.includes(`  single-pkg/shapes#Circle  class  ${shapes}:5  (single)`), circle);

  const byDocId = await call("go_to_definition", { symbol: "single-pkg/shapes#Circle" });
  assert.ok(byDocId.startsWith("Symbol not found"), byDocId);

  await call("load_solution", { solution: "single" });
  const live = await call("go_to_definition", { symbol: "single-pkg/shapes#Circle" });
  assert.ok(live.startsWith("Symbol: "), live);
});

test("get_outline of a file in an unloaded solution comes from the index", async () => {
  const path = `${fixture.root}/demo/src/retry.ts`;
  const text = await call("get_outline", { target: path });
  const lines = text.split("\n");
  assert.equal(
    lines[0],
    `Outline: ${path}  (Index demo, demo; solution not loaded, decorators not shown, load_solution for the live view)`,
  );
  assert.equal(lines[1], "  class RetryPolicy  1-3");
  assert.equal(lines[2], "    method createRetryOptions(): void  2");
  assert.equal(lines[3], "Total: 2 declarations");
});

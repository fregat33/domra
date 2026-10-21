import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "../../src/server/server.ts";
import type { RunningServer } from "../../src/server/server.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { PKG } from "../workspace/projects.ts";

let fixture: Fixture;
let nextId = 1;

before(() => {
  fixture = writeFixture(PKG);
});

after(() => fixture.remove());

async function withServer(
  options: { preload: string[]; warmUp: boolean },
  fn: (call: (name: string, args: Record<string, unknown>) => Promise<string>) => Promise<void>,
): Promise<void> {
  const server: RunningServer = await startServer({
    roots: [fixture.root], ...options, watch: false, indexPath: ":memory:", port: 0, warn: () => {},
  });
  try {
    await server.jobs.idle();
    await fn(async (name, args) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
      });
      const reply = (await response.json()) as { result: { content: { text: string }[] } };
      return reply.result.content[0]!.text;
    });
  } finally {
    await server.close();
  }
}

test("find_references and go_to_definition of a package type with the source solution loaded", async () => {
  await withServer({ preload: ["libpkg", "webapp"], warmUp: true }, async (call) => {
    const refs = await call("find_references", { symbol: "OrderPlaced" });
    assert.ok(refs.includes("\nLive libpkg: 1 references\n"), refs);
    assert.ok(refs.includes("\nLive webapp: 2 references  [package 1.0.0, source is 1.1.0]\n"), refs);
    assert.ok(refs.includes("\nIndex worker: 2 references (solution not loaded; from index)\n"), refs);
    assert.ok(refs.includes(`\n  ${fixture.path("worker/src/handler.ts")}:2:31  worker  usage  in handle\n`), refs);
    assert.ok(!refs.includes("/node_modules/"), refs);
    assert.ok(refs.endsWith("\nTotal: 5 references"), refs);

    const definition = await call("go_to_definition", { symbol: "OrderPlaced", solution: "webapp" });
    assert.ok(definition.includes("\nProject: acme-contracts (libpkg)\n"), definition);
    assert.ok(definition.includes("\nDeclared in source:\n"), definition);
    assert.ok(definition.includes(`  ${fixture.path("libpkg/src/orders.ts")}:1:18\n`), definition);
    assert.ok(!definition.includes("Source: "), definition);
  });
});

test("go_to_definition of a package type without the index knowing its source", async () => {
  await withServer({ preload: ["webapp"], warmUp: false }, async (call) => {
    const definition = await call("go_to_definition", { symbol: "OrderService" });
    assert.ok(definition.includes("\nDeclared in declaration file:\n"), definition);
    assert.ok(definition.includes("/webapp/node_modules/acme-contracts/dist/orders.d.ts:2:22"), definition);
    assert.ok(!definition.includes("Source: "), definition);
  });
});

test("go_to_definition and get_symbol_info of a package type whose source is indexed but not loaded", async () => {
  await withServer({ preload: ["webapp"], warmUp: true }, async (call) => {
    const source = `Source: ${fixture.path("libpkg/src/orders.ts")}:2  (acme-contracts, libpkg; solution not loaded, load_solution for the live view)`;
    const definition = await call("go_to_definition", { symbol: "OrderService" });
    const lines = definition.split("\n");
    const declared = lines.indexOf("Declared in declaration file:");
    assert.ok(declared > 0, definition);
    assert.ok(lines[declared + 1]!.endsWith("/webapp/node_modules/acme-contracts/dist/orders.d.ts:2:22"), definition);
    assert.equal(lines[declared + 2], source, definition);
    assert.equal(lines.filter((l) => l.startsWith("Source: ")).length, 1, definition);

    const info = await call("get_symbol_info", { symbol: "OrderService" });
    const infoLines = info.split("\n");
    const at = infoLines.findIndex((l) => l.startsWith("Declared at: "));
    assert.equal(infoLines[at + 1], source, info);
  });
});

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

type Call = (name: string, args: Record<string, unknown>) => Promise<string>;

async function withServer(preload: string[], fn: (call: Call, server: RunningServer) => Promise<void>, warmUp = true): Promise<void> {
  const server = await startServer({
    roots: [fixture.root], preload, warmUp, watch: false, indexPath: ":memory:", port: 0, warn: () => {},
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
    }, server);
  } finally {
    await server.close();
  }
}

const DRIFT_TEXT =
  "acme-contracts  source 1.1.0 (libpkg)\n  webapp  webapp  1.0.0\n" +
  "Total: 1 consumer projects on a version other than the source. Only solutions indexed at least once are compared.";

test("find_references tags the group of a consumer on another version", async () => {
  await withServer(["libpkg", "webapp"], async (call) => {
    const refs = await call("find_references", { symbol: "OrderPlaced" });
    assert.ok(refs.includes("\nLive libpkg: 1 references\n"), refs);
    assert.ok(refs.includes("\nLive webapp: 2 references  [package 1.0.0, source is 1.1.0]\n"), refs);
    assert.ok(refs.includes("\nIndex worker: 2 references (solution not loaded; from index)\n"), refs);
  });
});

test("a group without hits notes that the symbol may not exist in that version", async () => {
  await withServer(["libpkg", "webapp"], async (call) => {
    // find_implementations prints no group for a consumer solution without entries, so the zero-hit tag shows on a filtered find_references.
    const implementations = await call("find_implementations", { symbol: "OrderPlaced" });
    assert.ok(!implementations.includes("Live webapp:"), implementations);
    assert.ok(!implementations.includes("[package"), implementations);
    const refs = await call("find_references", { symbol: "OrderPlaced", kind: "decorator" });
    assert.ok(
      refs.includes("\nLive webapp: 0 of 2 references (kind=decorator)  [package 1.0.0, source is 1.1.0; the symbol may not exist in that version]\n"),
      refs,
    );
    assert.ok(refs.includes("\nLive libpkg: 0 of 1 references (kind=decorator)\n"), refs);
  });
});

test("package_drift lists the consumers on another version", async () => {
  await withServer(["libpkg", "webapp"], async (call) => {
    assert.equal(await call("package_drift", {}), DRIFT_TEXT);
    const limited = await call("package_drift", { limit: 1 });
    assert.equal(limited, DRIFT_TEXT);
  });
});

test("package_drift without drift", async () => {
  await withServer(["libpkg"], async (call) => {
    assert.equal(
      await call("package_drift", {}),
      "No package version drift: every indexed consumer uses the version its source package currently declares. Only solutions indexed at least once are compared.",
    );
  }, false);
});

test("tools/list puts package_drift after reindex", async () => {
  await withServer(["libpkg"], async (_call, server) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/list" }),
    });
    const { result } = (await response.json()) as { result: { tools: { name: string }[] } };
    const names = result.tools.map((t) => t.name);
    assert.equal(names.length, 17);
    assert.equal(names[names.indexOf("reindex") + 1], "package_drift");
  }, false);
});

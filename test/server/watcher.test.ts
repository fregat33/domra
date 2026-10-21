import { appendFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "../../src/server/server.ts";
import type { RunningServer } from "../../src/server/server.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { until } from "../watcher/until.ts";
import { SEARCH, SINGLE } from "../workspace/projects.ts";

let fixture: Fixture;
let server: RunningServer;
let nextId = 1;

before(async () => {
  fixture = writeFixture({ ...SINGLE, ...SEARCH });
  server = await startServer({
    roots: [fixture.root], preload: ["single"], warmUp: false, port: 0, indexPath: ":memory:", debounceMs: 100,
    unloadedRefreshSeconds: 1, unloadedRefreshMaxWaitSeconds: 10, warn: () => {},
  });
  await server.jobs.idle();
});

after(async () => {
  await server.close();
  fixture.remove();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const reply = (await response.json()) as { result: { content: { text: string }[] } };
  return reply.result.content[0]!.text;
}

test("file edits show up in live tools and an unloaded solution is refreshed later", async () => {
  const initial = await call("status");
  assert.ok(initial.includes("Watcher: 1 roots, 0 batches applied"), initial);
  assert.ok(initial.includes("Unloaded refresh: none pending"), initial);

  const started = performance.now();
  appendFileSync(fixture.path("single/src/shapes.ts"), "export class Hexagon {}\n");
  let text = "";
  await until(async () => {
    text = await call("search_symbols", { pattern: "Hexagon" });
    return /Live single/.test(text) && /class Hexagon/.test(text);
  });
  console.log(`watcher.test: shapes.ts write to first 'Live single' hit took ${Math.round(performance.now() - started)} ms`);
  await until(async () => (await call("status")).includes("1 batches applied"));

  writeFileSync(fixture.path("demo/src/newthing.ts"), "export class NewThing {}\n");
  await until(async () => (await call("status")).includes("Unloaded refresh: demo (1 files,"));
  await until(async () => (await call("status")).includes("Unloaded refresh: none pending"), 10000);
  await until(async () => (await call("search_symbols", { pattern: "NewThing" })).includes("Index demo (not loaded, 1):"));
});

test("watch: false turns the watcher off", async () => {
  const off = await startServer({
    roots: [fixture.root], preload: [], warmUp: false, port: 0, indexPath: ":memory:", watch: false, warn: () => {},
  });
  try {
    assert.equal(off.watcher, null);
    assert.equal(off.pending, null);
    const health = await (await fetch(`http://127.0.0.1:${off.port}/health`)).text();
    assert.ok(health.includes("Watcher: off"), health);
    assert.ok(!health.includes("Unloaded refresh:"), health);
  } finally {
    await off.close();
  }
});

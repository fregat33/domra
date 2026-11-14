import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "../../src/server/server.ts";
import type { RunningServer } from "../../src/server/server.ts";
import { WorkspaceManager } from "../../src/workspace/index.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";

const TSCONFIG = { compilerOptions: { types: [] }, include: ["*.ts"] };

let fixture: Fixture;
let root: string;
let server: RunningServer;
let nextId = 1;
const temp: string[] = [];

function makeSolution(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG));
  writeFileSync(join(dir, "o.ts"), "export const o = 1;\n");
  return `${dir.replace(/\\/g, "/")}/tsconfig.json`;
}

function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), "domra-rootsonly-"));
  temp.push(dir);
  return dir;
}

before(async () => {
  fixture = writeFixture({
    "r/package.json": { name: "r-pkg", version: "1.0.0" },
    "r/tsconfig.json": TSCONFIG,
    "r/a.ts": "export const a = 1;\n",
  });
  root = fixture.root;
  server = await startServer({ rootsOnly: true, roots: [root], port: 0, indexPath: ":memory:", watch: false, warn: () => {} });
  await server.jobs.idle();
});

after(async () => {
  await server.close();
  fixture.remove();
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
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

test("load_solution of an existing tsconfig outside the roots is refused", async () => {
  const path = makeSolution(makeTemp());
  const text = await call("load_solution", { solution: path });
  assert.ok(text.startsWith(`Outside the roots: ${path}.`), text);
  assert.equal(server.manager.isRegistered(path), false);
});

test("load_solution of a new tsconfig under a root still works", async () => {
  const path = makeSolution(`${root}/late/sub`);
  const text = await call("load_solution", { solution: path });
  assert.match(text, /projects loaded in/);
  await server.jobs.idle();
});

test("a query tool given an outside path answers as for an unknown solution", async () => {
  const path = makeSolution(makeTemp());
  const text = await call("search_symbols", { pattern: "o", solution: path });
  assert.ok(text.startsWith("Unknown solution: "), text);
  assert.equal(server.manager.isRegistered(path), false);
});

test("load_solution of a missing outside path is an unknown solution", async () => {
  const path = `${makeTemp().replace(/\\/g, "/")}/missing/tsconfig.json`;
  const text = await call("load_solution", { solution: path });
  assert.ok(text.startsWith("Unknown solution: "), text);
});

test("refusesOutsideRoots uses a path-segment prefix test", () => {
  const base = makeTemp();
  const r = `${base.replace(/\\/g, "/")}/r`;
  mkdirSync(r);
  const sibling = makeSolution(`${base}/r2`);
  const inside = makeSolution(`${r}/p`);
  assert.equal(new WorkspaceManager({ roots: [r], rootsOnly: true }).refusesOutsideRoots(sibling), true);
  assert.equal(new WorkspaceManager({ roots: [r], rootsOnly: true }).refusesOutsideRoots(inside), false);
  assert.equal(new WorkspaceManager({ roots: [], rootsOnly: true }).refusesOutsideRoots(sibling), true);
  assert.equal(new WorkspaceManager({ roots: [r], rootsOnly: false }).refusesOutsideRoots(sibling), false);
});

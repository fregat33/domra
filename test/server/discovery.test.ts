import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../../src/server/server.ts";
import type { RunningServer } from "../../src/server/server.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { delay, until } from "../watcher/until.ts";
import { MONO, SINGLE } from "../workspace/projects.ts";

let fixture: Fixture;
let server: RunningServer;
let nextId = 1;

before(async () => {
  fixture = writeFixture({ ...SINGLE, ...MONO });
  server = await startServer({
    roots: [fixture.root], preload: [], warmUp: false, port: 0, indexPath: ":memory:", debounceMs: 100,
    discoverySweepSeconds: 1, unloadedRefreshSeconds: 0, unloadedRefreshMaxWaitSeconds: 0, warn: () => {},
  });
  await server.jobs.idle();
});

after(async () => {
  await server.close();
  fixture.remove();
});

async function rpc(method: string, params?: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return (await response.json()).result;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  return (await rpc("tools/call", { name, arguments: args })).content[0].text as string;
}

const listed = async (path: string): Promise<boolean> => (await call("status")).includes(path);

function writeApp(relative: string, className: string): string {
  const dir = fixture.path(relative);
  mkdirSync(`${dir}/src`, { recursive: true });
  writeFileSync(`${dir}/src/a.ts`, `export class ${className} {}\n`);
  writeFileSync(
    `${dir}/tsconfig.json`,
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", types: [] }, include: ["src"] }),
  );
  return `${dir}/tsconfig.json`;
}

test("a tsconfig that appears under a root is registered lazily and answers queries", async () => {
  assert.ok(!(await listed("freshapp")));
  const tsconfig = writeApp("freshapp", "FreshThing");
  await until(() => listed(tsconfig), 5000);
  assert.ok((await call("status")).includes(`freshapp  registered  head -  ${tsconfig}`));
  const found = await call("search_symbols", { pattern: "FreshThing", solution: tsconfig });
  assert.ok(/class FreshThing/.test(found), found);
});

test("a deleted solution folder is forgotten", async () => {
  const tsconfig = fixture.path("freshapp/tsconfig.json");
  assert.ok(await listed(tsconfig));
  rmSync(fixture.path("freshapp"), { recursive: true, force: true, maxRetries: 5 });
  await until(async () => !(await listed(tsconfig)), 5000);
  assert.equal(server.manager.findRegistered(tsconfig), null);
});

test("tsconfigs referenced by a registered solution, in ignored folders or too deep are not registered", async () => {
  const mono = fixture.path("mono/tsconfig.json");
  const ui = fixture.path("mono/packages/ui/tsconfig.json");
  assert.ok(await listed(mono));
  assert.ok(!(await listed(ui)));
  writeFileSync(ui, `${JSON.stringify({ compilerOptions: { composite: true }, include: ["src"] })}\n`);
  writeApp("node_modules/pkg", "Ignored");
  writeApp("a/b/c/d/e/f/g", "TooDeep");
  await delay(500);
  const barrier = writeApp("a/b/c/d/e/f", "AtDepthSix");
  await until(() => listed(barrier), 5000);
  const status = await call("status");
  assert.ok(!status.includes(ui), status);
  assert.ok(!status.includes("node_modules/pkg"), status);
  assert.ok(!status.includes("a/b/c/d/e/f/g"), status);
  assert.ok(status.includes(mono), status);
});

test("forget_solution forgets by path, keeps it forgotten, and load_solution brings it back", async () => {
  const single = fixture.path("single/tsconfig.json");
  assert.ok(await listed(single));
  const text = await call("forget_solution", { solution: single });
  assert.equal(text, `Forgot single (${single}): 0 projects removed from the index.`);
  assert.ok(!(await listed(single)));
  await delay(1500);
  assert.ok(!(await listed(single)));
  assert.match(await call("forget_solution", { solution: single }), /^Unknown solution: .*Known: /);
  assert.match(await call("load_solution", { solution: single }), /^single: 1 projects loaded/);
  assert.ok(await listed(single));
});

test("forget_solution reports the removed index projects", async () => {
  await call("load_solution", { solution: "mono" });
  await server.jobs.idle();
  const text = await call("forget_solution", { solution: "mono" });
  assert.match(text, /^Forgot mono \(.*mono\/tsconfig\.json\): [1-9]\d* projects removed from the index\.$/);
  assert.equal(server.manager.resolveSolution("mono"), null);
});

test("a queued load job does not bring a forgotten solution back", async () => {
  const path = writeApp("queued", "Queued");
  await until(() => listed(path), 5000);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  void server.jobs.enqueue("blocker", () => gate);
  assert.match(await call("reindex", { solution: "queued" }), /was not loaded; load started/);
  assert.match(await call("forget_solution", { solution: path }), /^Forgot queued/);
  release();
  await server.jobs.idle();
  assert.ok(!(await listed(path)));
  assert.equal(server.manager.resolveSolution(path), null);
  rmSync(dirname(path), { recursive: true, force: true, maxRetries: 5 });
});

test("a new tsconfig that an existing solution already references is not registered separately", async () => {
  const dir = fixture.path("refmono");
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({ files: [], references: [{ path: "./libs/core" }] }));
  await until(() => listed(`${dir}/tsconfig.json`), 5000);
  const core = writeApp("refmono/libs/core", "Core");
  await delay(500);
  const barrier = writeApp("refbarrier", "Barrier");
  await until(() => listed(barrier), 5000);
  const status = await call("status");
  assert.ok(!status.includes(core), status);
  assert.ok(status.includes(`${dir}/tsconfig.json`), status);
});

test("after forget_solution and deleting the folder, a query with the old path answers Unknown solution", async () => {
  const tsconfig = writeApp("gone", "Gone");
  await until(() => listed(tsconfig), 5000);
  assert.match(await call("forget_solution", { solution: tsconfig }), /^Forgot gone/);
  rmSync(dirname(tsconfig), { recursive: true, force: true, maxRetries: 5 });
  assert.match(await call("search_symbols", { pattern: "Gone", solution: tsconfig }), /^Unknown solution: /);
  assert.ok(!(await listed(tsconfig)));
});

test("a folder renamed into the root is registered", async () => {
  const outside = mkdtempSync(join(tmpdir(), "domra-outside-"));
  try {
    mkdirSync(`${outside}/moved/src`, { recursive: true });
    writeFileSync(`${outside}/moved/src/a.ts`, "export class Moved {}\n");
    writeFileSync(`${outside}/moved/tsconfig.json`, JSON.stringify({ compilerOptions: { types: [] }, include: ["src"] }));
    renameSync(`${outside}/moved`, fixture.path("moved"));
    const tsconfig = fixture.path("moved/tsconfig.json");
    await until(() => listed(tsconfig), 5000);
    assert.match(await call("search_symbols", { pattern: "Moved", solution: tsconfig }), /class Moved/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("tools/list marks only load_solution, reindex and forget_solution as not read-only", async () => {
  const { tools } = await rpc("tools/list");
  const readOnly = Object.fromEntries(tools.map((t: any) => [t.name, t.annotations.readOnlyHint]));
  assert.equal(readOnly["forget_solution"], false);
  assert.equal(readOnly["load_solution"], false);
  assert.equal(readOnly["reindex"], false);
  assert.equal(readOnly["search_symbols"], true);
  assert.equal(Object.values(readOnly).filter((v) => v === false).length, 3);
});

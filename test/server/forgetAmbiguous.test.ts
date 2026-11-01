import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "../../src/server/server.ts";
import type { RunningServer } from "../../src/server/server.ts";
import { forgetSolution } from "../../src/watcher/index.ts";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";

const TSCONFIG = { compilerOptions: { types: [] }, include: ["*.ts"] };
const project = (dir: string, cls: string): Record<string, string | object> => ({
  [`${dir}/tsconfig.json`]: TSCONFIG,
  [`${dir}/a.ts`]: `export class ${cls} {}\n`,
});

let fixture: Fixture;
let server: RunningServer;
let nextId = 1;

before(async () => {
  fixture = writeFixture({
    ...project("a/app", "AppA"),
    ...project("b/app", "AppB"),
    ...project("c/application", "Application"),
    ...project("d/lib-one", "LibOne"),
    ...project("d/lib-two", "LibTwo"),
  });
  server = await startServer({ roots: [fixture.root], port: 0, indexPath: ":memory:", watch: false, warn: () => {} });
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
  return ((await response.json()) as any).result.content[0].text as string;
}

const registered = (rel: string): boolean => server.manager.isRegistered(fixture.path(rel));
const rows = (rel: string): number =>
  Number((server.store.db.prepare("SELECT count(*) AS n FROM project WHERE solution_path = ?").get(fixture.path(rel)) as { n: number }).n);

test("a fragment matching two solutions is ambiguous and forgets nothing", async () => {
  const one = fixture.path("d/lib-one/tsconfig.json");
  const two = fixture.path("d/lib-two/tsconfig.json");
  await call("load_solution", { solution: one });
  await call("load_solution", { solution: two });
  await server.jobs.idle();
  const before = [rows("d/lib-one/tsconfig.json"), rows("d/lib-two/tsconfig.json")];
  assert.ok(before.every((n) => n > 0));
  const text = await call("forget_solution", { solution: "lib" });
  assert.equal(
    text,
    `Ambiguous solution: lib matches lib-one (${one}), lib-two (${two}). Use the full path or the exact name.`,
  );
  assert.ok(registered("d/lib-one/tsconfig.json") && registered("d/lib-two/tsconfig.json"));
  assert.deepEqual([rows("d/lib-one/tsconfig.json"), rows("d/lib-two/tsconfig.json")], before);
  assert.ok(server.manager.resolveSolution(one) && server.manager.resolveSolution(two));
});

test("an exact name shared by two solutions is ambiguous, ignoring case and surrounding spaces", async () => {
  const a = fixture.path("a/app/tsconfig.json");
  const b = fixture.path("b/app/tsconfig.json");
  const text = await call("forget_solution", { solution: "  APP " });
  assert.equal(text, `Ambiguous solution: APP matches app (${a}), app (${b}). Use the full path.`);
  assert.ok(registered("a/app/tsconfig.json") && registered("b/app/tsconfig.json"));
});

test("the full path forgets exactly one; an exact name beats a fragment", async () => {
  const a = fixture.path("a/app/tsconfig.json");
  assert.match(await call("forget_solution", { solution: ` ${a} ` }), /^Forgot app \(/);
  assert.ok(!registered("a/app/tsconfig.json") && registered("b/app/tsconfig.json") && registered("c/application/tsconfig.json"));
  // "app" now names b/app exactly, although application also contains it
  assert.match(await call("forget_solution", { solution: "App" }), /^Forgot app \(/);
  assert.ok(!registered("b/app/tsconfig.json") && registered("c/application/tsconfig.json"));
});

test("a blank hint forgets nothing", async () => {
  const before = server.manager.solutions.length;
  assert.match(await call("forget_solution", { solution: "   " }), /^Unknown solution: /);
  assert.equal(server.manager.solutions.length, before);
});

test("resolveSolution prefers an exact name in another case over an earlier name containing the hint", async () => {
  const manager = new WorkspaceManager({ roots: [] });
  const application = manager.load(fixture.path("c/application/tsconfig.json"));
  const app = manager.load(fixture.path("b/app/tsconfig.json"));
  assert.equal(manager.resolveSolution("APP")?.path, app.path);
  assert.equal(manager.resolveSolution("appl")?.path, application.path); // fragment: first match stays
  assert.equal(manager.resolveSolution("APPLICATION")?.path, application.path);
  manager.unload(app.path);
  manager.unload(application.path);
});

test("a solution hidden by a part view is not a candidate", () => {
  const hiddenPath = fixture.path("d/lib-two/tsconfig.json");
  const view = server.manager.restrict((s) => s.path !== hiddenPath);
  const ambiguous = forgetSolution(view, server.store, null, "lib");
  // only lib-one is visible: no ambiguity, it is forgotten
  assert.ok(ambiguous && "solution" in ambiguous && ambiguous.solution.name === "lib-one");
  assert.ok(registered("d/lib-two/tsconfig.json"));
  assert.equal(forgetSolution(view, server.store, null, "lib-two"), null);
  assert.ok(registered("d/lib-two/tsconfig.json"));
});

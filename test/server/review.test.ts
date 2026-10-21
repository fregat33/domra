import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { startServer } from "../../src/server/server.ts";
import type { RunningServer } from "../../src/server/server.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { FakeGit } from "../workspace/fakeGit.ts";
import { PKG, REFS, REFS_SHAPES_TS } from "../workspace/projects.ts";

let fixture: Fixture;
let server: RunningServer;
let git: FakeGit;
let nextId = 1;

before(async () => {
  fixture = writeFixture(REFS);
  git = new FakeGit(fixture.root);
  server = await startServer({
    roots: [fixture.root], preload: ["refs"], watch: false, warmUp: false, port: 0, indexPath: ":memory:", warn: () => {}, git,
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
  return ((await response.json()) as { result: any }).result;
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  return (await rpc("tools/call", { name, arguments: args })).content[0].text as string;
}

test("tools/list has review_changes right after get_call_graph", async () => {
  const names = (await rpc("tools/list")).tools.map((t: { name: string }) => t.name);
  assert.equal(names.length, 17);
  assert.equal(names[names.indexOf("get_call_graph") + 1], "review_changes");
});

test("review_changes pages its lines and next_page continues them", async () => {
  const shapes = fixture.path("refs/src/shapes.ts");
  git.baseTexts.set("refs/src/shapes.ts", readFileSync(shapes, "utf8"));
  writeFileSync(shapes, REFS_SHAPES_TS.replace("export class Square extends Base { area(): number { return 4; } }", "export class Square extends Base { }"));
  git.files = [{ path: shapes, status: "modified" }];

  const text = await call("review_changes", { limit: 2 });
  const lines = text.split("\n");
  assert.equal(lines[0], "Review: refs  working tree vs main (merge-base abc1234)  1 files changed: 1 source, 0 project, 0 other");
  assert.deepEqual(lines.slice(1, 3), [`${shapes}  modified  surface`, "  - method  Square.area  public  was 4"]);
  const trailer = /^ {2}\.\.\. 3 more \(next_page cursor=([0-9a-f]{10})\)$/.exec(lines[3]!);
  assert.ok(trailer, text);
  assert.equal(lines[4], "Total: 1 source files, 1 changed declarations (1 surface, 0 body-only or private), 1 errors, 0 warnings");

  const next = await call("next_page", { cursor: trailer[1]! });
  const rest = next.split("\n");
  assert.equal(rest[0], "Continued: review_changes refs vs main");
  assert.equal(rest[1], "      references: Live refs 0 before removal (usages left show as errors below)");
  assert.equal(rest[2], "Diagnostics on changed files: 1 errors, 0 warnings (compiler only; lint is not run)");
  const more = /^ {2}\.\.\. 1 more \(next_page cursor=([0-9a-f]{10})\)$/.exec(rest[3]!);
  assert.ok(more, next);
  const last = (await call("next_page", { cursor: more[1]! })).split("\n");
  assert.equal(last[0], "Continued: review_changes refs vs main");
  assert.match(last[1]!, /shapes\.ts:4:14 {2}error TS2515: /);

  git.probeError = "boom";
  try {
    assert.equal(
      await call("review_changes", {}),
      "review_changes: 'git' could not be started (boom); install git or set gitPath in the config\n",
    );
  } finally {
    git.probeError = null;
  }
});

const DESCRIPTION =
  "Start a branch review here, then read the diff. Compares the working tree of a loaded solution with the merge base of a git ref: one line per changed file, then per changed declaration '+ added', '- removed', '~ signature' or '~ body' with a spec the other tools accept, reference counts per solution (live and index, with package drift) for removed and signature-changed members, caller counts for body edits, and compiler diagnostics on the changed files. Counts only; follow up with find_references or get_call_graph on a printed spec.";

test("tools/list carries the review_changes description", async () => {
  const tools = (await rpc("tools/list")).tools as Array<{ name: string; description: string }>;
  assert.equal(tools.find((t) => t.name === "review_changes")!.description, DESCRIPTION);
});

const ORDERS = "libpkg/src/orders.ts";

/** Review libpkg after `edit` changed the OrderService.place declaration; `preload` decides which solutions are loaded. */
async function pkgReview(preload: string[], edit: (text: string) => string): Promise<string> {
  const pkg = writeFixture(PKG);
  const pkgGit = new FakeGit(pkg.root);
  const orders = pkg.path(ORDERS);
  const original = readFileSync(orders, "utf8");
  pkgGit.baseTexts.set(ORDERS, original);
  writeFileSync(orders, edit(original));
  pkgGit.files = [{ path: orders, status: "modified" }];
  const pkgServer = await startServer({
    roots: [pkg.root], preload, warmUp: true, watch: false, indexPath: ":memory:", port: 0, warn: () => {}, git: pkgGit,
  });
  try {
    await pkgServer.jobs.idle();
    const response = await fetch(`http://127.0.0.1:${pkgServer.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "review_changes", arguments: { solution: "libpkg" } },
      }),
    });
    return ((await response.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
  } finally {
    await pkgServer.close();
    pkg.remove();
  }
}

const SECOND_PARAMETER = (text: string): string => text.replace("place(order: OrderPlaced)", "place(order: OrderPlaced, note: string)");
const TAG = "  [package 1.0.0, source is 1.1.0]";

test("impact: a signature change lists the index counts of unloaded consumers with their drift", async () => {
  const text = await pkgReview(["libpkg"], SECOND_PARAMETER);
  assert.ok(text.includes(`
      references: Live libpkg 0, Index webapp 1${TAG}
`), text);
});

test("impact: a signature change lists loaded consumers live", async () => {
  const text = await pkgReview(["libpkg", "webapp"], SECOND_PARAMETER);
  assert.ok(text.includes(`
      references: Live libpkg 0, Live webapp 1${TAG}
`), text);
});

test("impact: a removed member counts before removal and keeps the consumers as remaining", async () => {
  const text = await pkgReview(["libpkg", "webapp"], (original) => original.replace("  place(order: OrderPlaced): void { void order; }\n", ""));
  assert.ok(
    text.includes(`
      references: Live libpkg 0 before removal (usages left show as errors below), Live webapp 1${TAG} remaining
`),
    text,
  );
});

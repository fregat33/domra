import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "../../src/server/server.ts";
import type { RunningServer } from "../../src/server/server.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";

const identity = ["-c", "user.name=domra", "-c", "user.email=domra@example.invalid", "-c", "commit.gpgsign=false"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...identity, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const TSCONFIG = { compilerOptions: { types: [] }, include: ["*.ts"] };
const A_TS = [
  "export function Shared(): number { return 1; }",
  "export function useShared(): number { return Shared(); }",
  "export interface Shape { area(): number }",
  "export class Square implements Shape { area(): number { return 4; } }",
  "",
].join("\n");

let fixture: Fixture;
let root: string;
let server: RunningServer;
let nextId = 1;
let slot1: string;
let slot2: string;
let slotQ: string;
const outside: string[] = [];

before(async () => {
  fixture = writeFixture({
    "r/package.json": { name: "r-pkg", version: "1.0.0" },
    "r/tsconfig.json": TSCONFIG,
    "r/a.ts": A_TS,
    "q/package.json": { name: "q-pkg", version: "1.0.0" },
    "q/tsconfig.json": TSCONFIG,
    "q/other.ts": "export class Other {}\n",
  });
  root = fixture.root;
  git(`${root}/r`, "init", "-q", "-b", "main");
  git(`${root}/r`, "add", ".");
  git(`${root}/r`, "commit", "-q", "-m", "first");
  slot1 = `${root}/slots/r/1`;
  slot2 = `${root}/slots/r/2`;
  git(`${root}/r`, "worktree", "add", "-q", "-b", "s1", slot1);
  git(`${root}/r`, "worktree", "add", "-q", "-b", "s2", slot2);
  writeFileSync(`${slot1}/only1.ts`, "export class OnlyOne {}\n");
  writeFileSync(`${slot2}/only2.ts`, "export class OnlyTwo {}\n");
  git(`${root}/q`, "init", "-q", "-b", "main");
  git(`${root}/q`, "add", ".");
  git(`${root}/q`, "commit", "-q", "-m", "first");
  slotQ = `${root}/slots/q/1`;
  git(`${root}/q`, "worktree", "add", "-q", "-b", "q1", slotQ);
  writeFileSync(`${slotQ}/onlyq.ts`, "export class OnlyQ {}\n");
  server = await startServer({ roots: [root], port: 0, indexPath: ":memory:", watch: false, warn: () => {} });
  await server.jobs.idle();
});

after(async () => {
  await server.close();
  fixture.remove();
  for (const dir of outside) rmSync(dir, { recursive: true, force: true });
});

async function rpc(
  parts: string[], name: string, args: Record<string, unknown> = {}, target: RunningServer = server,
): Promise<{ text: string; isError: boolean }> {
  const query = parts.map((p) => `part=${encodeURIComponent(p)}`).join("&");
  const response = await fetch(`http://127.0.0.1:${target.port}/mcp${query === "" ? "" : `?${query}`}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const reply = (await response.json()) as { jsonrpc: string; result: { content: { text: string }[]; isError?: boolean } };
  assert.equal(reply.jsonrpc, "2.0");
  return { text: reply.result.content[0]!.text, isError: reply.result.isError === true };
}

const call = async (parts: string[], name: string, args: Record<string, unknown> = {}, target?: RunningServer): Promise<string> =>
  (await rpc(parts, name, args, target)).text;

/** The `Index:` counts line of a status text. */
const indexCounts = (text: string): string => text.match(/^Index: .*\n {2}(.+)$/m)![1]!;
const symbolCount = (counts: string): number => Number(counts.match(/(\d+) symbols/)![1]);
const projectCount = (counts: string): number => Number(counts.match(/(\d+) projects/)![1]);
const refreshLine = (text: string): string => text.split("\n").find((l) => l.startsWith("Unloaded refresh:"))!;

/** Assert a result mentions files of the visible slot only. */
function onlySlot1(text: string): void {
  assert.ok(text.includes(`${slot1}/`), text);
  assert.ok(!text.includes(`${root}/r/`), text);
  assert.ok(!text.includes(slot2), text);
}

test("the fixture is indexed, including the slots", () => {
  assert.ok(server.store.searchSymbols("OnlyTwo", null, 5).length > 0);
  assert.ok(server.store.searchSymbols("OnlyOne", null, 5).length > 0);
  assert.equal(server.manager.resolveSolution(`${slot2}/tsconfig.json`), null);
});

test("without part, slots are invisible and the base is unchanged", async () => {
  const status = await call([], "status");
  assert.ok(status.includes(`${root}/r/tsconfig.json`), status);
  assert.ok(status.includes(`${root}/q/tsconfig.json`), status);
  assert.ok(!status.includes("/slots/"), status);
  for (const pattern of ["OnlyOne", "OnlyTwo"]) {
    const text = await call([], "search_symbols", { pattern });
    assert.ok(!text.includes("only1.ts") && !text.includes("only2.ts") && !text.includes("/slots/"), text);
  }
  const shared = await call([], "search_symbols", { pattern: "Shared" });
  assert.ok(shared.includes(`${root}/r/a.ts`), shared);
  assert.ok(!shared.includes("/slots/"), shared);
  assert.equal(shared.match(/function Shared\b/g)?.length, 1, shared);
});

test("a part shows its slot and the other repositories, and hides the base and other slots", async () => {
  const parts = [slot1];
  const status = await call(parts, "status");
  assert.ok(status.includes(`${slot1}/tsconfig.json`), status);
  assert.ok(status.includes(`${root}/q/tsconfig.json`), status);
  assert.ok(!status.includes(`${root}/r/tsconfig.json`), status);
  assert.ok(!status.includes(slot2), status);
  const one = await call(parts, "search_symbols", { pattern: "OnlyOne" });
  assert.ok(one.includes("only1.ts"), one);
  const two = await call(parts, "search_symbols", { pattern: "OnlyTwo" });
  assert.ok(!two.includes("only2.ts"), two);
  assert.ok((await call(parts, "search_symbols", { pattern: "Other" })).includes("other.ts"));
  const shared = await call(parts, "search_symbols", { pattern: "Shared" });
  onlySlot1(shared);
});

test("references, call graph and implementations come from the part only, live and from the index", async () => {
  const parts = [slot1];
  const check = async (): Promise<void> => {
    onlySlot1(await call(parts, "find_references", { symbol: "Shared" }));
    onlySlot1(await call(parts, "get_call_graph", { symbol: "useShared" }));
    onlySlot1(await call(parts, "find_implementations", { symbol: "Shape" }));
    onlySlot1(await call(parts, "find_derived_types", { type: "Shape" }));
  };
  assert.equal(server.manager.resolveSolution(`${slot2}/tsconfig.json`), null);
  await check();
  for (const path of [`${root}/r/tsconfig.json`, `${slot2}/tsconfig.json`]) server.manager.load(path);
  try {
    await check();
    const hidden = await call(parts, "status");
    assert.ok(!hidden.includes(slot2) && !hidden.includes(`${root}/r/tsconfig.json`), hidden);
  } finally {
    for (const path of [`${root}/r/tsconfig.json`, `${slot2}/tsconfig.json`]) server.manager.unload(path);
  }
});

test("hidden solutions named by hint or path answer like unknown ones", async () => {
  const parts = [slot1];
  const byHint = await call(parts, "go_to_definition", { symbol: "Shared", solution: `${root}/r/tsconfig.json` });
  assert.match(byHint, /^Unknown solution: /);
  assert.ok(byHint.endsWith("Known: 1, q"), byHint);
  assert.match(await call(parts, "get_outline", { target: `${slot2}/a.ts`, solution: `${slot2}/tsconfig.json` }), /^Unknown solution: /);
  for (const dir of [slot2, `${root}/r`]) {
    const definition = await call(parts, "go_to_definition", { symbol: `${dir}/a.ts:1:17` });
    assert.ok(definition.includes("The file is not under any loaded solution.") && !definition.includes("Declared at"), definition);
    const outline = await call(parts, "get_outline", { target: `${dir}/a.ts` });
    assert.ok(!outline.includes("function Shared"), outline);
    assert.ok(!outline.includes("Index "), outline);
  }
  assert.match(await call(parts, "load_solution", { solution: `${root}/r/tsconfig.json` }), /^Unknown solution: /);
  assert.match(await call(parts, "forget_solution", { solution: `${slot2}/tsconfig.json` }), /^Unknown solution: /);
  assert.ok(server.manager.isRegistered(`${slot2}/tsconfig.json`));
});

test("package_drift and the outline of a path in the part work through the view", async () => {
  assert.ok(!(await call([slot1], "package_drift")).includes("/slots/r/2"));
  const outline = await call([slot1], "get_outline", { target: `${slot1}/a.ts` });
  assert.ok(outline.includes("function Shared"), outline);
});

test("parts of one repository, or not a worktree, are refused with a valid reply", async () => {
  const both = await rpc([slot1, slot2], "status");
  assert.equal(both.isError, true);
  assert.equal(both.text, `Two parts of one repository: ${slot1}, ${slot2}`);
  const plain = await rpc([`${root}/q`], "status");
  assert.equal(plain.isError, true);
  assert.equal(plain.text, `Unknown part: ${root}/q`);
  assert.equal((await rpc([`${root}/r`], "status")).text, `Unknown part: ${root}/r`);
  assert.equal((await rpc([`${root}/slots`], "status")).text, `Unknown part: ${root}/slots`);
  const list = await fetch(`http://127.0.0.1:${server.port}/mcp?part=${encodeURIComponent(`${root}/q`)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.ok(((await list.json()) as { result: { tools: unknown[] } }).result.tools.length > 0);
});

test("a repeated part is deduplicated", async () => {
  const status = await call([slot1, slot1], "status");
  assert.ok(status.includes(`${slot1}/tsconfig.json`), status);
  assert.equal(await call([slot1, slot1], "status").then(indexCounts), indexCounts(await call([slot1], "status")));
});

test("two parts of different repositories combine", async () => {
  const parts = [slot1, slotQ];
  const status = await call(parts, "status");
  assert.ok(status.includes(`${slot1}/tsconfig.json`), status);
  assert.ok(status.includes(`${slotQ}/tsconfig.json`), status);
  for (const hidden of [`${root}/r/tsconfig.json`, `${root}/q/tsconfig.json`, slot2]) assert.ok(!status.includes(hidden), status);
  const found = async (pattern: string): Promise<string> => call(parts, "search_symbols", { pattern });
  const one = await found("OnlyOne");
  assert.equal(one.match(/class OnlyOne\b/g)?.length, 1, one);
  assert.ok(one.includes(`${slot1}/only1.ts`), one);
  const onlyQ = await found("OnlyQ");
  assert.equal(onlyQ.match(/class OnlyQ\b/g)?.length, 1, onlyQ);
  assert.ok(onlyQ.includes(`${slotQ}/onlyq.ts`), onlyQ);
  const other = await found("Other");
  assert.equal(other.match(/class Other\b/g)?.length, 1, other);
  assert.ok(other.includes(`${slotQ}/other.ts`) && !other.includes(`${root}/q/`), other);
  assert.ok(!(await found("OnlyTwo")).includes("only2.ts"));
});

test("a part of one repository leaves the other repository at its base", async () => {
  const parts = [slotQ];
  const status = await call(parts, "status");
  assert.ok(status.includes(`${root}/r/tsconfig.json`), status);
  assert.ok(status.includes(`${slotQ}/tsconfig.json`), status);
  for (const hidden of [`${root}/q/tsconfig.json`, slot1, slot2]) assert.ok(!status.includes(hidden), status);
  const shared = await call(parts, "search_symbols", { pattern: "Shared" });
  assert.equal(shared.match(/function Shared\b/g)?.length, 1, shared);
  assert.ok(shared.includes(`${root}/r/a.ts`) && !shared.includes("/slots/"), shared);
});

test("without part, nothing of a slot of q is visible", async () => {
  const status = await call([], "status");
  assert.ok(!status.includes("/slots/"), status);
  assert.ok(!(await call([], "search_symbols", { pattern: "OnlyQ" })).includes("onlyq.ts"));
});

test("index counts follow the view", async () => {
  const bare = indexCounts(await call([], "status"));
  const both = indexCounts(await call([slot1, slotQ], "status"));
  assert.equal(projectCount(both), projectCount(bare));
  // Each view shows two solutions of the same size; the slots add one class each (OnlyOne, OnlyQ).
  assert.equal(symbolCount(both) - symbolCount(bare), 2, `${both} | ${bare}`);
  assert.notEqual(both, bare);
  const count = (table: string): number => Number((server.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
  const stats = server.store.restrict([]).stats();
  assert.deepEqual(stats, {
    projects: count("project"), trackedFiles: count("tree"), blobs: count("blob"),
    symbols: count("symbol"), references: count("reference"), relations: count("relation"),
  });
  assert.deepEqual(server.store.stats(), stats);
  assert.ok(server.store.stats().projects > projectCount(bare));
  const health = await (await fetch(`http://127.0.0.1:${server.port}/health`)).text();
  assert.equal(indexCounts(health), bare);
});

test("the unloaded refresh line follows the view", async () => {
  const watched = await startServer({ roots: [root], port: 0, indexPath: ":memory:", watch: true, warn: () => {} });
  try {
    await watched.jobs.idle();
    watched.pending!.touch(`${slot2}/tsconfig.json`, `${slot2}/a.ts`);
    watched.pending!.touch(`${root}/r/tsconfig.json`, `${root}/r/a.ts`);
    const line = async (part: string[]): Promise<string> => refreshLine(await call(part, "status", {}, watched));
    const viewOne = await line([slot1]);
    assert.ok(viewOne.includes("none pending"), viewOne);
    const bare = await line([]);
    assert.ok(bare.includes("r (") && !bare.includes("2 ("), bare);
    const viewTwo = await line([slot2]);
    assert.ok(viewTwo.includes("2 (") && !viewTwo.includes("r ("), viewTwo);
  } finally {
    await watched.close();
  }
});

test("an explicit load outside the view is refused without registering the path", async () => {
  const sub = `${slot2}/sub`;
  mkdirSync(sub);
  writeFileSync(`${sub}/tsconfig.json`, JSON.stringify(TSCONFIG));
  writeFileSync(`${sub}/s.ts`, "export const s = 1;\n");
  const path = `${sub}/tsconfig.json`;
  assert.match(await call([slot1], "load_solution", { solution: path }), /^Unknown solution: /);
  assert.equal(server.manager.isRegistered(path), false);
  assert.match(await call([slot2], "load_solution", { solution: path }), /projects loaded in/);
  assert.equal(server.manager.isRegistered(path), true);
  assert.ok((await call([slot2], "status")).includes(path));
  assert.ok(!(await call([], "status")).includes(path));
  await server.jobs.idle();
  server.manager.forget(path);
});

test("an explicit load of a path outside every root stays visible to everyone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domra-parts-outside-"));
  outside.push(dir);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG));
  writeFileSync(join(dir, "o.ts"), "export const o = 1;\n");
  const path = `${dir.replace(/\\/g, "/")}/tsconfig.json`;
  assert.match(await call([slot1], "load_solution", { solution: path }), /projects loaded in/);
  assert.ok((await call([], "status")).includes(path));
  await server.jobs.idle();
  server.manager.forget(path);
});

test("concurrent requests with different parts do not share a view", async () => {
  const jobs: Promise<string>[] = [];
  for (let i = 0; i < 6; i++) {
    jobs.push(call([i % 2 === 0 ? slot1 : slot2], "search_symbols", { pattern: "Only" }));
  }
  const results = await Promise.all(jobs);
  results.forEach((text, i) => {
    const mine = i % 2 === 0 ? "only1.ts" : "only2.ts";
    const other = i % 2 === 0 ? "only2.ts" : "only1.ts";
    assert.ok(text.includes(mine), text);
    assert.ok(!text.includes(other), text);
  });
});

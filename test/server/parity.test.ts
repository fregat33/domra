import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexStore } from "../../src/index/index.ts";
import { JobQueue } from "../../src/server/jobs.ts";
import { startServer } from "../../src/server/server.ts";
import type { ServerOptions } from "../../src/server/server.ts";
import { statusText } from "../../src/server/status.ts";
import type { ToolContext } from "../../src/server/tools.ts";
import { WorkspaceManager } from "../../src/workspace/index.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { until } from "../watcher/until.ts";
import { FakeGit } from "../workspace/fakeGit.ts";
import { REFS, SINGLE } from "../workspace/projects.ts";

let nextId = 1;

type Started = { server: Awaited<ReturnType<typeof startServer>>; fixture: Fixture; warnings: string[]; stop(): Promise<void> };

async function start(options: ServerOptions, files = { ...SINGLE, ...REFS }): Promise<Started> {
  const fixture = writeFixture(files);
  const warnings: string[] = [];
  const server = await startServer({
    roots: [fixture.root], port: 0, indexPath: ":memory:", debounceMs: 100, warn: (m) => void warnings.push(m), ...options,
  });
  return {
    server, fixture, warnings,
    stop: async () => {
      await server.close();
      fixture.remove();
    },
  };
}

async function rpc(s: Started, method: string, params?: unknown, query = ""): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${s.server.port}/mcp${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return await response.json();
}

async function call(s: Started, name: string, args: Record<string, unknown> = {}, query = ""): Promise<string> {
  return (await rpc(s, "tools/call", { name, arguments: args }, query)).result.content[0].text as string;
}

/** A fake git that also reports a version and a HEAD. */
class VersionGit extends FakeGit {
  versionResult: { version: string } | { error: string } = { version: "git version 9.8.7" };
  async version(): Promise<{ version: string } | { error: string }> {
    return this.versionResult;
  }
  async head(): Promise<string | null> {
    return "abcdef1234567890";
  }
}

test("status has a Git line in three states", async () => {
  const git = new VersionGit("/nowhere");
  const s = await start({ git, preload: ["single"], watch: false, warmUp: false });
  try {
    await s.server.jobs.idle();
    assert.match(await call(s, "status"), /^Git: not probed yet$/m);
    await until(async () => /^Git: git version 9\.8\.7$/m.test(await call(s, "status")));
    const text = await call(s, "status");
    assert.equal(text.split("\n").filter((l) => l.startsWith("Git:")).length, 1);
    assert.ok(text.indexOf("Ready:") < text.indexOf("Git:"), text);
  } finally {
    await s.stop();
  }
  const failing = new VersionGit("/nowhere");
  failing.versionResult = { error: "spawn git ENOENT" };
  const f = await start({ git: failing, watch: false, warmUp: false });
  try {
    await call(f, "status");
    await until(async () => (await call(f, "status")).includes("Git: not found (spawn git ENOENT)\n"));
  } finally {
    await f.stop();
  }
  const plain = new FakeGit("/nowhere");
  plain.probeError = "boom";
  const p = await start({ git: plain, watch: false, warmUp: false });
  try {
    await call(p, "status");
    await until(async () => /^Git: not found \(.*boom.*\)$/m.test(await call(p, "status")));
  } finally {
    await p.stop();
  }
});

test("status rows: pinned, last used, head placement, registered rows", async () => {
  const at = new Date(2024, 0, 2, 10, 20, 30).getTime();
  const git = new VersionGit("/nowhere");
  const s = await start({ git, preload: ["single"], watch: false, warmUp: false, now: () => at });
  try {
    await s.server.jobs.idle();
    const text = await call(s, "status");
    const single = s.fixture.path("single/tsconfig.json");
    const refs = s.fixture.path("refs/tsconfig.json");
    assert.match(
      text,
      new RegExp(`^ {2}single {2}loaded pinned {2}1 projects, \\d+ source files, loaded in \\d+\\.\\ds, last used 10:20:30 {2}head abcdef1 {2}${single}$`, "m"),
    );
    assert.ok(text.includes(`  refs  registered  head -  ${refs}\n`), text);
    // loading an unpinned solution shows no `pinned`
    await call(s, "load_solution", { solution: "refs" });
    await s.server.jobs.idle();
    assert.match(await call(s, "status"), /^ {2}refs {2}loaded {2}1 projects/m);
  } finally {
    await s.stop();
  }
});

/** A context that is just enough for `statusText`. */
function bareContext(manager: WorkspaceManager, failed?: string[]): ToolContext {
  return {
    manager, store: IndexStore.open(":memory:"), jobs: new JobQueue(), heads: new Map(), watcher: null, pending: null,
    changes: { batches: 0, lastBatch: null },
    warmUp: { ran: true, total: 2, done: 2, current: null, warmed: 0, fresh: 1, ...(failed ? { failed } : {}) },
  } as unknown as ToolContext;
}

test("Warm-up line counts failures only when there are some; a failed load puts error: on its row", () => {
  const manager = new WorkspaceManager();
  const none = bareContext(manager, []);
  try {
    assert.match(statusText(none), /^Warm-up: done, 0 warmed, 1 already fresh$/m);
    const two = bareContext(manager, ["a", "b"]);
    assert.match(statusText(two), /^Warm-up: done, 0 warmed, 1 already fresh, 2 failed \(a, b\)$/m);
    two.store.close();
    const one = bareContext(manager, ["a"]);
    assert.match(statusText(one), /^Warm-up: done, 0 warmed, 1 already fresh, 1 failed \(a\)$/m);
    one.store.close();

    manager.register({ name: "broken", path: "C:/nowhere/broken/tsconfig.json", dir: "C:/nowhere/broken", projects: [null as never] });
    assert.throws(() => manager.load("broken"));
    assert.match(statusText(none), /^ {2}broken {2}registered {2}head - {2}\S+broken\/tsconfig\.json {2}error: .+$/m);
    assert.equal(statusText(none).split("\n").filter((l) => l.includes("error:")).length, 1);
  } finally {
    none.store.close();
  }
});

test("a failed load shows error: in the status of the running server", async () => {
  const s = await start({ watch: false, warmUp: false }, { ...SINGLE });
  try {
    s.server.manager.register({ name: "broken", path: s.fixture.path("broken/tsconfig.json"), dir: s.fixture.path("broken"), projects: [null as never] });
    const failure = await call(s, "load_solution", { solution: "broken" });
    assert.match(failure, /failed/);
    assert.match(await call(s, "status"), /^ {2}broken {2}registered {2}head - {2}\S+ {2}error: \S.*$/m);
  } finally {
    await s.stop();
  }
});

test("idle eviction unloads unused unpinned solutions, keeps pinned and recently used ones", async () => {
  let clock = 0;
  const s = await start({
    preload: ["single"], idleEvictionMinutes: 2, idleCheckMs: 20, now: () => clock, watch: true,
  }, { ...SINGLE, ...REFS, "diag/tsconfig.json": SINGLE["single/tsconfig.json"]!, "diag/src/a.ts": "export class Gamma {}\n" });
  try {
    assert.equal(s.server.evictsIdle, true);
    await call(s, "load_solution", { solution: "refs" });
    await call(s, "load_solution", { solution: "diag" });
    await s.server.jobs.idle();
    clock = 90_000;
    await new Promise((r) => setTimeout(r, 80));
    assert.match(await call(s, "status"), /^ {2}refs {2}loaded/m);
    await call(s, "go_to_definition", { symbol: "Gamma", solution: "diag" });
    clock = 150_000;
    await until(async () => /^ {2}refs {2}registered/m.test(await call(s, "status")), 5000, 20);
    const status = await call(s, "status");
    assert.match(status, /^ {2}diag {2}loaded/m);
    assert.match(status, /^ {2}single {2}loaded pinned/m);
    assert.ok(s.warnings.includes("domra: Evicted refs after 2 idle minutes"), s.warnings.join("\n"));
    assert.ok(!s.warnings.some((w) => w.includes("Evicted single") || w.includes("Evicted diag")));
    // registered and still queryable through the index
    await s.server.jobs.idle();
    const found = await call(s, "search_symbols", { pattern: "Base" });
    assert.match(found, /Index refs \(not loaded/);
    // a use loads it again
    assert.match(await call(s, "load_solution", { solution: "refs" }), /^refs: 1 projects loaded/);
    await s.server.jobs.idle();
    // an unloaded registered solution still records pending refreshes from the watcher
    clock = 400_000;
    await until(async () => /^ {2}refs {2}registered/m.test(await call(s, "status")), 5000, 20);
    appendFileSync(s.fixture.path("refs/src/shapes.ts"), "export class Extra {}\n");
    await until(async () => (await call(s, "status")).includes("Unloaded refresh: refs ("), 10000);
  } finally {
    await s.stop();
  }
});

test("status calls do not refresh last used; idleEvictionMinutes 0 starts no timer", async () => {
  let clock = 1000;
  const s = await start({ idleEvictionMinutes: 0, now: () => clock, watch: false, warmUp: false, preload: ["single"] });
  try {
    assert.equal(s.server.evictsIdle, false);
    const before = await call(s, "status");
    clock = 7_200_000;
    const after = await call(s, "status");
    const used = (text: string): string => /last used (\S+)/.exec(text)![1]!;
    assert.equal(used(after), used(before));
    await call(s, "go_to_definition", { symbol: "Circle", solution: "single" });
    assert.notEqual(used(await call(s, "status")), used(before));
  } finally {
    await s.stop();
  }
  const on = await start({ idleEvictionMinutes: 1, watch: false, warmUp: false });
  try {
    assert.equal(on.server.evictsIdle, true);
  } finally {
    await on.stop();
  }
});

test("probes answer empty lists and write no call-log line; other unknown methods stay -32601", async () => {
  const s = await start({ watch: false, warmUp: false });
  try {
    const before = s.warnings.length;
    assert.deepEqual((await rpc(s, "prompts/list")).result, { prompts: [] });
    assert.deepEqual((await rpc(s, "resources/list")).result, { resources: [] });
    assert.deepEqual((await rpc(s, "resources/templates/list")).result, { resourceTemplates: [] });
    assert.equal(s.warnings.length, before);
    assert.equal((await rpc(s, "completion/complete")).error.code, -32601);
  } finally {
    await s.stop();
  }
});

test("tools/list annotations of all 17 tools", async () => {
  const s = await start({ watch: false, warmUp: false });
  try {
    const { tools } = (await rpc(s, "tools/list")).result;
    assert.equal(tools.length, 17);
    const mutating = ["load_solution", "reindex", "forget_solution"];
    for (const t of tools) {
      assert.deepEqual(
        t.annotations,
        {
          readOnlyHint: !mutating.includes(t.name),
          destructiveHint: t.name === "forget_solution",
          idempotentHint: t.name !== "next_page",
        },
        t.name,
      );
    }
  } finally {
    await s.stop();
  }
});

test("reindex: solution is optional, blank or absent means the default, ALL is case-insensitive", async () => {
  const s = await start({ defaultSolution: "single", preload: ["single"], watch: false, warmUp: false });
  try {
    await s.server.jobs.idle();
    assert.equal(await call(s, "reindex", {}), "Queued reindex of single (force=false).");
    assert.equal(await call(s, "reindex", { solution: "" }), "Queued reindex of single (force=false).");
    assert.equal(await call(s, "reindex", { solution: "  ", force: true }), "Queued reindex of single (force=true).");
    assert.equal(await call(s, "reindex", { solution: "ALL" }), "Queued reindex of 1 loaded solutions (force=false).");
    assert.equal(await call(s, "reindex", { solution: " all " }), "Queued reindex of 1 loaded solutions (force=false).");
    const { tools } = (await rpc(s, "tools/list")).result;
    assert.deepEqual(tools.find((t: any) => t.name === "reindex").inputSchema.required, []);
  } finally {
    await s.stop();
  }
  const none = await start({ watch: false, warmUp: false }, { ...SINGLE });
  try {
    assert.equal(await call(none, "reindex", {}), "Unknown solution: . Known: single");
    assert.equal(await call(none, "reindex", { solution: "   " }), "Unknown solution: . Known: single");
  } finally {
    await none.stop();
  }
});

const gitAvailable = spawnSync("git", ["--version"]).status === 0;
const identity = ["-c", "user.name=domra", "-c", "user.email=domra@example.invalid", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...identity, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("review_changes through a part on a real linked worktree", { skip: gitAvailable ? false : "git is not installed" }, async () => {
  const repo = writeFixture({ "tsconfig.json": { compilerOptions: { types: [] }, include: ["*.ts"] }, "a.ts": "export class Alpha {}\n" });
  const root = writeFixture({});
  const slot = `${root.root}/slot`;
  try {
    git(repo.root, "init", "-q", "-b", "main");
    git(repo.root, "add", ".");
    git(repo.root, "commit", "-q", "-m", "first");
    git(repo.root, "checkout", "-q", "-b", "trunk");
    git(repo.root, "worktree", "add", "-q", slot, "main");
    writeFileSync(`${slot}/a.ts`, "export class Alpha {}\nexport class Beta {}\n");
    const s = await start({ roots: [root.root], watch: false, warmUp: false });
    try {
      const query = `?part=${encodeURIComponent(slot)}`;
      assert.match(await call(s, "load_solution", { solution: `${slot}/tsconfig.json` }, query), /^slot: 1 projects loaded/);
      const text = await call(s, "review_changes", { base: "main" }, query);
      assert.ok(text.startsWith("Review: slot  working tree vs main"), text);
      assert.ok(text.includes(`${slot}/a.ts  modified`), text);
      assert.match(text, /^ {2}\+ class {2}Beta/m);
    } finally {
      await s.stop();
    }
  } finally {
    root.remove();
    repo.remove();
  }
});

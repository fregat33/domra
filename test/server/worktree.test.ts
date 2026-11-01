import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "../../src/server/server.ts";
import type { RunningServer } from "../../src/server/server.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { until } from "../watcher/until.ts";
import { SINGLE } from "../workspace/projects.ts";

const identity = ["-c", "user.name=domra", "-c", "user.email=domra@example.invalid", "-c", "commit.gpgsign=false"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...identity, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let repo: Fixture;
let root: Fixture;
let slot: string;
let tsconfig: string;
let server: RunningServer;
let nextId = 1;

before(async () => {
  repo = writeFixture({ "tsconfig.json": { compilerOptions: { types: [] }, include: ["*.ts"] }, "a.ts": "export class Alpha {}\n" });
  root = writeFixture({});
  git(repo.root, "init", "-q", "-b", "main");
  git(repo.root, "add", ".");
  git(repo.root, "commit", "-q", "-m", "first");
  git(repo.root, "checkout", "-q", "-b", "trunk");
  slot = `${root.root}/slot`;
  git(repo.root, "worktree", "add", "-q", slot, "main");
  tsconfig = `${slot}/tsconfig.json`;
  server = await startServer({
    roots: [root.root], preload: ["slot"], port: 0, indexPath: ":memory:", debounceMs: 100, warn: () => {},
  });
});

after(async () => {
  await server.close();
  root.remove();
  repo.remove();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/mcp?part=${encodeURIComponent(slot)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const reply = (await response.json()) as { result: { content: { text: string }[] } };
  return reply.result.content[0]!.text;
}

const head = (sha: string): string => `head ${sha.slice(0, 7)}  ${tsconfig}`;

async function settled(sha: string): Promise<void> {
  await until(async () => {
    const status = await call("status");
    return status.includes(head(sha)) && status.includes("Ready: yes");
  }, 10000);
}

test("a solution in a linked worktree is listed with its HEAD and the server gets ready", async () => {
  const sha = git(slot, "rev-parse", "HEAD");
  assert.equal(sha.slice(0, 7), git(slot, "rev-parse", "--short=7", "HEAD"));
  await settled(sha);
  assert.equal(server.watcher!.worktreeHeads.length, 1);
});

test("warm-up records the HEAD of an unloaded worktree solution", async () => {
  const warm = await startServer({ roots: [root.root], preload: [], port: 0, indexPath: ":memory:", debounceMs: 100, warn: () => {} });
  try {
    const expected = git(slot, "rev-parse", "--short=7", "HEAD");
    await until(async () => {
      const text = await (await fetch(`http://127.0.0.1:${warm.port}/health?part=${encodeURIComponent(slot)}`)).text();
      return text.includes(`head ${expected}  ${tsconfig}`) && text.includes("Ready: yes");
    }, 10000);
  } finally {
    await warm.close();
  }
});

test("branch switches in the worktree are followed: HEAD, symbols, and a switch that changes only a non-source file", async () => {
  git(slot, "checkout", "-q", "-b", "b2");
  writeFileSync(`${slot}/b.ts`, "export class Beta {}\n");
  git(slot, "add", ".");
  git(slot, "commit", "-q", "-m", "add b");
  const b2 = git(slot, "rev-parse", "HEAD");
  git(slot, "checkout", "-q", "main");
  git(slot, "checkout", "-q", "b2");
  await settled(b2);
  await until(async () => {
    const hit = await call("search_symbols", { pattern: "Beta", solution: tsconfig });
    return hit.includes("Beta") && hit.includes("b.ts");
  }, 10000);

  git(slot, "checkout", "-q", "-b", "docs", "main");
  writeFileSync(`${slot}/README.md`, "docs\n");
  git(slot, "add", ".");
  git(slot, "commit", "-q", "-m", "docs");
  const docs = git(slot, "rev-parse", "HEAD");
  await settled(docs);
  git(slot, "checkout", "-q", "main");
  await settled(git(slot, "rev-parse", "HEAD"));
  git(slot, "checkout", "-q", "docs");
  await settled(docs);
});

test("status reports buffered paths and is not ready while the debouncer holds them", async () => {
  const fixture = writeFixture(SINGLE);
  const slow = await startServer({
    roots: [fixture.root], preload: ["single"], warmUp: false, port: 0, indexPath: ":memory:", debounceMs: 1500, warn: () => {},
  });
  try {
    await slow.jobs.idle();
    const status = async (): Promise<string> =>
      (await (await fetch(`http://127.0.0.1:${slow.port}/health`)).text());
    await until(async () => (await status()).includes("Ready: yes"));
    appendFileSync(fixture.path("single/src/shapes.ts"), "export class Hexagon {}\n");
    let text = "";
    await until(async () => /Ready: no \(0 jobs, [1-9]\d* buffered\)/.test((text = await status())), 3000, 20);
    assert.match(text, /Watcher: 1 roots, 0 batches applied, [1-9]\d* buffered/);
    await until(async () => (await status()).includes("Ready: yes") && (await status()).includes("1 batches applied"), 15000);
  } finally {
    await slow.close();
    fixture.remove();
  }
});

test("an unloaded worktree solution follows branch switches: README-only switch, then a switch adding a symbol", async () => {
  const mainRepo = writeFixture({ "tsconfig.json": { compilerOptions: { types: [] }, include: ["*.ts"] }, "a.ts": "export class Alpha {}\n" });
  const slotRoot = writeFixture({});
  git(mainRepo.root, "init", "-q", "-b", "main");
  git(mainRepo.root, "add", ".");
  git(mainRepo.root, "commit", "-q", "-m", "first");
  git(mainRepo.root, "checkout", "-q", "-b", "trunk");
  const dir = `${slotRoot.root}/slot`;
  const config = `${dir}/tsconfig.json`;
  git(mainRepo.root, "worktree", "add", "-q", dir, "main");
  const cold = await startServer({ roots: [slotRoot.root], preload: [], port: 0, indexPath: ":memory:", debounceMs: 100, warn: () => {} });
  const ask = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const response = await fetch(`http://127.0.0.1:${cold.port}/mcp?part=${encodeURIComponent(dir)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    });
    return ((await response.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text;
  };
  const ready = async (sha: string): Promise<void> => {
    await until(async () => {
      const status = await ask("status");
      return status.includes(`head ${sha.slice(0, 7)}  ${config}`) && status.includes("Ready: yes");
    }, 10000);
  };
  try {
    await ready(git(dir, "rev-parse", "HEAD"));

    git(dir, "checkout", "-q", "-b", "docs");
    writeFileSync(`${dir}/README.md`, "docs\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "docs");
    await ready(git(dir, "rev-parse", "HEAD"));

    git(dir, "checkout", "-q", "-b", "b2", "main");
    writeFileSync(`${dir}/b.ts`, "export class Beta {}\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "add b");
    await ready(git(dir, "rev-parse", "HEAD"));
    await until(async () => {
      const hit = await ask("search_symbols", { pattern: "Beta", solution: config });
      return hit.includes("Beta") && hit.includes("b.ts");
    }, 10000);
  } finally {
    await cold.close();
    slotRoot.remove();
    mainRepo.remove();
  }
});

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { startServer } from "../../src/server/server.ts";
import type { GitProvider } from "../../src/workspace/index.ts";
import { writeFixture } from "../fixtures.ts";
import { delay, until } from "../watcher/until.ts";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";

const git: GitProvider = {
  probe: async () => null,
  repoRoot: () => null,
  head: async () => SHA,
  defaultBase: async () => null,
  changes: async () => ({ error: "none" }),
  show: async () => null,
};

function writeApp(root: string, relative: string, className: string): string {
  const dir = `${root}/${relative}`;
  mkdirSync(`${dir}/src`, { recursive: true });
  writeFileSync(`${dir}/src/a.ts`, `export class ${className} {}\n`);
  writeFileSync(
    `${dir}/tsconfig.json`,
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", types: [] }, include: ["src"] }),
  );
  return `${dir}/tsconfig.json`;
}

async function withServer(fn: (ctx: { root: string; warnings: string[]; status: () => Promise<string>; idle: () => Promise<void> }) => Promise<void>): Promise<void> {
  const fixture = writeFixture({});
  const warnings: string[] = [];
  const server = await startServer({
    roots: [fixture.root], preload: [], warmUp: false, port: 0, indexPath: ":memory:", debounceMs: 100,
    discoverySweepSeconds: 0, unloadedRefreshSeconds: 0, unloadedRefreshMaxWaitSeconds: 0, git,
    warn: (m: string) => void warnings.push(m),
  });
  let id = 1;
  const status = async (): Promise<string> => {
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "status", arguments: {} } }),
    });
    return (await response.json()).result.content[0].text as string;
  };
  try {
    await server.jobs.idle();
    await fn({ root: fixture.root, warnings, status, idle: () => server.jobs.idle() });
  } finally {
    await server.close();
    fixture.remove();
  }
}

const count = (lines: string[], name: string): number => lines.filter((l) => l.startsWith(`domra: refreshed ${name} in`)).length;

test("a discovered solution is indexed in the background and gets its head", async () => {
  await withServer(async ({ root, warnings, status, idle }) => {
    const tsconfig = writeApp(root, "one", "One");
    await until(async () => (await status()).includes(tsconfig), 5000);
    await idle();
    assert.equal(count(warnings, "one"), 1, warnings.join("\n"));
    const text = await status();
    assert.ok(text.includes(`one  registered  head ${SHA.slice(0, 7)}  ${tsconfig}`), text);
  });
});

test("two discovered solutions both get indexed and a later unrelated event does not index them again", async () => {
  await withServer(async ({ root, warnings, status, idle }) => {
    const first = writeApp(root, "alpha", "Alpha");
    await until(async () => (await status()).includes(first), 5000);
    const second = writeApp(root, "beta", "Beta");
    await until(async () => (await status()).includes(second), 5000);
    await idle();
    const text = await status();
    assert.ok(text.includes(`alpha  registered  head ${SHA.slice(0, 7)}  ${first}`), text);
    assert.ok(text.includes(`beta  registered  head ${SHA.slice(0, 7)}  ${second}`), text);
    assert.equal(count(warnings, "alpha"), 1, warnings.join("\n"));
    assert.equal(count(warnings, "beta"), 1, warnings.join("\n"));
    writeFileSync(`${root}/unrelated.txt`, "x\n");
    await delay(500);
    await idle();
    assert.equal(count(warnings, "alpha"), 1, warnings.join("\n"));
    assert.equal(count(warnings, "beta"), 1, warnings.join("\n"));
  });
});

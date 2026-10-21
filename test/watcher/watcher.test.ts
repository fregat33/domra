import { mkdirSync, watch, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { normalizePath } from "../../src/workspace/index.ts";
import type { ChangeBatch } from "../../src/watcher/debounce.ts";
import { RepoWatcher } from "../../src/watcher/watcher.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { delay, until } from "./until.ts";

let fixture: Fixture;
const watchers: RepoWatcher[] = [];

before(() => {
  fixture = writeFixture({ "src/seed.ts": "export {};\n", "node_modules/seed.ts": "export {};\n" });
});

after(() => {
  for (const watcher of watchers) watcher.close();
  fixture.remove();
});

function create(roots: string[], warnings: string[] = []): { watcher: RepoWatcher; batches: ChangeBatch[] } {
  const batches: ChangeBatch[] = [];
  const watcher = new RepoWatcher({
    roots, ignoredFolders: ["node_modules", ".git"], quietMs: 50,
    onBatch: (b) => batches.push(b), warn: (m) => warnings.push(m),
  });
  watchers.push(watcher);
  return { watcher, batches };
}

test("a source write yields a batch; ignored files yield none; close stops events", async () => {
  const warnings: string[] = [];
  const { watcher, batches } = create([fixture.root], warnings);
  watcher.start();
  assert.deepEqual(watcher.roots, [fixture.root]);
  assert.ok(warnings.includes(`domra: Watching ${fixture.root}`));

  writeFileSync(fixture.path("node_modules/x.ts"), "export {};\n");
  writeFileSync(fixture.path("notes.md"), "notes\n");
  await delay(300);
  assert.equal(batches.length, 0);

  writeFileSync(fixture.path("src/a.ts"), "export const a = 1;\n");
  await until(() => batches.length > 0);
  assert.ok(batches[0]!.paths.has(normalizePath(fixture.path("src/a.ts"))), [...batches[0]!.paths].join(","));

  watcher.close();
  const count = batches.length;
  mkdirSync(fixture.path("src"), { recursive: true });
  writeFileSync(fixture.path("src/b.ts"), "export const b = 1;\n");
  await delay(300);
  assert.equal(batches.length, count);
});

test("fs.watch event type for a new file", async () => {
  const types: string[] = [];
  const raw = watch(fixture.root, { recursive: true }, (type, name) => {
    if (String(name).endsWith("fresh.ts")) types.push(type);
  });
  try {
    writeFileSync(fixture.path("src/fresh.ts"), "export {};\n");
    await until(() => types.length > 0);
    console.log(`watcher.test: new file produced fs.watch events: ${types.join(",")}`);
  } finally {
    raw.close();
  }
});

test("a missing root is reported and start does not throw", () => {
  const warnings: string[] = [];
  const { watcher } = create([fixture.path("does-not-exist")], warnings);
  watcher.start();
  assert.ok(warnings.some((m) => m.includes("watch root missing")), warnings.join("\n"));
  assert.deepEqual(watcher.roots, []);
});

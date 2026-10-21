import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { IndexStore } from "../../src/index/index.ts";
import { WorkspaceManager } from "../../src/workspace/index.ts";
import { applyChanges } from "../../src/watcher/apply.ts";
import type { ChangeBatch } from "../../src/watcher/debounce.ts";
import { PendingRefreshes } from "../../src/watcher/pending.ts";
import { withFixture } from "../fixtures.ts";
import { SINGLE } from "../workspace/projects.ts";

const IGNORED = ["node_modules", ".git", "dist", "build", "out", "coverage"];
const APP = { compilerOptions: { types: [] }, include: ["src"] };

async function withManager(
  run: (s: { root: string; manager: WorkspaceManager; apply(batch: ChangeBatch): ReturnType<typeof applyChanges> }) => void,
): Promise<void> {
  await withFixture({ ...SINGLE, ".git/HEAD": "ref: refs/heads/main\n" }, (fixture) => {
    const manager = new WorkspaceManager({ roots: [fixture.root], ignoredFolders: IGNORED });
    manager.discover();
    const store = IndexStore.open(":memory:");
    const pending = new PendingRefreshes();
    try {
      run({
        root: fixture.root,
        manager,
        apply: (batch) => applyChanges({ manager, store, pending, ignoredFolders: IGNORED, roots: [fixture.root], warn: () => {} }, batch),
      });
    } finally {
      store.close();
    }
  });
}

test("a git batch still registers a tsconfig that appeared with it", async () => {
  await withManager(({ root, manager, apply }) => {
    mkdirSync(`${root}/copy/src`, { recursive: true });
    writeFileSync(`${root}/copy/src/a.ts`, "export class Copy {}\n");
    writeFileSync(`${root}/copy/tsconfig.json`, JSON.stringify(APP));
    const report = apply({ paths: new Set([`${root}/.git/HEAD`, `${root}/copy/tsconfig.json`]), overflowed: false });
    assert.deepEqual(report.discovered, [`${root}/copy/tsconfig.json`]);
    assert.ok(manager.isRegistered(`${root}/copy/tsconfig.json`));
    assert.equal(manager.resolveSolution(`${root}/copy/tsconfig.json`), null);
  });
});

test("an overflowed batch re-discovers solutions under the roots", async () => {
  await withManager(({ root, manager, apply }) => {
    mkdirSync(`${root}/late/src`, { recursive: true });
    writeFileSync(`${root}/late/src/a.ts`, "export class Late {}\n");
    writeFileSync(`${root}/late/tsconfig.json`, JSON.stringify(APP));
    assert.ok(!manager.isRegistered(`${root}/late/tsconfig.json`));
    const report = apply({ paths: new Set(), overflowed: true });
    assert.deepEqual(report.discovered, [`${root}/late/tsconfig.json`]);
    assert.ok(manager.isRegistered(`${root}/late/tsconfig.json`));
  });
});

test("a scanned directory registers the solutions inside it", async () => {
  await withManager(({ root, manager, apply }) => {
    mkdirSync(`${root}/dropped/inner/src`, { recursive: true });
    writeFileSync(`${root}/dropped/inner/src/a.ts`, "export class Dropped {}\n");
    writeFileSync(`${root}/dropped/inner/tsconfig.json`, JSON.stringify(APP));
    const report = apply({ paths: new Set(), overflowed: false, directories: new Set([`${root}/dropped`]) });
    assert.deepEqual(report.discovered, [`${root}/dropped/inner/tsconfig.json`]);
  });
});


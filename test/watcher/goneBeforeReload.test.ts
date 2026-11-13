import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { IndexStore } from "../../src/index/index.ts";
import { indexSolution, WorkspaceManager } from "../../src/workspace/index.ts";
import { applyChanges, forgetMissing } from "../../src/watcher/apply.ts";
import { PendingRefreshes } from "../../src/watcher/pending.ts";
import type { Fixture } from "../fixtures.ts";
import { withFixture } from "../fixtures.ts";
import { INHERIT, SINGLE } from "../workspace/projects.ts";

const IGNORED = ["node_modules", ".git", "dist", "build", "out", "coverage"];

function remove(fixture: Fixture, folder: string): void {
  rmSync(fixture.path(folder), { recursive: true, force: true, maxRetries: 5 });
}

function projectRows(store: IndexStore, path: string): number {
  return store.deleteSolution(path);
}

async function withLoaded(
  body: (fixture: Fixture, manager: WorkspaceManager, store: IndexStore, warnings: string[]) => void,
): Promise<void> {
  await withFixture({ ...SINGLE, ...INHERIT }, (fixture) => {
    const manager = new WorkspaceManager({ roots: [fixture.root], ignoredFolders: IGNORED });
    manager.discover();
    const store = IndexStore.open(":memory:");
    try {
      for (const hint of ["single", "inherit"]) indexSolution(store, manager.load(hint), { ignoredFolders: IGNORED });
      body(fixture, manager, store, []);
    } finally {
      store.close();
    }
  });
}

const context = (manager: WorkspaceManager, store: IndexStore, warn: (m: string) => void) =>
  ({ manager, store, pending: new PendingRefreshes(), ignoredFolders: IGNORED, warn });

test("reconcile: a solution whose tsconfig vanishes after forgetMissing is forgotten, not reloaded", async () => {
  await withLoaded((fixture, manager, store, warnings) => {
    const gone = fixture.path("single/tsconfig.json");
    const other = fixture.path("inherit/tsconfig.json");
    assert.equal(manager.loadedSolutions[0]!.name, "single", "the forgotten solution comes first");
    mkdirSync(fixture.path("inherit/extra"), { recursive: true });
    writeFileSync(fixture.path("inherit/extra/more.ts"), "export class MoreStuff {}\n");
    writeFileSync(
      fixture.path("inherit/tsconfig.json"),
      JSON.stringify({ compilerOptions: { types: [] }, include: ["src", "extra"] }),
    );
    const warn = (message: string): void => {
      warnings.push(message);
      if (message.startsWith("domra: Git HEAD changed")) remove(fixture, "single");
    };
    const report = applyChanges(context(manager, store, warn), { paths: new Set([`${fixture.root}/.git/HEAD`]), overflowed: false });
    assert.deepEqual(report.reloaded, ["inherit"]);
    assert.deepEqual(report.forgotten, ["single"]);
    assert.ok(!report.reloaded.includes("single"));
    assert.equal(manager.isRegistered(gone), false);
    assert.equal(manager.resolveSolution(gone), null);
    assert.equal(projectRows(store, gone), 0);
    assert.ok(manager.isRegistered(other));
    assert.ok(warnings.some((w) => w.startsWith("domra: forgot single (") && w.includes("tsconfig is gone")), warnings.join("\n"));
  });
});

test("project path: a solution whose tsconfig vanishes during the first reload is forgotten, not reloaded", async () => {
  await withLoaded((fixture, manager, store, warnings) => {
    const first = fixture.path("single/tsconfig.json");
    const second = fixture.path("inherit/tsconfig.json");
    let fired = false;
    manager.onLoad = () => {
      if (fired) return;
      fired = true;
      remove(fixture, "inherit");
    };
    const report = applyChanges(context(manager, store, (m) => void warnings.push(m)), {
      paths: new Set([first, second]), overflowed: false,
    });
    assert.deepEqual(report.reloaded, ["single"]);
    assert.deepEqual(report.forgotten, ["inherit"]);
    assert.equal(manager.isRegistered(second), false);
    assert.equal(manager.resolveSolution(second), null);
    assert.equal(projectRows(store, second), 0);
    assert.ok(projectRows(store, first) > 0);
  });
});

test("forgetMissing still forgets a solution whose tsconfig was gone before the batch, one line per solution", async () => {
  await withLoaded((fixture, manager, store, warnings) => {
    remove(fixture, "single");
    const names = forgetMissing(manager, store, new PendingRefreshes(), (m) => void warnings.push(m));
    assert.deepEqual(names, ["single"]);
    const lines = warnings.filter((w) => w.includes("tsconfig is gone"));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^domra: forgot single \(.*\): tsconfig is gone, [1-9]\d* projects removed from the index$/);
    assert.equal(manager.isRegistered(fixture.path("single/tsconfig.json")), false);
  });
});

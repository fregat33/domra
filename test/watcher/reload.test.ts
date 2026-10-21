import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { IndexStore } from "../../src/index/index.ts";
import { indexSolution, WorkspaceManager } from "../../src/workspace/index.ts";
import { applyChanges } from "../../src/watcher/apply.ts";
import { PendingRefreshes } from "../../src/watcher/pending.ts";
import { withFixture } from "../fixtures.ts";
import { INHERIT, SINGLE } from "../workspace/projects.ts";

const IGNORED = ["node_modules", ".git", "dist", "build", "out", "coverage"];

test("an overflowed batch reloads only the solutions whose project files changed", async () => {
  await withFixture({ ...SINGLE, ...INHERIT }, (fixture) => {
    const manager = new WorkspaceManager({ roots: [fixture.root], ignoredFolders: IGNORED });
    manager.discover();
    const store = IndexStore.open(":memory:");
    try {
      for (const hint of ["single", "inherit"]) indexSolution(store, manager.load(hint), { ignoredFolders: IGNORED });
      const reloads: string[] = [];
      manager.onLoad = (solution) => void reloads.push(solution.name);
      const apply = (): ReturnType<typeof applyChanges> =>
        applyChanges(
          { manager, store, pending: new PendingRefreshes(), ignoredFolders: IGNORED, warn: () => {} },
          { paths: new Set(), overflowed: true },
        );

      const untouched = apply();
      assert.deepEqual(untouched.reloaded, []);
      assert.deepEqual(reloads, []);

      mkdirSync(fixture.path("single/extra"), { recursive: true });
      writeFileSync(fixture.path("single/extra/more.ts"), "export class MoreStuff {}\n");
      writeFileSync(
        fixture.path("single/tsconfig.json"),
        JSON.stringify({ compilerOptions: { types: [] }, include: ["src", "extra"] }),
      );
      const report = apply();
      assert.deepEqual(report.reloaded, ["single"]);
      assert.deepEqual(reloads, ["single"]);
      assert.equal(store.searchSymbols("MoreStuff", null, 10).length, 1);

      assert.deepEqual(apply().reloaded, [], "the new load recorded the new stamps");
      assert.deepEqual(reloads, ["single"]);
    } finally {
      store.close();
    }
  });
});

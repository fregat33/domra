import { readFileSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexStore } from "../../src/index/index.ts";
import { indexSolution, normalizePath, packageOf, WorkspaceManager } from "../../src/workspace/index.ts";
import type { LoadedSolution } from "../../src/workspace/index.ts";
import { applyChanges } from "../../src/watcher/apply.ts";
import { PendingRefreshes } from "../../src/watcher/pending.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { SEARCH, SINGLE } from "../workspace/projects.ts";

const IGNORED = ["node_modules", ".git", "dist", "build", "out", "coverage"];

type Setup = {
  fixture: Fixture;
  manager: WorkspaceManager;
  store: IndexStore;
  pending: PendingRefreshes;
  solution: LoadedSolution;
  warnings: string[];
  apply(...paths: string[]): ReturnType<typeof applyChanges>;
};

async function withSetup(run: (s: Setup) => void | Promise<void>): Promise<void> {
  const fixture = writeFixture({ ...SINGLE, ...SEARCH });
  const manager = new WorkspaceManager({ roots: [fixture.root], ignoredFolders: IGNORED });
  manager.discover();
  const store = IndexStore.open(":memory:");
  const pending = new PendingRefreshes();
  const warnings: string[] = [];
  try {
    const solution = manager.load("single");
    indexSolution(store, solution, { ignoredFolders: IGNORED });
    await run({
      fixture, manager, store, pending, solution, warnings,
      apply: (...paths) =>
        applyChanges(
          { manager, store, pending, ignoredFolders: IGNORED, warn: (m) => warnings.push(m) },
          { paths: new Set(paths.map((p) => normalizePath(fixture.path(p)))), overflowed: false },
        ),
    });
  } finally {
    store.close();
    fixture.remove();
  }
}

test("an edited source file reaches the host and the index", async () => {
  await withSetup(({ fixture, solution, store, apply, warnings }) => {
    const file = fixture.path("single/src/shapes.ts");
    writeFileSync(file, `${readFileSync(file, "utf8")}export class Hexagon {}\n`);
    const report = apply("single/src/shapes.ts");
    assert.equal(report.applied, 1);
    assert.ok(solution.projects[0]!.host.getText(file)?.includes("Hexagon"));
    assert.equal(store.searchSymbols("Hexagon", null, 10).length, 1);
    assert.ok(warnings.some((m) => m.startsWith("domra: single: applied 1 file changes")), warnings.join("\n"));
  });
});

test("a project file in the batch resets the package cache", async () => {
  await withSetup(({ fixture, apply }) => {
    const manifest = fixture.path("single/package.json");
    const file = fixture.path("single/src/shapes.ts");
    assert.equal(packageOf(file)?.version, "1.0.0");
    writeFileSync(manifest, JSON.stringify({ name: "single-pkg", version: "2.0.0" }));
    assert.equal(packageOf(file)?.version, "1.0.0");
    apply("single/package.json");
    assert.equal(packageOf(file)?.version, "2.0.0");
  });
});

test("a new file becomes a root and is indexed", async () => {
  await withSetup(({ fixture, solution, store, apply }) => {
    const file = fixture.path("single/src/extra.ts");
    writeFileSync(file, "export class Extra {}\n");
    const report = apply("single/src/extra.ts");
    assert.equal(report.added, 1);
    const project = solution.projects[0]!;
    assert.ok(project.fileKeys.has(file.toLowerCase()) || project.fileNames.includes(file));
    assert.ok(project.host.getScriptFileNames().includes(file));
    assert.equal(store.searchSymbols("Extra", null, 10).length, 1);
  });
});

test("a deleted file leaves the roots and the index", async () => {
  await withSetup(({ fixture, solution, store, apply }) => {
    const file = fixture.path("single/src/widget.ts");
    assert.ok(store.getFileSymbols(file).length > 0);
    rmSync(file);
    const report = apply("single/src/widget.ts");
    assert.equal(report.removed, 1);
    assert.ok(!solution.projects[0]!.host.getScriptFileNames().includes(file));
    assert.deepEqual(store.getFileSymbols(file), []);
  });
});

test("a tsconfig change reloads the solution", async () => {
  await withSetup(({ fixture, manager, apply }) => {
    const report = apply("single/tsconfig.json");
    assert.deepEqual(report.reloaded, ["single"]);
    assert.ok(manager.resolveSolution(fixture.path("single/tsconfig.json")) !== null);
  });
});

test("a HEAD change reconciles loaded solutions by mtime and size", async () => {
  await withSetup(({ fixture, solution, apply, warnings }) => {
    const file = fixture.path("single/src/main.ts");
    writeFileSync(file, `${readFileSync(file, "utf8")}export const switched = true;\n`);
    const report = apply("single/.git/HEAD");
    assert.deepEqual(report.reconciled, ["single"]);
    assert.ok(report.applied >= 1);
    assert.ok(solution.projects[0]!.host.getText(file)?.includes("switched"));
    assert.ok(warnings.some((m) => m.startsWith("domra: Git HEAD changed; reconciling 1 loaded solutions")));
    assert.ok(warnings.some((m) => m.startsWith("domra: Reconciled single:")));
  });
});

test("a change under an unloaded solution is recorded as pending", async () => {
  await withSetup(({ fixture, manager, pending, apply }) => {
    const demo = manager.findRegistered("demo")!;
    writeFileSync(fixture.path("demo/src/newthing.ts"), "export class NewThing {}\n");
    const report = apply("demo/src/newthing.ts");
    assert.deepEqual(report.pendingTouched, [demo.path]);
    assert.equal(pending.entries().length, 1);
    assert.equal(report.applied + report.added + report.removed, 0);
  });
});

import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexStore } from "../../src/index/index.ts";
import type { LoadedSolution } from "../../src/workspace/index.ts";
import {
  indexSolution, normalizePath, referencingProjects, WorkspaceManager, withTransitiveDependents,
} from "../../src/workspace/index.ts";
import { applyChanges } from "../../src/watcher/apply.ts";
import { PendingRefreshes } from "../../src/watcher/pending.ts";
import type { Fixture, FixtureFiles } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";

const IGNORED = ["node_modules", ".git", "dist", "build", "out", "coverage"];
const OPTIONS = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, types: [], composite: true, rootDir: "src", outDir: "dist" };

const project = (references: string[] = []): object => ({
  compilerOptions: OPTIONS, include: ["src"], references: references.map((path) => ({ path })),
});

const LIB_V1 = "export function foo(): number {\n  return 1;\n}\n";
const LIB_BODY = "export function foo(): number {\n  return 2;\n}\n";
const LIB_RENAMED = "export function bar(): number {\n  return 1;\n}\n";

const FILES: FixtureFiles = {
  "ws/tsconfig.json": { files: [], references: [{ path: "./lib" }, { path: "./mid" }, { path: "./app" }, { path: "./unrelated" }] },
  "ws/lib/tsconfig.json": project(),
  "ws/lib/package.json": { name: "lib-pkg" },
  "ws/lib/src/index.ts": LIB_V1,
  "ws/mid/tsconfig.json": project(["../lib"]),
  "ws/mid/package.json": { name: "mid-pkg" },
  "ws/mid/src/index.ts": 'import { foo } from "../../lib/src/index";\nexport const mid = foo();\n',
  "ws/app/tsconfig.json": project(["../mid"]),
  "ws/app/package.json": { name: "app-pkg" },
  "ws/app/src/main.ts": 'import { foo } from "../../lib/src/index";\nexport const app = foo();\n',
  "ws/unrelated/tsconfig.json": project(),
  "ws/unrelated/package.json": { name: "unrelated-pkg" },
  "ws/unrelated/src/index.ts": "export const unrelated = 1;\n",
  "other/tsconfig.json": project(),
  "other/package.json": { name: "other-pkg", dependencies: { "lib-pkg": "*" } },
  "other/src/main.ts": 'import { foo } from "../../ws/lib/src/index";\nexport const other = foo();\n',
  "solo/tsconfig.json": project(),
  "solo/package.json": { name: "solo-pkg" },
  "solo/src/main.ts": 'import { foo } from "../../ws/lib/src/index";\nexport const solo = foo();\n',
};

type Setup = {
  fixture: Fixture;
  store: IndexStore;
  ws: LoadedSolution;
  other: LoadedSolution;
  solo: LoadedSolution;
  warnings: string[];
  /** Targets of the stored references of a project's file. */
  refs(solution: LoadedSolution, name: string, file: string): string[];
  apply(reextractDependents: boolean | undefined, ...paths: string[]): ReturnType<typeof applyChanges>;
};

async function withSetup(run: (s: Setup) => void | Promise<void>, files: FixtureFiles = FILES): Promise<void> {
  const fixture = writeFixture(files);
  const manager = new WorkspaceManager({ roots: [fixture.root], ignoredFolders: IGNORED });
  manager.discover();
  const store = IndexStore.open(":memory:");
  const pending = new PendingRefreshes();
  const warnings: string[] = [];
  try {
    const [ws, other, solo] = ["ws", "other", "solo"].map((name) => manager.load(name)) as [LoadedSolution, LoadedSolution, LoadedSolution];
    for (const solution of [ws, other, solo]) indexSolution(store, solution, { ignoredFolders: IGNORED });
    await run({
      fixture, store, ws, other, solo, warnings,
      refs: (solution, name, file) => {
        const loaded = solution.projects.find((p) => p.name === name)!;
        const id = store.getProject(loaded.tsconfig)!.id;
        const entry = store.getTreeEntry(id, normalizePath(fixture.path(file)))!;
        return store.readExtraction(id, entry.contentHash)!.references.map((r) => r.targetDocId);
      },
      apply: (reextractDependents, ...paths) =>
        applyChanges(
          { manager, store, pending, ignoredFolders: IGNORED, reextractDependents, warn: (m) => warnings.push(m) },
          { paths: new Set(paths.map((p) => normalizePath(fixture.path(p)))), overflowed: false },
        ),
    });
  } finally {
    store.close();
    fixture.remove();
  }
}

const usesFoo = (targets: string[]): boolean => targets.some((t) => t.includes("foo"));

test("renaming an export refreshes the stored references of projects that depend on it", async () => {
  await withSetup(({ fixture, store, ws, refs, apply, warnings }) => {    assert.ok(usesFoo(refs(ws, "app-pkg", "ws/app/src/main.ts")));
    writeFileSync(fixture.path("ws/lib/src/index.ts"), LIB_RENAMED);
    const report = apply(undefined, "ws/lib/src/index.ts");
    assert.equal(report.extracted, 1);
    // ws: lib, mid and app (one document each; `unrelated` is left alone) + `other` (2: its own file and the
    // lib file it claims, as no project of that solution owns it); `solo` is not linked.
    assert.equal(report.reextracted, 5);
    assert.ok(!usesFoo(refs(ws, "app-pkg", "ws/app/src/main.ts")), "app must not resolve to the old target");
    assert.ok(!usesFoo(refs(ws, "mid-pkg", "ws/mid/src/index.ts")));
    // Two rows: the lib project's, and the copy of the same file that `other` claims in its own tree.
    assert.equal(store.searchSymbols("bar", null, 10).length, 2);
    assert.ok(warnings.some((m) => /^domra: Re-extracted 3 documents of 3 dependent projects in ws in \d+ms$/.test(m)), warnings.join("\n"));
  });
});

test("a body-only edit extracts one document and re-extracts nothing", async () => {
  await withSetup(({ fixture, refs, ws, apply, warnings }) => {
    writeFileSync(fixture.path("ws/lib/src/index.ts"), LIB_BODY);
    const report = apply(undefined, "ws/lib/src/index.ts");
    assert.equal(report.extracted, 1);
    assert.equal(report.reextracted, 0);
    assert.ok(usesFoo(refs(ws, "app-pkg", "ws/app/src/main.ts")));
    assert.ok(!warnings.some((m) => m.includes("Re-extracted")));
  });
});

test("reextractDependents: false leaves dependents stale", async () => {
  await withSetup(({ fixture, refs, ws, apply, warnings }) => {
    writeFileSync(fixture.path("ws/lib/src/index.ts"), LIB_RENAMED);
    const report = apply(false, "ws/lib/src/index.ts");
    assert.equal(report.reextracted, 0);
    assert.ok(usesFoo(refs(ws, "app-pkg", "ws/app/src/main.ts")));
    assert.ok(!warnings.some((m) => m.includes("Re-extracted")));
  });
});

test("a loaded solution consuming the package is re-extracted; an unlinked one is not", async () => {
  await withSetup(({ fixture, refs, other, solo, apply, warnings }) => {
    assert.ok(usesFoo(refs(other, "other-pkg", "other/src/main.ts")));
    assert.ok(usesFoo(refs(solo, "solo-pkg", "solo/src/main.ts")));
    writeFileSync(fixture.path("ws/lib/src/index.ts"), LIB_RENAMED);
    const report = apply(undefined, "ws/lib/src/index.ts");
    assert.equal(report.reextracted, 5);
    assert.ok(!usesFoo(refs(other, "other-pkg", "other/src/main.ts")));
    assert.ok(usesFoo(refs(solo, "solo-pkg", "solo/src/main.ts")));
    assert.ok(warnings.some((m) => /^domra: Re-extracted 2 documents of 1 dependent projects in other in \d+ms$/.test(m)), warnings.join("\n"));
    assert.ok(!warnings.some((m) => m.includes("Re-extracted") && m.includes("in solo")));
  });
});

test("dependency helpers: transitive closure, package and tsconfig seeds", async () => {
  await withSetup(({ ws, other, solo }) => {
    assert.deepEqual(withTransitiveDependents(ws, ["lib-pkg"]), ["app-pkg", "lib-pkg", "mid-pkg"]);
    assert.deepEqual(withTransitiveDependents(ws, ["mid-pkg"]), ["app-pkg", "mid-pkg"]);
    assert.deepEqual(withTransitiveDependents(ws, ["unrelated-pkg"]), ["unrelated-pkg"]);
    assert.deepEqual(referencingProjects(other, ["lib-pkg"], []), ["other-pkg"]);
    assert.deepEqual(referencingProjects(solo, ["lib-pkg"], []), []);
    assert.deepEqual(referencingProjects(solo, [], [solo.projects[0]!.tsconfig]), ["solo-pkg"]);
  });
});

test("a reference cycle terminates", async () => {
  const files: FixtureFiles = {
    ...FILES,
    "ws/lib/tsconfig.json": project(["../app"]),
  };
  await withSetup(({ fixture, ws, refs, apply }) => {
    assert.deepEqual(withTransitiveDependents(ws, ["lib-pkg"]), ["app-pkg", "lib-pkg", "mid-pkg"]);
    writeFileSync(fixture.path("ws/lib/src/index.ts"), LIB_RENAMED);
    const report = apply(undefined, "ws/lib/src/index.ts");
    assert.ok(report.reextracted >= 3);
    assert.ok(!usesFoo(refs(ws, "app-pkg", "ws/app/src/main.ts")));
  }, files);
});

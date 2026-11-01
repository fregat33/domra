import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { IndexStore } from "../../src/index/index.ts";
import { indexSolution, WorkspaceManager } from "../../src/workspace/index.ts";
import { applyChanges } from "../../src/watcher/apply.ts";
import type { ChangeBatch } from "../../src/watcher/debounce.ts";
import { PendingRefreshes } from "../../src/watcher/pending.ts";
import { withFixture } from "../fixtures.ts";

const IGNORED = ["node_modules", ".git", "dist", "build", "out", "coverage"];
const APP = { compilerOptions: { types: [] }, include: ["src"] };

type Env = {
  base: string;
  roots: string[];
  manager: WorkspaceManager;
  store: IndexStore;
  warnings: string[];
  apply(batch: Partial<ChangeBatch> & { paths?: Set<string> }): ReturnType<typeof applyChanges>;
};

/** Roots `<base>/root` (solution `a`), `<base>/root2` (solution `b`), both loaded and indexed. */
async function withEnv(run: (env: Env) => void, rootNames = ["root", "root2"], load = true): Promise<void> {
  const files: Record<string, unknown> = {};
  const names = ["a", "b"];
  rootNames.forEach((r, i) => {
    files[`${r}/${names[i]}/tsconfig.json`] = APP;
    files[`${r}/${names[i]}/src/x.ts`] = `export class ${names[i]!.toUpperCase()}0 {}\n`;
  });
  await withFixture(files as never, (fixture) => {
    const roots = rootNames.map((r) => `${fixture.root}/${r}`);
    const manager = new WorkspaceManager({ roots, ignoredFolders: IGNORED });
    manager.discover();
    const store = IndexStore.open(":memory:");
    const pending = new PendingRefreshes();
    const warnings: string[] = [];
    try {
      if (load) for (const n of names.slice(0, rootNames.length)) indexSolution(store, manager.load(n), { ignoredFolders: IGNORED });
      run({
        base: fixture.root, roots, manager, store, warnings,
        apply: (batch) =>
          applyChanges(
            { manager, store, pending, ignoredFolders: IGNORED, roots, warn: (m) => warnings.push(m) },
            { paths: new Set(), overflowed: false, ...batch },
          ),
      });
    } finally {
      store.close();
    }
  });
}

const scoped = (...roots: string[]): Partial<ChangeBatch> => ({ overflowed: true, overflowedRoots: new Set(roots) });

test("an overflow on one root reconciles only that root; a path under another root is applied", async () => {
  await withEnv(({ base, roots, store, apply, warnings }) => {
    writeFileSync(`${base}/root/a/src/x.ts`, "export class A0 {}\nexport class AlphaNew {}\n");
    writeFileSync(`${base}/root2/b/src/x.ts`, "export class B0 {}\nexport class BetaNew {}\n");
    const report = apply({ ...scoped(roots[0]!), paths: new Set([`${base}/root2/b/src/x.ts`]) });
    assert.deepEqual(report.reconciled, ["a"]);
    assert.equal(report.applied, 2);
    assert.equal(store.searchSymbols("AlphaNew", null, 10).length, 1);
    assert.equal(store.searchSymbols("BetaNew", null, 10).length, 1);
    assert.ok(warnings.includes(`domra: File watcher overflow under ${roots[0]}; scheduling reconcile of that root`), warnings.join("\n"));
  });
});

test("a path under the overflowed root does not produce a second application", async () => {
  await withEnv(({ base, roots, apply }) => {
    writeFileSync(`${base}/root/a/src/x.ts`, "export class A0 {}\nexport class AlphaNew {}\n");
    const report = apply({ ...scoped(roots[0]!), paths: new Set([`${base}/root/a/src/x.ts`]) });
    assert.deepEqual(report.reconciled, ["a"]);
    assert.equal(report.applied, 1);
  });
});

test("the rescan discovers a tsconfig under the overflowed root only", async () => {
  await withEnv(({ base, roots, manager, apply }) => {
    for (const r of ["root", "root2"]) {
      mkdirSync(`${base}/${r}/late/src`, { recursive: true });
      writeFileSync(`${base}/${r}/late/src/a.ts`, "export class Late {}\n");
      writeFileSync(`${base}/${r}/late/tsconfig.json`, JSON.stringify(APP));
    }
    const report = apply(scoped(roots[0]!));
    assert.deepEqual(report.discovered, [`${base}/root/late/tsconfig.json`]);
    assert.ok(!manager.isRegistered(`${base}/root2/late/tsconfig.json`));
    const second = apply({ directories: new Set([`${base}/root2/late`]) });
    assert.deepEqual(second.discovered, [`${base}/root2/late/tsconfig.json`]);
  });
});

test("a sibling root sharing a name prefix is not under the overflowed root", async () => {
  await withEnv(({ base, roots, apply }) => {
    writeFileSync(`${base}/root2/b/src/x.ts`, "export class B0 {}\nexport class BetaNew {}\n");
    const report = apply(scoped(roots[0]!));
    assert.deepEqual(report.reconciled, ["a"]);
    assert.equal(report.applied, 0);
    const other = apply(scoped(roots[1]!));
    assert.deepEqual(other.reconciled, ["b"]);
    assert.equal(other.applied, 1);
  });
});

test("unloaded solutions are touched only under the overflowed root", async () => {
  await withEnv(({ roots, apply }) => {
    const report = apply(scoped(roots[1]!));
    assert.deepEqual(report.reconciled, []);
    assert.equal(report.pendingTouched.length, 1);
    assert.ok(report.pendingTouched[0]!.includes("/root2/"), report.pendingTouched.join());
  }, ["root", "root2"], false);
});

test("a global overflow and a git event with a per-root overflow reconcile everything", async () => {
  await withEnv(({ base, roots, apply }) => {
    const global = apply({ overflowed: true, overflowedGlobally: true, overflowedRoots: new Set([roots[0]!]) });
    assert.deepEqual(global.reconciled.sort(), ["a", "b"]);
    const git = apply({ ...scoped(roots[0]!), paths: new Set([`${base}/root/.git/HEAD`]) });
    assert.deepEqual(git.reconciled.sort(), ["a", "b"]);
    const legacy = apply({ overflowed: true });
    assert.deepEqual(legacy.reconciled.sort(), ["a", "b"]);
  });
});

import assert from "node:assert/strict";
import { utimesSync } from "node:fs";
import { test } from "node:test";
import { WorkspaceManager } from "../../src/workspace/index.ts";
import { loadSolution } from "../../src/workspace/solution.ts";
import { describeSolution } from "../../src/workspace/discovery.ts";
import { withFixture } from "../fixtures.ts";
import { SINGLE } from "./projects.ts";

const IGNORED = ["node_modules", ".git", "dist", "build", "out", "coverage"];

function shift(path: string, seconds: number): void {
  const when = new Date(Date.now() + seconds * 1000);
  utimesSync(path, when, when);
}

/** Every project file of SINGLE gets an old mtime, so nothing counts as written during a load. */
function age(fixture: { path(relative: string): string }): void {
  shift(fixture.path("single/tsconfig.json"), -60);
  shift(fixture.path("single/package.json"), -60);
}

test("loadSolution lists project files written at or after the load start", async () => {
  await withFixture(SINGLE, (fixture) => {
    age(fixture);
    const tsconfig = fixture.path("single/tsconfig.json");
    const solution = describeSolution(tsconfig);
    const before = Date.now();
    const clean = loadSolution(solution);
    const after = Date.now();
    assert.deepEqual(clean.changedDuringLoad, []);
    assert.ok(clean.loadStartedMs >= before && clean.loadStartedMs <= after);
    for (const project of clean.projects) project.service.dispose();

    shift(tsconfig, 60);
    const touched = loadSolution(solution);
    assert.deepEqual(touched.changedDuringLoad, [solution.path]);
    for (const project of touched.projects) project.service.dispose();
  });
});

function setup(fixture: { root: string; path(relative: string): string }, loaderFor: (calls: () => number) => (path: string) => void) {
  age(fixture);
  const tsconfig = fixture.path("single/tsconfig.json");
  const manager = new WorkspaceManager({ roots: [fixture.root], ignoredFolders: IGNORED });
  manager.discover();
  let calls = 0;
  const touch = loaderFor(() => calls);
  manager.loader = (solution, registry) => {
    calls++;
    touch(tsconfig);
    return loadSolution(solution, registry);
  };
  const warnings: string[] = [];
  manager.onWarn = (message) => void warnings.push(message);
  let loads = 0;
  manager.onLoad = () => void loads++;
  return { manager, warnings, calls: () => calls, loads: () => loads, tsconfig };
}

const firstOnly = (calls: () => number) => (path: string): void => shift(path, calls() === 1 ? 60 : -60);

test("a load that saw a project file written is repeated once", async () => {
  await withFixture(SINGLE, (fixture) => {
    const { manager, warnings, calls, loads } = setup(fixture, firstOnly);
    const result = manager.load("single");
    assert.equal(calls(), 2);
    assert.equal(loads(), 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /loading once more/);
    assert.deepEqual(result.changedDuringLoad, []);
    assert.equal(manager.loadedSolutions.length, 1);
  });
});

test("a second load that still saw a write is kept", async () => {
  await withFixture(SINGLE, (fixture) => {
    const { manager, warnings, calls } = setup(fixture, () => (path) => shift(path, 60));
    const result = manager.load("single");
    assert.equal(calls(), 2);
    assert.equal(warnings.length, 2);
    assert.match(warnings[1] ?? "", /keeping the second load/);
    assert.equal(manager.loadedSolutions.length, 1);
    assert.equal(manager.loadedSolutions[0], result);
  });
});

test("an untouched fixture is loaded once, silently, and a second load is a cache hit", async () => {
  await withFixture(SINGLE, (fixture) => {
    const { manager, warnings, calls } = setup(fixture, () => () => {});
    manager.load("single");
    assert.equal(calls(), 1);
    assert.deepEqual(warnings, []);
    manager.load("single");
    assert.equal(calls(), 1);
  });
});

test("reload repeats the load too and keeps lastUsed", async () => {
  await withFixture(SINGLE, (fixture) => {
    let clock = 1000;
    const { manager, tsconfig } = setup(fixture, () => () => {});
    manager.now = () => clock;
    const first = manager.load("single");
    clock = 5000;
    // from here on the loader writes the file on the first call of the reload only
    let reloadCalls = 0;
    manager.loader = (solution, registry) => {
      reloadCalls++;
      shift(tsconfig, reloadCalls === 1 ? 60 : -60);
      return loadSolution(solution, registry);
    };
    const before = manager.lastUsedAt(first.path);
    assert.equal(before, 1000);
    manager.reload("single");
    assert.equal(reloadCalls, 2);
    assert.equal(manager.lastUsedAt(first.path), before);
  });
});

test("an error of the second load is thrown and nothing stays loaded", async () => {
  await withFixture(SINGLE, (fixture) => {
    const { manager } = setup(fixture, () => () => {});
    let calls = 0;
    manager.loader = (solution, registry) => {
      calls++;
      if (calls === 2) throw new Error("second load broke");
      shift(fixture.path("single/tsconfig.json"), 60);
      return loadSolution(solution, registry);
    };
    assert.throws(() => manager.load("single"), /second load broke/);
    assert.equal(calls, 2);
    assert.deepEqual(manager.loadedSolutions, []);
  });
});

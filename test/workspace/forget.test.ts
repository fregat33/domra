import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexStore } from "../../src/index/index.ts";
import { normalizePath } from "../../src/workspace/discovery.ts";
import { indexSolution } from "../../src/workspace/indexer.ts";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import { withFixture } from "../fixtures.ts";
import { MONO, REFS, SINGLE } from "./projects.ts";

test("forget unloads and unregisters one solution and leaves the others", () =>
  withFixture({ ...SINGLE, ...MONO }, (fx) => {
    const manager = new WorkspaceManager({ roots: [fx.root] });
    manager.discover();
    const single = manager.register(fx.path("single/tsconfig.json"));
    manager.register(fx.path("mono/tsconfig.json"));
    manager.load("single");
    assert.equal(manager.status().length, 2);

    const forgotten = manager.forget(single.path.toUpperCase());
    assert.equal(forgotten?.path, single.path);
    assert.equal(manager.isRegistered(single.path), false);
    assert.equal(manager.resolveSolution("single"), null);
    assert.deepEqual(manager.status().map((s) => s.name), ["mono"]);
    assert.equal(manager.findRegistered("single"), null);
    assert.equal(manager.isRegistered(fx.path("mono/tsconfig.json")), true);

    assert.equal(manager.forget("single"), null);
    assert.equal(manager.forget("nothing-like-this"), null);
    assert.deepEqual(manager.status().map((s) => s.name), ["mono"]);
  }));

test("deleteSolution after a real indexSolution leaves no rows or fts hits and spares other solutions", () =>
  withFixture({ ...SINGLE, ...REFS }, (fx) => {
    const manager = new WorkspaceManager({ roots: [fx.root] });
    manager.discover();
    const store = IndexStore.open(":memory:");
    const single = manager.load("single");
    const refs = manager.load("refs");
    indexSolution(store, single);
    indexSolution(store, refs);
    const count = (sql: string): number => Number((store.db.prepare(sql).get() as { n: number }).n);
    const projects = (path: string): number =>
      count(`SELECT count(*) AS n FROM project WHERE solution_path = '${normalizePath(path)}'`);
    const symbols = (): number => count("SELECT count(*) AS n FROM symbol");
    assert.ok(store.searchSymbols("Widget", null, 10).length > 0);
    const refsProjects = projects(refs.path);
    const total = symbols();

    assert.equal(store.deleteSolution(single.path), single.projects.length);
    assert.equal(projects(single.path), 0);
    assert.equal(count("SELECT count(*) AS n FROM symbol WHERE name = 'Widget'"), 0);
    assert.equal(count("SELECT count(*) AS n FROM symbol_fts WHERE symbol_fts MATCH 'Widget'"), 0);
    assert.deepEqual(store.searchSymbols("Widget", null, 10), []);
    assert.equal(projects(refs.path), refsProjects);
    assert.ok(symbols() > 0 && symbols() < total);
    assert.ok(store.searchSymbols("Circle", null, 10).length > 0);
    store.close();
  }));

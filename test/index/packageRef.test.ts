import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexStore, SCHEMA_VERSION } from "../../src/index/index.ts";
import { indexSolution, WorkspaceManager } from "../../src/workspace/index.ts";
import { writeFixture } from "../fixtures.ts";
import { PKG, SINGLE } from "../workspace/projects.ts";

const project = (name: string, solution: string, packageName: string | null, version: string | null) => ({
  path: `/r/${solution}/${name}/tsconfig.json`, name, packageName, solutionPath: `/r/${solution}/tsconfig.json`, version,
});

test("setProjectPackages replaces the set; consumers are found ignoring case", () => {
  const store = IndexStore.open(":memory:");
  const app = store.ensureProject(project("app", "web", "app", "1.0.0"));
  store.setProjectPackages(app, [{ packageName: "acme-contracts", version: "3.1.0" }, { packageName: "left-pad", version: "1.0.0" }]);
  assert.equal(store.getPackageConsumers("acme-contracts").length, 1);
  store.setProjectPackages(app, [{ packageName: "acme-contracts", version: "3.2.0" }]);
  assert.deepEqual(store.getPackageConsumers("left-pad"), []);
  const consumers = store.getPackageConsumers("ACME-contracts");
  assert.equal(consumers.length, 1);
  assert.deepEqual(consumers[0], {
    projectId: app, projectPath: "/r/web/app/tsconfig.json", projectName: "app", solutionPath: "/r/web/tsconfig.json", version: "3.2.0",
  });
  store.close();
});

test("findPackageDrift compares consumers with the source version", () => {
  const store = IndexStore.open(":memory:");
  const source = store.ensureProject(project("contracts", "lib", "acme-contracts", "3.4.0"));
  const old = store.ensureProject(project("old", "web", "old", "1.0.0"));
  const current = store.ensureProject(project("current", "api", "current", "1.0.0"));
  store.setProjectPackages(old, [{ packageName: "acme-contracts", version: "3.1.0" }]);
  store.setProjectPackages(current, [{ packageName: "acme-contracts", version: "3.4.0" }]);
  store.setProjectPackages(source, [{ packageName: "acme-contracts", version: "3.0.0" }]);
  const rows = store.findPackageDrift();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    packageName: "acme-contracts", sourceVersion: "3.4.0", sourceProjectPath: "/r/lib/contracts/tsconfig.json",
    sourceSolutionPath: "/r/lib/tsconfig.json", consumerProjectPath: "/r/web/old/tsconfig.json", consumerProjectName: "old",
    consumerSolutionPath: "/r/web/tsconfig.json", consumedVersion: "3.1.0",
  });
  store.close();

  const bare = IndexStore.open(":memory:");
  const unversioned = bare.ensureProject(project("contracts", "lib", "acme-contracts", null));
  const consumer = bare.ensureProject(project("old", "web", "old", "1.0.0"));
  bare.setProjectPackages(consumer, [{ packageName: "acme-contracts", version: "3.1.0" }]);
  assert.ok(unversioned > 0);
  assert.deepEqual(bare.findPackageDrift(), []);
  bare.close();
});

test("a store created at schema 1 gets package_ref and is re-extracted", () => {
  assert.equal(SCHEMA_VERSION, 2);
  const fixture = writeFixture(SINGLE);
  const dbPath = fixture.path("db/index.db");
  const manager = new WorkspaceManager({ roots: [fixture.root] });
  try {
    manager.discover();
    const solution = manager.load("single");
    const first = IndexStore.open(dbPath);
    assert.ok(indexSolution(first, solution).documentsExtracted > 0);
    first.db.exec("DROP TABLE package_ref; UPDATE project SET indexed_schema = 1");
    first.close();

    const reopened = IndexStore.open(dbPath);
    assert.ok(reopened.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'package_ref'").get());
    const report = indexSolution(reopened, solution);
    assert.ok(report.documentsExtracted > 0);
    assert.equal(report.documentsReused, 0);
    assert.equal(reopened.getProject(solution.projects[0]!.tsconfig)!.indexedSchema, SCHEMA_VERSION);
    reopened.close();
  } finally {
    fixture.remove();
  }
});

test("the indexer records the package versions each project consumes", () => {
  const fixture = writeFixture(PKG);
  const manager = new WorkspaceManager({ roots: [fixture.root] });
  const store = IndexStore.open(":memory:");
  try {
    manager.discover();
    for (const name of ["libpkg", "webapp", "worker"]) {
      const started = performance.now();
      indexSolution(store, manager.load(name));
      console.log(`packageRef.test: indexed ${name} in ${Math.round(performance.now() - started)} ms`);
    }
    const consumers = store.getPackageConsumers("acme-contracts");
    assert.deepEqual(consumers.map((c) => [c.projectName, c.version]), [["webapp", "1.0.0"], ["worker", "1.1.0"]]);
    const drift = store.findPackageDrift();
    assert.equal(drift.length, 1);
    assert.equal(drift[0]!.consumerProjectName, "webapp");
    assert.equal(drift[0]!.consumedVersion, "1.0.0");
    assert.equal(drift[0]!.sourceVersion, "1.1.0");
  } finally {
    store.close();
    fixture.remove();
  }
});

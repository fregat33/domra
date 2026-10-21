import assert from "node:assert/strict";
import { test } from "node:test";
import type { Extraction, SymbolRow } from "../../src/index/index.ts";
import { IndexStore, parseDocId, SCHEMA_VERSION } from "../../src/index/index.ts";

const SLN = "/r/sln/tsconfig.json";
const OTHER = "/r/other/tsconfig.json";

function sym(docId: string, kind: string, line: number, accessibility = "export"): SymbolRow {
  const fqName = parseDocId(docId)!.fqName;
  const dot = fqName.lastIndexOf(".");
  const scope = parseDocId(docId)!.scope;
  return {
    docId, kind, name: fqName.slice(dot + 1), fqName, signature: fqName, accessibility,
    containingDocId: dot < 0 ? null : `${scope}#${fqName.slice(0, dot)}`, line, col: 14, endLine: line + 2,
  };
}

const ORDERS: Extraction = {
  symbols: [
    sym("app/src/orders#OrdersController", "class", 1),
    sym("app/src/orders#OrdersController.get", "method", 2, "public"),
    sym("app/src/orders#UpdateOrderCommand", "class", 5),
    sym("app/src/orders#RetryPolicy.createRetryOptions", "method", 8, "public"),
  ],
  references: [],
  relations: [],
};

const TESTS: Extraction = {
  symbols: [sym("app.tests/src/x#UpdateOrderCommand", "class", 1), sym("app.tests/src/x#OrdersController", "class", 3)],
  references: [],
  relations: [],
};

function seeded(fts = true): { store: IndexStore; app: number; tests: number } {
  const store = IndexStore.open(":memory:", { fts });
  const app = store.ensureProject({ path: "/r/sln/app/tsconfig.json", name: "app", packageName: "app", solutionPath: SLN, version: "1.0.0" });
  const tests = store.ensureProject({ path: "/r/sln/app.tests/tsconfig.json", name: "app.tests", packageName: null, solutionPath: SLN, version: null });
  store.writeBlob(app, "h-orders", ORDERS);
  store.setTreeEntry(app, "/r/sln/app/src/orders.ts", "h-orders", 1, 10);
  store.writeBlob(tests, "h-x", TESTS);
  store.setTreeEntry(tests, "/r/sln/app.tests/src/x.ts", "h-x", 1, 10);
  return { store, app, tests };
}

const names = (hits: { fqName: string; document: { projectName: string } }[]): string[] =>
  hits.map((h) => `${h.document.projectName}:${h.fqName}`);

test("schema, FTS detection and project rows", () => {
  const { store, app } = seeded();
  assert.equal(store.hasFts, true);
  const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  for (const t of ["project", "blob", "symbol", "symbol_fts", "reference", "relation", "tree", "excluded_file"]) assert.ok(tables.includes(t), t);
  assert.equal(store.getProject("/R/SLN/APP/tsconfig.json")!.id, app);
  assert.equal(store.getProject("/r/sln/app/tsconfig.json")!.indexedSchema, 0);
  store.stampProject(app, SCHEMA_VERSION);
  assert.equal(store.ensureProject({ path: "/r/sln/app/tsconfig.json", name: "app2", packageName: null, solutionPath: SLN, version: "2" }), app);
  assert.deepEqual({ ...store.getProject("/r/sln/app/tsconfig.json")! }, {
    id: app, path: "/r/sln/app/tsconfig.json", name: "app2", packageName: null, solutionPath: SLN, version: "2", indexedSchema: SCHEMA_VERSION,
  });
  store.setExcludedFiles(app, ["/r/sln/app/b.ts", "/r/sln/app/a.ts"]);
  assert.deepEqual(store.getExcludedFiles(app), ["/r/sln/app/a.ts", "/r/sln/app/b.ts"]);
  store.close();
});

for (const fts of [true, false]) {
  test(`searchSymbols ranks like compareRecords (fts: ${fts})`, () => {
    const { store } = seeded(fts);
    assert.equal(store.hasFts, fts);
    assert.deepEqual(names(store.searchSymbols("UOC", null, 10)), ["app:UpdateOrderCommand", "app.tests:UpdateOrderCommand"]);
    assert.deepEqual(names(store.searchSymbols("Update", null, 10)), ["app:UpdateOrderCommand", "app.tests:UpdateOrderCommand"]);
    assert.deepEqual(names(store.searchSymbols("App.Order", null, 10)), [
      "app:OrdersController", "app:UpdateOrderCommand", "app.tests:OrdersController", "app.tests:UpdateOrderCommand",
    ]);
    assert.deepEqual(names(store.searchSymbols("Upd", null, 1)), ["app:UpdateOrderCommand"]);
    assert.deepEqual(names(store.searchSymbols("CRO", null, 10)), ["app:RetryPolicy.createRetryOptions"]);
    assert.deepEqual(names(store.searchSymbols("get", "method", 10)), ["app:OrdersController.get"]);
    assert.deepEqual(names(store.searchSymbols("get", "class", 10)), []);
    assert.deepEqual(names(store.searchSymbols("uoc", null, 10)), []);
    assert.deepEqual(names(store.searchSymbols("Controller.Update", null, 10)), []);
    const hit = store.searchSymbols("OrdersController", null, 1)[0]!;
    assert.deepEqual(hit.document, {
      projectId: hit.document.projectId, projectName: "app", projectPath: "/r/sln/app/tsconfig.json", solutionPath: SLN,
      path: "/r/sln/app/src/orders.ts", contentHash: "h-orders",
    });
    store.close();
  });
}

test("blobs are per project and content; the tree decides what is visible", () => {
  const { store, app, tests } = seeded();
  const docId = "app/src/orders#OrdersController";
  assert.equal(store.findSymbolsByDocId(docId).length, 1);
  assert.equal(store.findSymbolsByDocId(docId)[0]!.endLine, 3);

  store.writeBlob(tests, "h-orders", ORDERS);
  assert.equal(store.stats().blobs, 3);
  assert.equal(store.findSymbolsByDocId(docId).length, 1);

  const path = "/r/sln/app/src/orders.ts";
  const edited: Extraction = { ...ORDERS, symbols: [sym("app/src/orders#OnlyInEdit", "class", 1)] };
  store.writeBlob(app, "h-edit", edited);
  store.setTreeEntry(app, path, "h-edit", 2, 11);
  assert.equal(store.findSymbolsByDocId(docId).length, 0);
  assert.equal(store.searchSymbols("OnlyInEdit", null, 5).length, 1);
  store.setTreeEntry(app, path, "h-orders", 1, 10);
  assert.equal(store.hasBlob(app, "h-edit"), true);
  assert.equal(store.findSymbolsByDocId(docId).length, 1);
  assert.equal(store.searchSymbols("OnlyInEdit", null, 5).length, 0);
  assert.deepEqual(store.getTree(app).get(path), { contentHash: "h-orders", mtime: 1, size: 10 });

  const blobs = store.stats().blobs;
  store.writeBlob(app, "h-orders", { ...ORDERS, symbols: ORDERS.symbols.slice(0, 1) }, { replace: true });
  assert.equal(store.stats().blobs, blobs);
  assert.equal(store.getFileSymbols(path).length, 1);
  store.writeBlob(app, "h-orders", ORDERS, { replace: true });

  assert.equal(store.gc(-1), 2);
  assert.equal(store.hasBlob(app, "h-edit"), false);
  assert.equal(store.hasBlob(tests, "h-orders"), false);
  assert.equal(store.hasBlob(app, "h-orders"), true);
  const orphans = store.db.prepare("SELECT count(*) AS n FROM symbol WHERE blob_id NOT IN (SELECT id FROM blob)").get() as { n: number };
  assert.equal(orphans.n, 0);
  const fts = store.db.prepare(`SELECT count(*) AS n FROM symbol_fts WHERE symbol_fts MATCH 'name : "onlyinedit"*'`).get() as { n: number };
  assert.equal(fts.n, 0);

  assert.equal(store.removeTreeEntries(app, ["/R/SLN/APP/SRC/ORDERS.TS"]), 0);
  assert.equal(store.removeTreeEntries(app, []), 1);
  assert.equal(store.findSymbolsByDocId(docId).length, 0);
  store.close();
});

test("getFileSymbols orders by position; stats counts rows", () => {
  const { store } = seeded();
  const path = "/r/sln/app/src/orders.ts";
  assert.deepEqual(store.getFileSymbols(path).map((s) => s.line), [1, 2, 5, 8]);
  assert.deepEqual(store.getFileSymbols(path.toUpperCase()).map((s) => s.line), [1, 2, 5, 8]);
  assert.deepEqual(store.stats(), { projects: 2, trackedFiles: 2, blobs: 2, symbols: 6, references: 0, relations: 0 });
  store.close();
});

test("references honour kinds and scope; counts per solution", () => {
  const { store, app, tests } = seeded();
  const target = "app/src/orders#UpdateOrderCommand";
  const ref = (kind: string, line: number, from: string | null) => ({ targetDocId: target, kind, line, col: 3, fromDocId: from });
  store.writeBlob(app, "h-main", { symbols: [], relations: [], references: [ref("creation", 4, "app/src/main#run"), ref("import", 1, null), ref("usage", 2, "<top-level>")] });
  store.setTreeEntry(app, "/r/sln/app/src/main.ts", "h-main", 1, 1);
  store.writeBlob(tests, "h-t", { symbols: [], relations: [], references: [ref("creation", 7, "app.tests/src/t#fixture")] });
  store.setTreeEntry(tests, "/r/sln/app.tests/src/t.ts", "h-t", 1, 1);
  const other = store.ensureProject({ path: "/r/other/tsconfig.json", name: "other", packageName: null, solutionPath: OTHER, version: null });
  store.writeBlob(other, "h-o", { symbols: [], relations: [], references: [ref("usage", 9, "other/src/o#use")] });
  store.setTreeEntry(other, "/r/other/src/o.ts", "h-o", 1, 1);

  const at = (hits: { document: { path: string }; line: number; kind: string }[]): string[] => hits.map((h) => `${h.document.path}:${h.line} ${h.kind}`);
  assert.deepEqual(at(store.findReferences(target, 10)), [
    "/r/other/src/o.ts:9 usage", "/r/sln/app.tests/src/t.ts:7 creation",
    "/r/sln/app/src/main.ts:1 import", "/r/sln/app/src/main.ts:2 usage", "/r/sln/app/src/main.ts:4 creation",
  ]);
  assert.deepEqual(at(store.findReferences(target, 10, { kinds: ["creation"] })), [
    "/r/sln/app.tests/src/t.ts:7 creation", "/r/sln/app/src/main.ts:4 creation",
  ]);
  assert.deepEqual(at(store.findReferences(target, 10, { scope: "tests" })), ["/r/sln/app.tests/src/t.ts:7 creation"]);
  assert.equal(store.findReferences(target, 10, { scope: "production" }).length, 4);
  assert.equal(store.findReferences(target, 2).length, 2);
  assert.equal(store.findReferences(target, 10)[2]!.fromDocId, null);
  assert.deepEqual(
    [...store.countReferencesBySolution(target, { kinds: ["creation"], scope: "production" })].sort(),
    [[OTHER, { total: 1, kept: 0 }], [SLN, { total: 4, kept: 1 }]],
  );
  store.close();
});

test("findRelations returns implements, inherits and overrides with the declaring symbol", () => {
  const { store, app } = seeded();
  const S = "app/src/shapes#";
  store.writeBlob(app, "h-shapes", {
    symbols: [sym(`${S}Base`, "class", 1), sym(`${S}Base.area`, "method", 1, "public"), sym(`${S}Circle`, "class", 2), sym(`${S}Circle.area`, "method", 2, "public")],
    references: [],
    relations: [
      { fromDocId: `${S}Base`, toDocId: `${S}Shape`, kind: "implements" },
      { fromDocId: `${S}Circle`, toDocId: `${S}Base`, kind: "inherits" },
      { fromDocId: `${S}Circle.area`, toDocId: `${S}Base.area`, kind: "overrides" },
      { fromDocId: `${S}Base.area`, toDocId: `${S}Shape.area`, kind: "implements" },
    ],
  });
  store.setTreeEntry(app, "/r/sln/app/src/shapes.ts", "h-shapes", 1, 1);
  const implementers = store.findRelations(`${S}Shape`, ["implements"], 10);
  assert.deepEqual(implementers.map((r) => [r.fromDocId, r.kind, r.symbol?.kind]), [[`${S}Base`, "implements", "class"]]);
  assert.deepEqual(store.findRelations(`${S}Base`, [], 10).map((r) => [r.fromDocId, r.kind]), [[`${S}Circle`, "inherits"]]);
  assert.deepEqual(store.findRelations(`${S}Base.area`, ["overrides"], 10).map((r) => r.fromDocId), [`${S}Circle.area`]);
  assert.equal(store.findRelations(`${S}Base.area`, ["implements"], 10).length, 0);
  assert.equal(store.findRelations(`${S}Shape.area`, ["implements"], 10)[0]!.symbol!.line, 1);
  assert.equal(store.stats().relations, 4);
  store.close();
});

test("deleteSolution removes the projects of one solution with their rows and fts entries", () => {
  const { store } = seeded();
  const other = store.ensureProject({ path: "/r/other/app/tsconfig.json", name: "other", packageName: null, solutionPath: OTHER, version: null });
  store.writeBlob(other, "h-other", { symbols: [sym("other/src/o#Zebra", "class", 1)], references: [], relations: [] });
  store.setTreeEntry(other, "/r/other/app/src/o.ts", "h-other", 1, 10);
  const count = (sql: string): number => Number((store.db.prepare(sql).get() as { n: number }).n);
  const fts = (term: string): number => count(`SELECT count(*) AS n FROM symbol_fts WHERE symbol_fts MATCH '${term}'`);
  assert.equal(fts("OrdersController"), 3);

  assert.equal(store.deleteSolution("/R/SLN/tsconfig.json"), 2);
  assert.equal(count(`SELECT count(*) AS n FROM project WHERE solution_path = '${SLN}'`), 0);
  assert.equal(count("SELECT count(*) AS n FROM symbol WHERE name = 'OrdersController'"), 0);
  assert.equal(count("SELECT count(*) AS n FROM blob WHERE content_hash IN ('h-orders', 'h-x')"), 0);
  assert.equal(fts("OrdersController"), 0);
  assert.deepEqual(store.searchSymbols("Orders", null, 10), []);
  assert.equal(count(`SELECT count(*) AS n FROM project WHERE solution_path = '${OTHER}'`), 1);
  assert.equal(fts("Zebra"), 1);
  assert.equal(store.searchSymbols("Zebra", null, 10).length, 1);
  assert.equal(store.deleteSolution(SLN), 0);
  store.close();
});

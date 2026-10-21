import assert from "node:assert/strict";
import { appendFileSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { IndexStore } from "../../src/index/index.ts";
import { indexDocuments, indexSolution, isFresh, isStale, removeDocument } from "../../src/workspace/indexer.ts";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import type { LoadedSolution } from "../../src/workspace/solution.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { REFS, REFS_MAIN_TS, REFS_TEST_TS, SINGLE } from "./projects.ts";

let fx: Fixture;
let store: IndexStore;
let manager: WorkspaceManager;
let refs: LoadedSolution;
let main: string;

before(() => {
  fx = writeFixture({ ...REFS, ...SINGLE });
  store = IndexStore.open(fx.path("index.db"));
  manager = new WorkspaceManager({ roots: [fx.root] });
  manager.discover();
  refs = manager.load("refs");
  main = fx.path("refs/src/main.ts");
});

after(() => {
  store.close();
  fx.remove();
});

const project = (): { host: { setFile(path: string, text: string | null): void } } => refs.projects[0]!;
const discovered = () => manager.solutions.find((s) => s.name === "refs")!;

/** Write a file on disk and in the host, with an mtime distinct from the previous one. */
function rewrite(path: string, text: string, mtime: number): void {
  writeFileSync(path, text);
  utimesSync(path, mtime, mtime);
  project().host.setFile(path, text);
}

test("indexing reuses unchanged documents and tracks edits by content", () => {
  const first = indexSolution(store, refs);
  assert.deepEqual([first.projectsVisited, first.documentsVisited, first.documentsExtracted, first.documentsReused], [1, 3, 3, 0]);
  const second = indexSolution(store, refs);
  assert.deepEqual([second.documentsExtracted, second.documentsReused, second.treeEntriesRemoved], [0, 3, 0]);
  assert.equal(store.stats().blobs, 3);
  assert.equal(store.findSymbolsByDocId("refs-pkg/shapes#Circle").length, 1);
  assert.equal(store.getProject(refs.projects[0]!.tsconfig)!.version, "1.0.0");

  appendFileSync(main, "// note\n");
  project().host.setFile(main, readFileSync(main, "utf8"));
  assert.deepEqual(indexDocuments(store, refs, [main]).changedProjects, []);
  assert.equal(store.stats().blobs, 4);

  rewrite(main, REFS_MAIN_TS, 1_700_000_000);
  const reverted = indexDocuments(store, refs, [main]);
  assert.equal(reverted.documentsExtracted, 0);
  assert.deepEqual(reverted.changedProjects, []);
  assert.equal(store.stats().blobs, 4);
  const holder = store.findSymbolsByDocId("refs-pkg/main#Holder");
  assert.equal(holder.length, 1);
  assert.equal(isStale(holder[0]!.document), false);

  rewrite(main, `${REFS_MAIN_TS}export const extra = 1;\n`, 1_700_000_100);
  assert.deepEqual(indexDocuments(store, refs, [main]).changedProjects, ["refs-pkg"]);
  assert.equal(store.findSymbolsByDocId("refs-pkg/main#extra").length, 1);
  rewrite(main, REFS_MAIN_TS, 1_700_000_200);
  indexDocuments(store, refs, [main]);
  assert.equal(store.findSymbolsByDocId("refs-pkg/main#extra").length, 0);
});

test("deleted documents disappear from the tree", () => {
  const testFile = fx.path("refs/test/shapes.test.ts");
  const fixture = "refs-pkg/test/shapes.test#fixture";
  assert.equal(store.findSymbolsByDocId(fixture).length, 1);
  rmSync(testFile);
  removeDocument(store, refs, testFile);
  assert.equal(store.findSymbolsByDocId(fixture).length, 0);

  writeFileSync(testFile, REFS_TEST_TS);
  project().host.setFile(testFile, REFS_TEST_TS);
  indexDocuments(store, refs, [testFile]);
  assert.equal(store.findSymbolsByDocId(fixture).length, 1);
  rmSync(testFile);
  const report = indexSolution(store, refs);
  assert.equal(report.treeEntriesRemoved, 1);
  assert.equal(store.findSymbolsByDocId(fixture).length, 0);
  writeFileSync(testFile, REFS_TEST_TS);
  assert.equal(indexSolution(store, refs).documentsExtracted, 0);
  assert.equal(store.findSymbolsByDocId(fixture).length, 1);
});

test("force and an old schema stamp re-extract every document once", () => {
  const blobs = store.stats().blobs;
  const forced = indexSolution(store, refs, { force: true });
  assert.equal(forced.documentsExtracted, 3);
  assert.equal(store.stats().blobs, blobs);

  store.db.prepare("UPDATE project SET indexed_schema = 0.5").run();
  assert.equal(indexSolution(store, refs).documentsExtracted, 3);
  assert.equal(indexSolution(store, refs).documentsExtracted, 0);
  assert.equal(store.stats().blobs, blobs);
});

test("isFresh compares mtimes, sizes and the tsconfig file list without loading", () => {
  indexSolution(store, refs);
  assert.equal(isFresh(store, discovered()), true);
  const shapes = fx.path("refs/src/shapes.ts");
  utimesSync(shapes, 1_600_000_000, 1_600_000_000);
  assert.equal(isFresh(store, discovered()), false);
  indexSolution(store, refs);
  assert.equal(isFresh(store, discovered()), true);

  const added = fx.path("refs/src/new.ts");
  writeFileSync(added, "export const fresh = 1;\n");
  assert.equal(isFresh(store, discovered()), false);
  rmSync(added);
  assert.equal(isFresh(store, discovered()), true);
  const single = manager.solutions.find((s) => s.name === "single")!;
  assert.equal(isFresh(store, single), false);
});

test("isStale re-reads the file and caches per call", () => {
  const hit = store.findSymbolsByDocId("refs-pkg/shapes#Circle")[0]!;
  const cache = new Map<string, boolean>();
  assert.equal(isStale(hit.document, cache), false);
  writeFileSync(hit.document.path, "export const changed = 1;\n");
  assert.equal(isStale(hit.document, cache), false);
  assert.equal(isStale(hit.document), true);
  assert.equal(isStale({ ...hit.document, path: fx.path("refs/src/missing.ts") }), true);
});

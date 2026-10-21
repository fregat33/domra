import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import { formatSearch, searchInSolution, searchWorkspace } from "../../src/workspace/search.ts";
import type { SearchHit } from "../../src/workspace/search.ts";
import type { Fixture } from "../fixtures.ts";
import { locate, writeFixture } from "../fixtures.ts";
import { JOBS_TS, MONO, RETRY_TS, SEARCH, SINGLE } from "./projects.ts";

let fx: Fixture;
let manager: WorkspaceManager;

before(() => {
  fx = writeFixture({ ...SEARCH, ...SINGLE, ...MONO });
  manager = new WorkspaceManager({ roots: [fx.root] });
  manager.discover();
  manager.load("demo");
});

after(() => fx.remove());

function search(pattern: string, options: { kind?: "interface"; limit?: number } = {}): SearchHit[] {
  const demo = manager.resolveSolution("demo");
  assert.ok(demo);
  return searchInSolution(demo, pattern, options).hits;
}

const names = (hits: SearchHit[]): string[] => hits.map((h) => h.name);

test("Job: the source class wins over its test duplicate", () => {
  const hits = search("Job");
  assert.equal(hits[0]!.name, "CloseCompletedOrdersJob");
  assert.equal(hits[0]!.kind, "class");
  assert.equal(hits[0]!.position.path, fx.path("demo/src/jobs.ts"));
  assert.equal(hits[0]!.isTest, false);
  assert.equal(hits[0]!.match, "lastHump");
});

test("Upload: methods, property, enum member, then test code", () => {
  const demo = manager.resolveSolution("demo")!;
  const result = searchInSolution(demo, "Upload");
  assert.equal(result.total, 5);
  assert.deepEqual(names(result.hits), [
    "uploadUri",
    "uploadFile",
    "uploadDate",
    "Uploaded",
    "handle_ShouldTruncateAndUpload",
  ]);
  assert.equal(result.hits[4]!.isTest, true);
});

test("Upload with limit keeps the total", () => {
  const demo = manager.resolveSolution("demo")!;
  const result = searchInSolution(demo, "Upload", { limit: 2 });
  assert.equal(result.hits.length, 2);
  assert.equal(result.total, 5);
});

test("Retry", () => {
  const hits = search("Retry");
  assert.deepEqual(names(hits).slice(0, 2), ["RetryPolicy", "createRetryOptions"]);
});

test("CCOJ: source first, test duplicate second", () => {
  const hits = search("CCOJ");
  assert.equal(hits[0]!.name, "CloseCompletedOrdersJob");
  assert.equal(hits[0]!.position.path, fx.path("demo/src/jobs.ts"));
  assert.equal(hits[1]!.name, "CloseCompletedOrdersJob");
  assert.equal(hits[1]!.position.path, fx.path("demo/test/jobs.test.ts"));
  assert.equal(hits[1]!.isTest, true);
});

test("hump, last-hump and substring patterns", () => {
  assert.equal(search("HCF")[0]!.name, "HTTPClientFactory");
  assert.equal(search("Client")[0]!.name, "HTTPClientFactory");
  assert.equal(search("validator")[0]!.name, "_validator");
  const sub = search("ompleted")[0]!;
  assert.equal(sub.name, "CloseCompletedOrdersJob");
  assert.equal(sub.match, "substring");
  assert.equal(search("UOC")[0]!.name, "UpdateOrderCommand");
  assert.deepEqual(search("uoc"), []);
  assert.deepEqual(search("   "), []);
});

test("container terms match the fqName or the file path", () => {
  const member = search("Order.uploadDate")[0]!;
  assert.equal(member.name, "uploadDate");
  assert.equal(member.kind, "property");
  assert.equal(member.fqName, "Order.uploadDate");
  const viaPath = search("jobs Job")[0]!;
  assert.equal(viaPath.name, "CloseCompletedOrdersJob");
  assert.equal(viaPath.position.path, fx.path("demo/src/jobs.ts"));
  assert.deepEqual(search("nomatch Job"), []);
});

test("kind filter is exact", () => {
  const hits = search("Order", { kind: "interface" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.name, "Order");
});

test("formatSearch", () => {
  const demo = manager.resolveSolution("demo")!;
  const results = [searchInSolution(demo, "Retry")];
  const path = fx.path("demo/src/retry.ts");
  const policy = locate(RETRY_TS, "RetryPolicy");
  const method = locate(RETRY_TS, "createRetryOptions");
  assert.equal(
    formatSearch(results, "Retry"),
    `Live demo (2):\n  class RetryPolicy  ${path}:${policy.line}:${policy.col}\n` +
      `  method RetryPolicy.createRetryOptions  ${path}:${method.line}:${method.col}\n`,
  );
  assert.equal(
    formatSearch([], "uoc"),
    "No symbols match uoc. Patterns support camel-case humps (e.g. UOC for UpdateOrderCommand).",
  );
  const jobs = locate(JOBS_TS, "CloseCompletedOrdersJob");
  assert.ok(formatSearch([searchInSolution(demo, "CCOJ", { limit: 1 })], "CCOJ").includes(`:${jobs.line}:${jobs.col}\n`));
});

test("searchWorkspace spans loaded solutions in load order and honours the hint", () => {
  manager.load("single");
  manager.load("mono");
  const all = searchWorkspace(manager, "Circle");
  assert.deepEqual(all.map((r) => r.solution), ["single"]);
  const greeting = searchWorkspace(manager, "Greeting");
  assert.deepEqual(greeting.map((r) => r.solution), ["mono"]);
  const widget = searchWorkspace(manager, "e");
  assert.deepEqual(widget.map((r) => r.solution), ["demo", "single", "mono"]);
  assert.deepEqual(searchWorkspace(manager, "e", { solution: "mono" }).map((r) => r.solution), ["mono"]);
  assert.deepEqual(searchWorkspace(manager, "e", { solution: "missing" }), []);
  assert.deepEqual(searchWorkspace(manager, "uoc"), []);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { humpStarts, kindRank, match, parseQuery } from "../../src/index/ranker.ts";

const TABLE: [string, string, string | null][] = [
  ["Job", "Job", "exact"],
  ["job", "Job", "exact"],
  ["Job", "CloseCompletedOrdersJob", "lastHump"],
  ["OrdersJob", "CloseCompletedOrdersJob", "lastHump"],
  ["Job", "JobTitle", "prefix"],
  ["Upload", "UploadFile", "prefix"],
  ["UOC", "UpdateOrderCommand", "camelHump"],
  ["UpOrCo", "UpdateOrderCommand", "camelHump"],
  ["Retry", "CreateRetryOptions", "camelHump"],
  ["retry", "CreateRetryOptions", "camelHump"],
  ["validator", "_validator", "lastHump"],
  ["valid", "_validator", "camelHump"],
  ["Client", "HTTPClientFactory", "camelHump"],
  ["ample", "Sample", "substring"],
  ["rsJo", "CloseCompletedOrdersJob", "substring"],
  ["uoc", "UpdateOrderCommand", null],
  ["Jobs", "Job", null],
  ["UOX", "UpdateOrderCommand", null],
  ["", "Job", null],
];

for (const [pattern, name, expected] of TABLE) {
  test(`match(${JSON.stringify(pattern)}, ${name}) = ${expected}`, () => {
    assert.equal(match(pattern, name), expected);
  });
}

test("humpStarts", () => {
  assert.deepEqual(humpStarts("HTTPClientFactory_v2"), [0, 4, 10, 18, 19]);
  assert.deepEqual(humpStarts("_validator"), [1]);
  assert.deepEqual(humpStarts("UOC", true), [0, 1, 2]);
});

test("parseQuery", () => {
  assert.deepEqual(parseQuery("App.Order"), { name: "Order", containers: ["App"] });
  assert.deepEqual(parseQuery("   "), { name: "", containers: [] });
  assert.deepEqual(parseQuery("a b:c.d"), { name: "d", containers: ["a", "b", "c"] });
  assert.deepEqual(parseQuery(" Job "), { name: "Job", containers: [] });
});

test("kindRank", () => {
  for (const kind of ["class", "interface", "typeAlias", "enum", "function", "method", "constructor"]) {
    assert.equal(kindRank(kind), 0);
  }
  assert.equal(kindRank("property"), 1);
  assert.equal(kindRank("accessor"), 1);
  assert.equal(kindRank("field"), 2);
  assert.equal(kindRank("enumMember"), 2);
  for (const kind of ["variable", "parameter", "namespace", "module"]) assert.equal(kindRank(kind), 3);
});

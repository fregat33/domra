import assert from "node:assert/strict";
import { test } from "node:test";
import { PendingRefreshes } from "../../src/watcher/pending.ts";

test("touch aggregates per solution", () => {
  const pending = new PendingRefreshes();
  pending.touch("/r/demo/tsconfig.json", "/r/demo/a.ts", 1000);
  pending.touch("/r/demo/tsconfig.json", "/r/demo/b.ts", 2000);
  const entries = pending.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]![1].paths.size, 2);
  assert.ok(entries[0]![1].first <= entries[0]![1].last);
});

test("due honours the quiet and max-wait rules", () => {
  const pending = new PendingRefreshes();
  pending.touch("/r/demo/tsconfig.json", "/r/demo/a.ts", 1000);
  pending.touch("/r/demo/tsconfig.json", "/r/demo/b.ts", 1200);
  assert.deepEqual(pending.due(2199, { quietMs: 1000, maxWaitMs: 0 }), []);
  assert.deepEqual(pending.due(2200, { quietMs: 1000, maxWaitMs: 0 }), ["/r/demo/tsconfig.json"]);
  assert.deepEqual(pending.due(1499, { quietMs: 0, maxWaitMs: 500 }), []);
  assert.deepEqual(pending.due(1500, { quietMs: 0, maxWaitMs: 500 }), ["/r/demo/tsconfig.json"]);
  assert.deepEqual(pending.due(999999, { quietMs: 0, maxWaitMs: 0 }), []);
});

test("take removes and statusLine prints", () => {
  const pending = new PendingRefreshes();
  assert.equal(pending.statusLine(0), "Unloaded refresh: none pending");
  pending.touch("/r/demo/tsconfig.json", "/r/demo/a.ts", 1000);
  pending.touch("/r/demo/tsconfig.json", "/r/demo/b.ts", 1000);
  assert.equal(pending.statusLine(4000), "Unloaded refresh: demo (2 files, last change 3s ago)");
  assert.equal(pending.take("/r/demo/tsconfig.json")?.paths.size, 2);
  assert.equal(pending.take("/r/demo/tsconfig.json"), undefined);
  assert.equal(pending.statusLine(4000), "Unloaded refresh: none pending");
});

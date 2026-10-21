import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangeBatch } from "../../src/watcher/debounce.ts";
import { ChangeDebouncer } from "../../src/watcher/debounce.ts";
import { delay, until } from "./until.ts";

test("a burst becomes one deduplicated batch", async () => {
  const batches: ChangeBatch[] = [];
  const debouncer = new ChangeDebouncer({ quietMs: 50, onFlush: (b) => batches.push(b) });
  for (let i = 0; i < 17; i++) debouncer.add(`/p/${i}.ts`);
  debouncer.add("/p/0.ts");
  await until(() => batches.length === 1);
  await delay(120);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.paths.size, 17);
  assert.equal(batches[0]!.overflowed, false);

  debouncer.add("/p/again.ts");
  await until(() => batches.length === 2);
  assert.deepEqual([...batches[1]!.paths], ["/p/again.ts"]);
  debouncer.dispose();
});

test("markOverflow is reported and flush emits at once", () => {
  const batches: ChangeBatch[] = [];
  const debouncer = new ChangeDebouncer({ quietMs: 5000, onFlush: (b) => batches.push(b) });
  debouncer.flush();
  assert.equal(batches.length, 0);
  debouncer.add("/p/a.ts");
  debouncer.markOverflow();
  debouncer.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.overflowed, true);
  debouncer.dispose();
});

test("max wait flushes a never-quiet stream", async () => {
  const started = Date.now();
  let firstFlush = 0;
  const debouncer = new ChangeDebouncer({
    quietMs: 50, maxWaitMs: 300, onFlush: () => { firstFlush ||= Date.now() - started; },
  });
  for (let elapsed = 0; elapsed < 600; elapsed += 20) {
    debouncer.add(`/p/${elapsed}.ts`);
    await delay(20);
  }
  assert.ok(firstFlush > 0 && firstFlush < 400, `first flush after ${firstFlush} ms`);
  debouncer.dispose();
});

test("dispose cancels a pending flush", async () => {
  let flushed = 0;
  const debouncer = new ChangeDebouncer({ quietMs: 50, onFlush: () => { flushed++; } });
  debouncer.add("/p/a.ts");
  debouncer.dispose();
  await delay(200);
  assert.equal(flushed, 0);
});

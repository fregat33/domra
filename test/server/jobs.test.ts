import assert from "node:assert/strict";
import { test } from "node:test";
import { JobQueue } from "../../src/server/jobs.ts";

test("jobs run in order, one at a time", async () => {
  const queue = new JobQueue();
  const log: string[] = [];
  let running = 0;
  const job = (name: string) => () => {
    running++;
    assert.equal(running, 1);
    log.push(name);
    running--;
  };
  const done = [queue.enqueue("a", job("a")), queue.enqueue("b", job("b")), queue.enqueue("c", job("c"))];
  assert.equal(queue.pending, 3);
  assert.deepEqual(log, []);
  await Promise.all(done);
  await queue.idle();
  assert.deepEqual(log, ["a", "b", "c"]);
  assert.equal(queue.pending, 0);
  assert.equal(queue.lastCompleted?.name, "c");
});

test("a throwing job is reported and the queue continues", async () => {
  const warnings: string[] = [];
  const queue = new JobQueue((message) => warnings.push(message));
  let ran = false;
  void queue.enqueue("bad", () => {
    throw new Error("boom");
  });
  void queue.enqueue("good", () => {
    ran = true;
  });
  await queue.idle();
  assert.equal(ran, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /bad.*boom/);
  assert.equal(queue.pending, 0);
});

test("idle resolves at once on an empty queue and waits for jobs enqueued by jobs", async () => {
  const queue = new JobQueue();
  await queue.idle();
  const log: string[] = [];
  void queue.enqueue("outer", () => {
    log.push("outer");
    void queue.enqueue("inner", () => {
      log.push("inner");
    });
  });
  await queue.idle();
  assert.deepEqual(log, ["outer", "inner"]);
});

test("an async job finishes before the next job starts", async () => {
  const queue = new JobQueue();
  const log: string[] = [];
  void queue.enqueue("slow", async () => {
    log.push("slow start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    log.push("slow end");
  });
  void queue.enqueue("next", () => {
    log.push("next");
  });
  await queue.idle();
  assert.deepEqual(log, ["slow start", "slow end", "next"]);
  assert.equal(queue.lastCompleted?.name, "next");
});

test("a rejecting async job is reported and the queue continues", async () => {
  const warnings: string[] = [];
  const queue = new JobQueue((message) => warnings.push(message));
  void queue.enqueue("bad", async () => {
    throw new Error("late");
  });
  await queue.idle();
  assert.match(warnings[0]!, /bad.*late/);
});

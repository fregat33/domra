import assert from "node:assert/strict";
import { test } from "node:test";
import { Pager } from "../../src/server/pager.ts";

const LINES = ["a", "b", "c", "d", "e"];
const CURSOR = /next_page cursor=([0-9a-f]{10})\)/;

function cursorOf(text: string): string {
  const match = CURSOR.exec(text);
  assert.ok(match, `no cursor in ${JSON.stringify(text)}`);
  return match[1]!;
}

test("appendPage prints the first page and a trailer", () => {
  const pager = new Pager();
  const text = pager.appendPage(LINES, 2, "demo");
  assert.match(text, /^a\nb\n {2}\.\.\. 3 more \(next_page cursor=[0-9a-f]{10}\)\n$/);
});

test("appendPage without remaining lines has no trailer", () => {
  assert.equal(new Pager().appendPage(["x"], 5, "demo"), "x\n");
});

test("take walks the pages, keeping old cursors valid", () => {
  const pager = new Pager();
  const first = cursorOf(pager.appendPage(LINES, 2, "demo"));
  const second = pager.take(first)!;
  assert.match(second, /^Continued: demo\nc\nd\n {2}\.\.\. 1 more \(next_page cursor=[0-9a-f]{10}\)\n$/);
  const last = pager.take(cursorOf(second))!;
  assert.equal(last, "Continued: demo\ne\n");
  assert.ok(pager.take(first));
});

test("take applies a new limit to the following pages", () => {
  const pager = new Pager();
  const first = cursorOf(pager.appendPage(LINES, 1, "demo"));
  assert.match(pager.take(first, 3)!, /^Continued: demo\nb\nc\nd\n {2}\.\.\. 1 more/);
});

test("take returns null for unknown or blank cursors", () => {
  const pager = new Pager();
  assert.equal(pager.take("nope"), null);
  assert.equal(pager.take("  "), null);
});

test("the oldest cursor is evicted beyond capacity 128", () => {
  const pager = new Pager();
  const first = cursorOf(pager.appendPage(LINES, 1, "first"));
  for (let i = 0; i < 128; i++) pager.appendPage(LINES, 1, `n${i}`);
  assert.equal(pager.take(first), null);
});

test("expired entries are evicted on the next store and refused on take", () => {
  let now = 1_000;
  const pager = new Pager({ now: () => now });
  const old = cursorOf(pager.appendPage(LINES, 1, "old"));
  const older = cursorOf(pager.appendPage(LINES, 1, "older"));
  now += 29 * 60 * 1000;
  assert.ok(pager.take(old));
  now += 2 * 60 * 1000;
  assert.equal(pager.take(older), null);
  pager.appendPage(LINES, 1, "new");
  assert.equal(pager.take(old), null);
});

test("cursors come from the injected random source", () => {
  const pager = new Pager({ random: () => Uint8Array.from([1, 2, 3, 4, 255]) });
  assert.match(pager.appendPage(LINES, 1, "x"), /cursor=01020304ff\)/);
});

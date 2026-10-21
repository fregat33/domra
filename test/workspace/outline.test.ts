import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { formatQueryText } from "../../src/workspace/display.ts";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import { outline } from "../../src/workspace/outline.ts";
import type { LoadedSolution } from "../../src/workspace/solution.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { INHERIT, SINGLE } from "./projects.ts";

let fx: Fixture;
let single: LoadedSolution;
let inherit: LoadedSolution;
let shapes: string;

before(() => {
  fx = writeFixture({ ...SINGLE, ...INHERIT });
  const manager = new WorkspaceManager({ roots: [fx.root] });
  manager.discover();
  single = manager.load("single");
  inherit = manager.load("inherit");
  shapes = fx.path("single/src/shapes.ts");
});

after(() => fx.remove());

const SHAPES_DEPTH_2 = [
  "  interface Shape  1-3",
  "    method area(): number  2",
  "  class Circle : Shape  5-14",
  "    field radius: number  6",
  "    constructor constructor(radius: number)  7-9",
  "    method area(): number  10-13",
  "  function makeCircle(radius: number): Circle  16-18",
  "  function format(value: string): string  20",
  "  function format(value: number, digits: number): string  21",
  "  function format(value: string | number, digits?: number): string  22-24",
  "  namespace Geometry  26-33",
  "    class Point  27-32",
  "  enum Color  35-38",
  "    enumMember Red = 0  36",
  "    enumMember Green = 1  37",
];

test("file outline at depth 2", () => {
  const result = outline(single, "src/shapes.ts");
  assert.deepEqual(result.head, [`Outline: ${shapes}  (Live single, single-pkg)`]);
  assert.deepEqual(result.items, SHAPES_DEPTH_2);
  assert.equal(result.footer, "Total: 15 declarations");
  assert.equal(result.label, `get_outline ${shapes}`);
  assert.deepEqual(outline(single, shapes.replace(/\//g, "\\")).items, SHAPES_DEPTH_2);
});

test("file outline at depth 1 and 3", () => {
  const one = outline(single, "src/shapes.ts", { depth: 1 });
  assert.equal(one.items.length, 8);
  assert.equal(one.footer, "Total: 8 declarations");
  const three = outline(single, "src/shapes.ts", { depth: 3 });
  assert.equal(three.items.length, 19);
  assert.equal(three.footer, "Total: 19 declarations");
  const point = three.items.indexOf("    class Point  27-32");
  assert.deepEqual(three.items.slice(point + 1, point + 5), [
    "      constructor constructor(x: number, y: number)  28",
    "      field x: number  28",
    "      field y: number  28",
    "      static method origin(): Point  29-31",
  ]);
  assert.deepEqual(outline(single, "src/shapes.ts", { depth: 9 }).items, three.items);
});

test("private top-level declarations", () => {
  const all = outline(single, "src/main.ts");
  assert.deepEqual(all.items, ["  private variable shape: Circle  3", "  variable total: number  4"]);
  assert.equal(all.footer, "Total: 2 declarations");
  const shown = outline(single, "src/main.ts", { includePrivate: false });
  assert.deepEqual(shown.items, ["  variable total: number  4"]);
  assert.equal(shown.footer, "Total: 1 declarations");
});

test("decorators and heritage", () => {
  const api = outline(inherit, "src/api.ts");
  assert.deepEqual(api.items, [
    "  private function Route(_path: string): (t: unknown, c: unknown) => void  1",
    "  private function Marker(_t: unknown, _c: unknown): void  2",
    "  class Api  3-6",
    '    method handle(): void  [Route("api/orders")] [Marker]  4-5',
  ]);
  const derived = outline(inherit, "src/derived.ts").items;
  assert.equal(derived[0], "  class Derived : Base  2");
  assert.equal(derived[2], "    method describe(): string  2");
});

test("type outline", () => {
  const expected = [
    `  ${shapes}  (single-pkg)`,
    "    class Circle : Shape  5-14",
    "      field radius: number  6",
    "      constructor constructor(radius: number)  7-9",
    "      method area(): number  10-13",
  ];
  const result = outline(single, "Circle");
  assert.deepEqual(result.head, ["Outline: class Circle  (Live single)"]);
  assert.deepEqual(result.items, expected);
  assert.equal(result.footer, "Total: 4 declarations");
  assert.equal(result.label, "get_outline Circle");
  assert.deepEqual(outline(single, "Circle.area").items, expected);
  assert.deepEqual(outline(single, "Circle", { depth: 1 }).items, expected.slice(0, 2));
  assert.equal(
    outline(single, "makeCircle").head[0],
    "makeCircle resolved to function makeCircle, which is not a type; pass a file path instead.",
  );
  assert.match(outline(single, "NoSuchThing").head[0]!, /^Symbol not found/);
});

test("errors", () => {
  assert.equal(
    outline(single, "src/nope.ts").head[0],
    "File not found: src/nope.ts. Pass an absolute path, or a path relative to a solution directory.",
  );
  mkdirSync(fx.path("single/other"), { recursive: true });
  writeFileSync(fx.path("single/other/extra.ts"), "export const x = 1;\n");
  const head = outline(single, "other/extra.ts").head[0]!;
  assert.ok(head.endsWith("is not part of single. New files are picked up on save; otherwise check the project globs."));
});

test("limit is applied by formatQueryText", () => {
  const text = formatQueryText(outline(single, "src/shapes.ts"), 5);
  const lines = text.split("\n");
  assert.equal(lines.length, 1 + 5 + 1 + 1);
  assert.equal(lines[6], "  ... 10 more");
  assert.equal(lines[7], "Total: 15 declarations");
  assert.ok(!text.endsWith("\n"));
});

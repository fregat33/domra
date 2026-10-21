import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import { findImplementationsText } from "../../src/workspace/implementations.ts";
import type { Fixture } from "../fixtures.ts";
import { locate, writeFixture } from "../fixtures.ts";
import { REFS, REFS_SHAPES_TS } from "./projects.ts";

let fx: Fixture;
let manager: WorkspaceManager;
let shapes: string;

before(() => {
  fx = writeFixture(REFS);
  manager = new WorkspaceManager({ roots: [fx.root] });
  manager.discover();
  manager.load("refs");
  shapes = fx.path("refs/src/shapes.ts");
});

after(() => fx.remove());

/** `  {relation}  {kind} {name}  {shapes}:line:col` where the name is declared after `after`. */
function line(relation: string, kind: string, name: string, needle: string, after: string): string {
  const { line: l, col } = locate(REFS_SHAPES_TS, needle, after);
  return `  ${relation}  ${kind} ${name}  ${shapes}:${l}:${col}`;
}

function items(spec: string, options: { typesOnly?: boolean } = {}): string[] {
  const result = findImplementationsText(manager, spec, { solution: "refs", ...options });
  assert.equal(result.groups.length, 1);
  return result.groups[0]!.items;
}

const CLASSES = [
  line("implements", "class", "Base", "Base", "abstract class "),
  line("implements", "class", "Circle", "Circle", "export class "),
  line("implements", "class", "Square", "Square", "export class "),
  line("implements", "class", "Tiny", "Tiny", "export class "),
];

test("interface: implementers across base classes", () => {
  const result = findImplementationsText(manager, "Shape", { solution: "refs" });
  assert.equal(result.groups[0]!.header, "Live refs: 4");
  assert.equal(result.groups[0]!.label, "find_implementations Shape in refs");
  assert.deepEqual(result.groups[0]!.items.map((l) => l.replace(/:\d+:\d+$/, "")), CLASSES.map((l) => l.replace(/:\d+:\d+$/, "")));
  assert.equal(result.groups[0]!.items[0], `  implements  class Base  ${shapes}:2:23`);
  assert.equal(result.footer, "Total: 4");
});

test("classes: derived classes", () => {
  const base = items("Base");
  assert.equal(base.length, 3);
  assert.deepEqual(base.map((l) => /^ {2}inherits {2}class (\w+) /.exec(l)?.[1]), ["Circle", "Square", "Tiny"]);
  const circle = items("Circle");
  assert.equal(circle.length, 1);
  assert.match(circle[0]!, /^ {2}inherits {2}class Tiny {2}/);
});

test("members: implementations and overrides", () => {
  const area = items("Shape.area");
  assert.deepEqual(area.map((l) => /^ {2}implements {2}method (\S+) /.exec(l)?.[1]), [
    "Base.area", "Circle.area", "Square.area", "Tiny.area",
  ]);
  const { line: l, col } = locate(REFS_SHAPES_TS, "area", "class Square extends Base { ");
  assert.equal(area[2], `  implements  method Square.area  ${shapes}:${l}:${col}`);
  assert.deepEqual(items("Base.area").map((x) => /^ {2}overrides {2}method (\S+) /.exec(x)?.[1]), [
    "Circle.area", "Square.area", "Tiny.area",
  ]);
  const describe = findImplementationsText(manager, "Base.describe", { solution: "refs" });
  assert.equal(describe.groups[0]!.header, "Live refs: 0");
  assert.equal(describe.footer, "Total: 0");
});

test("typesOnly", () => {
  const total = findImplementationsText(manager, "total", { solution: "refs", typesOnly: true });
  assert.deepEqual(total.head, ["total resolved to a function, not a type. Use find_implementations for members."]);
  assert.deepEqual(total.groups, []);
  assert.equal(total.footer, "Total: 0");
  const shape = findImplementationsText(manager, "Shape", { solution: "refs", typesOnly: true });
  assert.deepEqual(shape.groups[0]!.items, items("Shape"));
  assert.equal(shape.groups[0]!.label, "find_derived_types Shape in refs");
});

test("not found", () => {
  const result = findImplementationsText(manager, "NoSuch");
  assert.ok(result.head[0]!.startsWith("Symbol not found"));
  assert.deepEqual(result.groups, []);
  assert.equal(result.footer, "Total: 0");
});

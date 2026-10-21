import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { formatQueryText } from "../../src/workspace/display.ts";
import { definition, listMembers, symbolInfo } from "../../src/workspace/queries.ts";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import type { LoadedSolution } from "../../src/workspace/solution.ts";
import type { Fixture } from "../fixtures.ts";
import { locate, writeFixture } from "../fixtures.ts";
import { INHERIT, SHAPES_TS, SINGLE } from "./projects.ts";

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

/** `{shapes}:{line}:{col}` of `needle` in shapes.ts. */
function inShapes(needle: string, afterText = ""): string {
  const { line, col } = locate(SHAPES_TS, needle, afterText);
  return `${shapes}:${line}:${col}`;
}

function lineIndex(lines: string[], text: string, from = 0): number {
  const index = lines.indexOf(text, from);
  assert.ok(index >= from, `missing ${text} after line ${from} in:\n${lines.join("\n")}`);
  return index;
}

/** Asserts the lines appear in this order (not necessarily adjacent). */
function assertInOrder(lines: string[], expected: string[]): void {
  let from = 0;
  for (const text of expected) from = lineIndex(lines, text, from) + 1;
}

test("definition of a class", () => {
  const { head, items } = definition(single, "Circle");
  assert.match(head[0]!, /^Symbol: .*  \[class\]  Circle$/);
  assert.equal(head[1], "Project: single-pkg (single)");
  assert.equal(head[2], `Defined: ${inShapes("Circle")}`);
  assert.equal(head[3], "Declared in source:");
  assert.deepEqual(items, [`  ${inShapes("Circle")}`]);
});

test("definition lists every overload", () => {
  const { items } = definition(single, "format");
  const lines = [20, 21, 22].map((line) => `  ${shapes}:${line}:17`);
  assert.deepEqual(items, lines);
});

test("definition prefers source over a declaration file", () => {
  const { head, items } = definition(single, "Widget");
  assert.equal(head[1], "Project: single-pkg (single)");
  assert.equal(items.length, 1);
  assert.match(items[0]!, /widget\.ts:\d+:\d+$/);
});

test("definition not-found texts", () => {
  const missing = definition(single, "NoSuchThing");
  assert.deepEqual(missing.head, [
    "Symbol not found in any loaded solution: NoSuchThing",
    "Tip: use search_symbols to find the exact name, or load_solution if the owning solution is not loaded yet.",
  ]);
  assert.deepEqual(missing.items, []);
  const nowhere = definition(single, "src/shapes.ts:1:1");
  assert.equal(nowhere.head[0], "No symbol at src/shapes.ts:1:1");
  assert.equal(
    nowhere.head[1],
    "Point the column at an identifier, or omit the column to take the first declaration or reference on that line.",
  );
  assert.equal(definition(single, "C:/nowhere/x.ts:1:1").head[1], "The file is not under any loaded solution.");
});

test("symbolInfo of a class", () => {
  const { head } = symbolInfo(single, "Circle");
  for (const line of [
    "Kind: class", "Name: Circle", "Modifiers: export", "Module: src/shapes.ts", "Implements: Shape",
    `Declared at: ${inShapes("Circle")}`,
  ]) lineIndex(head, line);
  assert.ok(!head.some((l) => l.startsWith("Namespace:")));
  assertInOrder(head, ["Members (3):", "  radius: number", "  constructor(radius: number)", "  area(): number"]);
});

test("symbolInfo of a method", () => {
  const { head } = symbolInfo(single, "Circle.area");
  for (const line of ["Kind: method", "Containing type: Circle", "Modifiers: public", "Returns: number"]) {
    lineIndex(head, line);
  }
  assert.ok(!head.some((l) => l.startsWith("Parameter:") || l.startsWith("Overload")));
});

test("symbolInfo of overloads", () => {
  const { head } = symbolInfo(single, "format");
  assertInOrder(head, [
    "Overload 1:", "Returns: string", "Parameter: string value",
    "Overload 2:", "Returns: string", "Parameter: number value", "Parameter: number digits",
  ]);
});

test("symbolInfo of an enum member and a namespaced class", () => {
  const red = symbolInfo(single, "Color.Red").head;
  lineIndex(red, "Kind: enumMember");
  lineIndex(red, "Constant: 0");
  const point = symbolInfo(single, "Geometry.Point").head;
  lineIndex(point, "Namespace: Geometry");
  assertInOrder(point, [
    "Members (4):", "  constructor(x: number, y: number)", "  x: number", "  y: number", "  origin(): Point",
  ]);
});

test("symbolInfo of a missing symbol", () => {
  assert.equal(symbolInfo(single, "NoSuchThing").head[0], "Symbol not found in any loaded solution: NoSuchThing");
});

test("listMembers of a class, interface, enum and namespace", () => {
  const circle = listMembers(single, "Circle");
  assert.deepEqual(circle.head, [`class Circle  ${inShapes("Circle")}`, "3 members"]);
  assert.deepEqual(circle.items, [
    "  public field radius: number",
    "  public constructor constructor(radius: number)",
    "  public method area(): number",
  ]);
  const shape = listMembers(single, "Shape");
  assert.equal(shape.head[1], "1 members");
  assert.deepEqual(shape.items, ["  public method area(): number"]);
  assert.deepEqual(listMembers(single, "Color").items, [
    "  public enumMember Green = 1",
    "  public enumMember Red = 0",
  ]);
  const geometry = listMembers(single, "Geometry");
  assert.equal(geometry.head[1], "1 members");
  assert.deepEqual(geometry.items, ["  public class Point"]);
});

test("listMembers filter, limit and non-types", () => {
  const filtered = listMembers(single, "Circle", { filter: "rad" });
  assert.equal(filtered.head[1], "1 members");
  assert.deepEqual(filtered.items, ["  public field radius: number"]);
  assert.ok(formatQueryText(listMembers(single, "Circle", { limit: 1 }), 1).endsWith("  ... 2 more\n"));
  assert.deepEqual(listMembers(single, "makeCircle").head, ["makeCircle is not a type."]);
  assert.deepEqual(listMembers(single, "Circle.area").items, listMembers(single, "Circle").items);
});

test("listMembers with inherited members", () => {
  assert.equal(listMembers(inherit, "Derived").head[1], "2 members");
  assert.deepEqual(listMembers(inherit, "Derived").items, [
    "  public field name: string",
    "  public method describe(): string",
  ]);
  const all = listMembers(inherit, "Derived", { includeInherited: true });
  assert.equal(all.head[1], "4 members");
  assert.deepEqual(all.items, [
    "  public field name: string",
    "  public method describe(): string",
    "  public static method create(): Base  [from Base]",
    "  protected field id: number  [from Base]",
  ]);
});

test("queries report internal errors through onError and return not-found text", () => {
  const errors: string[] = [];
  const broken = { ...single, projects: null } as unknown as LoadedSolution;
  const result = definition(broken, "Circle", { onError: (_e, spec) => errors.push(spec) });
  assert.equal(result.head[0], "Symbol not found in any loaded solution: Circle");
  assert.deepEqual(errors, ["Circle"]);
});

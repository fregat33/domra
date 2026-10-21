import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import { formatPosition } from "../../src/workspace/positions.ts";
import type { ResolvedSymbol } from "../../src/workspace/resolver.ts";
import type { Fixture } from "../fixtures.ts";
import { locate, writeFixture } from "../fixtures.ts";
import { APP_TSX, MAIN_TS, MONO, SHAPES_TS, SINGLE } from "./projects.ts";

let fx: Fixture;
let manager: WorkspaceManager;
let shapes: string;

before(() => {
  fx = writeFixture({ ...SINGLE, ...MONO });
  manager = new WorkspaceManager({ roots: [fx.root] });
  manager.discover();
  manager.load("single");
  manager.load("mono");
  shapes = fx.path("single/src/shapes.ts");
});

after(() => fx.remove());

function resolve(spec: string, solution?: string): ResolvedSymbol {
  const result = manager.resolve(spec, solution === undefined ? {} : { solution });
  assert.ok(result, `${spec} did not resolve`);
  return result;
}

/** Position of `needle` in shapes.ts (after `after`). */
function inShapes(needle: string, afterText = ""): { path: string; line: number; col: number } {
  return { path: shapes, ...locate(SHAPES_TS, needle, afterText) };
}

test("bare class name", () => {
  const r = resolve("Circle");
  assert.equal(r.kind, "class");
  assert.equal(r.name, "Circle");
  assert.equal(r.fqName, "Circle");
  assert.equal(r.solution, "single");
  assert.equal(r.project, "single-pkg");
  assert.equal(r.isDeclarationFile, false);
  assert.deepEqual(r.position, inShapes("Circle"));
  assert.equal(r.signature, "Circle");
});

test("position printing is 1-based {path}:{line}:{col}", () => {
  const r = resolve("Circle");
  // "export class Circle" is on line 5; the name starts after 13 characters
  assert.equal(formatPosition(r.position), `${shapes}:5:14`);
  assert.doesNotMatch(r.position.path, /\\/);
});

test("bare function name with signature", () => {
  const r = resolve("makeCircle");
  assert.equal(r.kind, "function");
  assert.deepEqual(r.position, inShapes("makeCircle"));
  assert.equal(r.signature, "makeCircle(radius: number): Circle");
});

test("module-qualified names resolve through a file-level module", () => {
  const circle = resolve("shapes.Circle");
  assert.equal(circle.kind, "class");
  assert.deepEqual(circle.position, inShapes("Circle"));
  assert.equal(resolve("shapes.Geometry.Point").kind, "class");
  assert.equal(resolve("shapes.Circle.area").fqName, "Circle.area");
  assert.equal(manager.resolve("shapes.NoSuchExport"), null);
});

test("generic name resolves without type arguments", () => {
  assert.equal(resolve("Circle<T>").kind, "class");
});

test("qualified members", () => {
  const area = resolve("Circle.area");
  assert.equal(area.kind, "method");
  assert.equal(area.fqName, "Circle.area");
  assert.deepEqual(area.position, inShapes("area", "class Circle"));

  const origin = resolve("Geometry.Point.origin");
  assert.equal(origin.kind, "method");
  assert.equal(origin.fqName, "Geometry.Point.origin");

  assert.equal(resolve("Circle.radius").kind, "field");
  assert.equal(resolve("Shape.area").kind, "method");
  const green = resolve("Color.Green");
  assert.equal(green.kind, "enumMember");
  assert.equal(green.fqName, "Color.Green");
});

test("Type.constructor and Type.Type mean the constructor", () => {
  const ctor = resolve("Circle.constructor");
  assert.equal(ctor.kind, "constructor");
  assert.deepEqual(ctor.position, inShapes("constructor", "class Circle"));
  assert.equal(ctor.signature, "new Circle(radius: number): Circle");

  const pointCtor = resolve("Geometry.Point.Point");
  assert.equal(pointCtor.kind, "constructor");
  assert.deepEqual(pointCtor.position, inShapes("constructor", "class Point"));
});

test("overload by parameter list", () => {
  const second = resolve("format(value: number, digits: number)");
  assert.equal(second.kind, "function");
  assert.deepEqual(second.position, inShapes("format", "format(value: string): string;\n"));
  const first = resolve("format(string)");
  assert.deepEqual(first.position, inShapes("format"));
  const impl = resolve("format(string | number, number)");
  assert.equal(impl.position.line, 22);
  // no match falls back to the first declaration
  assert.deepEqual(resolve("format(boolean)").position, inShapes("format"));
  // a class name with parameters prefers the matching constructor
  assert.equal(resolve("Circle(radius: number)").kind, "constructor");
});

test("position without column ranks declarations on the line", () => {
  // class line: the class wins over the implemented interface reference
  assert.equal(resolve(`src/shapes.ts:5`, "single").name, "Circle");
  // a constructor with parameter properties: constructor (1) beats parameters (4)
  const ctorLine = inShapes("constructor", "class Point").line;
  assert.equal(resolve(`src/shapes.ts:${ctorLine}`, "single").kind, "constructor");
  // a method line
  assert.equal(resolve(`src/shapes.ts:10`, "single").fqName, "Circle.area");
  // a local
  const local = resolve(`src/shapes.ts:11`, "single");
  assert.equal(local.name, "factor");
  assert.equal(local.kind, "variable");
  // no declaration on the line: first referenced symbol (Circle in `new Circle(radius)`)
  const reference = resolve(`src/shapes.ts:17`, "single");
  assert.equal(reference.name, "Circle");
  assert.equal(reference.kind, "class");
});

test("position with column, including one past an identifier", () => {
  const mainPath = fx.path("single/src/main.ts");
  const area = locate(MAIN_TS, "area");
  assert.equal(resolve(`${mainPath}:${area.line}:${area.col}`).fqName, "Circle.area");
  const call = locate(MAIN_TS, "makeCircle(1)");
  const pastEnd = call.col + "makeCircle".length;
  const r = resolve(`${mainPath}:${call.line}:${pastEnd}`);
  assert.equal(r.kind, "function");
  assert.equal(r.name, "makeCircle");
});

test("import alias is normalised to the original declaration", () => {
  const use = locate(MAIN_TS, "Round(2)");
  const r = resolve(`src/main.ts:${use.line}:${use.col}`, "single");
  assert.equal(r.name, "Circle");
  assert.deepEqual(r.position, inShapes("Circle"));
  assert.deepEqual(resolve("Round").position, inShapes("Circle"));
  // re-export alias
  const reexport = resolve("circleFactory");
  assert.equal(reexport.name, "makeCircle");
  assert.deepEqual(reexport.position, inShapes("makeCircle"));
});

test(".d.ts loses to source", () => {
  const r = resolve("Widget");
  assert.equal(r.isDeclarationFile, false);
  assert.equal(r.position.path, fx.path("single/src/widget.ts"));
});

test("resolution across projects of a referenced solution", () => {
  const r = resolve("coreGreeting", "mono");
  assert.equal(r.project, "@mono/core");
  assert.equal(r.position.path, fx.path("mono/packages/core/src/index.ts"));
  const use = locate(APP_TSX, "coreGreeting(");
  const fromUi = resolve(`packages/ui/src/App.tsx:${use.line}:${use.col}`, "mono");
  assert.equal(fromUi.project, "@mono/core");
  assert.equal(fromUi.position.path, fx.path("mono/packages/core/src/index.ts"));
  assert.equal(resolve("App", "mono").project, "ui");
});

test("solution hint limits the search; unknown specs return null", () => {
  assert.equal(manager.resolve("Circle", { solution: "mono" }), null);
  assert.equal(manager.resolve("Circle", { solution: "nope" }), null);
  assert.equal(manager.resolve("NoSuchThing"), null);
  assert.equal(manager.resolve("Circle.nothing"), null);
  assert.equal(manager.resolve("src/missing.ts:1"), null);
  assert.equal(manager.resolve("src/shapes.ts:999", { solution: "single" }), null);
  assert.equal(manager.resolve("((("), null);
});

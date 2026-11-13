import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import { MAX_LISTED_PROPERTIES, outline } from "../../src/workspace/outline.ts";
import type { LoadedSolution } from "../../src/workspace/solution.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { OMIT } from "./projects.ts";

let fx: Fixture;
let solution: LoadedSolution;

before(() => {
  fx = writeFixture(OMIT);
  const manager = new WorkspaceManager({ roots: [fx.root] });
  manager.discover();
  solution = manager.load("omit");
});

after(() => fx.remove());

test("the limit is 8", () => assert.equal(MAX_LISTED_PROPERTIES, 8));

test("a wide interface lists no property, but its method", () => {
  const { items } = outline(solution, "src/models.ts");
  const wide = items.findIndex((l) => l.startsWith("  interface Wide  "));
  assert.ok(wide >= 0, items.join("\n"));
  assert.ok(items[wide]!.endsWith("  9 properties omitted"), items[wide]);
  assert.equal(items[wide + 1], "    method run(): void  11");
  assert.ok(!items.slice(wide, items.findIndex((l) => l.startsWith("  interface Edge  "))).some((l) => l.includes("property ")));
});

test("Edge, Literal, Model and Many", () => {
  const result = outline(solution, "src/models.ts");
  const { items } = result;
  const edge = items.findIndex((l) => l.startsWith("  interface Edge  "));
  assert.ok(!items[edge]!.includes("omitted"), items[edge]);
  assert.equal(items.slice(edge + 1, edge + 9).filter((l) => l.startsWith("    property p")).length, 8);
  const literal = items.findIndex((l) => l.startsWith("  typeAlias Literal"));
  assert.ok(items[literal]!.endsWith("  10 properties omitted"), items[literal]);
  assert.ok(items[literal + 1]!.startsWith("  class Model"), items[literal + 1]);
  const model = items.findIndex((l) => l.startsWith("  class Model"));
  assert.ok(!items[model]!.includes("omitted"));
  assert.equal(items.slice(model + 1, model + 10).filter((l) => l.startsWith("    field f")).length, 9);
  const many = items.findIndex((l) => l.startsWith("  enum Many"));
  assert.ok(!items[many]!.includes("omitted"));
  assert.equal(items.slice(many + 1).filter((l) => l.startsWith("    enumMember M")).length, 9);
  assert.equal(
    result.footer,
    `Total: ${items.length} declarations, 19 properties omitted (read the line span, or get_outline with the type name)`,
  );
});

test("depth 1 omits nothing", () => {
  const result = outline(solution, "src/models.ts", { depth: 1 });
  assert.ok(!result.items.some((l) => l.includes("properties omitted")));
  assert.equal(result.footer, "Total: 5 declarations");
});

test("a type target lists every property", () => {
  const result = outline(solution, "Wide");
  assert.equal(result.items.filter((l) => l.includes("property p")).length, 9);
  assert.ok(result.items.some((l) => l.includes("method run(): void")));
  assert.ok(!result.items.some((l) => l.includes("properties omitted")));
  assert.ok(!result.footer?.includes("properties omitted"));
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getCallGraphText } from "../../src/workspace/callGraph.ts";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { REFS, SHARED } from "./projects.ts";

let refsFx: Fixture;
let sharedFx: Fixture;
let refs: WorkspaceManager;
let shared: WorkspaceManager;

before(() => {
  refsFx = writeFixture(REFS);
  refs = new WorkspaceManager({ roots: [refsFx.root] });
  refs.discover();
  refs.load("refs");
  sharedFx = writeFixture(SHARED);
  shared = new WorkspaceManager({ roots: [sharedFx.root] });
  shared.discover();
  shared.load("appA");
  shared.load("appB");
});

after(() => {
  refsFx.remove();
  sharedFx.remove();
});

const callersOf = (text: ReturnType<typeof getCallGraphText>) => text.groups.find((g) => g.label.startsWith("get_call_graph callers"))!;
const calleesOf = (text: ReturnType<typeof getCallGraphText>) => text.groups.find((g) => g.label.startsWith("get_call_graph callees"))!;

test("a function: one caller, one source callee, external callees on request", () => {
  const result = getCallGraphText(refs, "total");
  assert.ok(result.head[0]!.startsWith("Symbol: "), result.head[0]);
  assert.equal(result.head[1], "Project: refs-pkg (refs)");
  assert.equal(result.footer, "");
  assert.equal(callersOf(result).header, "Callers (1, live, loaded solutions only):");
  assert.equal(callersOf(result).label, "get_call_graph callers of total");
  assert.equal(callersOf(result).items.length, 1);
  assert.match(callersOf(result).items[0]!, /^ {2}Holder\.run {2}.*main\.ts:4:\d+ {2}refs$/);
  assert.equal(calleesOf(result).header, "Callees (1, source only; includeExternal=true adds node_modules and lib calls):");
  assert.equal(calleesOf(result).items.length, 1);
  assert.match(calleesOf(result).items[0]!, /^ {2}Shape\.area {2}.*shapes\.ts:1:\d+ {2}called at .*main\.ts:3:\d+$/);

  const external = getCallGraphText(refs, "total", { includeExternal: true });
  assert.equal(calleesOf(external).header, "Callees (2):");
  assert.match(calleesOf(external).items[0]!, /^ {2}.*reduce {2}\(lib\) {2}called at .*main\.ts:3:\d+$/);
  assert.match(calleesOf(external).items[1]!, /^ {2}Shape\.area {2}.*shapes\.ts:1:\d+ {2}called at .*main\.ts:3:\d+$/);
});

test("a class is its constructor: creation sites, scope, and the explicit constructor body", () => {
  const result = getCallGraphText(refs, "Circle");
  const callers = callersOf(result);
  assert.equal(callers.header, "Callers (4, live, loaded solutions only):");
  assert.match(callers.items[0]!, /^ {2}unit {2}.*main\.ts:2:\d+ {2}refs$/);
  assert.match(callers.items[1]!, /^ {2}Holder\.shape {2}.*main\.ts:4:\d+ {2}refs$/);
  assert.match(callers.items[2]!, /^ {2}<top-level> {2}.*main\.ts:5:\d+ {2}refs$/);
  assert.match(callers.items[3]!, /^ {2}fixture {2}.*test\/shapes\.test\.ts:2:\d+ {2}refs$/);

  const tests = getCallGraphText(refs, "Circle", { scope: "tests" });
  assert.equal(callersOf(tests).header, "Callers (1 of 4, scope=tests, live, loaded solutions only):");
  assert.match(callersOf(tests).items[0]!, /^ {2}fixture /);
  const production = getCallGraphText(refs, "Circle", { scope: "production" });
  assert.equal(callersOf(production).header, "Callers (3 of 4, scope=production, live, loaded solutions only):");

  const callees = calleesOf(result);
  assert.equal(callees.items.length, 1);
  assert.match(callees.items[0]!, /^ {2}Base .*shapes\.ts:2:\d+ {2}called at .*shapes\.ts:3:\d+$/);
});

test("callers keep dispatch, tagged via; siblings are not callers", () => {
  const callers = (spec: string, direct = false) => callersOf(getCallGraphText(refs, spec, { direct }));
  const circle = callers("Circle.area");
  assert.equal(circle.header, "Callers (3: 1 direct, 2 via base or interface members, live, loaded solutions only):");
  assert.equal(circle.items.length, 3);
  assert.match(circle.items.find((i) => i.includes("Holder.big"))!, /main\.ts:\d+:\d+ {2}refs$/);
  assert.match(circle.items.find((i) => i.startsWith("  total "))!, / {2}refs {2}via Shape\.area$/);
  assert.match(circle.items.find((i) => i.startsWith("  Base.describe "))!, / {2}refs {2}via Base\.area$/);
  const direct = callers("Circle.area", true);
  assert.equal(direct.header, "Callers (1, live, loaded solutions only):");
  assert.equal(direct.items.length, 1);

  const via = (spec: string): Record<string, string | null> =>
    Object.fromEntries(callers(spec).items.map((i) => [i.trim().split(" ")[0]!, /via (\S+)$/.exec(i)?.[1] ?? null]));
  assert.equal(callers("Shape.area").header, "Callers (3: 1 direct, 2 via base or interface members, live, loaded solutions only):");
  assert.deepEqual(via("Shape.area"), { total: null, "Holder.big": "Circle.area", "Base.describe": "Base.area" });
  assert.equal(callers("Base.area").header, "Callers (3: 1 direct, 2 via base or interface members, live, loaded solutions only):");
  assert.deepEqual(via("Base.area"), { "Base.describe": null, total: "Shape.area", "Holder.big": "Circle.area" });
  assert.equal(callers("Square.area").header, "Callers (2: 0 direct, 2 via base or interface members, live, loaded solutions only):");
  assert.deepEqual(via("Square.area"), { total: "Shape.area", "Base.describe": "Base.area" });
  assert.equal(callers("Tiny.area").header, "Callers (3: 0 direct, 3 via base or interface members, live, loaded solutions only):");
});

test("a method: no callers, callees with and without externals", () => {
  const result = getCallGraphText(refs, "Base.describe");
  assert.equal(callersOf(result).header, "Callers (0, live, loaded solutions only):");
  assert.deepEqual(callersOf(result).items, []);
  assert.equal(calleesOf(result).items.length, 1);
  assert.match(calleesOf(result).items[0]!, /^ {2}Base\.area /);
  const external = getCallGraphText(refs, "Base.describe", { includeExternal: true });
  assert.equal(calleesOf(external).items.length, 2);
  // call-site order: `String(` comes before `this.area()`
  assert.match(calleesOf(external).items[0]!, /^ {2}String {2}\(lib\) {2}called at .*shapes\.ts:2:\d+$/);
  assert.match(calleesOf(external).items[1]!, /^ {2}Base\.area /);
});

test("direction, unknown scope, non-callable and unknown symbols", () => {
  assert.deepEqual(getCallGraphText(refs, "total", { direction: "callers" }).groups.map((g) => g.label), ["get_call_graph callers of total"]);
  assert.deepEqual(getCallGraphText(refs, "total", { direction: "callees" }).groups.map((g) => g.label), ["get_call_graph callees of total"]);
  assert.equal(getCallGraphText(refs, "total", { direction: "Callers" }).groups.length, 1);
  assert.equal(getCallGraphText(refs, "total", { direction: "x" }).groups.length, 2);

  const iface = getCallGraphText(refs, "Shape");
  assert.deepEqual(iface.head, [
    "Shape resolved to interface Shape. get_call_graph needs a function, method, constructor, accessor or class; use find_references for types and values.",
  ]);
  assert.deepEqual(iface.groups, []);
  const bad = getCallGraphText(refs, "total", { scope: "x" });
  assert.deepEqual(bad.head, ["get_call_graph: unknown scope 'x'. Accepted: all, production, tests."]);
  assert.deepEqual(bad.groups, []);
  const missing = getCallGraphText(refs, "nothing_here");
  assert.ok(missing.head[0]!.startsWith("Symbol not found in any loaded solution: nothing_here"), missing.head[0]);
  assert.deepEqual(missing.groups, []);
  assert.equal(missing.footer, "");
});

test("an accessor and a property arrow function are roots; a plain value is not", () => {
  const big = getCallGraphText(refs, "Holder.big");
  assert.equal(callersOf(big).items.length, 0);
  assert.match(calleesOf(big).items[0]!, /^ {2}Circle\.area /); // `this.shape` is inferred as Circle
  assert.ok(getCallGraphText(refs, "unit").head[0]!.includes("get_call_graph needs a function"));
});

test("callers in twin solutions are listed after the defining solution", () => {
  const make = getCallGraphText(shared, "makeGadget", { solution: "appA" });
  assert.equal(callersOf(make).header, "Callers (1, live, loaded solutions only):");
  assert.match(callersOf(make).items[0]!, /^ {2}b {2}.*appB\/src\/b\.ts:2:\d+ {2}appB$/);
  assert.equal(calleesOf(make).items.length, 1);
  assert.match(calleesOf(make).items[0]!, /^ {2}Gadget {2}.*shared\/src\/lib\.ts:1:\d+ {2}called at /);

  const spin = getCallGraphText(shared, "Gadget.spin", { solution: "appA" });
  assert.equal(callersOf(spin).items.length, 1);
  assert.match(callersOf(spin).items[0]!, /^ {2}spun {2}.*appA\/src\/a\.ts:3:\d+ {2}appA$/);

  const tagged = getCallGraphText(shared, "makeGadget", { solution: "appA", groupSuffix: (path, hits) => ` [twin ${hits}]` });
  assert.equal(callersOf(tagged).header, "Callers (1, live, loaded solutions only): [twin 1]");
});

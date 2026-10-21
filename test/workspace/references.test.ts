import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { formatGroupedText } from "../../src/workspace/display.ts";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import { findReferencesText, gather, resolveTargets } from "../../src/workspace/references.ts";
import type { Fixture } from "../fixtures.ts";
import { locate, writeFixture } from "../fixtures.ts";
import { REFS, REFS_MAIN_TS, REFS_SHAPES_TS, REFS_TEST_TS, SINGLE, UNION } from "./projects.ts";

let fx: Fixture;
let manager: WorkspaceManager;
let shapes: string;
let main: string;
let test_: string;

before(() => {
  fx = writeFixture({ ...REFS, ...SINGLE });
  manager = new WorkspaceManager({ roots: [fx.root] });
  manager.discover();
  manager.load("refs");
  manager.load("single");
  shapes = fx.path("refs/src/shapes.ts");
  main = fx.path("refs/src/main.ts");
  test_ = fx.path("refs/test/shapes.test.ts");
});

after(() => fx.remove());

function at(path: string, text: string, needle: string, after = ""): string {
  const { line, col } = locate(text, needle, after);
  return `${path}:${line}:${col}`;
}

const HEADER_LINES = 3;

test("Circle: every usage with kind and enclosing member", () => {
  const result = findReferencesText(manager, "Circle", { solution: "refs" });
  assert.equal(result.head.length, HEADER_LINES);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]!.header, "Live refs: 7 references");
  assert.equal(result.groups[0]!.label, "find_references Circle in refs");
  assert.deepEqual(result.groups[0]!.items, [
    `  ${at(main, REFS_MAIN_TS, "Circle")}  refs-pkg  import`,
    `  ${at(main, REFS_MAIN_TS, "Circle", "unit = new ")}  refs-pkg  creation  in unit`,
    `  ${at(main, REFS_MAIN_TS, "Circle", "shape = new ")}  refs-pkg  creation  in Holder.shape`,
    `  ${at(main, REFS_MAIN_TS, "Circle", "\nnew ")}  refs-pkg  creation  in <top-level>`,
    `  ${at(shapes, REFS_SHAPES_TS, "Circle", "Tiny extends ")}  refs-pkg  base  in Tiny`,
    `  ${at(test_, REFS_TEST_TS, "Circle")}  refs-pkg  import`,
    `  ${at(test_, REFS_TEST_TS, "Circle", "= new ")}  refs-pkg  creation  in fixture`,
  ]);
  assert.equal(result.footer, "Total: 7 references");
});

test("Circle: scope and kind filters", () => {
  const header = (options: { kind?: string; scope?: string }): string[] => {
    const r = findReferencesText(manager, "Circle", { solution: "refs", ...options });
    return [r.groups[0]!.header, r.footer];
  };
  assert.deepEqual(header({ scope: "production" }), [
    "Live refs: 5 of 7 references (scope=production)",
    "Total: 5 references (scope=production)",
  ]);
  assert.equal(header({ scope: "TESTS" })[0], "Live refs: 2 of 7 references (scope=tests)");
  assert.equal(header({ scope: "test" })[0], "Live refs: 2 of 7 references (scope=tests)");
  assert.equal(header({ kind: "creation" })[0], "Live refs: 4 of 7 references (kind=creation)");
  assert.equal(
    header({ kind: "creation", scope: "production" })[0],
    "Live refs: 3 of 7 references (kind=creation; scope=production)",
  );
  assert.equal(header({ kind: " Import, base ,," })[0], "Live refs: 3 of 7 references (kind=base,import)");
  assert.equal(header({ scope: " " })[0], "Live refs: 7 references");
});

test("function, decorator and type usages", () => {
  const total = findReferencesText(manager, "total", { solution: "refs" });
  assert.deepEqual(total.groups[0]!.items, [`  ${at(main, REFS_MAIN_TS, "total", "run(): number { return ")}  refs-pkg  invocation  in Holder.run`]);
  assert.equal(total.footer, "Total: 1 references");

  // the bare name `Tag` resolves to the lib.dom interface WebAssembly.Tag (types outrank functions), so use a position
  const tag = findReferencesText(manager, `${shapes}:6`, { solution: "refs" });
  assert.deepEqual(tag.groups[0]!.items, [
    `  ${at(main, REFS_MAIN_TS, "Tag")}  refs-pkg  import`,
    `  ${at(main, REFS_MAIN_TS, "Tag", "@")}  refs-pkg  decorator  in Holder.run`,
  ]);
  assert.equal(tag.footer, "Total: 2 references");

  const shape = findReferencesText(manager, "Shape", { solution: "refs" });
  assert.deepEqual(shape.groups[0]!.items, [
    `  ${at(main, REFS_MAIN_TS, "Shape")}  refs-pkg  import`,
    `  ${at(main, REFS_MAIN_TS, "Shape", "shapes: ")}  refs-pkg  usage  in total`,
    `  ${at(shapes, REFS_SHAPES_TS, "Shape", "implements ")}  refs-pkg  base  in Base`,
  ]);
  assert.equal(shape.footer, "Total: 3 references");
});

test("member references bind to the declaration itself", () => {
  const run = (spec: string) => findReferencesText(manager, spec, { solution: "refs" });
  const shapeArea = run("Shape.area");
  assert.equal(shapeArea.groups[0]!.header, "Live refs: 1 references");
  assert.deepEqual(shapeArea.groups[0]!.items, [`  ${at(main, REFS_MAIN_TS, "area", "sum + s.")}  refs-pkg  invocation  in total`]);
  const baseArea = run("Base.area");
  assert.equal(baseArea.groups[0]!.header, "Live refs: 1 references");
  assert.deepEqual(baseArea.groups[0]!.items, [`  ${at(shapes, REFS_SHAPES_TS, "area", "String(this.")}  refs-pkg  invocation  in Base.describe`]);
  const circleArea = run("Circle.area");
  assert.equal(circleArea.groups[0]!.header, "Live refs: 1 references");
  assert.deepEqual(circleArea.groups[0]!.items, [`  ${at(main, REFS_MAIN_TS, "area", "this.shape.")}  refs-pkg  invocation  in Holder.big`]);
  for (const spec of ["Square.area", "Tiny.area"]) {
    const result = run(spec);
    assert.equal(result.groups[0]!.header, "Live refs: 0 references");
    assert.deepEqual(result.groups[0]!.items, []);
    assert.equal(result.footer, "Total: 0 references");
  }
  for (const result of [shapeArea, baseArea, circleArea]) {
    for (const item of result.groups[0]!.items) assert.match(item, / {2}invocation {2}/);
  }
});

test("gather tags the family usages with the member they bind to", () => {
  const hitsOf = (spec: string) => {
    const target = resolveTargets(manager, spec, "refs", false, undefined)!.targets[0]!;
    return gather(target).map((h) => h.via);
  };
  assert.deepEqual(hitsOf("Circle.area").sort(), ["Base.area", "Shape.area", null]);
  const square = hitsOf("Square.area");
  assert.ok(!square.includes(null));
  assert.ok(square.includes("Shape.area") && square.includes("Base.area"));
  assert.ok(!square.includes("Circle.area"));
  assert.ok(!hitsOf("Circle.area").includes("Tiny.area") && !hitsOf("Circle.area").includes("Square.area"));
});

test("a call on a union binds to the first member of the synthetic property", () => {
  const fxu = writeFixture(UNION);
  try {
    const m = new WorkspaceManager({ roots: [fxu.root] });
    m.discover();
    m.load("union");
    const count = (spec: string): number => findReferencesText(m, spec, { solution: "union" }).groups[0]!.items.length;
    assert.equal(count("A.f"), 1);
    assert.equal(count("B.f"), 1);
    assert.equal(count("C.f"), 0);
  } finally {
    fxu.remove();
  }
});

test("allSolutions false and several solutions", () => {
  const defining = findReferencesText(manager, "Circle", { solution: "refs", allSolutions: false });
  assert.ok(defining.footer.endsWith("(defining solution only; pass allSolutions=true to include other solutions)"));
  assert.equal(defining.footer, "Total: 7 references (defining solution only; pass allSolutions=true to include other solutions)");
  // `single` also has a Circle, but in another file: no twin, so refs (loaded first) is the only group
  const all = findReferencesText(manager, "Circle");
  assert.equal(all.groups.length, 1);
  assert.equal(all.groups[0]!.header, "Live refs: 7 references");
  const text = formatGroupedText(findReferencesText(manager, "Circle", { solution: "refs" }), 2);
  assert.ok(text.includes("\nLive refs: 7 references\n"));
  assert.ok(text.includes("  ... 5 more\nTotal: 7 references"));
});

test("errors", () => {
  assert.deepEqual(findReferencesText(manager, "Circle", { kind: "nope" }), {
    head: ["find_references: unknown kind 'nope'. Accepted: usage, invocation, creation, base, decorator, import; several are comma-separated."],
    groups: [],
    footer: "",
  });
  assert.deepEqual(findReferencesText(manager, "Circle", { scope: "x" }).head, [
    "find_references: unknown scope 'x'. Accepted: all, production, tests.",
  ]);
  const missing = findReferencesText(manager, "NoSuch");
  assert.deepEqual(missing.head, [
    "Symbol not found in any loaded solution: NoSuch",
    "Tip: use search_symbols to find the exact name, or load_solution if the owning solution is not loaded yet.",
  ]);
  assert.deepEqual(missing.groups, []);
  assert.equal(missing.footer, "Total: 0 references");
  assert.equal(findReferencesText(manager, "Circle", { solution: "unknown" }).footer, "Total: 0 references");
});

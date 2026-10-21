import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Extraction } from "../../src/index/index.ts";
import { extractDocument } from "../../src/workspace/extractor.ts";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import type { LoadedSolution } from "../../src/workspace/solution.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { MONO, REFS } from "./projects.ts";

let fx: Fixture;
let refs: LoadedSolution;
let mono: LoadedSolution;

before(() => {
  fx = writeFixture({ ...REFS, ...MONO });
  const manager = new WorkspaceManager({ roots: [fx.root] });
  manager.discover();
  refs = manager.load("refs");
  mono = manager.load("mono");
});

after(() => fx.remove());

function extract(solution: LoadedSolution, relative: string): Extraction {
  const path = fx.path(relative);
  for (const project of solution.projects) {
    const program = project.service.getProgram()!;
    const sourceFile = program.getSourceFile(path);
    if (sourceFile) return extractDocument(project, sourceFile, program.getTypeChecker(), { solution, program });
  }
  throw new Error(`${path} is not in ${solution.name}`);
}

const S = "refs-pkg/shapes#";
const M = "refs-pkg/main#";

test("shapes.ts: symbols with docIds, kinds, accessibility and spans", () => {
  const { symbols } = extract(refs, "refs/src/shapes.ts");
  assert.deepEqual(
    symbols.map((s) => s.docId).sort(),
    [
      "Base", "Base.area", "Base.describe", "Circle", "Circle.area", "Circle.constructor", "Circle.r", "Shape",
      "Shape.area", "Square", "Square.area", "Tag", "Tiny", "Tiny.area",
    ].map((n) => S + n).sort(),
  );
  const circle = symbols.find((s) => s.docId === `${S}Circle`)!;
  assert.equal(circle.kind, "class");
  assert.equal(circle.accessibility, "export");
  assert.equal(circle.line, 3);
  assert.equal(circle.col, 14);
  assert.equal(circle.endLine, 3);
  assert.equal(circle.containingDocId, null);
  const r = symbols.find((s) => s.docId === `${S}Circle.r`)!;
  assert.equal(r.kind, "field");
  assert.equal(r.accessibility, "public");
  assert.equal(r.containingDocId, `${S}Circle`);
  const ctor = symbols.find((s) => s.docId === `${S}Circle.constructor`)!;
  assert.equal(ctor.kind, "constructor");
  assert.equal(ctor.signature, "new Circle(r: number): Circle");
  assert.equal(symbols.find((s) => s.docId === `${S}Tag`)!.signature, "Tag(_t: unknown, _c: unknown): void");
  assert.equal(symbols.find((s) => s.docId === `${S}Base.area`)!.containingDocId, `${S}Base`);
});

test("shapes.ts: heritage and member relations", () => {
  const { relations } = extract(refs, "refs/src/shapes.ts");
  const has = (from: string, to: string, kind: string): boolean =>
    relations.some((r) => r.fromDocId === S + from && r.toDocId === S + to && r.kind === kind);
  assert.ok(has("Base", "Shape", "implements"));
  assert.ok(has("Circle", "Base", "inherits"));
  assert.ok(has("Tiny", "Circle", "inherits"));
  assert.ok(has("Tiny.area", "Circle.area", "overrides"));
  assert.ok(has("Tiny.area", "Base.area", "overrides"));
  assert.ok(has("Circle.area", "Base.area", "overrides"));
  assert.ok(has("Base.area", "Shape.area", "implements"));
  assert.ok(has("Square.area", "Shape.area", "implements"));
  assert.ok(!relations.some((r) => r.kind === "overrides" && r.fromDocId === `${S}Base.describe`));
});

test("main.ts: references with kinds and enclosing docIds; nothing from default libraries", () => {
  const { references } = extract(refs, "refs/src/main.ts");
  const circle = references
    .filter((r) => r.targetDocId === `${S}Circle`)
    .map((r) => ({ kind: r.kind, at: `${r.line}:${r.col}`, from: r.fromDocId }));
  assert.deepEqual(circle, [
    { kind: "import", at: "1:10", from: null },
    { kind: "creation", at: "2:25", from: `${M}unit` },
    { kind: "creation", at: "4:35", from: `${M}Holder.shape` },
    { kind: "creation", at: "5:5", from: "<top-level>" },
  ]);
  assert.ok(references.some((r) => r.targetDocId === `${S}Tag` && r.kind === "decorator" && r.fromDocId === `${M}Holder.run`));
  assert.ok(references.some((r) => r.targetDocId === `${S}Shape.area` && r.kind === "invocation" && r.fromDocId === `${M}total`));
  for (const r of references) {
    assert.ok(r.targetDocId.startsWith("refs-pkg/"), r.targetDocId);
    assert.ok(!/#(Array|String|reduce)$/.test(r.targetDocId), r.targetDocId);
  }
  const keys = references.map((r) => `${r.targetDocId}:${r.line}:${r.col}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("shapes.ts: references to parameter properties and own members, none to parameters", () => {
  const { references } = extract(refs, "refs/src/shapes.ts");
  assert.ok(references.some((r) => r.targetDocId === `${S}Circle.r` && r.fromDocId === `${S}Circle.area`));
  assert.ok(references.some((r) => r.targetDocId === `${S}Base.area` && r.fromDocId === `${S}Base.describe`));
  assert.ok(!references.some((r) => r.targetDocId.endsWith("#_t") || r.targetDocId.endsWith("Tag._t")));
});

test("mono: docIds use the package name and the owning project across project references", () => {
  const core = extract(mono, "mono/packages/core/src/index.ts");
  assert.deepEqual(core.symbols.map((s) => s.docId), ["@mono/core/index#coreGreeting"]);
  const app = extract(mono, "mono/packages/ui/src/App.tsx");
  assert.deepEqual(app.symbols.map((s) => s.docId), ["ui/src/App#App"]);
  assert.ok(app.references.some((r) => r.targetDocId === "@mono/core/index#coreGreeting" && r.kind === "invocation"));
});

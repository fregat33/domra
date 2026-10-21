import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { diagnosticsText } from "../../src/workspace/diagnostics.ts";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { BAD_TS, DIAG } from "./projects.ts";

let fx: Fixture;
let manager: WorkspaceManager;
let bad: string;

const SUFFIX = "(compiler only; lint is not run)";

before(() => {
  fx = writeFixture(DIAG);
  manager = new WorkspaceManager({ roots: [fx.root] });
  manager.discover();
  manager.load("diag");
  bad = fx.path("diag/src/bad.ts");
});

after(() => fx.remove());

test("file target: errors only by default", () => {
  const result = diagnosticsText(manager, bad);
  assert.deepEqual(result.head, [`Diagnostics for ${bad}: 2 errors, 0 warnings ${SUFFIX}`]);
  assert.deepEqual(result.items, [
    `  ${bad}:1:14  error TS2322: Type 'string' is not assignable to type 'number'.`,
    `  ${bad}:3:3  error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`,
  ]);
  assert.equal(result.label, `get_diagnostics ${bad}`);
  assert.equal(result.footer, undefined);
});

test("severity filter", () => {
  const info = diagnosticsText(manager, bad, { minSeverity: "INFO" });
  assert.equal(info.items.length, 3);
  assert.ok(info.items.some((l) => /^ {2}.*bad\.ts:4:35 {2}info TS6133: 'unused' is declared but its value is never read\.$/.test(l)));
  assert.equal(diagnosticsText(manager, bad, { minSeverity: "information" }).items.length, 3);
  assert.equal(diagnosticsText(manager, bad, { minSeverity: "error" }).items.length, 2);
  assert.equal(diagnosticsText(manager, bad, { minSeverity: "bogus" }).items.length, 2);
});

test("clean and unparsable files", () => {
  const ok = fx.path("diag/src/ok.ts");
  const clean = diagnosticsText(manager, ok);
  assert.deepEqual(clean.head, [`Diagnostics for ${ok}: 0 errors, 0 warnings ${SUFFIX}`]);
  assert.deepEqual(clean.items, []);

  const syntax = fx.path("diag/src/syntax.ts");
  const broken = diagnosticsText(manager, syntax);
  assert.ok(broken.items.length >= 1);
  for (const item of broken.items) assert.ok(item.startsWith(`  ${syntax}:1:`) && item.includes("error TS"), item);
});

test("project target", () => {
  const result = diagnosticsText(manager, "diag-pkg");
  assert.match(result.head[0]!, /^Diagnostics for diag-pkg: (\d+) errors, 0 warnings /);
  assert.ok(Number(/: (\d+) errors/.exec(result.head[0]!)![1]) >= 3);
  const paths = result.items.map((l) => /^ {2}(\S+?):\d+:\d+ /.exec(l)![1]!);
  assert.deepEqual(paths, [...paths].sort());
  assert.ok(paths.includes(bad) && paths.includes(fx.path("diag/src/syntax.ts")));
  assert.deepEqual(diagnosticsText(manager, "DIAG-PKG").head, result.head);
  assert.deepEqual(diagnosticsText(manager, "nope").head, ["No project named nope in diag. Projects: diag-pkg"]);
  assert.deepEqual(diagnosticsText(manager, "nope").items, []);
});

test("relative targets and error cases", () => {
  assert.deepEqual(diagnosticsText(manager, "src/bad.ts", { solution: "diag" }).items.length, 2);
  assert.deepEqual(diagnosticsText(manager, "src/bad.ts").items.length, 2);
  const missing = diagnosticsText(manager, "src/missing.ts", { solution: "diag" });
  assert.ok(
    missing.head[0]!.endsWith("is not part of diag. New files are picked up on save; otherwise check the project globs."),
    missing.head[0],
  );
  const outside = "C:/definitely/elsewhere/x.ts";
  assert.deepEqual(diagnosticsText(manager, outside).head, [`No loaded solution contains ${outside}`]);
  assert.deepEqual(diagnosticsText(new WorkspaceManager({ roots: [fx.root] }), "diag-pkg").head, ["No solution loaded."]);
});

test("file is synced from disk before analysis", () => {
  try {
    writeFileSync(bad, "export const n: number = 1;\n");
    const fixed = diagnosticsText(manager, bad);
    assert.equal(fixed.head[0], `Diagnostics for ${bad}: 0 errors, 0 warnings ${SUFFIX}`);
    writeFileSync(bad, BAD_TS);
    assert.equal(diagnosticsText(manager, bad).items.length, 2);
  } finally {
    writeFileSync(bad, BAD_TS);
  }
});

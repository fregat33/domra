import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { BROKEN, IGNORED, MONO, SINGLE } from "./projects.ts";

let fx: Fixture;
let manager: WorkspaceManager;

before(() => {
  fx = writeFixture({ ...SINGLE, ...MONO, ...BROKEN, ...IGNORED });
  manager = new WorkspaceManager({ roots: [fx.root] });
  manager.discover();
});

after(() => fx.remove());

test("solution with references loads two projects with correct names", () => {
  const mono = manager.load("mono");
  assert.deepEqual(
    mono.projects.map((p) => p.name),
    ["@mono/core", "ui"],
  );
  assert.equal(mono.fileCount, 2);
  assert.ok(mono.projects[1]!.fileNames.some((f) => f.endsWith("/App.tsx")));
  // the ui project imports @mono/core, which maps to an unbuilt .d.ts; the project reference
  // redirects it to core's source, so nothing is unresolved
  assert.equal(mono.unresolvedImports, 0);
  assert.equal(mono.projects[0]!.diagnostics.length, 0);
});

test("single-project solution is named from its directory, project from package.json", () => {
  const single = manager.load("single");
  assert.equal(single.name, "single");
  assert.deepEqual(single.projects.map((p) => p.name), ["single-pkg"]);
  assert.equal(single.fileCount, 4);
  assert.equal(single.unresolvedImports, 0);
});

test("missing package is counted, loading still succeeds", () => {
  const broken = manager.load("broken");
  assert.equal(broken.unresolvedImports, 1);
  assert.deepEqual(broken.projects.map((p) => p.name), ["broken"]);
  assert.ok(broken.projects[0]!.service.getProgram());
});

test("metrics cover the whole program, not only root files", () => {
  const files = writeFixture({
    "m1/tsconfig.json": { compilerOptions: { moduleResolution: "Bundler", module: "ESNext", types: [] }, files: ["src/main.ts"] },
    "m1/src/main.ts": 'import "./a";\nimport "./b";\nimport "missing-pkg";\n',
    "m1/src/a.ts": "export const a = 1;\n",
    "m1/src/b.ts": "export const b = 2;\n",
    "m2/tsconfig.json": { compilerOptions: { moduleResolution: "Bundler", module: "ESNext", types: [] }, files: ["src/main.ts"] },
    "m2/src/main.ts": 'import "./a";\nexport * from "./gone";\n',
    "m2/src/a.ts": 'import { x } from "./gone-too";\nexport const a = x;\n',
  });
  try {
    const m = new WorkspaceManager({ roots: [files.root] });
    m.discover();
    const one = m.load("m1");
    assert.equal(one.projects[0]!.rootFiles, 1);
    assert.equal(one.projects[0]!.sourceFiles, 3);
    assert.equal(one.unresolved.relative, 0);
    assert.equal(one.unresolved.package, 1);
    assert.equal(one.unresolvedImports, 1);
    const two = m.load("m2");
    assert.equal(two.rootFiles, 1);
    assert.equal(two.sourceFiles, 2);
    assert.equal(two.unresolved.relative, 2);
    assert.equal(two.unresolved.package, 0);
    assert.equal(m.status().find((s) => s.name === "m2")?.unresolved?.relative, 2);
  } finally {
    files.remove();
  }
});

test("loading never writes to disk and edits stay in memory", () => {
  const single = manager.load("single");
  const project = single.projects[0]!;
  const widget = fx.path("single/src/widget.ts");
  project.host.setFile(widget, "export class Widget { size = 2; extra = 3; }\n");
  const text = project.service.getProgram()!.getSourceFile(widget)!.text;
  assert.match(text, /extra/);
  assert.doesNotMatch(readFileSync(widget, "utf8"), /extra/);
  project.host.setFile(widget, readFileSync(widget, "utf8"));
});

test("manager status, resolveSolution and findSolutionForPath", () => {
  manager.load("single");
  const status = manager.status();
  assert.deepEqual(
    status.map((s) => s.name),
    ["broken", "mono", "single"],
  );
  assert.ok(status.every((s) => s.state === "loaded"));
  assert.equal(manager.resolveSolution(fx.path("mono/tsconfig.json"))?.name, "mono");
  assert.equal(manager.resolveSolution("sing")?.name, "single");
  assert.equal(manager.resolveSolution("nothing"), null);
  assert.equal(manager.findSolutionForPath(fx.path("mono/packages/ui/src/App.tsx"))?.name, "mono");
  assert.equal(manager.findSolutionForPath(fx.path("single/src/new-file.ts"))?.name, "single");
  assert.equal(manager.findSolutionForPath(fx.path("elsewhere/x.ts")), null);
});

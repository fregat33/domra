import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import { fileNameIndex, resolveInSolution } from "../../src/workspace/resolver.ts";
import type { LoadedSolution } from "../../src/workspace/solution.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";

const FILES = {
  "p/tsconfig.json": {
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, types: [] },
    include: ["src"],
  },
  // member < variable
  "p/src/a.ts": `export class Holder { Pick1 = 1; }\nexport const Pick1 = 1;\n`,
  // variable < function
  "p/src/b.ts": `export const Pick2 = 1;\nexport function Pick2b() {}\nexport function Pick3() {}\nexport const Pick3Var = 1;\n`,
  "p/src/b2.ts": `export const Pick3 = 1;\n`,
  // function < type
  "p/src/c.ts": `export function Pick4() {}\nexport interface Pick5 {}\n`,
  "p/src/c2.ts": `export interface Pick4 {}\nexport const Pick5 = 1;\n`,
  // shortest fqName wins; the nested one sorts first by file name
  "p/src/d.ts": `export namespace Outer { export class Tie {} }\n`,
  "p/src/z.ts": `export class Tie {}\n`,
  "p/src/overloads.ts": `export function over(a: string): void;\nexport function over(a: number): void;\nexport function over(a: any): void {}\nexport function plain(a, b) {}\n`,
};

let fx: Fixture;
let manager: WorkspaceManager;
let solution: LoadedSolution;

before(() => {
  fx = writeFixture(FILES);
  manager = new WorkspaceManager({ roots: [fx.root] });
  manager.discover();
  solution = manager.load("p");
});

after(() => fx.remove());

function resolve(spec: string) {
  const result = resolveInSolution(solution, spec);
  assert.ok(result, `${spec} did not resolve`);
  return result;
}

test("bare-name category order: type over function over variable over member", () => {
  assert.equal(resolve("Pick1").kind, "variable"); // top-level variable beats a member field
  assert.equal(resolve("Pick3").kind, "function"); // function beats variable
  assert.equal(resolve("Pick4").kind, "interface"); // type beats function
});

test("bare-name tie-break prefers the shortest fqName", () => {
  assert.equal(resolve("Tie").fqName, "Tie");
  assert.match(resolve("Tie").position.path, /z\.ts$/);
});

test("per-file name index is reused after setFile on another file", () => {
  const project = solution.projects[0]!;
  const programBefore = project.service.getProgram()!;
  const files = programBefore.getSourceFiles();
  const lib = files.find((f) => programBefore.isSourceFileDefaultLibrary(f))!;
  const untouched = programBefore.getSourceFile(fx.path("p/src/z.ts"))!;
  const edited = programBefore.getSourceFile(fx.path("p/src/a.ts"))!;
  const libIndex = fileNameIndex(lib);
  const untouchedIndex = fileNameIndex(untouched);
  const editedIndex = fileNameIndex(edited);

  project.host.setFile(fx.path("p/src/a.ts"), `export class Holder { Pick1 = 2; }\nexport const Pick1 = 2;\n`);
  const programAfter = project.service.getProgram()!;
  assert.notEqual(programAfter, programBefore);

  assert.equal(fileNameIndex(programAfter.getSourceFile(lib.fileName)!), libIndex);
  assert.equal(fileNameIndex(programAfter.getSourceFile(untouched.fileName)!), untouchedIndex);
  assert.notEqual(fileNameIndex(programAfter.getSourceFile(edited.fileName)!), editedIndex);
  assert.equal(resolve("Pick1").kind, "variable");
});

test("overload selection compares annotation text before asking the checker", () => {
  const program = solution.projects[0]!.service.getProgram()!;
  const checker = program.getTypeChecker();
  const original = checker.getTypeAtLocation;
  let calls = 0;
  checker.getTypeAtLocation = ((...args: Parameters<typeof original>) => {
    calls++;
    return original.apply(checker, args);
  }) as typeof original;
  try {
    const hit = resolve("over(string)");
    assert.equal(hit.signature, "over(a: string): void");
    assert.equal(calls, 0);
    // un-annotated parameters have no text to compare, so the checker is consulted
    resolve("plain(any, any)");
    assert.ok(calls > 0);
    calls = 0;
    resolve("over(boolean)"); // mismatch falls back to the checker
    assert.ok(calls > 0);
  } finally {
    checker.getTypeAtLocation = original;
  }
});

test("internal errors go to onError and resolve still returns null", () => {
  const broken = {
    ...solution,
    projects: solution.projects.map((p) => ({
      ...p,
      service: {
        getProgram() {
          throw new Error("boom");
        },
      } as unknown as typeof p.service,
    })),
  };
  const errors: unknown[] = [];
  assert.equal(
    resolveInSolution(broken, "Tie", { onError: (error, spec) => errors.push([error, spec]) }),
    null,
  );
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as [Error, string])[1], "Tie");
  assert.equal(resolveInSolution(broken, "Tie"), null);
  assert.equal(resolveInSolution(broken, "Tie", { onError: () => { throw new Error("handler"); } }), null);
});

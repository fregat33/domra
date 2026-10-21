import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import type { ReviewOptions } from "../../src/workspace/review.ts";
import { reviewChangesText } from "../../src/workspace/review.ts";
import { adoptRootFile, SnapshotHost } from "../../src/workspace/solution.ts";
import ts from "typescript";
import type { LoadedProject } from "../../src/workspace/solution.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { FakeGit } from "./fakeGit.ts";
import { gather } from "../../src/workspace/references.ts";
import { findInSolution } from "../../src/workspace/resolver.ts";
import { REFS, REFS_MAIN_TS, REFS_SHAPES_TS, REFS_TEST_TS } from "./projects.ts";

type Scenario = {
  fx: Fixture;
  manager: WorkspaceManager;
  git: FakeGit;
  project: LoadedProject;
  /** Rewrite a committed file on disk (the review pushes it into the host) and record its base text. */
  edit(rel: string, text: string): string;
  /** Delete a committed file on disk and in the host. */
  remove(rel: string): string;
  /** Create an untracked or added file on disk and adopt it as a root (what the watcher does). */
  add(rel: string, text: string, root?: boolean): string;
  review(options?: Partial<ReviewOptions>): ReturnType<typeof reviewChangesText>;
};

async function withScenario(run: (s: Scenario) => Promise<void>): Promise<void> {
  const fx = writeFixture(REFS);
  try {
    const manager = new WorkspaceManager({ roots: [fx.root] });
    manager.discover();
    const solution = manager.load("refs");
    const project = solution.projects[0]!;
    const git = new FakeGit(fx.root);
    const scenario: Scenario = {
      fx, manager, git, project,
      edit(rel, text) {
        const path = fx.path(rel);
        git.baseTexts.set(rel, readFileSync(path, "utf8"));
        writeFileSync(path, text);
        git.files.push({ path, status: "modified" });
        return path;
      },
      remove(rel) {
        const path = fx.path(rel);
        git.baseTexts.set(rel, readFileSync(path, "utf8"));
        rmSync(path);
        project.host.setFile(path, null);
        git.files.push({ path, status: "deleted" });
        return path;
      },
      add(rel, text, root = true) {
        const path = fx.path(rel);
        writeFileSync(path, text);
        if (root) adoptRootFile(project, path);
        git.files.push({ path, status: "added" });
        return path;
      },
      review: (options = {}) => reviewChangesText(manager, { git, ...options }),
    };
    await run(scenario);
  } finally {
    fx.remove();
  }
}

const GONE = "      references: Live refs {n} before removal (usages left show as errors below)";
const shapesLine = (n: number): string => REFS_SHAPES_TS.split("\n")[n - 1]!;
const replaceLine = (text: string, n: number, line: string): string => {
  const lines = text.split("\n");
  lines[n - 1] = line;
  return lines.join("\n");
};

test("body edit: one body-only line with exact head and footer", async () => {
  await withScenario(async (s) => {
    const loop = "export function total(shapes: Shape[]): number { let sum = 0; for (const s of shapes) sum += s.area(); return sum; }";
    const started = performance.now();
    const main = s.edit("refs/src/main.ts", replaceLine(REFS_MAIN_TS, 3, loop));
    const result = await s.review();
    console.log(`review.test: one modified file reviewed in ${Math.round(performance.now() - started)} ms`);
    assert.deepEqual(result.head, ["Review: refs  working tree vs main (merge-base abc1234)  1 files changed: 1 source, 0 project, 0 other"]);
    assert.deepEqual(result.items, [`${main}  modified  body-only`, "  ~ body  total  export  3", "      callers: 1"]);
    assert.equal(result.footer, "Total: 1 source files, 1 changed declarations (0 surface, 1 body-only or private), 0 errors, 0 warnings");
    assert.equal(result.label, "review_changes refs vs main");
    assert.equal(s.project.host.getText(main)?.includes("for (const s of shapes)"), true, "disk text pushed into the live host");
  });
});

test("signature: a constructor parameter is a signature change", async () => {
  await withScenario(async (s) => {
    const line = shapesLine(3).replace("constructor(public r: number)", "constructor(public r: number, k: number)");
    const shapes = s.edit("refs/src/shapes.ts", replaceLine(REFS_SHAPES_TS, 3, line));
    const result = await s.review();
    assert.deepEqual(result.items, [
      `${shapes}  modified  surface`,
      "  ~ signature  Circle.constructor  new Circle(r: number): Circle -> new Circle(r: number, k: number): Circle  3",
      "      references: Live refs 4 (3 production, 1 tests)",
    ]);
  });
});

test("removed: a deleted member and the diagnostic it causes", async () => {
  await withScenario(async (s) => {
    const shapes = s.edit("refs/src/shapes.ts", replaceLine(REFS_SHAPES_TS, 4, "export class Square extends Base { }"));
    const result = await s.review();
    assert.deepEqual(result.items, [
      `${shapes}  modified  surface`,
      "  - method  Square.area  public  was 4",
      "      references: Live refs 0 before removal (usages left show as errors below)",
      "Diagnostics on changed files: 1 errors, 0 warnings (compiler only; lint is not run)",
      `  ${shapes}:4:14  error TS2515: Non-abstract class 'Square' does not implement inherited abstract member area from class 'Base'.`,
    ]);
    assert.equal(result.footer, "Total: 1 source files, 1 changed declarations (1 surface, 0 body-only or private), 1 errors, 0 warnings");
  });
});

test("added: a new interface member and the classes missing it", async () => {
  await withScenario(async (s) => {
    const shapes = s.edit("refs/src/shapes.ts", replaceLine(REFS_SHAPES_TS, 1, "export interface Shape { area(): number; perimeter(): number; }"));
    const result = await s.review();
    assert.deepEqual(result.items.slice(0, 4), [
      `${shapes}  modified  surface`,
      "  + method  Shape.perimeter  public  1",
      "      implementations: Live refs 0",
      "Diagnostics on changed files: 1 errors, 0 warnings (compiler only; lint is not run)",
    ]);
    assert.match(result.items[4]!, /shapes\.ts:2:23  error TS2420: Class 'Base' incorrectly implements interface 'Shape'\./);
    assert.equal(result.items.length, 5);
    assert.equal(result.footer, "Total: 1 source files, 1 changed declarations (1 surface, 0 body-only or private), 1 errors, 0 warnings");
  });
});

test("header: an explicit implements clause", async () => {
  await withScenario(async (s) => {
    const line = shapesLine(4).replace("extends Base", "extends Base implements Shape");
    const shapes = s.edit("refs/src/shapes.ts", replaceLine(REFS_SHAPES_TS, 4, line));
    const result = await s.review();
    assert.deepEqual(result.items, [`${shapes}  modified  surface`, "  ~ header  Square  export  4  + implements Shape"]);
  });
});

test("reformatting and doc comments are not declaration changes", async () => {
  await withScenario(async (s) => {
    const lines = REFS_SHAPES_TS.split("\n");
    lines[3] = lines[3]!.replace("{ return 4; }", "{\n    return 4;\n  }");
    lines[5] = `/** Tags a member. */\n${lines[5]}`;
    lines.splice(1, 0, "", "");
    const shapes = s.edit("refs/src/shapes.ts", lines.join("\n"));
    const result = await s.review();
    assert.deepEqual(result.items, [`${shapes}  modified`]);
    assert.equal(result.footer, "Total: 1 source files, 0 changed declarations (0 surface, 0 body-only or private), 0 errors, 0 warnings");
  });
});

test("added, deleted and untracked files", async () => {
  await withScenario(async (s) => {
    const extraText = Array.from({ length: 12 }, (_, i) => `export const a${i + 1} = ${i};\n`).join("");
    const extra = s.add("refs/src/extra.ts", extraText);
    const main = s.remove("refs/src/main.ts");
    const notes = s.add("refs/src/notes.ts", "export const note = 1;\n");
    const result = await s.review();
    assert.deepEqual(result.items, [
      `${extra}  added  (12 declarations; get_outline lists them)`,
      `${main}  deleted`,
      "  - variable  unit  export  was 2",
      `${GONE.replace("{n}", "0")}`,
      "  - function  total  export  was 3",
      `${GONE.replace("{n}", "1")}`,
      "  - class  Holder  export  was 4",
      `${GONE.replace("{n}", "0")}`,
      "  - field  Holder.shape  public  was 4",
      `${GONE.replace("{n}", "2")}`,
      "  - accessor  Holder.big  public  was 4",
      `${GONE.replace("{n}", "0")}`,
      "  - method  Holder.run  public  was 4",
      `${GONE.replace("{n}", "0")}`,
      `${notes}  added`,
      "  + variable  note  export  1",
    ]);
    assert.equal(result.head[0], "Review: refs  working tree vs main (merge-base abc1234)  3 files changed: 3 source, 0 project, 0 other");
    assert.equal(result.footer, "Total: 3 source files, 19 changed declarations (19 surface, 0 body-only or private), 0 errors, 0 warnings");
  });
});

test("project files, other files and files outside the solution", async () => {
  await withScenario(async (s) => {
    const tsconfig = s.fx.path("refs/tsconfig.json");
    s.git.files.push({ path: tsconfig, status: "modified" }, { path: s.fx.path("outside.ts"), status: "added" });
    const readme = s.add("refs/README.md", "# refs\n", false);
    const result = await s.review();
    assert.deepEqual(result.head, [
      "Review: refs  working tree vs main (merge-base abc1234)  2 files changed: 0 source, 1 project, 1 other; 1 outside the solution ignored",
    ]);
    assert.deepEqual(result.items, [
      `${tsconfig}  modified  (project file, not analysed; run reindex force=true if a package version changed)`,
      `${readme}  added  (not a source file of the solution)`,
    ]);
    assert.equal(result.footer, "Total: 0 source files, 0 changed declarations (0 surface, 0 body-only or private), 0 errors, 0 warnings");
  });
});

test("includeTests=false hides test files but counts them", async () => {
  await withScenario(async (s) => {
    s.edit("refs/test/shapes.test.ts", 'import { Circle } from "../src/shapes";\nexport const fixture = new Circle(6);\n');
    const result = await s.review({ includeTests: false });
    assert.deepEqual(result.head, [
      "Review: refs  working tree vs main (merge-base abc1234)  1 files changed: 1 source, 0 project, 0 other; 1 in test projects hidden (includeTests=true shows them)",
    ]);
    assert.deepEqual(result.items, []);
    assert.equal(result.footer, "Total: 1 source files, 1 changed declarations (0 surface, 1 body-only or private), 0 errors, 0 warnings");
    const shown = await s.review();
    assert.deepEqual(shown.items, [`${s.fx.path("refs/test/shapes.test.ts")}  modified  body-only`, "  ~ body  fixture  export  2"]);
  });
});

test("error paths", async () => {
  await withScenario(async (s) => {
    const only = (result: Awaited<ReturnType<typeof reviewChangesText>>): string => {
      assert.deepEqual(result.items, []);
      assert.equal(result.footer, undefined);
      assert.equal(result.head.length, 1);
      return result.head[0]!;
    };
    s.git.probeError = "boom";
    assert.equal(only(await s.review()), "review_changes: 'git' could not be started (boom); install git or set gitPath in the config");
    s.git.probeError = null;

    s.git.changesError = "git merge-base nope HEAD failed: fatal: Not a valid object name nope. Pass an existing branch, tag or commit as base.";
    assert.equal(only(await s.review({ base: "nope" })), `review_changes: ${s.git.changesError}`);
    s.git.changesError = null;

    s.git.root = null;
    assert.equal(only(await s.review()), `review_changes: ${s.fx.path("refs/tsconfig.json")} is not inside a git repository.`);
    s.git.root = s.fx.root;

    s.git.base = null;
    assert.equal(
      only(await s.review()),
      `review_changes: No default branch found in ${s.fx.root}: origin/HEAD is not set and none of main, master, develop, dev exists. Pass a branch, tag or commit as base.`,
    );
    s.git.base = "main";

    assert.equal(only(await s.review({ solution: "nosuch" })), "Unknown solution: nosuch. Known: refs");
    s.manager.unload("refs");
    assert.equal(only(await s.review({ solution: "refs" })), "review_changes: refs is not loaded; call load_solution first.");
  });
});

test("impact: a removed function still called shows its base-side references and the resulting error", async () => {
  await withScenario(async (s) => {
    const started = performance.now();
    const main = s.edit("refs/src/main.ts", replaceLine(REFS_MAIN_TS, 3, ""));
    const result = await s.review();
    console.log(`review.test: removed total reviewed in ${Math.round(performance.now() - started)} ms`);
    assert.deepEqual(result.items.slice(0, 4), [
      `${main}  modified  surface`,
      "  - function  total  export  was 3",
      GONE.replace("{n}", "1"),
      "Diagnostics on changed files: 1 errors, 0 warnings (compiler only; lint is not run)",
    ]);
    assert.match(result.items[4]!, /main\.ts:4:\d+ {2}error TS2304: Cannot find name 'total'\.$/);
    assert.equal(result.items.length, 5);
  });
});

test("impact: gather with fork services counts on the services it is given", async () => {
  await withScenario(async (s) => {
    const solution = s.manager.resolveSolution("refs")!;
    const found = findInSolution(solution, "total")!;
    assert.equal(gather({ solution, found }).length, 1);
    const host = new SnapshotHost(s.project.parsed, s.project.dir);
    host.copyFrom(s.project.host);
    host.setFile(s.fx.path("refs/src/main.ts"), replaceLine(REFS_MAIN_TS, 4, "export class Holder { }"));
    const fork = ts.createLanguageService(host, ts.createDocumentRegistry());
    try {
      const forked = { solution, found: { ...found, node: fork.getProgram()!.getSourceFile(s.fx.path("refs/src/main.ts"))!.statements[2]! } };
      assert.equal(gather(forked, new Map([[s.project, fork]])).length, 0, "the fork has no caller left");
      assert.equal(gather({ solution, found }).length, 1, "the live services are unchanged");
    } finally {
      fork.dispose();
    }
  });
});

test("impact: a signature change counts the live references", async () => {
  await withScenario(async (s) => {
    const total = "export function total(shapes: Shape[], scale = 1): number { return shapes.reduce((sum, s) => sum + s.area(), 0); }";
    const main = s.edit("refs/src/main.ts", replaceLine(REFS_MAIN_TS, 3, total));
    const result = await s.review();
    assert.deepEqual(result.items, [
      `${main}  modified  surface`,
      "  ~ signature  total  total(shapes: Shape[]): number -> total(shapes: Shape[], scale?: number): number  3",
      "      references: Live refs 1",
    ]);
  });
});

test("impact: body edits count callers of callables in production files only", async () => {
  await withScenario(async (s) => {
    const area = shapesLine(3).replace("return this.r * this.r;", "return this.r * 2;");
    const shapes = s.edit("refs/src/shapes.ts", replaceLine(REFS_SHAPES_TS, 3, area));
    const main = s.edit("refs/src/main.ts", replaceLine(REFS_MAIN_TS, 2, "export const unit = new Circle(9);"));
    const result = await s.review();
    assert.deepEqual(result.items, [
      `${main}  modified  body-only`,
      "  ~ body  unit  export  2",
      `${shapes}  modified  body-only`,
      "  ~ body  Circle.area  public  3",
      "      callers: 3 (1 direct, 2 via base or interface members)",
    ]);
  });
});

test("impact: a body edit in a test file has no callers line", async () => {
  await withScenario(async (s) => {
    const base = `${REFS_TEST_TS}export function check(): number { return 1; }\n`;
    writeFileSync(s.fx.path("refs/test/shapes.test.ts"), base);
    const edited = s.edit("refs/test/shapes.test.ts", base.replace("return 1;", "return 2;"));
    const result = await s.review({ includeTests: true });
    assert.deepEqual(result.items, [`${edited}  modified  body-only`, "  ~ body  check  export  3"]);
  });
});

test("impact: added interface members and abstract members count implementations and overrides", async () => {
  await withScenario(async (s) => {
    const shapes = s.edit("refs/src/shapes.ts", replaceLine(REFS_SHAPES_TS, 1, "export interface Shape { area(): number; describe(): string; }"));
    const result = await s.review();
    assert.deepEqual(result.items.slice(0, 3), [
      `${shapes}  modified  surface`,
      "  + method  Shape.describe  public  1",
      "      implementations: Live refs 1",
    ]);
  });
  await withScenario(async (s) => {
    const base = shapesLine(2).replace("abstract area(): number;", "abstract area(): number; abstract name(): string;");
    const shapes = s.edit("refs/src/shapes.ts", replaceLine(REFS_SHAPES_TS, 2, base));
    const result = await s.review();
    assert.deepEqual(result.items.slice(0, 3), [
      `${shapes}  modified  surface`,
      "  + method  Base.name  public  2",
      "      overrides: Live refs 0",
    ]);
    assert.equal(result.items.filter((i) => i.includes("error TS2515")).length, 3);
    assert.match(result.footer!, /, 3 errors, 0 warnings$/);
  });
});

test("impact: private members and unimplemented new interfaces have no impact line", async () => {
  await withScenario(async (s) => {
    const line = REFS_MAIN_TS.split("\n")[3]!.replace("@Tag run()", "private helper(): void {} @Tag run()");
    const main = s.edit("refs/src/main.ts", replaceLine(REFS_MAIN_TS, 4, line));
    const result = await s.review();
    assert.deepEqual(result.items, [`${main}  modified  body-only`, "  + method  Holder.helper  private  4"]);
  });
  await withScenario(async (s) => {
    const shapes = s.edit("refs/src/shapes.ts", `${REFS_SHAPES_TS.trimEnd()}\nexport interface Marker {}\n`);
    const result = await s.review();
    assert.deepEqual(result.items, [`${shapes}  modified  surface`, "  + interface  Marker  export  7"]);
  });
  await withScenario(async (s) => {
    const shapes = s.edit("refs/src/shapes.ts", `${REFS_SHAPES_TS.trimEnd()}\nexport interface Marker {}\nexport class Boxed implements Marker {}\n`);
    const result = await s.review();
    assert.deepEqual(result.items, [
      `${shapes}  modified  surface`,
      "  + interface  Marker  export  7",
      "      implementations: Live refs 1",
      "  + class  Boxed  export  8",
    ]);
  });
});

test("impact: hidden test files get no impact lines", async () => {
  await withScenario(async (s) => {
    s.edit("refs/test/shapes.test.ts", `${REFS_TEST_TS}export function check(): number { return 1; }\n`);
    const result = await s.review({ includeTests: false });
    assert.deepEqual(result.items, []);
  });
});

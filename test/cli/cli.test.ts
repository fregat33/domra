import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { runCli, runCliAsync } from "../../src/cli/cli.ts";
import { createGit } from "../../src/workspace/git.ts";
import type { Fixture } from "../fixtures.ts";
import { locate, writeFixture } from "../fixtures.ts";
import { DIAG, INHERIT, PKG, REFS, RETRY_TS, SEARCH, SHAPES_TS, SINGLE } from "../workspace/projects.ts";

let fx: Fixture;
let inheritFx: Fixture;
let refsFx: Fixture;

before(() => {
  fx = writeFixture({ ...SEARCH, ...SINGLE });
  inheritFx = writeFixture(INHERIT);
  refsFx = writeFixture(REFS);
});

after(() => {
  fx.remove();
  inheritFx.remove();
  refsFx.remove();
});

function run(...argv: string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = runCli(argv, {
    stdout: { write: (t) => (out += t) },
    stderr: { write: (t) => (err += t) },
  });
  return { code, out, err };
}

test("diagnostics prints the header and the lines; unknown project exits 1", () => {
  const diagFx = writeFixture(DIAG);
  try {
    const bad = diagFx.path("diag/src/bad.ts");
    const { code, out } = run("diagnostics", diagFx.root, "src/bad.ts", "--solution", "diag");
    assert.equal(code, 0);
    assert.equal(
      out,
      `Diagnostics for ${bad}: 2 errors, 0 warnings (compiler only; lint is not run)\n` +
        `  ${bad}:1:14  error TS2322: Type 'string' is not assignable to type 'number'.\n` +
        `  ${bad}:3:3  error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n`,
    );
    const missing = run("diagnostics", diagFx.root, "nope", "--solution", "diag");
    assert.equal(missing.code, 1);
    assert.equal(missing.out, "No project named nope in diag. Projects: diag-pkg\n");
    const limited = run("diagnostics", diagFx.root, "diag-pkg", "--solution", "diag", "--limit", "1");
    assert.equal(limited.code, 0);
    assert.match(limited.out, /\n {2}\.\.\. \d+ more\n$/);
  } finally {
    diagFx.remove();
  }
});

test("status prints one line per solution and a total", () => {
  const { code, out } = run("status", fx.root);
  assert.equal(code, 0);
  const lines = out.split("\n");
  assert.equal(lines.pop(), "");
  assert.equal(lines.pop(), "Total: 2 solution(s)");
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(
      line,
      /^\S+  loaded  projects=\S+  rootFiles=\d+  sourceFiles=\d+  unresolved=\d+\/\d+  loadMs=\d+$/,
    );
  }
  assert.deepEqual(lines.map((l) => l.split("  ")[0]).sort(), ["demo", "single"]);
});

test("search with a solution hint", () => {
  const path = fx.path("demo/src/retry.ts");
  const policy = locate(RETRY_TS, "RetryPolicy");
  const method = locate(RETRY_TS, "createRetryOptions");
  const { code, out } = run("search", fx.root, "Retry", "--solution", "demo");
  assert.equal(code, 0);
  assert.equal(
    out,
    `Live demo (2):\n  class RetryPolicy  ${path}:${policy.line}:${policy.col}\n` +
      `  method RetryPolicy.createRetryOptions  ${path}:${method.line}:${method.col}\n`,
  );
});

test("search without hits", () => {
  const { code, out } = run("search", fx.root, "uoc");
  assert.equal(code, 0);
  assert.equal(
    out,
    "No symbols match uoc. Patterns support camel-case humps (e.g. UOC for UpdateOrderCommand).\n",
  );
});

test("search with limit and kind", () => {
  const { code, out } = run("search", fx.root, "Upload", "--limit", "2", "--kind", "method");
  assert.equal(code, 0);
  const lines = out.trimEnd().split("\n");
  assert.equal(lines[0], "Live demo (2):");
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /^ {2}method /);
  assert.match(lines[2]!, /^ {2}method /);
});

test("resolve prints symbol, definition and project", () => {
  const circle = locate(SHAPES_TS, "Circle");
  const { code, out } = run("resolve", fx.root, "Circle", "--solution", "single");
  assert.equal(code, 0);
  const lines = out.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^Symbol: .*Circle.*  \[class\]  Circle$/);
  assert.equal(lines[1], "Project: single-pkg (single)");
  assert.equal(lines[2], `Defined: ${fx.path("single/src/shapes.ts")}:${circle.line}:${circle.col}`);
});

const NOT_FOUND =
  "Symbol not found in any loaded solution: NoSuchThing\n" +
  "Tip: use search_symbols to find the exact name, or load_solution if the owning solution is not loaded yet.\n";

test("resolve without a match returns 1", () => {
  const { code, out } = run("resolve", fx.root, "NoSuchThing");
  assert.equal(code, 1);
  assert.equal(out, NOT_FOUND);
});

test("definition prints the header and the declarations", () => {
  const circle = locate(SHAPES_TS, "Circle");
  const { code, out } = run("definition", fx.root, "Circle", "--solution", "single");
  assert.equal(code, 0);
  const path = `${fx.path("single/src/shapes.ts")}:${circle.line}:${circle.col}`;
  const lines = out.split("\n");
  assert.equal(lines[1], "Project: single-pkg (single)");
  assert.equal(lines[2], `Defined: ${path}`);
  assert.equal(lines[3], "Declared in source:");
  assert.equal(lines[4], `  ${path}`);
  assert.equal(lines.length, 6);
});

test("definition without a match returns 1", () => {
  const { code, out } = run("definition", fx.root, "NoSuchThing");
  assert.equal(code, 1);
  assert.equal(out, NOT_FOUND);
});

test("info prints symbol details", () => {
  const { code, out } = run("info", fx.root, "Circle", "--solution", "single");
  assert.equal(code, 0);
  assert.match(out, /^Signature: /);
  assert.ok(out.split("\n").includes("Kind: class"));
});

test("members with --inherited, --filter and --limit", () => {
  const inherited = run("members", inheritFx.root, "Derived", "--inherited", "--solution", "inherit");
  assert.equal(inherited.code, 0);
  assert.ok(inherited.out.includes("  [from Base]"));
  const limited = run("members", fx.root, "Circle", "--limit", "1", "--solution", "single");
  assert.equal(limited.code, 0);
  assert.ok(limited.out.endsWith("  ... 2 more\n"));
  const filtered = run("members", fx.root, "Circle", "--filter", "AREA");
  assert.ok(filtered.out.endsWith("1 members\n  public method area(): number\n"));
  assert.equal(run("members", fx.root, "makeCircle").code, 1);
});

test("outline of a file and of a type", () => {
  const one = run("outline", fx.root, "src/shapes.ts", "--solution", "single", "--depth", "1");
  assert.equal(one.code, 0);
  const lines = one.out.split("\n");
  assert.equal(lines.length, 1 + 8 + 1);
  assert.equal(lines[9], "Total: 8 declarations");
  const three = run("outline", fx.root, "src/shapes.ts", "--solution", "single", "--depth", "3");
  assert.equal(run("outline", fx.root, "src/shapes.ts", "--solution", "single", "--depth", "9").out, three.out);
  assert.equal(run("outline", fx.root, "src/shapes.ts", "--depth", "x").code, 2);
  const type = run("outline", fx.root, "Circle", "--solution", "single");
  assert.equal(type.code, 0);
  assert.ok(type.out.startsWith("Outline: class Circle  (Live single)\n"));
  assert.ok(type.out.endsWith("Total: 4 declarations"));
  const hidden = run("outline", fx.root, "src/main.ts", "--no-private");
  assert.ok(hidden.out.endsWith("  variable total: number  4\nTotal: 1 declarations"));
});

test("outline failures return 1", () => {
  assert.equal(run("outline", fx.root, "src/nope.ts", "--solution", "single").code, 1);
  assert.equal(run("outline", fx.root, "makeCircle").code, 1);
  assert.equal(run("outline", fx.root, "NoSuchThing").code, 1);
});

test("callgraph prints the selected groups; usage lists the command", () => {
  const callers = run("callgraph", refsFx.root, "total", "--solution", "refs", "--direction", "callers");
  assert.equal(callers.code, 0);
  assert.ok(callers.out.includes("\nCallers (1, live, loaded solutions only):\n  Holder.run  "), callers.out);
  assert.ok(!callers.out.includes("Callees"), callers.out);
  const both = run("callgraph", refsFx.root, "total", "--solution", "refs", "--include-external", "--scope", "production");
  assert.ok(both.out.includes("\nCallees (2 of 2, scope=production):\n"), both.out);
  const direct = run("callgraph", refsFx.root, "Circle.area", "--solution", "refs", "--direction", "callers", "--direct");
  assert.equal(direct.code, 0);
  assert.ok(direct.out.includes("\nCallers (1, live, loaded solutions only):\n  Holder.big  "), direct.out);
  assert.ok(run("help").out.includes("--direct"));
  assert.equal(run("callgraph", refsFx.root, "Shape", "--solution", "refs").code, 1);
  assert.equal(run("callgraph", refsFx.root, "total", "--scope", "x").code, 1);
  assert.ok(run("help").out.includes("callgraph <root> <spec>"));
});

test("references, implementations and derived", () => {
  const scoped = run("references", refsFx.root, "Circle", "--solution", "refs", "--scope", "production");
  assert.equal(scoped.code, 0);
  assert.ok(scoped.out.includes("Live refs: 5 of 7 references (scope=production)\n"), scoped.out);
  assert.ok(scoped.out.endsWith("Total: 5 references (scope=production)\n"), scoped.out);
  const defining = run("references", refsFx.root, "Circle", "--defining-only", "--kind", "base", "--limit", "1");
  assert.equal(defining.code, 0);
  assert.ok(defining.out.includes("Live refs: 1 of 7 references (kind=base)\n"), defining.out);
  assert.ok(defining.out.endsWith("(defining solution only; pass allSolutions=true to include other solutions)\n"));

  const derived = run("derived", refsFx.root, "Base", "--solution", "refs");
  assert.equal(derived.code, 0);
  assert.equal(derived.out.split("\n").filter((l) => l.startsWith("  inherits  class ")).length, 3);
  assert.ok(derived.out.endsWith("Total: 3\n"), derived.out);
  const implementations = run("implementations", refsFx.root, "Shape.area", "--limit", "2");
  assert.equal(implementations.code, 0);
  assert.ok(implementations.out.endsWith("  ... 2 more\nTotal: 4\n"), implementations.out);

  assert.equal(run("references", refsFx.root, "Circle", "--kind", "nope").code, 1);
  assert.equal(run("references", refsFx.root, "Circle", "--scope", "x").code, 1);
  assert.equal(run("references", refsFx.root, "NoSuch").code, 1);
  assert.equal(run("derived", refsFx.root, "total").code, 1);
});

test("index, index-search and index-status use the --db file", () => {
  const indexFx = writeFixture({ ...REFS, ...SINGLE });
  try {
    const db = indexFx.path("index.db");
    const stats = /^Index: .+index\.db {2}2 projects, 7 tracked files, 7 blobs, \d+ symbols, \d+ references, \d+ relations$/;
    const indexed = run("index", indexFx.root, "--db", db);
    assert.equal(indexed.code, 0, indexed.err);
    const lines = indexed.out.trimEnd().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /^refs: 1 projects, 3 documents, 3 extracted, 0 reused, 0 removed, \d+ ms$/);
    assert.match(lines[1]!, /^single: 1 projects, 4 documents, 4 extracted, 0 reused, 0 removed, \d+ ms$/);
    assert.match(lines[2]!, stats);
    assert.match(run("index", indexFx.root, "--db", db).out, /^refs: 1 projects, 3 documents, 0 extracted, 3 reused, 0 removed/);
    assert.match(run("index", indexFx.root, "--db", db, "--force", "--solution", "refs").out, /^refs: 1 projects, 3 documents, 3 extracted, 0 reused/);

    const circle = locate(SHAPES_TS, "Circle");
    const searched = run("index-search", indexFx.root, "Circle", "--db", db, "--kind", "class");
    assert.equal(searched.code, 0, searched.err);
    assert.equal(
      searched.out,
      `Index refs (1):\n  class Circle  ${indexFx.path("refs/src/shapes.ts")}:3:14\n` +
        `Index single (1):\n  class Circle  ${indexFx.path("single/src/shapes.ts")}:${circle.line}:${circle.col}\n`,
    );
    const all = run("index-search", indexFx.root, "Circle", "--db", db).out;
    assert.ok(all.startsWith("Index refs ("), all);
    assert.ok(all.includes("\nIndex single ("), all);
    assert.match(run("index-search", indexFx.root, "uoc", "--db", db).out, /^No symbols match uoc\./);

    const status = run("index-status", "--db", db);
    assert.equal(status.code, 0);
    assert.match(status.out.trimEnd(), stats);
    assert.equal(run("index-search", indexFx.root, "X", "--db", db, "--kind", "nope").code, 2);
  } finally {
    indexFx.remove();
  }
});

test("drift prints the package_drift text of the --db file", () => {
  const pkgFx = writeFixture(PKG);
  try {
    const db = pkgFx.path("index.db");
    assert.equal(run("index", pkgFx.root, "--db", db).code, 0);
    const drift = run("drift", "--db", db);
    assert.equal(drift.code, 0, drift.err);
    assert.equal(
      drift.out,
      "acme-contracts  source 1.1.0 (libpkg)\n  webapp  webapp  1.0.0\n" +
        "Total: 1 consumer projects on a version other than the source. Only solutions indexed at least once are compared.\n",
    );
    assert.equal(run("drift", "--db", db, "--limit", "0").code, 2);
  } finally {
    pkgFx.remove();
  }
});

test("usage errors return 2", () => {
  const missing = run("search", fx.root);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /domra-cli: missing required argument 'pattern'/);
  assert.equal(run("bogus", fx.root).code, 2);
  assert.equal(run("search", fx.root, "X", "--limit", "0").code, 2);
  assert.equal(run("search", fx.root, "X", "--kind", "nope").code, 2);
  assert.match(run("search", fx.root, "X", "--nope", "1").err, /unknown option '--nope'/);
  const help = run("help");
  assert.equal(help.code, 2);
  assert.match(help.out, /^usage:/);
});

test("unknown solution hint returns 1", () => {
  const { code, err } = run("search", fx.root, "X", "--solution", "missing");
  assert.equal(code, 1);
  assert.match(err, /domra-cli: no solution matches 'missing'/);
});

test("--verbose reports to stderr only", () => {
  const quiet = run("status", fx.root);
  assert.equal(quiet.err, "");
  const verbose = run("status", fx.root, "--verbose");
  assert.match(verbose.err, /^loaded 2 solution\(s\) in \d+ ms\n$/);
});

test("review is listed in the usage", () => {
  const help = run("review", "--help");
  assert.equal(help.code, 2);
  assert.match(help.err, /\n {2}review <root> {17}changed files and declarations/);
  assert.match(help.err, /--base <ref> {18}review:/);
  assert.match(help.err, /--git <path> {18}review:/);
  assert.match(help.err, /--no-tests {20}review:/);
});

test("review outside a git repository exits 1", async () => {
  let out = "";
  const code = await runCliAsync(["review", refsFx.root, "--base", "nope"], {
    stdout: { write: (t) => (out += t) },
    stderr: { write: () => {} },
  });
  assert.equal(code, 1);
  const git = await createGit().probe();
  if (git === null) assert.equal(out, `review_changes: ${refsFx.path("refs/tsconfig.json")} is not inside a git repository.\n`);
  else assert.match(out, /^review_changes: /);
});

test("the script exits 1 for a review outside a git repository", () => {
  const child = spawnSync(process.execPath, ["scripts/domra-cli.ts", "review", refsFx.root, "--base", "nope"], { encoding: "utf8" });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stdout, /^review_changes: /);
});

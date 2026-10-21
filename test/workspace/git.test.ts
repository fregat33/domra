import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { createGit } from "../../src/workspace/git.ts";
import { writeFixture } from "../fixtures.ts";
import { REFS, REFS_MAIN_TS } from "./projects.ts";

test("real git: changes, show and defaultBase", async (t) => {
  const git = createGit();
  const problem = await git.probe();
  if (problem !== null) {
    t.skip(problem);
    return;
  }
  const fx = writeFixture(REFS);
  try {
    const run = (...args: string[]): string =>
      execFileSync("git", ["-c", "user.name=domra", "-c", "user.email=domra@example.invalid", "-c", "core.autocrlf=false", ...args], { cwd: fx.root, encoding: "utf8" });
    run("init", "-q", "-b", "main");
    run("add", "-A");
    run("commit", "-q", "-m", "refs");
    writeFileSync(fx.path("refs/src/main.ts"), `${REFS_MAIN_TS}export const more = 1;\n`);
    rmSync(fx.path("refs/test/shapes.test.ts"));
    writeFileSync(fx.path("refs/src/new.ts"), "export const fresh = 1;\n");

    assert.equal(git.repoRoot(fx.path("refs/src")), fx.root);
    assert.equal(await git.defaultBase(fx.root), "main");
    const changes = await git.changes(fx.root, "main");
    assert.ok(!("error" in changes), JSON.stringify(changes));
    assert.match(changes.mergeBase, /^[0-9a-f]{40}$/);
    const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f.status]));
    assert.deepEqual(byPath, {
      [fx.path("refs/src/main.ts")]: "modified",
      [fx.path("refs/test/shapes.test.ts")]: "deleted",
      [fx.path("refs/src/new.ts")]: "added",
    });
    const committed = await git.show(fx.root, changes.mergeBase, "refs/src/main.ts");
    assert.equal(committed?.replace(/\r\n/g, "\n"), REFS_MAIN_TS);
    assert.equal(await git.show(fx.root, changes.mergeBase, "refs/src/new.ts"), null);

    const bad = await git.changes(fx.root, "nope");
    assert.ok("error" in bad);
    assert.match(bad.error, /^git merge-base nope HEAD failed: .+\. Pass an existing branch, tag or commit as base\.$/);
  } finally {
    fx.remove();
  }
});

test("probe reports a git that cannot be started", async () => {
  const problem = await createGit("domra-no-such-git").probe();
  assert.match(problem ?? "", /^'domra-no-such-git' could not be started \(.+\); install git or set gitPath in the config$/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverSolutions } from "../../src/workspace/discovery.ts";
import { withFixture } from "../fixtures.ts";
import { IGNORED, MONO, SINGLE } from "./projects.ts";

test("discovers solutions, skips node_modules and referenced tsconfigs", async () => {
  await withFixture({ ...SINGLE, ...MONO, ...IGNORED }, (fx) => {
    const solutions = discoverSolutions([fx.root]);
    assert.deepEqual(
      solutions.map((s) => s.path),
      [fx.path("mono/tsconfig.json"), fx.path("single/tsconfig.json")],
    );
    const [mono, single] = solutions;
    assert.equal(mono!.name, "mono");
    assert.equal(mono!.dir, fx.path("mono"));
    assert.deepEqual(mono!.projects, [
      fx.path("mono/packages/core/tsconfig.json"),
      fx.path("mono/packages/ui/tsconfig.json"),
    ]);
    assert.equal(single!.name, "single");
    assert.deepEqual(single!.projects, [fx.path("single/tsconfig.json")]);
  });
});

test("discovery depth: a tsconfig 6 folders deep is found, 7 is not", async () => {
  await withFixture(
    {
      "six/a/b/c/d/e/tsconfig.json": {},
      "seven/a/b/c/d/e/f/tsconfig.json": {},
    },
    (fx) => {
      assert.deepEqual(
        discoverSolutions([fx.root]).map((s) => s.path),
        [fx.path("six/a/b/c/d/e/tsconfig.json")],
      );
    },
  );
});

test("ignoredFolders are configurable and depth is limited", async () => {
  await withFixture(
    {
      ...SINGLE,
      "deep/a/b/c/d/e/f/g/tsconfig.json": {},
      "deep/a/b/c/d/e/tsconfig.json": {},
    },
    (fx) => {
      assert.deepEqual(
        discoverSolutions([fx.root]).map((s) => s.path),
        [fx.path("deep/a/b/c/d/e/tsconfig.json"), fx.path("single/tsconfig.json")],
      );
      assert.deepEqual(
        discoverSolutions([fx.root], ["single"]).map((s) => s.name),
        ["e"],
      );
    },
  );
});

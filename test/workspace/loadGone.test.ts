import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { WorkspaceManager } from "../../src/workspace/index.ts";
import { withFixture } from "../fixtures.ts";
import { SINGLE } from "./projects.ts";

const IGNORED = ["node_modules", ".git", "dist", "build", "out", "coverage"];

test("load refuses a registered, not loaded solution whose tsconfig is gone, and works again once it is back", async () => {
  await withFixture(SINGLE, (fixture) => {
    const manager = new WorkspaceManager({ roots: [fixture.root], ignoredFolders: IGNORED });
    manager.discover();
    const path = fixture.path("single/tsconfig.json");
    const text = readFileSync(path, "utf8");
    rmSync(path);
    assert.throws(() => manager.load("single"), /^Error: unknown solution/);
    assert.deepEqual(manager.loadedSolutions, []);
    assert.ok(manager.isRegistered(path));
    writeFileSync(path, text);
    assert.equal(manager.load("single").name, "single");
  });
});

test("load returns an already loaded solution even when its tsconfig is gone", async () => {
  await withFixture(SINGLE, (fixture) => {
    const manager = new WorkspaceManager({ roots: [fixture.root], ignoredFolders: IGNORED });
    manager.discover();
    const loaded = manager.load("single");
    rmSync(fixture.path("single/tsconfig.json"));
    assert.equal(manager.load("single"), loaded);
  });
});

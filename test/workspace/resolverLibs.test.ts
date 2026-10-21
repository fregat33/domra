import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import { resolveInSolution } from "../../src/workspace/resolver.ts";
import type { LoadedSolution } from "../../src/workspace/solution.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { REFS } from "./projects.ts";

let fx: Fixture;
let refs: LoadedSolution;

before(() => {
  fx = writeFixture(REFS);
  const manager = new WorkspaceManager({ roots: [fx.root] });
  manager.discover();
  refs = manager.load("refs");
});

after(() => fx.remove());

test("a project function beats a higher-category default-library type of the same name", () => {
  const tag = resolveInSolution(refs, "Tag");
  assert.ok(tag);
  assert.equal(tag.kind, "function");
  assert.equal(tag.isDeclarationFile, false);
  assert.match(tag.position.path, /src[\\/]shapes\.ts$/);
});

test("a bare name without a project declaration still resolves to the default library", () => {
  const map = resolveInSolution(refs, "Map");
  assert.ok(map);
  assert.equal(map.isDeclarationFile, true);
});

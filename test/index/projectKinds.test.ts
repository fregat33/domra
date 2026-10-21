import assert from "node:assert/strict";
import { test } from "node:test";
import { isTestProject } from "../../src/index/projectKinds.ts";

test("test projects by name, directory and file name", () => {
  assert.equal(isTestProject("acme.UnitTests", "src/a.ts"), true);
  assert.equal(isTestProject("TestUtilities", "x.ts"), true);
  assert.equal(isTestProject("@mono/core-tests", "x.ts"), true);
  assert.equal(isTestProject("app", "src/tests/a.ts"), true);
  assert.equal(isTestProject("app", "src/__tests__/a.ts"), true);
  assert.equal(isTestProject("app", "src\\Test\\a.ts"), true);
  assert.equal(isTestProject("app", "src/a.spec.tsx"), true);
  assert.equal(isTestProject("app", "src/a.test.mjs"), true);
});

test("non-test projects", () => {
  assert.equal(isTestProject("Latest", "src/a.ts"), false);
  assert.equal(isTestProject("contest", "src/attest/a.ts"), false);
  assert.equal(isTestProject("app", "src/testing.ts"), false);
});

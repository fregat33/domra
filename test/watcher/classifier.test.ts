import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangeKind } from "../../src/watcher/classifier.ts";
import { classifyChange } from "../../src/watcher/classifier.ts";

const IGNORED = ["node_modules", ".git", "dist", "build", "out", "coverage"];

const TABLE: [string, ChangeKind][] = [
  ["src/a.ts", "source"],
  ["src/a.tsx", "source"],
  ["src/a.mts", "source"],
  ["src/a.cts", "source"],
  ["lib/b.js", "source"],
  ["lib/b.jsx", "source"],
  ["tsconfig.json", "project"],
  ["tsconfig.build.json", "project"],
  ["package.json", "project"],
  ["package-lock.json", "project"],
  ["pnpm-lock.yaml", "project"],
  ["yarn.lock", "project"],
  ["repo/.git/HEAD", "git"],
  ["repo/.git/index", "ignored"],
  ["repo/.git/refs/heads/main", "ignored"],
  ["node_modules/x/index.ts", "ignored"],
  ["dist/a.ts", "ignored"],
  [".idea/a.ts", "ignored"],
  [".vs/a.ts", "ignored"],
  ["README.md", "ignored"],
  ["a.tmp", "ignored"],
  ["a.ts~", "ignored"],
];

test("classifyChange table", () => {
  for (const [path, kind] of TABLE) {
    assert.equal(classifyChange(path, IGNORED), kind, path);
    assert.equal(classifyChange(path.replace(/\//g, "\\"), IGNORED), kind, `backslash ${path}`);
  }
});

test("classifyChange honours custom ignored folders, case-insensitively", () => {
  assert.equal(classifyChange("custom/a.ts", ["custom"]), "ignored");
  assert.equal(classifyChange("Custom/a.ts", ["custom"]), "ignored");
  assert.equal(classifyChange("custom/a.ts", IGNORED), "source");
});

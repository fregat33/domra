import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const srcDir = resolve(process.cwd(), "src");

function sourceFiles(layer: string): string[] {
  const dir = join(srcDir, layer);
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile() && /\.(ts|tsx|mts)$/.test(path));
}

function specifiers(source: string): string[] {
  const result: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) result.push(match[1]!);
  return result;
}

test("index layer never imports typescript", () => {
  const files = sourceFiles("index");
  assert.ok(files.length > 0);
  for (const file of files) {
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      assert.ok(
        spec !== "typescript" && !spec.startsWith("typescript/"),
        `${file} imports ${spec}`,
      );
    }
  }
});

test("workspace layer never imports the watcher layer", () => {
  const files = sourceFiles("workspace");
  assert.ok(files.length > 0);
  for (const file of files) {
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      assert.ok(!/(^|\/)\.\.\/watcher(\/|$)/.test(spec), `${file} imports ${spec}`);
    }
  }
});

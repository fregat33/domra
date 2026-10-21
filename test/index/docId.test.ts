import assert from "node:assert/strict";
import { test } from "node:test";
import { makeDocId, parseDocId, scopeOf, stripExtension } from "../../src/index/index.ts";

test("parseDocId splits scope and fqName", () => {
  assert.deepEqual(parseDocId("single-pkg/src/shapes#Circle.area"), { scope: "single-pkg/src/shapes", fqName: "Circle.area" });
  assert.deepEqual(parseDocId("@mono/core/src/index#coreGreeting"), { scope: "@mono/core/src/index", fqName: "coreGreeting" });
  assert.equal(parseDocId("no-hash"), null);
});

test("the split is at the first '#': a scope containing '#' is not supported", () => {
  // Documented limitation: docIds are not escaped. A `#private` member keeps its `#` in the fqName,
  // but a module path containing `#` would be split at the wrong place.
  assert.deepEqual(parseDocId("pkg/src/a#Circle.#secret"), { scope: "pkg/src/a", fqName: "Circle.#secret" });
  assert.deepEqual(parseDocId(makeDocId("pkg/dir#x/a", "A")), { scope: "pkg/dir", fqName: "x/a#A" });
});

test("scopeOf strips the extension, declaration-file extensions included", () => {
  assert.equal(scopeOf("single-pkg", "src/shapes.ts"), "single-pkg/src/shapes");
  assert.equal(scopeOf("single-pkg", "src/legacy.d.ts"), "single-pkg/src/legacy");
  assert.equal(scopeOf("ui", "src\\App.tsx"), "ui/src/App");
  assert.equal(stripExtension("lib/index.d.mts"), "lib/index");
  assert.equal(stripExtension("a/b.cjs"), "a/b");
});

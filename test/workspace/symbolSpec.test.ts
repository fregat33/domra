import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSymbolSpec } from "../../src/workspace/symbolSpec.ts";

test("position without column", () => {
  assert.deepEqual(parseSymbolSpec("file.tsx:12"), {
    kind: "position",
    path: "file.tsx",
    line: 12,
    col: null,
  });
});

test("position with column, absolute and case-insensitive extension", () => {
  assert.deepEqual(parseSymbolSpec("file.ts:12:5"), {
    kind: "position",
    path: "file.ts",
    line: 12,
    col: 5,
  });
  assert.deepEqual(parseSymbolSpec("C:/src/App.TSX:3:1"), {
    kind: "position",
    path: "C:/src/App.TSX",
    line: 3,
    col: 1,
  });
  for (const ext of ["mts", "cts", "js", "jsx"]) {
    assert.equal(parseSymbolSpec(`a/b.${ext}:1`)?.kind, "position");
  }
});

test("position with zero line or column is not a position", () => {
  assert.equal(parseSymbolSpec("file.ts:0"), null);
  assert.equal(parseSymbolSpec("file.ts:3:0"), null);
});

test("Name(params) strips parameter names and whitespace", () => {
  assert.deepEqual(parseSymbolSpec("fn(a: string, b: number)"), {
    kind: "name",
    parts: ["fn"],
    params: ["string", "number"],
  });
  assert.deepEqual(parseSymbolSpec("fn()"), { kind: "name", parts: ["fn"], params: [] });
  assert.deepEqual(parseSymbolSpec("Ns.fn(Map<string, number>, ...rest: T[], opt?: Foo)"), {
    kind: "name",
    parts: ["Ns", "fn"],
    params: ["map<string,number>", "t[]", "foo"],
  });
  assert.deepEqual(parseSymbolSpec("fn(cb: (x: number) => void)"), {
    kind: "name",
    parts: ["fn"],
    params: ["(x:number)=>void"],
  });
});

test("generic names drop type arguments", () => {
  assert.deepEqual(parseSymbolSpec("Foo<T>"), { kind: "name", parts: ["Foo"], params: null });
  assert.deepEqual(parseSymbolSpec("Foo<T, Bar<U>>.baz"), {
    kind: "name",
    parts: ["Foo", "baz"],
    params: null,
  });
});

test("qualified names", () => {
  assert.deepEqual(parseSymbolSpec("Ns.Type.member"), {
    kind: "name",
    parts: ["Ns", "Type", "member"],
    params: null,
  });
  assert.deepEqual(parseSymbolSpec("Type.constructor"), {
    kind: "name",
    parts: ["Type", "constructor"],
    params: null,
  });
});

test("bare names", () => {
  assert.deepEqual(parseSymbolSpec("  Circle "), { kind: "name", parts: ["Circle"], params: null });
  assert.deepEqual(parseSymbolSpec("$el"), { kind: "name", parts: ["$el"], params: null });
});

test("invalid specs", () => {
  for (const spec of ["", "   ", "a..b", "Foo<T", "fn(a", "1abc", "a b"]) {
    assert.equal(parseSymbolSpec(spec), null, spec);
  }
});

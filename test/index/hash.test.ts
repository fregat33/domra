import assert from "node:assert/strict";
import { test } from "node:test";
import type { Extraction } from "../../src/index/index.ts";
import { contentHash, decodeText, surfaceHash } from "../../src/index/index.ts";

test("contentHash is the SHA-256 of the UTF-8 text", () => {
  assert.equal(contentHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("a BOM-prefixed buffer hashes like the BOM-free one", () => {
  const plain = Buffer.from("export const x = 1;\n", "utf8");
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
  assert.equal(decodeText(bom), decodeText(plain));
  assert.equal(contentHash(decodeText(bom)), contentHash(decodeText(plain)));
  assert.equal(contentHash(bom.toString("utf8")), contentHash(plain.toString("utf8")));
});

const symbol = (docId: string, accessibility: string, signature = docId) => ({
  docId, kind: "method", name: docId, fqName: docId, signature, accessibility, containingDocId: null, line: 1, col: 1, endLine: 1,
});

test("surfaceHash ignores private symbols, references, positions and ordering", () => {
  const base: Extraction = {
    symbols: [symbol("a#A", "export"), symbol("a#A.m", "public")],
    references: [],
    relations: [{ fromDocId: "a#A", toDocId: "b#B", kind: "inherits" }],
  };
  const reordered: Extraction = {
    symbols: [{ ...symbol("a#A.m", "public"), line: 9 }, symbol("a#hidden", "private"), symbol("a#A", "export")],
    references: [{ targetDocId: "b#B", kind: "usage", line: 1, col: 1, fromDocId: null }],
    relations: [{ fromDocId: "a#A", toDocId: "b#B", kind: "inherits" }],
  };
  assert.equal(surfaceHash(reordered), surfaceHash(base));
  assert.notEqual(surfaceHash({ ...base, symbols: [...base.symbols, symbol("a#B", "export")] }), surfaceHash(base));
  assert.notEqual(surfaceHash({ ...base, symbols: [symbol("a#A", "export", "A<T>"), base.symbols[1]!] }), surfaceHash(base));
  assert.notEqual(surfaceHash({ ...base, relations: [] }), surfaceHash(base));
});

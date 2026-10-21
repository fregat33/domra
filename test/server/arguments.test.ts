import assert from "node:assert/strict";
import { test } from "node:test";
import { checkArguments } from "../../src/server/arguments.ts";
import { TOOLS } from "../../src/server/tools.ts";

const ACCEPTED = "Accepted arguments: pattern (required), kind, limit.";

test("a single misnamed argument is remapped", () => {
  assert.deepEqual(checkArguments(TOOLS, "search_symbols", { query: "x" }), { ok: true, args: { pattern: "x" } });
});

test("missing required argument lists the accepted ones", () => {
  assert.deepEqual(checkArguments(TOOLS, "search_symbols", {}), {
    ok: false,
    text: `search_symbols: missing required argument 'pattern'. ${ACCEPTED}`,
  });
});

test("several unknown arguments are reported, sorted", () => {
  assert.deepEqual(checkArguments(TOOLS, "search_symbols", { query: "x", extra: 1 }), {
    ok: false,
    text: `search_symbols: missing required argument 'pattern'. Not accepted: 'extra', 'query'; the value probably belongs in 'pattern'. ${ACCEPTED}`,
  });
});

test("wrong argument types are rejected", () => {
  assert.deepEqual(checkArguments(TOOLS, "search_symbols", { pattern: "x", limit: "3" }), {
    ok: false,
    text: "search_symbols: argument 'limit' must be integer.",
  });
  assert.deepEqual(checkArguments(TOOLS, "list_members", { type: "T", includeInherited: "yes" }), {
    ok: false,
    text: "list_members: argument 'includeInherited' must be boolean.",
  });
  assert.equal(checkArguments(TOOLS, "search_symbols", { pattern: "x", limit: 1.5 }).ok, false);
});

test("extra unknown arguments alone pass through", () => {
  assert.deepEqual(checkArguments(TOOLS, "search_symbols", { pattern: "x", bogus: 1 }), {
    ok: true,
    args: { pattern: "x", bogus: 1 },
  });
});

test("an unknown tool lists the tools", () => {
  const result = checkArguments(TOOLS, "nope", {});
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.text.startsWith("Unknown tool: nope. Tools: status, load_solution, reindex, package_drift, next_page,"));
});

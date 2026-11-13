import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "../../src/server/server.ts";
import type { RunningServer } from "../../src/server/server.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { OMIT, SINGLE } from "../workspace/projects.ts";

let fixture: Fixture;
let server: RunningServer;

before(async () => {
  fixture = writeFixture({ ...SINGLE, ...OMIT });
  server = await startServer({
    roots: [fixture.root], preload: ["single"], warmUp: true, indexPath: ":memory:", port: 0, warn: () => {},
  });
  await server.jobs.idle();
});

after(async () => {
  await server.close();
  fixture.remove();
});

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const reply = (await response.json()) as { result: { content: { text: string }[] } };
  return reply.result.content[0]!.text;
}

test("get_outline from the index omits the properties of large types", async () => {
  const path = `${fixture.root}/omit/src/models.ts`;
  const text = await call("get_outline", { target: path });
  const lines = text.split("\n");
  assert.ok(lines[0]!.includes("(Index omit, "), text);
  const wide = lines.findIndex((l) => l.startsWith("  interface Wide  "));
  assert.ok(lines[wide]!.endsWith("  9 properties omitted"), text);
  assert.ok(lines[wide + 1]!.startsWith("    method run"), text);
  const edge = lines.findIndex((l) => l.startsWith("  interface Edge  "));
  assert.ok(!lines[edge]!.includes("omitted"), text);
  assert.equal(lines.slice(edge + 1, edge + 9).filter((l) => l.startsWith("    property p")).length, 8, text);
  assert.equal(lines.filter((l) => l.startsWith("    property p")).length, 8, text);
  const literal = lines.find((l) => l.startsWith("  typeAlias Literal"));
  assert.ok(literal?.endsWith("  10 properties omitted"), text);
  assert.match(lines.at(-1)!, /^Total: \d+ declarations, 19 properties omitted \(read the line span, or get_outline with the type name\)$/);
});

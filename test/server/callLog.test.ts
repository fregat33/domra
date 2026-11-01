import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { clientOf, cut, formatCallLine, formatKey, formatRejected, formatValue, quote } from "../../src/server/callLog.ts";
import { startServer } from "../../src/server/server.ts";
import type { RunningServer } from "../../src/server/server.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { FakeGit } from "../workspace/fakeGit.ts";
import { REFS, REFS_SHAPES_TS } from "../workspace/projects.ts";

test("quote escapes backslash, quote, CR and LF", () => {
  assert.equal(quote('a\\b"c\r\nd'), '"a\\\\b\\"c\\r\\nd"');
});

test("cut appends the ellipsis after the limit, then quote escapes", () => {
  assert.equal(cut("abc", 3), "abc");
  assert.equal(cut("abcd", 3), "abc…");
  assert.equal(formatValue("x".repeat(120)), `"${"x".repeat(120)}"`);
  assert.equal(formatValue(`${"x".repeat(119)}"y`), `"${"x".repeat(119)}\\"…"`);
});

test("keys: identifiers as is, others cut and quoted", () => {
  assert.equal(formatKey("limit_2"), "limit_2");
  assert.equal(formatKey("a-b"), '"a-b"');
  assert.equal(formatKey("a\nb"), '"a\\nb"');
  assert.equal(formatKey(""), '""');
  assert.equal(formatKey("k".repeat(120)), "k".repeat(120));
  assert.equal(formatKey("k".repeat(121)), `"${"k".repeat(120)}…"`);
});

test("values of each JSON type", () => {
  assert.equal(formatValue("s"), '"s"');
  assert.equal(formatValue(20), "20");
  assert.equal(formatValue(false), "false");
  assert.equal(formatValue(null), "null");
  assert.equal(formatValue(["a", 1]), '["a",1]');
  assert.equal(formatValue({ a: "x\ny" }), '{"a":"x\\ny"}');
  assert.equal(formatValue(["y".repeat(200)]).length, 121);
});

test("formatCallLine: order, empty arguments, error", () => {
  const base = { tool: "status", args: {}, found: null, client: null, caller: null, parts: [], elapsedMs: 3 };
  assert.equal(formatCallLine(base), "INFO status found=- client=- caller=- part=- 3ms");
  assert.equal(
    formatCallLine({ ...base, tool: "search_symbols", args: { pattern: "U", limit: 20 }, found: 18, client: "claude-code 2.1", caller: "w/t1", parts: ["a", "b"] }),
    'INFO search_symbols pattern="U" limit=20 found=18 client="claude-code 2.1" caller="w/t1" part="a;b" 3ms',
  );
  assert.ok(formatCallLine({ ...base, error: "first\nsecond" }).endsWith(" 3ms error=first"));
  assert.ok(formatCallLine({ ...base, error: "first" }).startsWith("WARN "));
});

test("clientOf trims and rejects a blank name", () => {
  assert.equal(clientOf({ clientInfo: { name: "c", version: "1" } }), "c 1");
  assert.equal(clientOf({ clientInfo: { name: "c" } }), "c");
  assert.equal(clientOf({ clientInfo: { name: "  " } }), null);
  assert.equal(clientOf({}), null);
});

let fixture: Fixture;
let server: RunningServer;
let git: FakeGit;
let nextId = 1;
const lines: string[] = [];

before(async () => {
  fixture = writeFixture(REFS);
  git = new FakeGit(fixture.root);
  server = await startServer({
    roots: [fixture.root], preload: ["refs"], watch: false, warmUp: false, port: 0, indexPath: ":memory:",
    warn: (message) => void lines.push(message), git,
  });
  await server.jobs.idle();
});

after(async () => {
  await server.close();
  fixture.remove();
});

async function rpc(method: string, params?: unknown, query = ""): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${server.port}/mcp${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return ((await response.json()) as { result: any }).result;
}

/** The call-log lines written while `run` ran. */
async function logged(run: () => Promise<unknown>): Promise<string[]> {
  const before = lines.length;
  await run();
  return lines.slice(before).filter((l) => /^(INFO|WARN) /.test(l));
}

test("initialize with clientInfo, then search_symbols with caller and part", async () => {
  await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "tester", version: "9.1" } });
  const [line] = await logged(() => rpc("tools/call", { name: "search_symbols", arguments: { pattern: "Square", limit: 20 } }, "?caller=%20abc%20"));
  assert.match(line!, /^INFO search_symbols pattern="Square" limit=20 found=[1-9]\d* client="tester 9.1" caller="abc" part=- \d+ms$/);
  const none = await logged(() => rpc("tools/call", { name: "search_symbols", arguments: { pattern: "NoSuchSymbolAnywhere" } }));
  assert.match(none[0]!, /^INFO search_symbols pattern="NoSuchSymbolAnywhere" found=0 client="tester 9.1" caller=- part=- \d+ms$/);
});

test("a part query value is logged quoted", async () => {
  const [line] = await logged(() => rpc("tools/call", { name: "status", arguments: {} }, "?part=Z:/nope"));
  assert.match(line!, /^WARN status found=- client=.* part="Z:\/nope" \d+ms error=Unknown part: /);
});

test("search_symbols with both caller and a valid part logs the whole line in field order", async () => {
  const identity = ["-c", "user.name=domra", "-c", "user.email=domra@example.invalid", "-c", "commit.gpgsign=false"];
  const git2 = (cwd: string, ...args: string[]): void => void execFileSync("git", [...identity, ...args], { cwd, stdio: "ignore" });
  const tsconfig = { compilerOptions: { types: [] }, include: ["*.ts"] };
  const fx = writeFixture({
    "r/package.json": { name: "r-pkg", version: "1.0.0" },
    "r/tsconfig.json": tsconfig,
    "r/a.ts": "export class Square { area(): number { return 4; } }\n",
  });
  git2(`${fx.root}/r`, "init", "-q", "-b", "main");
  git2(`${fx.root}/r`, "add", ".");
  git2(`${fx.root}/r`, "commit", "-q", "-m", "first");
  const part = `${fx.root}/slots/r/1`;
  git2(`${fx.root}/r`, "worktree", "add", "-q", "-b", "s1", part);
  const own: string[] = [];
  const srv = await startServer({
    roots: [fx.root], port: 0, indexPath: ":memory:", watch: false, warn: (m) => void own.push(m),
  });
  try {
    await srv.jobs.idle();
    const response = await fetch(`http://127.0.0.1:${srv.port}/mcp?caller=abc&part=${encodeURIComponent(part)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_symbols", arguments: { pattern: "Square", limit: 20 } },
      }),
    });
    await response.json();
    const callLines = own.filter((l) => /^(INFO|WARN) /.test(l));
    assert.equal(callLines.length, 1, callLines.join("\n"));
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      callLines[0]!,
      new RegExp(`^INFO search_symbols pattern="Square" limit=20 found=[1-9]\\d* client=- caller="abc" part=${escape(quote(part))} \\d+ms$`),
    );
  } finally {
    await srv.close();
    fx.remove();
  }
});

test("blank part values are not logged", async () => {
  const [line] = await logged(() => rpc("tools/call", { name: "status", arguments: {} }, "?part="));
  assert.ok(line !== undefined && line.includes(" caller=- part=- "), line);
});

test("RpcError exits of tools/call write a Rejected line", async () => {
  const noName = await logged(() => rpc("tools/call", { arguments: {} }));
  assert.deepEqual(noName, ["WARN Rejected ? call with arguments []: Invalid params: name is required"]);
  const badArgs = await logged(() => rpc("tools/call", { name: "status", arguments: [1] }));
  assert.deepEqual(badArgs, ["WARN Rejected status call with arguments []: Invalid params: arguments must be an object"]);
});

test("a lone CR in the error or the problem text does not stay in the line", () => {
  const base = { tool: "status", args: {}, found: null, client: null, caller: null, parts: [], elapsedMs: 3 };
  assert.ok(formatCallLine({ ...base, error: "first\rsecond" }).endsWith(" 3ms error=first"));
  assert.equal(formatRejected("t", {}, "a\rb\r\nc\nd"), "WARN Rejected t call with arguments []: a b c d");
});

test("status has found=-; initialize without clientInfo gives client=-", async () => {
  await rpc("initialize", { protocolVersion: "2025-06-18" });
  const [line] = await logged(() => rpc("tools/call", { name: "status" }));
  assert.match(line!, /^INFO status found=- client=- caller=- part=- \d+ms$/);
});

test("review_changes found is the number of changed declarations", async () => {
  const shapes = fixture.path("refs/src/shapes.ts");
  git.baseTexts.set("refs/src/shapes.ts", readFileSync(shapes, "utf8"));
  writeFileSync(shapes, REFS_SHAPES_TS.replace("export class Square extends Base { area(): number { return 4; } }", "export class Square extends Base { }"));
  git.files = [{ path: shapes, status: "modified" }];
  const [line] = await logged(() => rpc("tools/call", { name: "review_changes", arguments: {} }));
  // the fixture diff removes Square.area: one changed declaration (footer "1 changed declarations")
  assert.match(line!, /^INFO review_changes found=1 /);
});

test("failing calls carry error=; a newline in a key stays on one line", async () => {
  const unknown = await logged(() => rpc("tools/call", { name: "nope", arguments: { x: 1 } }));
  assert.equal(unknown.length, 2);
  assert.match(unknown[0]!, /^WARN Rejected nope call with arguments \[x\]: Unknown tool: nope/);
  assert.match(unknown[1]!, /^WARN nope x=1 found=- .* \d+ms error=Unknown tool: nope\./);

  const bad = await logged(() => rpc("tools/call", { name: "search_symbols", arguments: { "k\ney": 1, z: 2 } }));
  assert.equal(bad.length, 2);
  for (const l of bad) assert.ok(!l.includes("\n"), l);
  assert.ok(bad[0]!.startsWith('WARN Rejected search_symbols call with arguments ["k\\ney", z]: '), bad[0]);
  assert.match(bad[1]!, / error=/);
});

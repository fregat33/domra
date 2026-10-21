import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/post-edit-diagnostics.ts", import.meta.url));

let server: Server;
let url: string;
let calls = 0;
let answer = "";
let lastBody = "";

before(async () => {
  server = createServer((req, res) => {
    calls++;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      lastBody = body;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: answer }] } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

function runHook(stdin: string, domraUrl = url): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, DOMRA_URL: domraUrl } });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(stdin);
  });
}

const EDIT = JSON.stringify({ tool_input: { file_path: "C:/x/a.ts" }, cwd: "C:/x" });

test("errors are reported as additionalContext", async () => {
  answer = "Diagnostics for x: 1 errors, 0 warnings (compiler only; lint is not run)\n  x:1:1  error TS1: boom\n";
  const { code, out } = await runHook(EDIT);
  assert.equal(code, 0);
  const lines = out.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  const output = JSON.parse(lines[0]!).hookSpecificOutput;
  assert.equal(output.hookEventName, "PostToolUse");
  assert.ok(output.additionalContext.startsWith("domra get_diagnostics on the file just edited"), output.additionalContext);
  assert.ok(output.additionalContext.includes("error TS1: boom"));
  const params = JSON.parse(lastBody).params;
  assert.equal(params.name, "get_diagnostics");
  assert.equal(params.arguments.minSeverity, "error");
  assert.equal(params.arguments.limit, 30);
});

test("a clean file prints nothing", async () => {
  answer = "Diagnostics for x: 0 errors, 0 warnings (compiler only; lint is not run)\n";
  assert.deepEqual(await runHook(EDIT), { code: 0, out: "" });
});

test("non-TypeScript paths and empty input do not call the server", async () => {
  answer = "Diagnostics for x: 1 errors, 0 warnings (compiler only; lint is not run)\n";
  const before = calls;
  assert.deepEqual(await runHook(JSON.stringify({ tool_input: { file_path: "C:/x/readme.md" } })), { code: 0, out: "" });
  assert.deepEqual(await runHook(""), { code: 0, out: "" });
  assert.deepEqual(await runHook("{}"), { code: 0, out: "" });
  assert.equal(calls, before);
});

test("an unreachable server prints nothing", async () => {
  assert.deepEqual(await runHook(EDIT, "http://127.0.0.1:1/mcp"), { code: 0, out: "" });
});

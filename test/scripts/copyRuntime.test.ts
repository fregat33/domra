import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/copy-runtime.ts", import.meta.url));
const PKG = fileURLToPath(new URL("../..", import.meta.url));

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "domra-copy-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[], cwd?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("copies the runtime, replaces dist and keeps other files, and the copy starts", { timeout: 120000 }, async () => {
  const target = join(tmp, "copy dir");
  mkdirSync(join(target, "dist"), { recursive: true });
  writeFileSync(join(target, "dist", "stale.js"), "");
  writeFileSync(join(target, "keep.txt"), "x");

  const r = await run([target]);
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(target, "dist", "server", "index.js")));
  assert.ok(existsSync(join(target, "package.json")));
  assert.ok(existsSync(join(target, "node_modules", "typescript", "lib", "typescript.js")));
  assert.ok(!existsSync(join(target, "dist", "stale.js")));
  assert.ok(existsSync(join(target, "keep.txt")));

  const work = join(tmp, "work");
  mkdirSync(work);
  writeFileSync(
    join(work, "domra.local.json"),
    JSON.stringify({
      port: 0,
      roots: [],
      watch: false,
      indexPath: join(tmp, "index.db"),
      logDirectory: join(tmp, "logs"),
    }),
  );
  const child = spawn(process.execPath, [join(target, "dist", "server", "index.js")], { cwd: work });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  try {
    let err = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listening line: ${err}`)), 60000);
      child.on("close", () => reject(new Error(`server exited: ${err}`)));
      child.stderr.on("data", (c) => {
        err += c;
        if (/^domra listening on http:\/\/127\.0\.0\.1:\d+\/mcp$/m.test(err)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    assert.ok(existsSync(join(tmp, "index.db")));
  } finally {
    child.kill();
    await closed;
  }
});

test("without an argument it prints the usage", async () => {
  const r = await run([]);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: node scripts\/copy-runtime\.ts <target folder>/);
});

test("a target inside the package folder is refused", async () => {
  const target = join(PKG, "copy-runtime-test-target");
  const r = await run([target]);
  assert.equal(r.code, 1);
  assert.ok(r.err.startsWith("copy-runtime: the target must be outside the package folder: "));
  assert.ok(!existsSync(target));
});

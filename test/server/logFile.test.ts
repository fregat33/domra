import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LogFile } from "../../src/server/logFile.ts";
import { startServer } from "../../src/server/server.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "domra-log-"));
}

function lines(file: string): Record<string, string>[] {
  return readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, string>);
}

test("lines carry @t, @l for WARN only and the message without its prefix; date change starts a new file", () => {
  const dir = tempDir();
  try {
    let now = new Date(2026, 4, 3, 10, 0, 0);
    const log = new LogFile(dir, 7, () => {}, () => now);
    log.write("INFO status found=1 5ms");
    log.write("WARN Rejected status: bad");
    log.write("domra: plain");
    now = new Date(2026, 4, 4, 0, 0, 1);
    log.write("INFO next day");
    log.close();
    assert.deepEqual(readdirSync(dir).sort(), ["domra-20260503.clef", "domra-20260504.clef"]);
    const first = lines(join(dir, "domra-20260503.clef"));
    assert.equal(first.length, 3);
    assert.deepEqual(first[0], { "@t": new Date(2026, 4, 3, 10, 0, 0).toISOString(), "@m": "status found=1 5ms" });
    assert.equal(first[1]!["@l"], "Warning");
    assert.equal(first[1]!["@m"], "Rejected status: bad");
    assert.deepEqual(Object.keys(first[2]!), ["@t", "@m"]);
    assert.equal(first[2]!["@m"], "domra: plain");
    assert.deepEqual(lines(join(dir, "domra-20260504.clef")).map((l) => l["@m"]), ["next day"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention keeps the newest logRetainedDays domra-*.clef files and nothing else is deleted", () => {
  const dir = tempDir();
  try {
    for (let day = 1; day <= 9; day++) writeFileSync(join(dir, `domra-2026040${day}.clef`), "{}\n");
    writeFileSync(join(dir, "other.clef"), "x");
    new LogFile(dir, 7, () => {}, () => new Date(2026, 4, 1));
    const left = readdirSync(dir).sort();
    assert.deepEqual(left, [
      "domra-20260403.clef", "domra-20260404.clef", "domra-20260405.clef", "domra-20260406.clef",
      "domra-20260407.clef", "domra-20260408.clef", "domra-20260409.clef", "other.clef",
    ]);
    new LogFile(dir, 0, () => {}, () => new Date(2026, 4, 1));
    assert.equal(readdirSync(dir).length, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unwritable log directory neither throws nor warns more than once", () => {
  const dir = tempDir();
  try {
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    const warnings: string[] = [];
    const log = new LogFile(join(blocker, "logs"), 7, (m) => void warnings.push(m));
    log.write("INFO one");
    log.write("WARN two");
    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(warnings[0]!, /log file write failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startServer with logDirectory writes a tool call line to the file", async () => {
  const dir = tempDir();
  const own: string[] = [];
  const logs = join(dir, "logs");
  const srv = await startServer({
    roots: [], port: 0, indexPath: ":memory:", watch: false, warmUp: false, logDirectory: logs,
    warn: (m) => void own.push(m),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: {} } }),
    });
    await response.json();
    const files = readdirSync(logs);
    assert.equal(files.length, 1);
    const entries = lines(join(logs, files[0]!));
    assert.ok(entries.some((e) => /^status /.test(e["@m"]!)), JSON.stringify(entries));
    assert.ok(own.some((m) => m.startsWith("INFO status ")), own.join("\n"));
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

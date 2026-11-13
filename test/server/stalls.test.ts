import assert from "node:assert/strict";
import { test } from "node:test";
import { StallMonitor, clock } from "../../src/server/stalls.ts";
import { startServer } from "../../src/server/server.ts";
import { indexTimingLine } from "../../src/workspace/indexer.ts";
import type { IndexReport } from "../../src/workspace/indexer.ts";
import { writeFixture } from "../fixtures.ts";
import { REFS } from "../workspace/projects.ts";

test("observe below warnMs records nothing", () => {
  const lines: string[] = [];
  const monitor = new StallMonitor({ warn: (m) => void lines.push(m) });
  monitor.observe(2999);
  assert.equal(monitor.line(), "Stalls: none over 3s");
  assert.deepEqual(lines, []);
});

test("observe writes the WARN line and counts", () => {
  const lines: string[] = [];
  const at = new Date(2026, 10, 13, 9, 5, 7);
  const monitor = new StallMonitor({ warn: (m) => void lines.push(m), now: () => at });
  monitor.mark("tool find_references");
  monitor.mark("job index a");
  monitor.observe(4200);
  assert.deepEqual(lines, ["WARN domra: Event loop stalled 4.2s; last work: tool find_references, job index a"]);
  assert.equal(monitor.line(), `Stalls: longest 4.2s at ${clock(at)}, 1 over 3s, 0 over 10s since start`);
  assert.match(monitor.line(), /at 09:05:07,/);
});

test("a long stall is in both counts; a shorter one keeps the longest", () => {
  const lines: string[] = [];
  const monitor = new StallMonitor({ warn: (m) => void lines.push(m) });
  monitor.mark("job x");
  monitor.observe(4200);
  monitor.observe(12000);
  assert.equal(lines[1], "WARN domra: Event loop stalled 12.0s; last work: none");
  assert.match(monitor.line(), /longest 12\.0s at \d\d:\d\d:\d\d, 2 over 3s, 1 over 10s since start$/);
  monitor.observe(5000);
  assert.match(monitor.line(), /longest 12\.0s at \d\d:\d\d:\d\d, 3 over 3s, 1 over 10s since start$/);
  assert.equal(lines.length, 3);
});

test("a stall with nothing marked says none", () => {
  const lines: string[] = [];
  const monitor = new StallMonitor({ warn: (m) => void lines.push(m) });
  monitor.observe(12000);
  assert.equal(lines[0], "WARN domra: Event loop stalled 12.0s; last work: none");
});

test("start and stop are safe twice", () => {
  const monitor = new StallMonitor({ warn: () => undefined });
  monitor.start();
  monitor.start();
  monitor.stop();
  monitor.stop();
});

test("indexTimingLine rounds the time", () => {
  const report = { elapsedMs: 12.6, documentsVisited: 3 } as IndexReport;
  assert.equal(indexTimingLine("a", report), "domra: a: index 13ms, 3 documents");
});

test("the server reports a stall, its work, and the load and index timings", async () => {
  const fixture = writeFixture(REFS);
  const lines: string[] = [];
  const server = await startServer({
    roots: [fixture.root], watch: false, warmUp: false, port: 0, indexPath: ":memory:",
    warn: (message) => void lines.push(message), stalls: { warnMs: 200, longMs: 60000, intervalMs: 20 },
  });
  try {
    let nextId = 1;
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
      });
      return ((await response.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text;
    };
    const fresh = await call("status", {});
    assert.match(fresh, /^Jobs: .*\nStalls: none over 0\.2s\n/m);

    await server.jobs.enqueue("block", () => {
      const end = performance.now() + 500;
      while (performance.now() < end) {
        // block the loop
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(lines.some((l) => /^WARN domra: Event loop stalled \d+\.\ds; last work: .*job block/.test(l)), lines.join("\n"));
    assert.match(await call("status", {}), /^Stalls: longest \d+\.\ds at \d\d:\d\d:\d\d, [1-9]\d* over 0\.2s, 0 over 60s since start$/m);

    await call("load_solution", { solution: "refs" });
    await server.jobs.idle();
    assert.equal(lines.filter((l) => /^domra: (.+): load \d+ms$/.test(l)).length, 1);
    assert.ok(lines.some((l) => /^domra: refs: index \d+ms, \d+ documents$/.test(l)), lines.join("\n"));
  } finally {
    await server.close();
    fixture.remove();
  }
});

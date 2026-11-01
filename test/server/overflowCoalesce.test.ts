import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "../../src/server/server.ts";
import { writeFixture } from "../fixtures.ts";
import { until } from "../watcher/until.ts";

const APP = { compilerOptions: { types: [] }, include: ["src"] };

test("two overflow batches queued behind a slow job merge into one reconcile and keep their paths", async () => {
  const names = ["a", "b", "c"];
  const files: Record<string, unknown> = {};
  for (const n of names) {
    files[`r${n}/${n}/tsconfig.json`] = APP;
    files[`r${n}/${n}/src/x.ts`] = `export class ${n.toUpperCase()}0 {}\n`;
  }
  const fixture = writeFixture(files as never);
  const warnings: string[] = [];
  const roots = names.map((n) => `${fixture.root}/r${n}`);
  const server = await startServer({
    roots, preload: names, warmUp: false, port: 0, indexPath: ":memory:", debounceMs: 100, warn: (m) => warnings.push(m),
  });
  try {
    await server.jobs.idle();
    warnings.length = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    void server.jobs.enqueue("slow", () => gate);
    const debouncer = (server.watcher as unknown as { debouncer: { add(p: string): void; markOverflow(r?: string): void; flush(): void } }).debouncer;
    const first = `${fixture.root}/rc/c/src/y1.ts`;
    const second = `${fixture.root}/rc/c/src/y2.ts`;
    writeFileSync(first, "export class CFirst {}\n");
    debouncer.add(first);
    debouncer.markOverflow(roots[0]);
    debouncer.flush();
    writeFileSync(second, "export class CSecond {}\n");
    debouncer.add(second);
    debouncer.markOverflow(roots[1]);
    debouncer.flush();
    release();
    await until(() => warnings.some((m) => m.includes("Reconciling")), 10000);
    await server.jobs.idle();
    const reconciles = warnings.filter((m) => m.startsWith("domra: Reconciling"));
    assert.deepEqual(reconciles, ["domra: Reconciling 2 loaded solutions under overflowed roots"], warnings.join("\n"));
    assert.equal(warnings.filter((m) => m.startsWith("domra: File watcher overflow under")).length, 2);
    assert.equal(server.store.searchSymbols("CFirst", null, 10).length, 1);
    assert.equal(server.store.searchSymbols("CSecond", null, 10).length, 1);
  } finally {
    await server.close();
    fixture.remove();
  }
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { docIdOf } from "../../src/workspace/extractor.ts";
import { findImplementationsText } from "../../src/workspace/implementations.ts";
import { WorkspaceManager } from "../../src/workspace/manager.ts";
import { findReferencesText } from "../../src/workspace/references.ts";
import { findInSolution } from "../../src/workspace/resolver.ts";
import type { LoadedSolution } from "../../src/workspace/solution.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { HANDLER_TS, PKG, SHARED } from "./projects.ts";

let fx: Fixture;
let manager: WorkspaceManager;
let libpkg: LoadedSolution;
let webapp: LoadedSolution;
let worker: LoadedSolution;

before(() => {
  fx = writeFixture({ ...PKG, ...SHARED });
  manager = new WorkspaceManager({ roots: [fx.root] });
  manager.discover();
  libpkg = manager.load("libpkg");
  webapp = manager.load("webapp");
  worker = manager.load("worker");
});

after(() => fx.remove());

const header = (text: { groups: { header: string }[] }): string[] => text.groups.map((g) => g.header);

test("discovery finds libpkg, webapp and worker, nothing under node_modules", () => {
  const names = manager.solutions.map((s) => s.name).sort();
  assert.deepEqual(names, ["appA", "appB", "libpkg", "webapp", "worker"]);
});

test("a package's source and its published d.ts share one docId", () => {
  const source = findInSolution(libpkg, "OrderPlaced")!;
  assert.equal(source.node.getSourceFile().fileName, fx.path("libpkg/src/orders.ts"));
  assert.equal(docIdOf(source.node, source.project, libpkg), "acme-contracts/orders#OrderPlaced");
  const published = findInSolution(webapp, "OrderPlaced")!;
  assert.equal(published.node.getSourceFile().fileName, fx.path("webapp/node_modules/acme-contracts/dist/orders.d.ts"));
  assert.equal(docIdOf(published.node, published.project, webapp), "acme-contracts/orders#OrderPlaced");
  const service = findInSolution(worker, "OrderService")!;
  assert.equal(docIdOf(service.node, service.project, worker), "acme-contracts/orders#OrderService");
});

test("SHARED: the shared package's docId drops the src root", () => {
  const appA = manager.load("appA");
  const gadget = findInSolution(appA, "Gadget")!;
  assert.equal(docIdOf(gadget.node, gadget.project, appA), "shared-lib/lib#Gadget");
});

test("find_references of a package type covers every consumer solution", () => {
  const refs = findReferencesText(manager, "OrderPlaced", { solution: undefined });
  const headers = header(refs);
  assert.ok(headers.includes("Live libpkg: 1 references"), headers.join("\n"));
  assert.ok(headers.includes("Live webapp: 2 references"), headers.join("\n"));
  assert.ok(headers.includes("Live worker: 2 references"), headers.join("\n"));
  const items = refs.groups.flatMap((g) => g.items);
  assert.ok(items.every((line) => !line.includes("/node_modules/")), items.join("\n"));
  assert.ok(items.includes(`  ${fx.path("libpkg/src/orders.ts")}:3:16  acme-contracts  usage  in OrderService.place`), items.join("\n"));
  assert.ok(items.includes(`  ${fx.path("worker/src/handler.ts")}:2:31  worker  usage  in handle`), items.join("\n"));
  assert.equal(refs.footer, "Total: 5 references");
});

test("find_references of a published class from the source solution", () => {
  const refs = findReferencesText(manager, "OrderService");
  const headers = header(refs);
  assert.ok(headers.includes("Live libpkg: 0 references"), headers.join("\n"));
  assert.ok(headers.includes("Live webapp: 2 references"), headers.join("\n"));
  const webappItems = refs.groups.find((g) => g.header.startsWith("Live webapp"))!.items;
  assert.ok(webappItems.some((l) => l.includes("  import")), webappItems.join("\n"));
  assert.ok(webappItems.some((l) => l.includes("  creation  in checkout")), webappItems.join("\n"));
});

test("find_implementations / find_derived_types reach consumer classes through the d.ts twin", () => {
  const big = writeFixture({
    ...PKG,
    "worker/src/handler.ts": `${HANDLER_TS}export class Big implements OrderPlaced { id = ""; total = 1e6; }\n`,
  });
  try {
    const local = new WorkspaceManager({ roots: [big.root] });
    local.discover();
    for (const name of ["libpkg", "webapp", "worker"]) local.load(name);
    for (const typesOnly of [false, true]) {
      const impl = findImplementationsText(local, "OrderPlaced", { typesOnly });
      assert.deepEqual(header(impl), ["Live libpkg: 0", "Live worker: 1"]);
      const items = impl.groups[1]!.items;
      assert.deepEqual(items, [`  implements  class Big  ${big.path("worker/src/handler.ts")}:3:14`]);
      assert.equal(impl.footer, "Total: 1");
    }
  } finally {
    big.remove();
  }
});

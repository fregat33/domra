import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { packageModulePath, packageOf } from "../../src/workspace/packages.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { MONO, PKG, SHARED } from "./projects.ts";

let fx: Fixture;

before(() => {
  fx = writeFixture({
    ...PKG,
    ...SHARED,
    ...MONO,
    "loose/src/x.ts": "export const x = 1;\n",
    "scoped/node_modules/@scope/pkg/package.json": { name: "@scope/pkg", version: "2.0.0", main: "lib/index.js" },
    "scoped/node_modules/@scope/pkg/lib/x.d.ts": "export declare const x: number;\n",
  });
});

after(() => fx.remove());

const summary = (path: string) => {
  const info = packageOf(fx.path(path));
  return info && { name: info.name, version: info.version, sourceRoot: info.sourceRoot };
};

test("package source: tsconfig rootDir is the source root", () => {
  assert.deepEqual(summary("libpkg/src/orders.ts"), { name: "acme-contracts", version: "1.1.0", sourceRoot: "src" });
  assert.equal(packageOf(fx.path("libpkg/src/orders.ts"))!.dir, fx.path("libpkg"));
});

test("published package: the directory of package.json types is the source root", () => {
  const path = fx.path("webapp/node_modules/acme-contracts/dist/orders.d.ts");
  assert.deepEqual(summary("webapp/node_modules/acme-contracts/dist/orders.d.ts"), { name: "acme-contracts", version: "1.0.0", sourceRoot: "dist" });
  assert.equal(packageOf(path)!.dir, fx.path("webapp/node_modules/acme-contracts"));
  assert.equal(packageModulePath(packageOf(path)!, path), "orders.d.ts");
});

test("module path strips the source root", () => {
  const path = fx.path("libpkg/src/orders.ts");
  assert.equal(packageModulePath(packageOf(path)!, path), "orders.ts");
});

test("src is the default source root; mono core takes rootDir", () => {
  assert.equal(packageOf(fx.path("shared/src/lib.ts"))!.sourceRoot, "src");
  assert.equal(packageOf(fx.path("shared/src/lib.ts"))!.version, null);
  assert.equal(packageOf(fx.path("mono/packages/core/src/index.ts"))!.sourceRoot, "src");
  assert.equal(packageOf(fx.path("mono/packages/core/src/index.ts"))!.name, "@mono/core");
});

test("a file without a package.json above has no package", () => {
  assert.equal(packageOf(fx.path("loose/src/x.ts")), null);
  assert.equal(packageOf(fx.path("mono/packages/ui/src/App.tsx")), null);
});

test("scoped package under node_modules: the directory of main is the source root", () => {
  const path = fx.path("scoped/node_modules/@scope/pkg/lib/x.d.ts");
  assert.deepEqual(summary("scoped/node_modules/@scope/pkg/lib/x.d.ts"), { name: "@scope/pkg", version: "2.0.0", sourceRoot: "lib" });
  assert.equal(packageModulePath(packageOf(path)!, path), "x.d.ts");
});

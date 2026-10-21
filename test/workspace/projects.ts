import type { FixtureFiles } from "../fixtures.ts";

const compilerOptions = {
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "Bundler",
  strict: true,
  jsx: "preserve",
  types: [],
};

export const SHAPES_TS = `export interface Shape {
  area(): number;
}

export class Circle implements Shape {
  radius: number;
  constructor(radius: number) {
    this.radius = radius;
  }
  area(): number {
    const factor = Math.PI;
    return factor * this.radius * this.radius;
  }
}

export function makeCircle(radius: number): Circle {
  return new Circle(radius);
}

export function format(value: string): string;
export function format(value: number, digits: number): string;
export function format(value: string | number, digits?: number): string {
  return typeof value === "number" ? value.toFixed(digits) : value;
}

export namespace Geometry {
  export class Point {
    constructor(public x: number, public y: number) {}
    static origin(): Point {
      return new Point(0, 0);
    }
  }
}

export enum Color {
  Red,
  Green,
}

export { makeCircle as circleFactory };
`;

export const MAIN_TS = `import { Circle as Round, makeCircle } from "./shapes";

const shape = new Round(2);
export const total = shape.area() + makeCircle(1).area();
`;

export const WIDGET_TS = `export class Widget {
  size = 1;
}
`;

export const LEGACY_D_TS = `declare class Widget {
  size: number;
}
`;

/** A solution without references: one project named from package.json. */
export const SINGLE: FixtureFiles = {
  "single/tsconfig.json": { compilerOptions, include: ["src"] },
  "single/package.json": { name: "single-pkg", version: "1.0.0" },
  "single/src/shapes.ts": SHAPES_TS,
  "single/src/main.ts": MAIN_TS,
  "single/src/widget.ts": WIDGET_TS,
  "single/src/legacy.d.ts": LEGACY_D_TS,
};

export const DECORATED_TS = `function Route(_path: string): (t: unknown, c: unknown) => void { return () => {}; }
function Marker(_t: unknown, _c: unknown): void {}
export class Api {
  @Route("api/orders") @Marker
  handle(): void {}
}
`;

/** Single-project solution `inherit`: a derived class overriding one member of its base. */
export const INHERIT: FixtureFiles = {
  "inherit/tsconfig.json": { compilerOptions, include: ["src"] },
  "inherit/src/base.ts":
    'export class Base { protected id = 0; static create(): Base { return new Base(); } describe(): string { return ""; } }\n',
  "inherit/src/derived.ts":
    'import { Base } from "./base";\nexport class Derived extends Base { name = ""; override describe(): string { return this.name; } }\n',
  "inherit/src/api.ts": DECORATED_TS,
};

export const APP_TSX = `import { coreGreeting } from "@mono/core";

export function App() {
  return <div>{coreGreeting("ui")}</div>;
}
`;

/** A solution whose tsconfig references two projects; `ui` (no package.json) has a .tsx file. */
export const MONO: FixtureFiles = {
  "mono/tsconfig.json": {
    files: [],
    references: [{ path: "./packages/core" }, { path: "./packages/ui" }],
  },
  "mono/packages/core/tsconfig.json": {
    compilerOptions: { ...compilerOptions, composite: true, outDir: "dist", rootDir: "src" },
    include: ["src"],
  },
  "mono/packages/core/package.json": {
    name: "@mono/core",
    types: "dist/index.d.ts",
  },
  "mono/packages/core/src/index.ts": `export function coreGreeting(name: string): string {
  return "hello " + name;
}
`,
  "mono/packages/ui/tsconfig.json": {
    compilerOptions: {
      ...compilerOptions,
      composite: true,
      outDir: "dist",
      rootDir: "src",
      paths: { "@mono/core": ["../core/dist/index.d.ts"] },
    },
    include: ["src"],
    references: [{ path: "../core" }],
  },
  "mono/packages/ui/src/App.tsx": APP_TSX,
};

export const JOBS_TS = `export class CloseCompletedOrdersJob {
  jobTitle = "";
}

export interface Order {
  jobTitle: string;
  uploadDate: Date;
}

export class UpdateOrderCommand {}
`;

export const FILES_TS = `export enum FileStatus {
  Uploaded,
  Pending,
}

export interface FileRepository {
  uploadFile(): void;
  uploadUri(): string;
}
`;

export const RETRY_TS = `export class RetryPolicy {
  createRetryOptions(): void {}
}
`;

export const HTTP_TS = `export class HTTPClientFactory {}

export const _validator = 1;
`;

export const JOBS_TEST_TS = `export class CloseCompletedOrdersJob {}

export function handle_ShouldTruncateAndUpload() {}
`;

/** Single-project solution `demo` for symbol search. */
export const SEARCH: FixtureFiles = {
  "demo/tsconfig.json": { compilerOptions, include: ["src", "test"] },
  "demo/src/jobs.ts": JOBS_TS,
  "demo/src/files.ts": FILES_TS,
  "demo/src/retry.ts": RETRY_TS,
  "demo/src/http.ts": HTTP_TS,
  "demo/test/jobs.test.ts": JOBS_TEST_TS,
};

export const REFS_SHAPES_TS = `export interface Shape { area(): number; }
export abstract class Base implements Shape { abstract area(): number; describe(): string { return String(this.area()); } }
export class Circle extends Base { constructor(public r: number) { super(); } area(): number { return this.r * this.r; } }
export class Square extends Base { area(): number { return 4; } }
export class Tiny extends Circle { override area(): number { return 1; } }
export function Tag(_t: unknown, _c: unknown): void {}
`;

export const REFS_MAIN_TS = `import { Circle, Shape, Tag } from "./shapes";
export const unit = new Circle(1);
export function total(shapes: Shape[]): number { return shapes.reduce((sum, s) => sum + s.area(), 0); }
export class Holder { shape = new Circle(2); get big(): boolean { return this.shape.area() > 10; } @Tag run(): number { return total([this.shape]); } }
new Circle(3);
`;

export const REFS_TEST_TS = `import { Circle } from "../src/shapes";
export const fixture = new Circle(5);
`;

/** Single-project solution `refs`: a class hierarchy used from production and test code. */
export const REFS: FixtureFiles = {
  "refs/tsconfig.json": { compilerOptions: { ...compilerOptions, experimentalDecorators: false }, include: ["src", "test"] },
  "refs/package.json": { name: "refs-pkg", version: "1.0.0" },
  "refs/src/shapes.ts": REFS_SHAPES_TS,
  "refs/src/main.ts": REFS_MAIN_TS,
  "refs/test/shapes.test.ts": REFS_TEST_TS,
};

export const BAD_TS = `export const n: number = "x";
export function f(a: number): number { return a; }
f("y");
export function g(): void { const unused = 1; }
`;

/** Single-project solution `diag` (project `diag-pkg`): one clean, one type-broken and one unparsable file. */
export const DIAG: FixtureFiles = {
  "diag/tsconfig.json": { compilerOptions: { ...compilerOptions, strict: true }, include: ["src"] },
  "diag/package.json": { name: "diag-pkg", version: "1.0.0" },
  "diag/src/ok.ts": "export const fine: number = 1;\n",
  "diag/src/bad.ts": BAD_TS,
  "diag/src/syntax.ts": "export const = 1;\n",
};

/** A project importing a package that is not installed. */
export const BROKEN: FixtureFiles = {
  "broken/tsconfig.json": { compilerOptions, include: ["src"] },
  "broken/src/index.ts": `import leftPad from "left-pad-not-installed";
import { helper } from "./helper";

export const padded = leftPad(helper());
`,
  "broken/src/helper.ts": `export function helper(): string {
  return "x";
}
`,
};

/** A tsconfig inside node_modules that discovery must ignore. */
export const IGNORED: FixtureFiles = {
  "node_modules/some-pkg/tsconfig.json": { compilerOptions },
  "node_modules/some-pkg/index.ts": "export const x = 1;\n",
};

const sharedTsconfig = { compilerOptions, include: ["src", "../shared/src"] };

/** Two solutions (`appA`, `appB`) that both include the package `shared` (docId scope `shared-lib/lib`). */
export const SHARED: FixtureFiles = {
  "shared/package.json": { name: "shared-lib" },
  "shared/src/lib.ts": `export class Gadget { spin(): number { return 1; } }
export function makeGadget(): Gadget { return new Gadget(); }
`,
  "appA/package.json": { name: "app-a" },
  "appA/tsconfig.json": sharedTsconfig,
  "appA/src/a.ts": `import { Gadget } from "../../shared/src/lib";
export const a = new Gadget();
export const spun = a.spin();
`,
  "appB/package.json": { name: "app-b" },
  "appB/tsconfig.json": sharedTsconfig,
  "appB/src/b.ts": `import { makeGadget } from "../../shared/src/lib";
export const b = makeGadget();
`,
};

export const ORDERS_TS = `export interface OrderPlaced { id: string; total: number }
export class OrderService {
  place(order: OrderPlaced): void { void order; }
}
`;

export const ORDERS_D_TS = `export interface OrderPlaced { id: string; total: number; }
export declare class OrderService { place(order: OrderPlaced): void; }
`;

export const HANDLER_TS = `import type { OrderPlaced } from "acme-contracts";
export function handle(event: OrderPlaced): number { return event.total; }
`;

const consumerTsconfig = { compilerOptions, include: ["src"] };

/** `acme-contracts` as published under a consumer's node_modules. */
function publishedContracts(prefix: string, version: string): FixtureFiles {
  return {
    [`${prefix}/package.json`]: { name: "acme-contracts", version, types: "dist/index.d.ts" },
    [`${prefix}/dist/index.d.ts`]: 'export * from "./orders";\n',
    [`${prefix}/dist/orders.d.ts`]: ORDERS_D_TS,
  };
}

/**
 * Three solutions: `libpkg` (the source of the package `acme-contracts`) and its consumers `webapp` and `worker`,
 * which get it published under node_modules (`dist/*.d.ts`). Both sides share docIds such as `acme-contracts/orders#OrderPlaced`.
 */
export const PKG: FixtureFiles = {
  "libpkg/package.json": { name: "acme-contracts", version: "1.1.0", types: "dist/index.d.ts" },
  "libpkg/tsconfig.json": {
    compilerOptions: { ...compilerOptions, outDir: "dist", rootDir: "src", declaration: true },
    include: ["src"],
  },
  "libpkg/src/index.ts": 'export * from "./orders";\n',
  "libpkg/src/orders.ts": ORDERS_TS,
  "webapp/package.json": { name: "webapp", version: "0.1.0" },
  "webapp/tsconfig.json": consumerTsconfig,
  ...publishedContracts("webapp/node_modules/acme-contracts", "1.0.0"),
  "webapp/src/checkout.ts": `import { OrderPlaced, OrderService } from "acme-contracts";
export function checkout(order: OrderPlaced): void { new OrderService().place(order); }
`,
  "worker/package.json": { name: "worker", version: "0.1.0" },
  "worker/tsconfig.json": consumerTsconfig,
  ...publishedContracts("worker/node_modules/acme-contracts", "1.1.0"),
  "worker/src/handler.ts": HANDLER_TS,
};

/** Single-project solution `union`: an interface, two implementations and a call on their union. */
export const UNION: FixtureFiles = {
  "union/tsconfig.json": { compilerOptions, include: ["src"] },
  "union/package.json": { name: "union-pkg", version: "1.0.0" },
  "union/src/u.ts": `export interface A { f(): void }
export class B implements A { f(): void {} }
export class C implements A { f(): void {} }
export function g(x: B | C, a: A): void { x.f(); a.f(); }
`,
};

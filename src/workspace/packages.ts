import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import ts from "typescript";
import { toSlashes } from "./positions.ts";

/** The package a file belongs to: its directory, name, version and the root its module paths are taken from. */
export type PackageInfo = { dir: string; name: string; version: string | null; sourceRoot: string };

type Manifest = { name: string | null; version: string | null; entries: string[] };

const NODE_MODULES = "/node_modules/";
const manifests = new Map<string, Manifest | null>();
const tsconfigRoots = new Map<string, string | null>();
const packages = new Map<string, PackageInfo | null>();

const trimSlashes = (path: string): string => toSlashes(path).replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
const stringOr = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** `name`, `version` and the entry fields (`types`, `typings`, `main`, `module`) of `dir/package.json`, cached per directory. */
function manifestOf(dir: string): Manifest | null {
  if (manifests.has(dir)) return manifests.get(dir)!;
  let manifest: Manifest | null = null;
  const file = `${dir}/package.json`;
  if (existsSync(file)) {
    try {
      const json: unknown = JSON.parse(readFileSync(file, "utf8"));
      const data = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : {};
      const entries = ["types", "typings", "main", "module"].map((k) => stringOr(data[k])).filter((v): v is string => v !== null);
      manifest = { name: stringOr(data["name"]), version: stringOr(data["version"]), entries };
    } catch {
      manifest = null;
    }
  }
  manifests.set(dir, manifest);
  return manifest;
}

/** `compilerOptions.rootDir`, else `compilerOptions.outDir`, of `dir/tsconfig.json` relative to `dir`; cached per directory. */
function tsconfigRootOf(dir: string): string | null {
  if (tsconfigRoots.has(dir)) return tsconfigRoots.get(dir)!;
  let root: string | null = null;
  const file = `${dir}/tsconfig.json`;
  if (existsSync(file)) {
    const options: unknown = ts.readConfigFile(file, ts.sys.readFile).config?.compilerOptions;
    if (options !== null && typeof options === "object") {
      const record = options as Record<string, unknown>;
      root = stringOr(record["rootDir"]) ?? stringOr(record["outDir"]);
    }
  }
  tsconfigRoots.set(dir, root);
  return root;
}

/** The first rule that applies: tsconfig rootDir/outDir, the directory of an entry field, `src`, else `""`. */
function sourceRootOf(dir: string, manifest: Manifest | null, relativePath: string): string {
  const within = (root: string | null): root is string => root !== null && root !== "" && relativePath.startsWith(`${root}/`);
  const configured = tsconfigRootOf(dir);
  const fromConfig = configured === null ? null : trimSlashes(configured);
  if (within(fromConfig)) return fromConfig;
  const entry = manifest?.entries[0] === undefined ? null : toSlashes(manifest.entries[0]);
  const fromEntry = entry === null ? null : trimSlashes(entry.slice(0, Math.max(0, entry.lastIndexOf("/"))));
  if (within(fromEntry)) return fromEntry;
  return relativePath.startsWith("src/") ? "src" : "";
}

/** The `node_modules/<name>` or `node_modules/@scope/<name>` directory of a path under node_modules, else null. */
function nodeModulesPackageDir(path: string): { dir: string; name: string } | null {
  const index = path.lastIndexOf(NODE_MODULES);
  if (index < 0) return null;
  const at = index + NODE_MODULES.length;
  const segments = path.slice(at).split("/");
  const count = segments[0]!.startsWith("@") ? 2 : 1;
  return { dir: path.slice(0, at) + segments.slice(0, count).join("/"), name: segments.slice(0, count).join("/") };
}

function info(dir: string, name: string, manifest: Manifest | null, path: string): PackageInfo {
  return { dir, name, version: manifest?.version ?? null, sourceRoot: sourceRootOf(dir, manifest, path.slice(dir.length + 1)) };
}

function computePackage(path: string): PackageInfo | null {
  const bound = nodeModulesPackageDir(path);
  for (let dir = toSlashes(dirname(path)); ; dir = toSlashes(dirname(dir))) {
    if (bound && dir.length < bound.dir.length) return info(bound.dir, bound.name, manifestOf(bound.dir), path);
    const manifest = manifestOf(dir);
    if (manifest?.name) return info(dir, manifest.name, manifest, path);
    if (toSlashes(dirname(dir)) === dir) return null;
  }
}

/**
 * The package of a file: the nearest directory at or above it whose package.json has a string `name`
 * (under node_modules no higher than the `node_modules/<name>` directory). Null without one.
 */
export function packageOf(fileName: string): PackageInfo | null {
  const path = toSlashes(fileName);
  // The source root depends on the file's top-level directory inside the package, so the cache key is the directory.
  const key = toSlashes(dirname(path));
  if (packages.has(key)) return packages.get(key)!;
  const result = computePackage(path);
  packages.set(key, result);
  return result;
}

/** Path of a file relative to its package directory with the source root stripped (extension kept). */
export function packageModulePath(info: PackageInfo, fileName: string): string {
  const relativePath = toSlashes(fileName).slice(info.dir.length + 1);
  return info.sourceRoot !== "" && relativePath.startsWith(`${info.sourceRoot}/`) ? relativePath.slice(info.sourceRoot.length + 1) : relativePath;
}

/** Forget every cached package.json and tsconfig read (tests, or after manifests change). */
export function clearPackageCache(): void {
  manifests.clear();
  tsconfigRoots.clear();
  packages.clear();
}

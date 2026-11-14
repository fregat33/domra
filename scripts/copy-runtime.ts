// Writes a runnable copy of the server into a folder: node scripts/copy-runtime.ts <target folder>
// The copy holds dist/, package.json and node_modules/<each key of dependencies>.
// Limit: dependencies are copied as installed folders; nested dependencies of a dependency are NOT handled
// (typescript has none). Add real installation if a dependency with dependencies is ever added.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const arg = process.argv[2];

if (!arg) {
  console.error("usage: node scripts/copy-runtime.ts <target folder>");
  process.exit(1);
}

const target = resolve(arg);
const rel = relative(pkgDir, target);
if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
  console.error(`copy-runtime: the target must be outside the package folder: ${target}`);
  process.exit(1);
}

const build = spawnSync(
  process.execPath,
  [join(pkgDir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
  { cwd: pkgDir, stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
  version: string;
  dependencies?: Record<string, string>;
};

mkdirSync(target, { recursive: true });
rmSync(join(target, "dist"), { recursive: true, force: true });
cpSync(join(pkgDir, "dist"), join(target, "dist"), { recursive: true });
cpSync(join(pkgDir, "package.json"), join(target, "package.json"));
for (const name of Object.keys(pkg.dependencies ?? {})) {
  const dest = join(target, "node_modules", name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(pkgDir, "node_modules", name), dest, { recursive: true });
}

console.log(`copy-runtime: ${target} (${pkg.version})`);

// Usage: node scripts/measure-load.ts <root>
// Discovers tsconfig solutions under <root>, loads them all and prints load statistics.
import { WorkspaceManager } from "../src/workspace/index.ts";

const root = process.argv[2];
if (!root) {
  console.error("usage: node scripts/measure-load.ts <root>");
  process.exit(2);
}

const manager = new WorkspaceManager({ roots: [root] });
const solutions = manager.discover();
console.log(`${solutions.length} solution(s) under ${root}`);

let rootFiles = 0;
let sourceFiles = 0;
let relative = 0;
let packages = 0;
const started = performance.now();
for (const solution of solutions) {
  const loaded = manager.load(solution.path);
  rootFiles += loaded.rootFiles;
  sourceFiles += loaded.sourceFiles;
  relative += loaded.unresolved.relative;
  packages += loaded.unresolved.package;
  console.log(
    [
      loaded.name,
      `projects=${loaded.projects.map((p) => p.name).join(",")}`,
      `rootFiles=${loaded.rootFiles}`,
      `sourceFiles=${loaded.sourceFiles}`,
      `loadMs=${loaded.loadMs}`,
      `unresolvedRelative=${loaded.unresolved.relative}`,
      `unresolvedPackage=${loaded.unresolved.package}`,
    ].join("  "),
  );
}
const totalMs = Math.round(performance.now() - started);
console.log(
  [
    "total",
    `projects=${solutions.length} solution(s)`,
    `rootFiles=${rootFiles}`,
    `sourceFiles=${sourceFiles}`,
    `loadMs=${totalMs}`,
    `unresolvedRelative=${relative}`,
    `unresolvedPackage=${packages}`,
  ].join("  "),
);

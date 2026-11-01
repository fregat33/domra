import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathKey, readReferences } from "./discovery.ts";
import type { LoadedProject, LoadedSolution } from "./solution.ts";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

function readPackageJson(dir: string): Record<string, unknown> {
  try {
    const json: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return json !== null && typeof json === "object" ? (json as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `name` of the package.json in `dir`; null when there is none (the directory-name fallback of a project is not a package name). */
export function packageNameOf(dir: string): string | null {
  const name = readPackageJson(dir)["name"];
  return typeof name === "string" && name !== "" ? name : null;
}

/** Package names declared in any dependency field of the package.json in `dir`. */
function declaredDependencies(dir: string): Set<string> {
  const json = readPackageJson(dir);
  const result = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const value = json[field];
    if (value !== null && typeof value === "object") for (const name of Object.keys(value)) result.add(name);
  }
  return result;
}

function referencedKeys(project: LoadedProject): Set<string> {
  try {
    return new Set(readReferences(project.tsconfig).map(pathKey));
  } catch {
    return new Set();
  }
}

/** Whether `project` consumes a project with one of the package names or is referenced to one of the tsconfigs (keys). */
function consumes(project: LoadedProject, packageNames: ReadonlySet<string>, tsconfigKeys: ReadonlySet<string>): boolean {
  if (tsconfigKeys.size > 0) for (const key of referencedKeys(project)) if (tsconfigKeys.has(key)) return true;
  if (packageNames.size === 0) return false;
  for (const name of declaredDependencies(project.dir)) if (packageNames.has(name)) return true;
  return false;
}

/**
 * The given projects (by name) plus every project of the solution that depends on one of them, transitively.
 * An edge is a tsconfig `references` entry to a project, or a package.json dependency naming a project's package.
 * Cycles terminate (each project is visited once). Unknown names are ignored. Sorted.
 */
export function withTransitiveDependents(solution: LoadedSolution, projectNames: Iterable<string>): string[] {
  const names = new Set(projectNames);
  const result = new Set(solution.projects.filter((p) => names.has(p.name)).map((p) => p.name));
  const queue = solution.projects.filter((p) => result.has(p.name));
  while (queue.length > 0) {
    const current = queue.pop()!;
    const packageName = packageNameOf(current.dir);
    const packages = new Set(packageName ? [packageName] : []);
    const tsconfigs = new Set([pathKey(current.tsconfig)]);
    for (const project of solution.projects) {
      if (result.has(project.name) || !consumes(project, packages, tsconfigs)) continue;
      result.add(project.name);
      queue.push(project);
    }
  }
  return [...result].sort();
}

/**
 * Projects of another solution that consume a changed project: they declare a dependency on one of the
 * package names, reference one of the tsconfigs, or are one of the tsconfigs themselves (paths of the changed projects).
 */
export function referencingProjects(
  solution: LoadedSolution, changedPackageNames: Iterable<string>, changedTsconfigs: Iterable<string>,
): string[] {
  const packages = new Set(changedPackageNames);
  const tsconfigs = new Set([...changedTsconfigs].map(pathKey));
  const result = solution.projects.filter((p) => tsconfigs.has(pathKey(p.tsconfig)) || consumes(p, packages, tsconfigs));
  return [...new Set(result.map((p) => p.name))].sort();
}

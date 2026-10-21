import { basename, dirname } from "node:path";
import type { DriftRow, IndexStore } from "../index/index.ts";
import { pathKey } from "../workspace/index.ts";

const solutionName = (solutionPath: string): string => basename(dirname(solutionPath));
const NODE_MODULES = /(^|\/)node_modules\//;
const NO_DRIFT =
  "No package version drift: every indexed consumer uses the version its source package currently declares. Only solutions indexed at least once are compared.";
const FOOTER_NOTE = "Only solutions indexed at least once are compared.";

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** Package name of a docId scope: the first segment, or two when it starts with `@`. */
function packageNameOf(docId: string): string {
  const scope = docId.split("#", 1)[0]!;
  const segments = scope.split("/");
  return segments.slice(0, segments[0]!.startsWith("@") ? 2 : 1).join("/");
}

/**
 * `  [package 1.0.0, source is 1.1.0]` for a group of `solutionPath` whose consumed version of the target's
 * package differs from the version its source project declares; `""` when there is nothing to report.
 */
export function driftTagFor(store: IndexStore, targetDocId: string, solutionPath: string, hits: number): string {
  const name = packageNameOf(targetDocId);
  if (name === "") return "";
  const sources = store.getPackageSources(name).filter((p) => p.version !== null && !NODE_MODULES.test(p.path));
  if (sources.length === 0) return "";
  const key = pathKey(solutionPath);
  const consumers = store.getPackageConsumers(name).filter((c) => pathKey(c.solutionPath) === key);
  if (consumers.length === 0) return "";
  const sourceVersions = sorted(sources.map((p) => p.version!));
  const consumed = sorted(consumers.map((c) => c.version));
  if (sourceVersions.length === 1 && consumed.every((v) => v === sourceVersions[0])) return "";
  const note = hits === 0 ? "; the symbol may not exist in that version" : "";
  return `  [package ${consumed.join("/")}, source is ${sourceVersions.join("/")}${note}]`;
}

/** The `package_drift` lines: one block per package, at most `limit` consumer lines each, and the footer. */
export function driftLines(rows: readonly DriftRow[], limit: number): { items: string[]; footer: string } {
  if (rows.length === 0) return { items: [], footer: NO_DRIFT };
  const byPackage = new Map<string, DriftRow[]>();
  for (const row of rows) byPackage.set(row.packageName, [...(byPackage.get(row.packageName) ?? []), row]);
  const lines: string[] = [];
  for (const [name, group] of [...byPackage].sort((a, b) => (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1))) {
    const first = group[0]!;
    lines.push(`${name}  source ${first.sourceVersion} (${solutionName(first.sourceSolutionPath)})`);
    for (const row of group.slice(0, limit)) {
      lines.push(`  ${solutionName(row.consumerSolutionPath)}  ${row.consumerProjectName}  ${row.consumedVersion}`);
    }
    if (group.length > limit) lines.push(`  ... ${group.length - limit} more`);
  }
  return { items: lines, footer: `Total: ${rows.length} consumer projects on a version other than the source. ${FOOTER_NOTE}` };
}

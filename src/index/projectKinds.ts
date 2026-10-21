import { humpStarts } from "./ranker.ts";

/** True when a hump of a project-name segment is `Test` or `Tests` (ignoring case). */
function hasTestHump(segment: string): boolean {
  const starts = humpStarts(segment, false);
  return starts.some((start, k) => {
    const hump = segment.slice(start, k + 1 < starts.length ? starts[k + 1] : segment.length).replace(/_+$/, "");
    const lower = hump.toLowerCase();
    return lower === "test" || lower === "tests";
  });
}

/** A project or file is test code by project name, a test directory, or a `.test.`/`.spec.` file name. */
export function isTestProject(projectName: string, filePath: string): boolean {
  if (projectName.split(/[./\-@]/).some(hasTestHump)) return true;
  const segments = filePath.split(/[/\\]/);
  if (segments.some((s) => ["test", "tests", "__tests__"].includes(s.toLowerCase()))) return true;
  return /\.(test|spec)\.[cm]?[jt]sx?$/i.test(segments[segments.length - 1] ?? "");
}

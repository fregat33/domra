export type ChangeKind = "source" | "project" | "git" | "ignored";

const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx)$/i;
const PROJECT_FILE = /^(tsconfig[^/]*\.json|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const EDITOR_FOLDERS = [".idea", ".vs"];

/** What a changed path means for the workspace; see docs/watcher.md. */
export function classifyChange(path: string, ignoredFolders: readonly string[]): ChangeKind {
  const segments = path.replace(/\\/g, "/").split("/").filter((s) => s !== "");
  const git = segments.indexOf(".git");
  if (git >= 0) return segments.slice(git + 1).join("/") === "HEAD" ? "git" : "ignored";
  const ignored = new Set([...ignoredFolders, ...EDITOR_FOLDERS].map((s) => s.toLowerCase()));
  if (segments.some((s) => ignored.has(s.toLowerCase()))) return "ignored";
  const name = segments[segments.length - 1] ?? "";
  if (SOURCE_EXTENSION.test(name)) return "source";
  if (PROJECT_FILE.test(name)) return "project";
  return "ignored";
}

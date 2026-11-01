import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizePath } from "../workspace/index.ts";

export type GitHead = {
  /** The real HEAD file: `<root>/.git/HEAD`, or `<gitdir>/HEAD` of a linked worktree. */
  headPath: string;
  /** The directory holding `refs/` and `packed-refs`. */
  commonDir: string;
  /** `refs/heads/<branch>` when HEAD is symbolic to a branch; null when detached or unreadable. */
  branchRef: string | null;
  /** `<commonDir>/<branchRef>`, or null. */
  looseRef: string | null;
  /** `<commonDir>/packed-refs` when HEAD is symbolic to a branch, else null. */
  packedRefs: string | null;
};

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Where the HEAD and the ref files of the checkout at `root` live; null when `root` has no `.git`. */
export function resolveGitHead(root: string): GitHead | null {
  const dotGit = join(root, ".git");
  let gitDir: string;
  let commonDir: string;
  try {
    if (statSync(dotGit).isDirectory()) {
      gitDir = dotGit;
      commonDir = dotGit;
    } else {
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "");
      if (!match) return null;
      gitDir = resolve(root, match[1]!);
      const common = readText(join(gitDir, "commondir"))?.trim();
      commonDir = common ? resolve(gitDir, common) : resolve(gitDir, "..", "..");
    }
  } catch {
    return null;
  }
  const headPath = join(gitDir, "HEAD");
  const ref = /^ref:\s*(refs\/heads\/\S.*?)\s*$/m.exec(readText(headPath) ?? "")?.[1] ?? null;
  const branchRef = ref !== null && !ref.split("/").some((s) => s === ".." || s === "." || s === "") ? ref : null;
  return {
    headPath: normalizePath(headPath),
    commonDir: normalizePath(commonDir),
    branchRef,
    looseRef: branchRef === null ? null : normalizePath(join(commonDir, branchRef)),
    packedRefs: branchRef === null ? null : normalizePath(join(commonDir, "packed-refs")),
  };
}

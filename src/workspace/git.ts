import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { toSlashes } from "./positions.ts";

/** A file that differs between the merge base and the working tree; `path` is absolute, forward slashes. */
export type ChangedFile = { path: string; status: "added" | "modified" | "deleted" };
export type GitChanges = { mergeBase: string; files: ChangedFile[] };

/** The few git operations `review_changes` needs; tests substitute a fake. */
export interface GitProvider {
  /** Null when git can be started, else the error text. */
  probe(): Promise<string | null>;
  /** First line of `git --version` (e.g. 'git version 2.43.0'), or the error text. Optional: fakes may omit it; `status` then uses `probe`. */
  version?(): Promise<{ version: string } | { error: string }>;
  /** The directory holding `.git` (a directory or a worktree file), walking up from `dir`; null outside a repository. */
  repoRoot(dir: string): string | null;
  /** Full `git rev-parse HEAD` of the repository containing `dir`; null outside git or when git fails. Optional: fakes may omit it. */
  head?(dir: string): Promise<string | null>;
  /** origin/HEAD (its local branch when present), else the first of main, master, develop, dev; null when none exists. */
  defaultBase(root: string): Promise<string | null>;
  /** Files changed between merge-base(base, HEAD) and the working tree, untracked files included. */
  changes(root: string, base: string): Promise<GitChanges | { error: string }>;
  /** Text of `relPath` at `mergeBase`, or null when it does not exist there. */
  show(root: string, mergeBase: string, relPath: string): Promise<string | null>;
}

type RunResult = { ok: true; stdout: string } | { ok: false; stderr: string; message: string };

const MAX_BUFFER = 64 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const FALLBACK_BRANCHES = ["main", "master", "develop", "dev"];

function firstLine(result: { stderr: string; message: string }): string {
  const text = result.stderr.trim() || result.message.trim();
  return text.split(/\r?\n/)[0] ?? "";
}

/** `GitProvider` running `gitPath` as a child process. */
export function createGit(gitPath = "git"): GitProvider {
  let probed: Promise<string | null> | undefined;
  let versioned: Promise<{ version: string } | { error: string }> | undefined;

  const run = (cwd: string | undefined, args: string[]): Promise<RunResult> =>
    new Promise((done) => {
      execFile(gitPath, args, { cwd, maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) done({ ok: false, stderr: String(stderr ?? ""), message: error.message });
        else done({ ok: true, stdout: String(stdout) });
      });
    });

  const isCommit = async (root: string, ref: string): Promise<boolean> =>
    (await run(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok;

  const absolute = (root: string, rel: string): string => `${toSlashes(root).replace(/\/$/, "")}/${rel.replace(/\\/g, "/")}`;

  return {
    probe() {
      probed ??= run(undefined, ["--version"]).then((result) =>
        result.ok ? null : `'${gitPath}' could not be started (${result.message}); install git or set gitPath in the config`,
      );
      return probed;
    },

    version() {
      versioned ??= run(undefined, ["--version"]).then((result) =>
        result.ok
          ? { version: (result.stdout.trim().split(/\r?\n/)[0] ?? "").trim() }
          : { error: firstLine(result) },
      );
      return versioned;
    },

    repoRoot(dir) {
      for (let current = resolve(dir); ; current = dirname(current)) {
        if (existsSync(`${current}/.git`)) return toSlashes(current);
        if (dirname(current) === current) return null;
      }
    },

    async head(dir) {
      const result = await run(dir, ["rev-parse", "HEAD"]);
      const sha = result.ok ? result.stdout.trim() : "";
      return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
    },

    async defaultBase(root) {
      const head = await run(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
      const remote = head.ok ? head.stdout.trim() : "";
      if (remote !== "") {
        const local = remote.replace(/^origin\//, "");
        return (await isCommit(root, local)) ? local : remote;
      }
      for (const name of FALLBACK_BRANCHES) {
        if (await isCommit(root, name)) return name;
      }
      return null;
    },

    async changes(root, base) {
      const merge = await run(root, ["merge-base", base, "HEAD"]);
      if (!merge.ok) {
        return { error: `git merge-base ${base} HEAD failed: ${firstLine(merge)}. Pass an existing branch, tag or commit as base.` };
      }
      const mergeBase = merge.stdout.trim();
      const diff = await run(root, ["diff", "--name-status", "--no-renames", "-z", mergeBase]);
      if (!diff.ok) return { error: `git diff failed: ${firstLine(diff)}` };
      const files: ChangedFile[] = [];
      const fields = diff.stdout.split("\0");
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const code = fields[i]!.trim();
        const rel = fields[i + 1]!;
        if (code === "" || rel === "") continue;
        const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
        files.push({ path: absolute(root, rel), status });
      }
      const untracked = await run(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
      if (!untracked.ok) return { error: `git ls-files failed: ${firstLine(untracked)}` };
      for (const rel of untracked.stdout.split("\0")) {
        if (rel !== "") files.push({ path: absolute(root, rel), status: "added" });
      }
      return { mergeBase, files };
    },

    async show(root, mergeBase, relPath) {
      const result = await run(root, ["show", `${mergeBase}:${relPath.replace(/\\/g, "/")}`]);
      return result.ok ? result.stdout : null;
    },
  };
}

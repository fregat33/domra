import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { normalizePath } from "../../src/workspace/index.ts";
import type { ChangeBatch } from "../../src/watcher/debounce.ts";
import { resolveGitHead } from "../../src/watcher/gitHead.ts";
import { RepoWatcher } from "../../src/watcher/watcher.ts";
import type { Fixture } from "../fixtures.ts";
import { writeFixture } from "../fixtures.ts";
import { delay, until } from "./until.ts";

const identity = ["-c", "user.name=domra", "-c", "user.email=domra@example.invalid", "-c", "commit.gpgsign=false"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...identity, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}
const skip = hasGit ? false : "git is not installed";

const fixtures: Fixture[] = [];
const watchers: RepoWatcher[] = [];
const fresh = (files: Record<string, string> = {}): Fixture => {
  const fixture = writeFixture(files);
  fixtures.push(fixture);
  return fixture;
};

after(() => {
  for (const watcher of watchers) watcher.close();
  for (const fixture of fixtures) fixture.remove();
});

// ---- resolveGitHead (plain files) ----

test("resolveGitHead: normal repository, symbolic HEAD", () => {
  const f = fresh({ ".git/HEAD": "ref: refs/heads/main\n" });
  const root = normalizePath(f.root);
  assert.deepEqual(resolveGitHead(root), {
    headPath: `${root}/.git/HEAD`,
    commonDir: `${root}/.git`,
    branchRef: "refs/heads/main",
    looseRef: `${root}/.git/refs/heads/main`,
    packedRefs: `${root}/.git/packed-refs`,
  });
});

test("resolveGitHead: detached HEAD has no ref targets; no .git gives null", () => {
  const f = fresh({ ".git/HEAD": "0123456789abcdef0123456789abcdef01234567\n" });
  const root = normalizePath(f.root);
  const info = resolveGitHead(root)!;
  assert.equal(info.branchRef, null);
  assert.equal(info.looseRef, null);
  assert.equal(info.packedRefs, null);
  assert.equal(resolveGitHead(normalizePath(fresh().root)), null);
});

test("resolveGitHead: nested branch a/b", () => {
  const f = fresh({ ".git/HEAD": "ref: refs/heads/a/b\n" });
  const root = normalizePath(f.root);
  const info = resolveGitHead(root)!;
  assert.equal(info.branchRef, "refs/heads/a/b");
  assert.equal(info.looseRef, `${root}/.git/refs/heads/a/b`);
});

test("resolveGitHead: linked worktree, absolute and relative gitdir, commondir or fallback", () => {
  const f = fresh({
    "main/.git/worktrees/abs/HEAD": "ref: refs/heads/feat\n",
    "main/.git/worktrees/abs/commondir": "../..\n",
    "main/.git/worktrees/rel/HEAD": "ref: refs/heads/rel\n",
    "wt1/.git": "",
    "wt2/.git": "gitdir: ../main/.git/worktrees/rel\n",
  });
  const base = normalizePath(f.root);
  writeFileSync(f.path("wt1/.git"), `gitdir: ${base}/main/.git/worktrees/abs\n`);
  const abs = resolveGitHead(`${base}/wt1`)!;
  assert.equal(abs.headPath, `${base}/main/.git/worktrees/abs/HEAD`);
  assert.equal(abs.commonDir, `${base}/main/.git`);
  assert.equal(abs.looseRef, `${base}/main/.git/refs/heads/feat`);
  const rel = resolveGitHead(`${base}/wt2`)!;
  assert.equal(rel.headPath, `${base}/main/.git/worktrees/rel/HEAD`);
  assert.equal(rel.commonDir, `${base}/main/.git`, "no commondir file: <gitdir>/../..");
  assert.equal(rel.packedRefs, `${base}/main/.git/packed-refs`);
});

// ---- real git ----

function watch(root: string, dirs: string[] = [root]): { watcher: RepoWatcher; batches: ChangeBatch[]; warnings: string[] } {
  const batches: ChangeBatch[] = [];
  const warnings: string[] = [];
  const watcher = new RepoWatcher({
    roots: [], ignoredFolders: ["node_modules", ".git"], quietMs: 50,
    onBatch: (b) => batches.push(b), warn: (m) => warnings.push(m),
  });
  watchers.push(watcher);
  watcher.syncWorktrees(dirs, (d) => d);
  return { watcher, batches, warnings };
}

const saw = (batches: ChangeBatch[], root: string): boolean => batches.some((b) => b.paths.has(`${normalizePath(root)}/.git/HEAD`));

function repoWithTwoCommits(): { f: Fixture; first: string; second: string } {
  const f = fresh({ "a.txt": "a\n" });
  git(f.root, "init", "-q", "-b", "main");
  git(f.root, "add", ".");
  git(f.root, "commit", "-q", "-m", "first");
  const first = git(f.root, "rev-parse", "HEAD");
  writeFileSync(f.path("a.txt"), "b\n");
  git(f.root, "commit", "-q", "-am", "second");
  return { f, first, second: git(f.root, "rev-parse", "HEAD") };
}

test("git update-ref of the current branch from outside yields the root's HEAD event", { skip }, async () => {
  const { f, first } = repoWithTwoCommits();
  const { watcher, batches } = watch(f.root);
  assert.deepEqual(watcher.refWatchTargets, [`${normalizePath(f.root)}/.git/packed-refs`, `${normalizePath(f.root)}/.git/refs/heads/main`].sort());
  assert.deepEqual(watcher.worktreeHeads, []);
  git(f.root, "update-ref", "refs/heads/main", first);
  await until(() => saw(batches, f.root), 3000);
});

test("pack-refs, then a moved packed ref, yield events", { skip }, async () => {
  const { f, first, second } = repoWithTwoCommits();
  const { batches } = watch(f.root);
  git(f.root, "pack-refs", "--all");
  await until(() => saw(batches, f.root), 3000);
  await delay(150);
  batches.length = 0;
  git(f.root, "update-ref", "refs/heads/main", first);
  await until(() => saw(batches, f.root), 3000);
  await delay(150);
  batches.length = 0;
  git(f.root, "pack-refs", "--all");
  await delay(150);
  batches.length = 0;
  git(f.root, "update-ref", "refs/heads/main", second);
  await until(() => saw(batches, f.root), 3000);
});

test("nested branch whose directory does not exist yet is picked up once it appears", { skip }, async () => {
  const { f, first } = repoWithTwoCommits();
  git(f.root, "checkout", "-q", "-b", "a/b");
  git(f.root, "pack-refs", "--all");
  rmSync(f.path(".git/refs/heads/a"), { recursive: true, force: true });
  const { watcher, batches } = watch(f.root);
  const base = `${normalizePath(f.root)}/.git`;
  assert.ok(watcher.refWatchTargets.includes(`${base}/refs/heads/a`), watcher.refWatchTargets.join(","));
  git(f.root, "update-ref", "refs/heads/a/b", first);
  await until(() => saw(batches, f.root), 3000);
  await until(() => watcher.refWatchTargets.includes(`${base}/refs/heads/a/b`), 3000);
});

test("linked worktree: branch moved from the main checkout, branch switch re-points, removal leaves nothing", { skip }, async () => {
  const { f, first } = repoWithTwoCommits();
  const holder = fresh();
  const slot = normalizePath(`${holder.root}/slot`);
  git(f.root, "worktree", "add", "-q", "-b", "feat", slot);
  const { watcher, batches } = watch(slot, [slot]);
  const common = `${normalizePath(f.root)}/.git`;
  assert.equal(watcher.worktreeHeads.length, 1);
  assert.deepEqual(watcher.refWatchTargets, [`${common}/packed-refs`, `${common}/refs/heads/feat`].sort());

  git(f.root, "update-ref", "refs/heads/feat", first);
  await until(() => saw(batches, slot), 3000);

  batches.length = 0;
  git(slot, "checkout", "-q", "-b", "other");
  await until(() => saw(batches, slot) && watcher.refWatchTargets.includes(`${common}/refs/heads/other`), 3000);
  assert.ok(!watcher.refWatchTargets.includes(`${common}/refs/heads/feat`));

  watcher.syncWorktrees([], () => null);
  assert.deepEqual(watcher.worktreeHeads, []);
  assert.deepEqual(watcher.refWatchTargets, []);
});

test("two checkouts on one common dir each report their own root", { skip }, async () => {
  const { f, first } = repoWithTwoCommits();
  const holder = fresh();
  const slot = normalizePath(`${holder.root}/slot`);
  git(f.root, "worktree", "add", "-q", slot, "-b", "feat");
  const { watcher, batches } = watch(f.root, [f.root, slot]);
  assert.equal(watcher.refWatchTargets.filter((t) => t.endsWith("/packed-refs")).length, 2);
  git(f.root, "update-ref", "refs/heads/main", first);
  await until(() => saw(batches, f.root), 3000);
  assert.ok(!saw(batches, slot));
  git(f.root, "update-ref", "refs/heads/feat", first);
  await until(() => saw(batches, slot), 3000);
});

test("a linked worktree removed and recreated at the same path is watched again after syncWorktrees", { skip }, async () => {
  const { f } = repoWithTwoCommits();
  const holder = fresh();
  const slot = normalizePath(`${holder.root}/slot`);
  git(f.root, "worktree", "add", "-q", "-b", "feat", slot);
  const { watcher, batches } = watch(slot, [slot]);
  assert.equal(watcher.worktreeHeads.length, 1);

  git(f.root, "worktree", "remove", "--force", slot);
  git(f.root, "worktree", "prune");
  git(f.root, "worktree", "add", "-q", "-B", "feat", slot);
  await delay(200);
  watcher.syncWorktrees([slot], (d) => d);
  assert.equal(watcher.worktreeHeads.length, 1);
  batches.length = 0;
  await delay(200);
  batches.length = 0;
  git(slot, "checkout", "-q", "-b", "after");
  await until(() => saw(batches, slot), 3000);
});

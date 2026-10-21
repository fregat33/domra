import type { ChangedFile, GitChanges, GitProvider } from "../../src/workspace/git.ts";

/** In-memory git: `files` are the changes, `baseTexts` the merge-base text by repository-relative path. */
export class FakeGit implements GitProvider {
  root: string | null;
  base: string | null = "main";
  mergeBase = "abc1234def";
  files: ChangedFile[] = [];
  baseTexts = new Map<string, string>();
  probeError: string | null = null;
  changesError: string | null = null;

  constructor(root: string) {
    this.root = root;
  }
  async probe(): Promise<string | null> {
    return this.probeError === null ? null : `'git' could not be started (${this.probeError}); install git or set gitPath in the config`;
  }
  repoRoot(): string | null {
    return this.root;
  }
  async defaultBase(): Promise<string | null> {
    return this.base;
  }
  async changes(): Promise<GitChanges | { error: string }> {
    return this.changesError !== null ? { error: this.changesError } : { mergeBase: this.mergeBase, files: this.files };
  }
  async show(_root: string, _mergeBase: string, relPath: string): Promise<string | null> {
    return this.baseTexts.get(relPath) ?? null;
  }
}

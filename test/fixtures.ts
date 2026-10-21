import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Relative path (forward slashes) → file content; objects are written as JSON. */
export type FixtureFiles = Record<string, string | object>;

export type Fixture = {
  /** Absolute root directory, forward slashes. */
  root: string;
  path(relative: string): string;
  remove(): void;
};

export const FIXTURES_DIR = join(tmpdir(), "domra-tests");

/** Write an inline fixture project to a fresh directory under `os.tmpdir()/domra-tests`. */
export function writeFixture(files: FixtureFiles): Fixture {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const root = mkdtempSync(join(FIXTURES_DIR, "fx-")).replace(/\\/g, "/");
  for (const [relative, content] of Object.entries(files)) {
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return {
    root,
    path: (relative) => `${root}/${relative}`,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Run `fn` against a fixture and remove it afterwards. */
export async function withFixture<T>(
  files: FixtureFiles,
  fn: (fixture: Fixture) => T | Promise<T>,
): Promise<T> {
  const fixture = writeFixture(files);
  try {
    return await fn(fixture);
  } finally {
    fixture.remove();
  }
}

/** 1-based line and column of the first occurrence of `needle` (after `after`, if given). */
export function locate(text: string, needle: string, after = ""): { line: number; col: number } {
  const start = after === "" ? 0 : text.indexOf(after);
  const offset = text.indexOf(needle, Math.max(start, 0) + after.length);
  if (start < 0 || offset < 0) throw new Error(`fixture text does not contain ${needle}`);
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, col: before[before.length - 1]!.length + 1 };
}

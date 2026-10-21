/**
 * Symbol identity: `{scope}#{fqName}` where `scope` is `{projectKey}/{modulePath}` (or
 * `{packageName}/{path in package}` under node_modules), extension stripped. The first `#`
 * separates scope and fqName, so a fqName containing `#` (e.g. a `#private` member) round-trips,
 * but a scope containing `#` is not supported.
 */

export const TOP_LEVEL = "<top-level>";

export type DocIdParts = { scope: string; fqName: string };

/** Strip `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx` and their `.d.` declaration forms. */
export function stripExtension(path: string): string {
  return path.replace(/(\.d)?\.[cm]?[jt]sx?$/i, "");
}

/** `{projectKey}/{modulePath}` from a project key and the file path relative to the project directory. */
export function scopeOf(projectKey: string, relativePath: string): string {
  return `${projectKey}/${stripExtension(relativePath.replace(/\\/g, "/").replace(/^\.\//, ""))}`;
}

export function makeDocId(scope: string, fqName: string): string {
  return `${scope}#${fqName}`;
}

/** Split at the first `#`; null when there is none. */
export function parseDocId(docId: string): DocIdParts | null {
  const at = docId.indexOf("#");
  if (at < 0) return null;
  return { scope: docId.slice(0, at), fqName: docId.slice(at + 1) };
}

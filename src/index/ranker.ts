/** Symbol search ranking: query parsing, match quality, camel-hump matching, sort order. Pure strings, no TypeScript. */

export type MatchQuality = "exact" | "lastHump" | "prefix" | "camelHump" | "substring";

export type Query = {
  /** Last term; the only part that is ranked. */
  name: string;
  /** Earlier terms; each must occur in the fully-qualified name or the relative file path. */
  containers: string[];
};

/** What the ranker needs to know about a declaration. */
export type SymbolRecord = {
  name: string;
  fqName: string;
  kind: string;
  isTest: boolean;
  /** Path relative to the solution directory, forward slashes. */
  path: string;
  offset: number;
};

export type RankedRecord = SymbolRecord & { match: MatchQuality };

const MATCH_RANK: Record<MatchQuality, number> = { exact: 0, lastHump: 1, prefix: 2, camelHump: 3, substring: 4 };

export function matchRank(match: MatchQuality): number {
  return MATCH_RANK[match];
}

export function parseQuery(pattern: string): Query {
  const terms = pattern
    .split(/[ .:]/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (terms.length === 0) return { name: pattern.trim(), containers: [] };
  return { name: terms[terms.length - 1]!, containers: terms.slice(0, -1) };
}

const isUpper = (c: string): boolean => /\p{Lu}/u.test(c);
const isLower = (c: string): boolean => /\p{Ll}/u.test(c);
const isLetter = (c: string): boolean => /\p{L}/u.test(c);
const isDigit = (c: string): boolean => /\p{Nd}/u.test(c);

export function isHumpStart(name: string, i: number, everyUpperStarts = false): boolean {
  if (i <= 0) return i === 0;
  const c = name[i]!;
  const prev = name[i - 1]!;
  if (prev === "_") return c !== "_";
  if (isUpper(c)) {
    return everyUpperStarts || !isUpper(prev) || (i + 1 < name.length && isLower(name[i + 1]!));
  }
  if (isDigit(c)) return !isDigit(prev);
  return isLetter(c) && !isLetter(prev);
}

/** Indexes where a hump starts; underscores never start one. */
export function humpStarts(name: string, everyUpperStarts = false): number[] {
  const starts: number[] = [];
  for (let i = 0; i < name.length; i++) {
    if (name[i] !== "_" && isHumpStart(name, i, everyUpperStarts)) starts.push(i);
  }
  return starts;
}

function slices(text: string, starts: number[]): string[] {
  return starts.map((start, k) => text.slice(start, k + 1 < starts.length ? starts[k + 1] : text.length));
}

export function matchesHumps(pattern: string, name: string): boolean {
  const patternHumps = slices(pattern, humpStarts(pattern, true)).map((h) => h.replace(/_+$/, ""));
  const nameHumps = slices(name, humpStarts(name, false)).map((h) => h.toLowerCase());
  if (patternHumps.length === 0 || nameHumps.length === 0) return false;
  let at = 0;
  for (const hump of patternHumps) {
    const wanted = hump.toLowerCase();
    while (at < nameHumps.length && !nameHumps[at]!.startsWith(wanted)) at++;
    if (at >= nameHumps.length) return false;
    at++;
  }
  return true;
}

export function match(pattern: string, name: string): MatchQuality | null {
  if (pattern === "" || name === "") return null;
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  if (p === n) return "exact";
  if (n.endsWith(p) && isHumpStart(name, name.length - pattern.length)) return "lastHump";
  if (n.startsWith(p)) return "prefix";
  if (matchesHumps(pattern, name)) return "camelHump";
  if (n.includes(p)) return "substring";
  return null;
}

export function kindRank(kind: string): number {
  switch (kind) {
    case "class":
    case "interface":
    case "typeAlias":
    case "enum":
    case "function":
    case "method":
    case "constructor":
      return 0;
    case "property":
    case "accessor":
      return 1;
    case "field":
    case "enumMember":
      return 2;
    default:
      return 3;
  }
}

/** Every container term is a case-insensitive substring of the fully-qualified name or the relative path. */
export function containersMatch(containers: string[], record: Pick<SymbolRecord, "fqName" | "path">): boolean {
  const fq = record.fqName.toLowerCase();
  const path = record.path.toLowerCase();
  return containers.every((c) => {
    const term = c.toLowerCase();
    return fq.includes(term) || path.includes(term);
  });
}

function ordinal(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Ascending sort order: tests last, then match quality, kind rank, name length, fqName, path, offset. */
export function compareRecords(a: RankedRecord, b: RankedRecord): number {
  if (a.isTest !== b.isTest) return a.isTest ? 1 : -1;
  return (
    matchRank(a.match) - matchRank(b.match) ||
    kindRank(a.kind) - kindRank(b.kind) ||
    a.name.length - b.name.length ||
    ordinal(a.fqName, b.fqName) ||
    ordinal(a.path, b.path) ||
    a.offset - b.offset
  );
}

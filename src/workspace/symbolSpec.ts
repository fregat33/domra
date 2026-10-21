/** `path:line[:col]` — path absolute or relative to the solution directory; 1-based. */
export type PositionSpec = { kind: "position"; path: string; line: number; col: number | null };

/**
 * A (possibly qualified) name. `parts` has type arguments removed (`Foo<T>` → `Foo`).
 * `params` is the normalised parameter type list of `Name(params)`, or null without parentheses.
 */
export type NameSpec = { kind: "name"; parts: string[]; params: string[] | null };

export type SymbolSpec = PositionSpec | NameSpec;

const POSITION = /^(?<path>.+?\.(ts|tsx|mts|cts|js|jsx)):(?<line>\d+)(?::(?<col>\d+))?$/i;
const IDENTIFIER = /^#?[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_$‌‍]*$/u;

/** Split on top-level commas, ignoring commas nested in <>, (), [], {}. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if ("<([{".includes(ch)) depth++;
    else if (">)]}".includes(ch) && !(ch === ">" && text[i - 1] === "=")) depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Type text with whitespace removed, lower-cased. */
export function normalizeType(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

/** `a: string` → `string`, `...rest: T[]` → `T[]`, `b?: number` → `number`, `string` → `string`. */
export function normalizeParam(text: string): string {
  const trimmed = text.trim().replace(/^\.\.\./, "");
  const named = /^[\p{L}_$][\p{L}\p{N}_$]*\??\s*:(?<type>[\s\S]+)$/u.exec(trimmed);
  return normalizeType(named ? named.groups!.type! : trimmed);
}

/** Remove balanced `<...>` groups: `Foo<Bar<T>>.baz` → `Foo.baz`; null when unbalanced. */
function stripTypeArguments(text: string): string | null {
  let depth = 0;
  let result = "";
  for (const ch of text) {
    if (ch === "<") depth++;
    else if (ch === ">") {
      if (--depth < 0) return null;
    } else if (depth === 0) result += ch;
  }
  return depth === 0 ? result : null;
}

/**
 * Parse a symbol spec. Forms are tried in order, first match wins:
 * position, `Name(params)`, generic `Foo<T>`, qualified `A.B.C`, bare name.
 * Returns null when the text matches none of them.
 */
export function parseSymbolSpec(input: string): SymbolSpec | null {
  const text = input.trim();
  if (text === "") return null;

  const position = POSITION.exec(text);
  if (position) {
    const line = Number(position.groups!.line);
    const col = position.groups!.col === undefined ? null : Number(position.groups!.col);
    if (line > 0 && (col === null || col > 0)) {
      return { kind: "position", path: position.groups!.path!, line, col };
    }
  }

  let name = text;
  let params: string[] | null = null;
  const open = text.indexOf("(");
  if (open >= 0) {
    if (!text.endsWith(")")) return null;
    name = text.slice(0, open);
    const inner = text.slice(open + 1, -1);
    params = inner.trim() === "" ? [] : splitTopLevel(inner).map(normalizeParam);
  }

  const stripped = stripTypeArguments(name);
  if (stripped === null) return null;
  const parts = stripped.split(".").map((part) => part.trim());
  if (!parts.every((part) => IDENTIFIER.test(part))) return null;
  return { kind: "name", parts, params };
}

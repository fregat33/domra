/** One log line per `tools/call`; see docs/server.md. */

const VALUE_LIMIT = 120;
const CALLER_LIMIT = 100;
const ERROR_LIMIT = 199;

/** Tools whose result is not a list: their `found` is `-`. */
const UNCOUNTED = new Set([
  "go_to_definition", "get_symbol_info", "next_page", "status", "reindex", "load_solution", "forget_solution",
]);

/** `found` of a tool that counts nothing is `-` (also for an unknown tool). */
export function countsFound(tool: string, known: boolean): boolean {
  return known && !UNCOUNTED.has(tool);
}

/** The text cut to `limit` characters, `…` appended when it was longer. */
export function cut(value: string, limit: number = VALUE_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** Double-quoted, with `\`, `"`, CR and LF escaped so the result is one line. */
export function quote(value: string): string {
  const escaped = value.replace(/[\\"\r\n]/g, (c) => (c === "\r" ? "\\r" : c === "\n" ? "\\n" : `\\${c}`));
  return `"${escaped}"`;
}

const PLAIN_KEY = /^[A-Za-z0-9_]{1,120}$/;

export function formatKey(key: string): string {
  return PLAIN_KEY.test(key) ? key : quote(cut(key));
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") return quote(cut(value));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "null";
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  return cut(json ?? "null").replace(/[\r\n]/g, (c) => (c === "\r" ? "\\r" : "\\n"));
}

export type CallLogInput = {
  tool: string;
  args: Record<string, unknown> | undefined;
  /** null prints `-`. */
  found: number | null;
  /** "name version" or null. */
  client: string | null;
  caller: string | null;
  parts: string[];
  elapsedMs: number;
  /** Text of an `isError` result. */
  error?: string;
};

/** The first non-blank `?caller=` value, trimmed and cut, or null. */
export function callerOf(values: string[]): string | null {
  const first = values[0]?.trim();
  return first ? first : null;
}

/** The whole line including the `INFO ` / `WARN ` prefix. */
export function formatCallLine(input: CallLogInput): string {
  const fields = [formatKey(input.tool)];
  for (const [key, value] of Object.entries(input.args ?? {})) fields.push(`${formatKey(key)}=${formatValue(value)}`);
  fields.push(`found=${input.found === null ? "-" : input.found}`);
  fields.push(`client=${input.client === null ? "-" : quote(input.client)}`);
  fields.push(`caller=${input.caller === null ? "-" : quote(cut(input.caller, CALLER_LIMIT))}`);
  fields.push(`part=${input.parts.length === 0 ? "-" : quote(input.parts.join(";"))}`);
  fields.push(`${Math.round(input.elapsedMs)}ms`);
  let line = `${input.error === undefined ? "INFO" : "WARN"} ${fields.join(" ")}`;
  if (input.error !== undefined) line += ` error=${cut((input.error.split(/\r\n|\r|\n/)[0] ?? ""), ERROR_LIMIT)}`;
  return line;
}

/** `WARN Rejected {tool} call with arguments [keys]: {problem}` on one line. */
export function formatRejected(tool: string, args: Record<string, unknown>, problem: string): string {
  const keys = Object.keys(args).map(formatKey).join(", ");
  return `WARN Rejected ${formatKey(tool)} call with arguments [${keys}]: ${problem.replace(/\r\n|\r|\n/g, " ")}`;
}

/** The `client` field value from an `initialize` params object, or null. */
export function clientOf(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const info = (params as Record<string, unknown>)["clientInfo"];
  if (typeof info !== "object" || info === null) return null;
  const { name, version } = info as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") return null;
  const v = typeof version === "string" ? version : "";
  return `${name} ${v}`.trim();
}

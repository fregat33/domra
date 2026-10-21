export type ParsedArgs = {
  positionals: string[];
  options: Map<string, string>;
  verbose: boolean;
  inherited: boolean;
  noPrivate: boolean;
  definingOnly: boolean;
  force: boolean;
  includeExternal: boolean;
  direct: boolean;
  noTests: boolean;
};

/** Options that take a value; `--verbose`, `--inherited`, `--no-private`, `--defining-only`, `--force` and `--no-tests` are flags. */
const VALUE_OPTIONS = new Set(["solution", "kind", "limit", "filter", "depth", "scope", "direction", "min-severity", "db", "base", "git"]);

export class UsageError extends Error {}

/** Split argv into positionals and `--name value` options (anywhere), or throw a UsageError. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  let verbose = false;
  let inherited = false;
  let noPrivate = false;
  let definingOnly = false;
  let force = false;
  let includeExternal = false;
  let direct = false;
  let noTests = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === "verbose") {
      verbose = true;
    } else if (name === "inherited") {
      inherited = true;
    } else if (name === "no-private") {
      noPrivate = true;
    } else if (name === "defining-only") {
      definingOnly = true;
    } else if (name === "force") {
      force = true;
    } else if (name === "include-external") {
      includeExternal = true;
    } else if (name === "direct") {
      direct = true;
    } else if (name === "no-tests") {
      noTests = true;
    } else if (VALUE_OPTIONS.has(name)) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`option '${arg}' requires a value`);
      options.set(name, value);
    } else {
      throw new UsageError(`unknown option '${arg}'`);
    }
  }
  return { positionals, options, verbose, inherited, noPrivate, definingOnly, force, includeExternal, direct, noTests };
}

/** A positive integer from option text, or null. */
export function parsePositiveInt(text: string): number | null {
  return /^[0-9]+$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type DomraConfig = {
  roots: string[];
  preload: string[];
  defaultSolution: string | null;
  port: number;
  loadWaitSeconds: number;
  ignoredFolders: string[];
  indexPath: string | null;
  warmUp: boolean;
  blobRetentionDays: number;
  watch: boolean;
  debounceMs: number;
  unloadedRefreshSeconds: number;
  unloadedRefreshMaxWaitSeconds: number;
  discoverySweepSeconds: number;
  gitPath: string;
  allowedOrigins: string[];
  logDirectory: string | null;
  logRetainedDays: number;
  reextractDependents: boolean;
};

export const DEFAULT_CONFIG: DomraConfig = {
  roots: [],
  preload: [],
  defaultSolution: null,
  port: 5302,
  loadWaitSeconds: 20,
  ignoredFolders: ["node_modules", ".git", "dist", "build", "out", "coverage"],
  indexPath: null,
  warmUp: true,
  blobRetentionDays: 30,
  watch: true,
  debounceMs: 500,
  unloadedRefreshSeconds: 60,
  unloadedRefreshMaxWaitSeconds: 600,
  discoverySweepSeconds: 30,
  gitPath: "git",
  allowedOrigins: [],
  logDirectory: null,
  logRetainedDays: 7,
  reextractDependents: true,
};

const ENV_KEYS: Record<keyof DomraConfig, string> = {
  roots: "DOMRA_ROOTS",
  preload: "DOMRA_PRELOAD",
  defaultSolution: "DOMRA_DEFAULT_SOLUTION",
  port: "DOMRA_PORT",
  loadWaitSeconds: "DOMRA_LOAD_WAIT_SECONDS",
  ignoredFolders: "DOMRA_IGNORED_FOLDERS",
  indexPath: "DOMRA_INDEX_PATH",
  warmUp: "DOMRA_WARM_UP",
  blobRetentionDays: "DOMRA_BLOB_RETENTION_DAYS",
  watch: "DOMRA_WATCH",
  debounceMs: "DOMRA_DEBOUNCE_MS",
  unloadedRefreshSeconds: "DOMRA_UNLOADED_REFRESH_SECONDS",
  unloadedRefreshMaxWaitSeconds: "DOMRA_UNLOADED_REFRESH_MAX_WAIT_SECONDS",
  discoverySweepSeconds: "DOMRA_DISCOVERY_SWEEP_SECONDS",
  gitPath: "DOMRA_GIT_PATH",
  allowedOrigins: "DOMRA_ALLOWED_ORIGINS",
  logDirectory: "DOMRA_LOG_DIRECTORY",
  logRetainedDays: "DOMRA_LOG_RETAINED_DAYS",
  reextractDependents: "DOMRA_REEXTRACT_DEPENDENTS",
};

function readJsonFile(path: string): Partial<DomraConfig> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = (parsed as Record<string, unknown>)[key];
    if (value !== undefined) result[key] = value;
  }
  return result as Partial<DomraConfig>;
}

function parseNumber(name: string, raw: string): number {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) {
    throw new Error(`${name}: expected a number, got "${raw}"`);
  }
  return value;
}

function parseBoolean(name: string, raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value !== "true" && value !== "false") throw new Error(`${name}: expected true or false, got "${raw}"`);
  return value === "true";
}

function parseList(name: string, raw: string): string[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${name}: expected a JSON array of strings`);
  }
  return value as string[];
}

function readEnv(env: Record<string, string | undefined>): Partial<DomraConfig> {
  const result: Partial<DomraConfig> = {};
  const get = (key: keyof DomraConfig): string | undefined => env[ENV_KEYS[key]];

  const roots = get("roots");
  if (roots !== undefined) result.roots = parseList(ENV_KEYS.roots, roots);
  const preload = get("preload");
  if (preload !== undefined) result.preload = parseList(ENV_KEYS.preload, preload);
  const ignored = get("ignoredFolders");
  if (ignored !== undefined) result.ignoredFolders = parseList(ENV_KEYS.ignoredFolders, ignored);
  const port = get("port");
  if (port !== undefined) result.port = parseNumber(ENV_KEYS.port, port);
  const wait = get("loadWaitSeconds");
  if (wait !== undefined) result.loadWaitSeconds = parseNumber(ENV_KEYS.loadWaitSeconds, wait);
  const def = get("defaultSolution");
  if (def !== undefined) result.defaultSolution = def === "" || def === "null" ? null : def;
  const indexPath = get("indexPath");
  if (indexPath !== undefined) result.indexPath = indexPath === "" || indexPath === "null" ? null : indexPath;
  const warmUp = get("warmUp");
  if (warmUp !== undefined) result.warmUp = parseBoolean(ENV_KEYS.warmUp, warmUp);
  const retention = get("blobRetentionDays");
  if (retention !== undefined) result.blobRetentionDays = parseNumber(ENV_KEYS.blobRetentionDays, retention);
  const watch = get("watch");
  if (watch !== undefined) result.watch = parseBoolean(ENV_KEYS.watch, watch);
  const debounce = get("debounceMs");
  if (debounce !== undefined) result.debounceMs = parseNumber(ENV_KEYS.debounceMs, debounce);
  const refresh = get("unloadedRefreshSeconds");
  if (refresh !== undefined) result.unloadedRefreshSeconds = parseNumber(ENV_KEYS.unloadedRefreshSeconds, refresh);
  const refreshMax = get("unloadedRefreshMaxWaitSeconds");
  if (refreshMax !== undefined) {
    result.unloadedRefreshMaxWaitSeconds = parseNumber(ENV_KEYS.unloadedRefreshMaxWaitSeconds, refreshMax);
  }
  const sweep = get("discoverySweepSeconds");
  if (sweep !== undefined) result.discoverySweepSeconds = parseNumber(ENV_KEYS.discoverySweepSeconds, sweep);
  const gitPath = get("gitPath");
  if (gitPath !== undefined && gitPath !== "") result.gitPath = gitPath;
  const origins = get("allowedOrigins");
  if (origins !== undefined) result.allowedOrigins = parseList(ENV_KEYS.allowedOrigins, origins);
  const logDirectory = get("logDirectory");
  if (logDirectory !== undefined) result.logDirectory = logDirectory === "" || logDirectory === "null" ? null : logDirectory;
  const logRetained = get("logRetainedDays");
  if (logRetained !== undefined) result.logRetainedDays = parseNumber(ENV_KEYS.logRetainedDays, logRetained);
  const reextract = get("reextractDependents");
  if (reextract !== undefined) result.reextractDependents = parseBoolean(ENV_KEYS.reextractDependents, reextract);
  return result;
}

/** Merge order (later wins): defaults, domra.json, domra.local.json, DOMRA_* environment variables. */
export function loadConfig(cwd: string = process.cwd()): DomraConfig {
  return {
    ...DEFAULT_CONFIG,
    ...readJsonFile(join(cwd, "domra.json")),
    ...readJsonFile(join(cwd, "domra.local.json")),
    ...readEnv(process.env),
  };
}

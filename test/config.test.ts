import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

test("config merges domra.json, domra.local.json and DOMRA_* env in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "domra-config-"));
  const saved = process.env.DOMRA_PORT;
  try {
    writeFileSync(
      join(dir, "domra.json"),
      JSON.stringify({ port: 6000, loadWaitSeconds: 5, roots: ["/a"] }),
    );
    writeFileSync(
      join(dir, "domra.local.json"),
      JSON.stringify({ port: 6001, roots: ["/b"] }),
    );
    process.env.DOMRA_PORT = "6002";

    const config = loadConfig(dir);
    assert.equal(config.port, 6002);
    assert.deepEqual(config.roots, ["/b"]);
    assert.equal(config.loadWaitSeconds, 5);
    assert.equal(config.defaultSolution, null);
    assert.deepEqual(config.ignoredFolders, [
      "node_modules", ".git", "dist", "build", "out", "coverage",
    ]);

    delete process.env.DOMRA_PORT;
    assert.equal(loadConfig(dir).port, 6001);
  } finally {
    if (saved === undefined) delete process.env.DOMRA_PORT;
    else process.env.DOMRA_PORT = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watcher config defaults and env overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "domra-config-"));
  const keys = [
    "DOMRA_WATCH", "DOMRA_DEBOUNCE_MS", "DOMRA_UNLOADED_REFRESH_SECONDS", "DOMRA_UNLOADED_REFRESH_MAX_WAIT_SECONDS",
  ];
  const saved = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    const defaults = loadConfig(dir);
    assert.equal(defaults.watch, true);
    assert.equal(defaults.debounceMs, 500);
    assert.equal(defaults.unloadedRefreshSeconds, 60);
    assert.equal(defaults.unloadedRefreshMaxWaitSeconds, 600);
    process.env.DOMRA_WATCH = "false";
    process.env.DOMRA_DEBOUNCE_MS = "250";
    process.env.DOMRA_UNLOADED_REFRESH_SECONDS = "0";
    process.env.DOMRA_UNLOADED_REFRESH_MAX_WAIT_SECONDS = "30";
    const config = loadConfig(dir);
    assert.equal(config.watch, false);
    assert.equal(config.debounceMs, 250);
    assert.equal(config.unloadedRefreshSeconds, 0);
    assert.equal(config.unloadedRefreshMaxWaitSeconds, 30);
    process.env.DOMRA_WATCH = "maybe";
    assert.throws(() => loadConfig(dir), /DOMRA_WATCH/);
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log config defaults and env overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "domra-config-"));
  const keys = ["DOMRA_LOG_DIRECTORY", "DOMRA_LOG_RETAINED_DAYS"];
  const saved = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    const defaults = loadConfig(dir);
    assert.equal(defaults.logDirectory, null);
    assert.equal(defaults.logRetainedDays, 7);
    process.env.DOMRA_LOG_DIRECTORY = "C:/logs";
    process.env.DOMRA_LOG_RETAINED_DAYS = "3";
    const config = loadConfig(dir);
    assert.equal(config.logDirectory, "C:/logs");
    assert.equal(config.logRetainedDays, 3);
    process.env.DOMRA_LOG_DIRECTORY = "";
    assert.equal(loadConfig(dir).logDirectory, null);
    process.env.DOMRA_LOG_RETAINED_DAYS = "many";
    assert.throws(() => loadConfig(dir), /DOMRA_LOG_RETAINED_DAYS/);
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("index config defaults and env overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "domra-config-"));
  const keys = ["DOMRA_INDEX_PATH", "DOMRA_WARM_UP", "DOMRA_BLOB_RETENTION_DAYS"];
  const saved = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    const defaults = loadConfig(dir);
    assert.equal(defaults.indexPath, null);
    assert.equal(defaults.warmUp, true);
    assert.equal(defaults.blobRetentionDays, 30);
    process.env.DOMRA_WARM_UP = "false";
    process.env.DOMRA_BLOB_RETENTION_DAYS = "7";
    process.env.DOMRA_INDEX_PATH = ":memory:";
    const config = loadConfig(dir);
    assert.equal(config.warmUp, false);
    assert.equal(config.blobRetentionDays, 7);
    assert.equal(config.indexPath, ":memory:");
    process.env.DOMRA_WARM_UP = "maybe";
    assert.throws(() => loadConfig(dir), /DOMRA_WARM_UP/);
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

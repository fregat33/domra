import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { LAYER as indexLayer } from "../src/index/index.ts";
import { LAYER as workspaceLayer } from "../src/workspace/index.ts";
import { LAYER as watcherLayer } from "../src/watcher/index.ts";
import { LAYER as serverLayer } from "../src/server/index.ts";

test("layer modules expose their LAYER constants", () => {
  assert.equal(indexLayer, "index");
  assert.equal(workspaceLayer, "workspace");
  assert.equal(watcherLayer, "watcher");
  assert.equal(serverLayer, "server");
});

test("typescript compiler API is available", () => {
  assert.equal(typeof ts.createLanguageService, "function");
});

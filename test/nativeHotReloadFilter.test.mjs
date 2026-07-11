// Unit tests for paths accepted by the built-in experimental hot-reload watcher.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { shouldIgnoreNativeHotReload } = require("../out/nativeHotReloadFilter.js");

test("reloads project Python files and excludes generated, environment, and migration paths", () => {
  assert.equal(shouldIgnoreNativeHotReload("/workspace/app/views.py"), false);
  assert.equal(shouldIgnoreNativeHotReload("C:\\workspace\\app\\services.py"), false);
  for (const file of [
    "/workspace/.django-shell/console-cell.py",
    "/workspace/.venv/lib/python/site-packages/pkg/mod.py",
    "/workspace/app/__pycache__/views.py",
    "/workspace/app/migrations/0001_initial.py",
    "/workspace/node_modules/tool.py",
    "/workspace/readme.txt"
  ]) {
    assert.equal(shouldIgnoreNativeHotReload(file), true, file);
  }
});

// Shared fixtures/helpers for the model data-browser backend tests (kept in one place so the test
// suites stay under the per-file line limit and run the backend identically).

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
export const { BackendClient } = require("../out/backendClient.js");
export const { buildComputedOrm, buildRowsOrm, __test: ormBuilders } = require("../out/modelOrm.js");

/** Returns the first runnable Python interpreter for backend tests. */
export function pythonExecutable() {
  const candidates = [process.env.DJANGO_SHELL_E2E_PYTHON, process.env.DJLS_E2E_BASE_PYTHON, "/Users/lky/.asdf/installs/python/3.11.15/bin/python3.11", "/usr/bin/python3", "python3"].filter(Boolean);
  return candidates.find((candidate) => childProcess.spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0);
}

export const PYTHON = pythonExecutable();
export const HAS_DJANGO = PYTHON ? childProcess.spawnSync(PYTHON, ["-c", "import django"], { encoding: "utf8" }).status === 0 : false;

/** Runs Python that loads the backend module as `mod` and prints one JSON line, returning the parsed object. */
export function runBackend(lines) {
  const header = [
    "import importlib.util",
    `path = ${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec = importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)"
  ];
  const result = childProcess.spawnSync(PYTHON, ["-c", [...header, ...lines].join("\n")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
}

// Verifies ordered composition of the split Python Django-shell backend source.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { backendPythonDirectory, readComposedBackendSource } from "./backendComposedSourceHelper.mjs";

const pythonDirectory = backendPythonDirectory();
const manifestPath = path.join(pythonDirectory, "django_shell_backend.parts.json");
const loaderPath = path.join(pythonDirectory, "django_shell_backend.py");
const vscodeIgnorePath = path.resolve(pythonDirectory, "../.vscodeignore");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

/** Returns an available Python executable, or undefined when no local Python is installed. */
function pythonExecutable() {
  for (const candidate of [process.env.DJANGO_SHELL_E2E_PYTHON, process.env.DJLS_E2E_BASE_PYTHON, "/usr/bin/python3", "python3"]) {
    if (!candidate) {
      continue;
    }
    const result = childProcess.spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) {
      return candidate;
    }
  }
  return undefined;
}

const PYTHON = pythonExecutable();

test("manifest preserves the fixed backend fragment order and line budget", () => {
  assert.deepEqual(manifest, [
    "backend_parts/00_bootstrap.pyfrag",
    "backend_parts/10_inspection.pyfrag",
    "backend_parts/20_execution_hot_reload.pyfrag",
    "backend_parts/30_debug_progress.pyfrag",
    "backend_parts/40_pty_capture.pyfrag",
    "backend_parts/50_model_core.pyfrag",
    "backend_parts/60_model_aggregate.pyfrag",
    "backend_parts/70_model_annotations.pyfrag",
    "backend_parts/80_model_edit_query.pyfrag",
    "backend_parts/90_model_query_recipe_predicate.pyfrag",
    "backend_parts/91_model_query_recipe_computed.pyfrag"
  ]);
  for (const fragment of manifest) {
    const source = fs.readFileSync(path.join(pythonDirectory, fragment), "utf8");
    assert.ok(source.startsWith("#"), `${fragment} must start with a purpose comment`);
    assert.ok(source.split("\n").length <= 1000, `${fragment} must stay within 1000 lines`);
  }
});

test("extension package rules retain the composed backend manifest and fragments", () => {
  const ignored = fs.readFileSync(vscodeIgnorePath, "utf8").split(/\r?\n/);
  assert.equal(ignored.includes("python/django_shell_backend.parts.json"), false);
  assert.equal(ignored.includes("python/backend_parts/**"), false);
  assert.equal(ignored.includes("python/**/*.pyfrag"), false);
});

test("composed source retains the single model-browser feature marker and backend symbols", () => {
  const source = readComposedBackendSource();
  assert.equal((source.match(/^# --- Model data browser/gm) ?? []).length, 1);
  assert.ok(source.includes("def _check_complete("));
  assert.ok(source.includes("def _execute_code("));
  assert.ok(source.includes("def _load_feature("));
  assert.ok(source.includes("def _browse_models("));
  assert.ok(source.includes("def _browse_recipe_rows("));
  assert.ok(source.includes("def _browse_recipe_validate("));
  assert.ok(source.includes("def start(namespace"));
});

test("loader executes ordered fragments in its own shared module globals", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, json",
    `path=${JSON.stringify(loaderPath)}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "print(json.dumps({'complete':hasattr(mod,'_check_complete'),'execute':hasattr(mod,'_execute_code'),'feature':hasattr(mod,'_load_feature'),'browse':hasattr(mod,'_browse_models'),'start':hasattr(mod,'start'),'temps':[name for name in vars(mod) if name.startswith('_djs_parts_')]}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.temps, []);
  assert.equal(payload.complete, true);
  assert.equal(payload.execute, true);
  assert.equal(payload.feature, true);
  assert.equal(payload.browse, true);
  assert.equal(payload.start, true);
});

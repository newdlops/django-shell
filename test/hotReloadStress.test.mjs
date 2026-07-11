// Repeated-generation stress coverage for the built-in deep hot-reload registry.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PYTHON = pythonExecutable();
const BACKEND_PATH = path.resolve("python", "django_shell_backend.py");

test("updates fifty held function generations and releases unreferenced generations", { skip: !PYTHON, timeout: 15_000 }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-reload-stress-"));
  const sourcePath = path.join(directory, "reload_stress_target.py");
  fs.writeFileSync(sourcePath, moduleSource(0));
  try {
    const run = childProcess.spawnSync(PYTHON, ["-c", stressScript(BACKEND_PATH, directory, sourcePath)], {
      encoding: "utf8",
      env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(directory, "pycache") },
      timeout: 12_000
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.iterations, 50);
    assert.equal(result.finalValue, "v0050");
    assert.equal(result.liveGenerations, 1);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

/** Returns a same-sized module generation so bytecode invalidation is exercised on every cycle. */
function moduleSource(generation) {
  return `def current():\n    return 'v${String(generation).padStart(4, "0")}'\n`;
}

/** Builds one isolated process that retains all old function objects across fifty reloads. */
function stressScript(backendPath, directory, sourcePath) {
  return [
    "import gc, importlib, importlib.util, json, os, sys",
    `backend_path=${JSON.stringify(backendPath)}`,
    `directory=${JSON.stringify(directory)}`,
    `source_path=${JSON.stringify(sourcePath)}`,
    "sys.path.insert(0,directory)",
    "spec=importlib.util.spec_from_file_location('django_shell_backend_stress',backend_path)",
    "backend=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(backend)",
    "module=importlib.import_module('reload_stress_target')",
    "backend._STATE['debug_engine']='native'",
    "stamp=os.stat(source_path).st_mtime_ns",
    "held=[module.current]",
    "for generation in range(1,51):",
    "    expected='v%04d' % generation",
    "    with open(source_path,'w',encoding='utf-8') as output:",
    "        output.write(\"def current():\\n    return %r\\n\" % expected)",
    "    os.utime(source_path,ns=(stamp,stamp))",
    "    response=backend._run_request({},'secret',{'token':'secret','kind':'hotReload','paths':[source_path]},set())",
    "    if not response.get('ok') or response.get('results',[{}])[0].get('status') != 'ok':",
    "        raise RuntimeError(response)",
    "    held.append(module.current)",
    "    values=[function() for function in held]",
    "    if any(value != expected for value in values):",
    "        raise RuntimeError({'generation':generation,'expected':expected,'values':values,'response':response,'cached':getattr(module,'__cached__',None)})",
    "held=[held[-1]]",
    "gc.collect()",
    "live=sum(len(bucket) for registry in backend._HOT_RELOAD_FUNCTION_GENERATIONS.values() for bucket in registry.values())",
    "print(json.dumps({'iterations':50,'finalValue':held[0](),'liveGenerations':live}))"
  ].join("\n");
}

/** Returns a working Python command for the isolated stress process. */
function pythonExecutable() {
  for (const candidate of [process.env.DJANGO_SHELL_E2E_PYTHON, "python3", "python"].filter(Boolean)) {
    if (childProcess.spawnSync(candidate, ["-c", "import sys"], { stdio: "ignore" }).status === 0) { return candidate; }
  }
  return undefined;
}

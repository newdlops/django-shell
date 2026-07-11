// Focused subprocess tests for the built-in experimental hot-reload backend.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PYTHON = pythonExecutable();
const BACKEND_PATH = path.resolve("python/django_shell_backend.py");

test("deep reload patches held, decorated, class, property, and every live function generation", { skip: !PYTHON }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-hot-reload-"));
  const sourcePath = path.join(directory, "hot_reload_target.py");
  const badPath = path.join(directory, "hot_reload_bad.py");
  const skippedPath = path.join(directory, "not_loaded.py");
  fs.writeFileSync(sourcePath, targetSource("aaaa"));
  fs.writeFileSync(badPath, "def stable():\n    return 'ok'\n");
  try {
    const script = String.raw`
import importlib.util
import json
import os
import sys

backend_path, source_path, bad_path, skipped_path, directory = sys.argv[1:]
spec = importlib.util.spec_from_file_location("django_shell_backend", backend_path)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)
sys.path.insert(0, directory)
import hot_reload_target as target
import hot_reload_bad as bad_target

backend._STATE["debug_engine"] = "native"
pyc_existed = os.path.isfile(getattr(target, "__cached__", ""))
target.__file__ = target.__cached__
held_plain = target.plain
held_decorated = target.decorated
held_wrapped = target.wrapped
held_class = target.Example
initial_stat = os.stat(source_path)
with open(source_path, encoding="utf-8") as handle:
    next_source = handle.read().replace("aaaa", "bbbb")
with open(source_path, "w", encoding="utf-8") as handle:
    handle.write(next_source)
os.utime(source_path, ns=(initial_stat.st_atime_ns, initial_stat.st_mtime_ns))
first = backend._run_request({}, "secret", {"token": "secret", "kind": "hotReload", "paths": [source_path]}, set())
middle_plain = target.plain
first_values = [held_plain(), held_decorated(), held_wrapped(), held_class.class_value(), held_class.static_value(), held_class().value]

middle_stat = os.stat(source_path)
with open(source_path, encoding="utf-8") as handle:
    final_source = handle.read().replace("bbbb", "cccc")
with open(source_path, "w", encoding="utf-8") as handle:
    handle.write(final_source)
os.utime(source_path, ns=(middle_stat.st_atime_ns, middle_stat.st_mtime_ns))
second = backend._run_request({}, "secret", {"token": "secret", "kind": "hotReload", "paths": [source_path]}, set())
second_values = [held_plain(), middle_plain(), held_decorated(), held_wrapped(), held_class.class_value(), held_class.static_value(), held_class().value]

with open(bad_path, "w", encoding="utf-8") as handle:
    handle.write("def broken(:\n    pass\n")
mixed = backend._run_request({}, "secret", {"token": "secret", "kind": "hotReload", "paths": [bad_path, skipped_path]}, set())
print(json.dumps({
    "first": first,
    "second": second,
    "firstValues": first_values,
    "secondValues": second_values,
    "mixed": mixed,
    "pycExisted": pyc_existed,
}))
`;
    const result = childProcess.spawnSync(PYTHON, ["-c", script, BACKEND_PATH, sourcePath, badPath, skippedPath, directory], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.pycExisted, true);
    assert.equal(payload.first.ok, true);
    assert.equal(payload.first.results[0].status, "ok");
    assert.equal(payload.first.results[0].module, "hot_reload_target");
    assert.ok(payload.first.results[0].patched.includes("plain"));
    assert.ok(payload.first.results[0].patched.includes("decorated"));
    assert.ok(payload.first.results[0].patched.includes("wrapped"));
    assert.ok(payload.first.results[0].patched.includes("Example.class_value"));
    assert.ok(payload.first.results[0].patched.includes("Example.static_value"));
    assert.ok(payload.first.results[0].patched.includes("Example.value"));
    assert.deepEqual(payload.firstValues, ["bbbb", "bbbb", "bbbb", "bbbb", "bbbb", "bbbb"]);
    assert.equal(payload.second.ok, true);
    assert.deepEqual(payload.secondValues, ["cccc", "cccc", "cccc", "cccc", "cccc", "cccc", "cccc"]);
    assert.equal(payload.mixed.ok, false);
    assert.equal(payload.mixed.results[0].status, "error");
    assert.equal(payload.mixed.results[0].module, "hot_reload_bad");
    assert.match(payload.mixed.results[0].message, /SyntaxError/);
    assert.equal(payload.mixed.results[1].status, "skipped");
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("reload removes canonical bytecode for both raw symlink and normalized source paths", { skip: !PYTHON || process.platform === "win32" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-hot-reload-symlink-"));
  const realDirectory = path.join(directory, "real");
  const aliasDirectory = path.join(directory, "alias");
  const cacheDirectory = path.join(directory, "pycache");
  fs.mkdirSync(realDirectory);
  fs.symlinkSync(realDirectory, aliasDirectory, "dir");
  const sourcePath = path.join(realDirectory, "symlink_target.py");
  fs.writeFileSync(sourcePath, "def value():\n    return 'old!'\n");
  try {
    const script = String.raw`
import importlib.util
import json
import os
import sys

backend_path, source_path, alias_directory = sys.argv[1:]
spec = importlib.util.spec_from_file_location("django_shell_backend", backend_path)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)
sys.path.insert(0, alias_directory)
import symlink_target as target

backend._STATE["debug_engine"] = "native"
held = target.value
raw_module_path = target.__file__
raw_cached_path = importlib.util.cache_from_source(raw_module_path)
cache_existed_before = os.path.isfile(raw_cached_path)
initial_stat = os.stat(source_path)
with open(source_path, "w", encoding="utf-8") as handle:
    handle.write("def value():\n    return 'new!'\n")
os.utime(source_path, ns=(initial_stat.st_atime_ns, initial_stat.st_mtime_ns))
result = backend._run_request({}, "secret", {"token": "secret", "kind": "hotReload", "paths": [source_path]}, set())
print(json.dumps({
    "result": result,
    "rawWasAlias": os.path.abspath(raw_module_path).startswith(os.path.abspath(alias_directory) + os.sep),
    "cacheExistedBefore": cache_existed_before,
    "held": held(),
    "current": target.value(),
}))
`;
    const result = childProcess.spawnSync(PYTHON, ["-c", script, BACKEND_PATH, sourcePath, aliasDirectory], {
      encoding: "utf8",
      env: { ...process.env, PYTHONPYCACHEPREFIX: cacheDirectory },
      timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.rawWasAlias, true);
    assert.equal(payload.cacheExistedBefore, true);
    assert.equal(payload.result.ok, true);
    assert.equal(payload.result.results[0].status, "ok");
    assert.equal(payload.held, "new!");
    assert.equal(payload.current, "new!");
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("runtime reload failure restores the module's shallow global snapshot", { skip: !PYTHON }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-hot-reload-rollback-"));
  const sourcePath = path.join(directory, "rollback_target.py");
  fs.writeFileSync(sourcePath, [
    "state = 'original'",
    "identity = object()",
    "",
    "def value():",
    "    return state",
    ""
  ].join("\n"));
  try {
    const script = String.raw`
import importlib.util
import json
import sys

backend_path, source_path, directory = sys.argv[1:]
spec = importlib.util.spec_from_file_location("django_shell_backend", backend_path)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)
sys.path.insert(0, directory)
import rollback_target as target

backend._STATE["debug_engine"] = "native"
held_value = target.value
original_identity = target.identity
original_keys = sorted(target.__dict__)
with open(source_path, "w", encoding="utf-8") as handle:
    handle.write("state = 'partially-mutated'\n")
    handle.write("leaked = 'must-not-survive'\n")
    handle.write("identity = object()\n")
    handle.write("raise RuntimeError('runtime reload exploded')\n")
result = backend._run_request({}, "secret", {"token": "secret", "kind": "hotReload", "paths": [source_path]}, set())
print(json.dumps({
    "result": result,
    "state": target.state,
    "hasLeaked": hasattr(target, "leaked"),
    "sameIdentity": target.identity is original_identity,
    "sameFunction": target.value is held_value,
    "heldValue": held_value(),
    "sameKeys": sorted(target.__dict__) == original_keys,
}))
`;
    const result = childProcess.spawnSync(PYTHON, ["-c", script, BACKEND_PATH, sourcePath, directory], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.ok, false);
    assert.equal(payload.result.results[0].status, "error");
    assert.match(payload.result.results[0].message, /RuntimeError: runtime reload exploded/);
    assert.equal(payload.state, "original");
    assert.equal(payload.hasLeaked, false);
    assert.equal(payload.sameIdentity, true);
    assert.equal(payload.sameFunction, true);
    assert.equal(payload.heldValue, "original");
    assert.equal(payload.sameKeys, true);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("closure-shape patch failures return a bounded partial result", { skip: !PYTHON }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-hot-reload-partial-"));
  const sourcePath = path.join(directory, "partial_target.py");
  fs.writeFileSync(sourcePath, partialTargetSource(true));
  try {
    const script = String.raw`
import importlib.util
import json
import sys

backend_path, source_path, directory = sys.argv[1:]
spec = importlib.util.spec_from_file_location("django_shell_backend", backend_path)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)
sys.path.insert(0, directory)
import partial_target as target

backend._STATE["debug_engine"] = "native"
held_stable = target.stable
held_fragile = target.fragile
with open(source_path, "w", encoding="utf-8") as handle:
    handle.write(${JSON.stringify(partialTargetSource(false))})
result = backend._run_request({}, "secret", {"token": "secret", "kind": "hotReload", "paths": [source_path]}, set())
print(json.dumps({
    "result": result,
    "heldStable": held_stable(),
    "heldFragile": held_fragile(),
    "currentFragile": target.fragile(),
}))
`;
    const result = childProcess.spawnSync(PYTHON, ["-c", script, BACKEND_PATH, sourcePath, directory], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    const row = payload.result.results[0];
    assert.equal(payload.result.ok, false);
    assert.equal(row.status, "partial");
    assert.ok(row.patched.includes("stable"));
    assert.match(row.message, /decorate\.<locals>\.wrapper/);
    assert.match(row.message, /ValueError/);
    assert.match(row.message, /free var/i);
    assert.ok(row.message.length <= 2048);
    assert.equal(payload.heldStable, "stable-new");
    assert.equal(payload.heldFragile, "old:value-new");
    assert.equal(payload.currentFragile, "value-new");
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("validates token, engine ownership, paths, bounds, uniqueness, and the execution barrier", { skip: !PYTHON }, () => {
  const script = String.raw`
import importlib.util
import json
import os
import sys
import types

spec = importlib.util.spec_from_file_location("django_shell_backend", sys.argv[1])
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)
second_spec = importlib.util.spec_from_file_location("django_shell_backend_second", sys.argv[1])
second_backend = importlib.util.module_from_spec(second_spec)
second_spec.loader.exec_module(second_backend)
shared_registry = backend._HOT_RELOAD_FUNCTION_GENERATIONS is second_backend._HOT_RELOAD_FUNCTION_GENERATIONS
shared_lock = backend._HOT_RELOAD_LOCK is second_backend._HOT_RELOAD_LOCK
absolute = os.path.abspath("not-loaded.py")
unauthorized = backend._run_request({}, "secret", {"token": "wrong", "kind": "hotReload", "paths": [absolute]}, set())
unowned = backend._run_request({}, "secret", {"token": "secret", "kind": "hotReload", "paths": [absolute]}, set())
backend._STATE["debug_engine"] = "native"
relative = backend._run_request({}, "secret", {"token": "secret", "kind": "hotReload", "paths": ["relative.py"]}, set())
suffix = backend._run_request({}, "secret", {"token": "secret", "kind": "hotReload", "paths": [os.path.abspath("module.txt")]}, set())
bounded = backend._run_request({}, "secret", {"token": "secret", "kind": "hotReload", "paths": [os.path.abspath("module-%d.py" % index) for index in range(65)]}, set())
lock_observations = []
original_reload_one = backend._hot_reload_one
def observe_execution_lock(source_path):
    acquired = backend._EXECUTION_LOCK.acquire(blocking=False)
    lock_observations.append(acquired)
    if acquired:
        backend._EXECUTION_LOCK.release()
    return original_reload_one(source_path)
backend._hot_reload_one = observe_execution_lock
idle = backend._run_request({}, "secret", {"token": "secret", "kind": "hotReload", "paths": [absolute, absolute]}, set())
idle_lock_observations = list(lock_observations)
released_after_idle = backend._EXECUTION_LOCK.acquire(blocking=False)
if released_after_idle:
    backend._EXECUTION_LOCK.release()
paused_threads = 0
native = types.SimpleNamespace(status=lambda: {"pausedThreads": paused_threads})
sys.modules["django_shell_native_tracer"] = native
sys.modules["_django_shell_native_tracer"] = native
with backend._EXECUTION_LOCK:
    busy = backend._run_request({}, "secret", {"token": "secret", "kind": "hotReload", "paths": [absolute]}, set())
    paused_threads = 1
    paused = backend._run_request({}, "secret", {"token": "secret", "kind": "hotReload", "paths": [absolute]}, set())
print(json.dumps({"unauthorized": unauthorized, "unowned": unowned, "relative": relative, "suffix": suffix, "bounded": bounded, "idle": idle, "releasedAfterIdle": released_after_idle, "idleLockObservations": idle_lock_observations, "lockObservations": lock_observations, "busy": busy, "paused": paused, "sharedRegistry": shared_registry, "sharedLock": shared_lock}))
`;
  const result = childProcess.spawnSync(PYTHON, ["-c", script, BACKEND_PATH], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.unauthorized.ok, false);
  assert.match(payload.unauthorized.stderr, /Invalid backend token/);
  assert.equal(payload.unowned.ok, false);
  assert.match(payload.unowned.error, /experimental debugger/i);
  assert.equal(payload.relative.ok, false);
  assert.match(payload.relative.error, /absolute \.py/);
  assert.equal(payload.suffix.ok, false);
  assert.match(payload.suffix.error, /absolute \.py/);
  assert.equal(payload.bounded.ok, false);
  assert.match(payload.bounded.error, /at most 64/);
  assert.equal(payload.idle.ok, true);
  assert.equal(payload.idle.results.length, 1);
  assert.equal(payload.idle.results[0].status, "skipped");
  assert.deepEqual(payload.idleLockObservations, [false]);
  assert.equal(payload.releasedAfterIdle, true);
  assert.equal(payload.busy.ok, false);
  assert.equal(payload.busy.retryable, true);
  assert.match(payload.busy.error, /still running/i);
  assert.deepEqual(payload.busy.results, []);
  assert.equal(payload.paused.ok, true);
  assert.equal(payload.paused.results.length, 1);
  assert.equal(payload.paused.results[0].status, "skipped");
  assert.deepEqual(payload.lockObservations, [false, false]);
  assert.equal(payload.sharedRegistry, true);
  assert.equal(payload.sharedLock, true);
});

/** Returns one same-size source generation used to prove canonical pyc invalidation. */
function targetSource(value) {
  return [
    "import functools",
    "",
    "def plain():",
    `    return ${JSON.stringify(value)}`,
    "",
    "def decorate(function):",
    "    def wrapper():",
    "        return function()",
    "    return wrapper",
    "",
    "@decorate",
    "def decorated():",
    `    return ${JSON.stringify(value)}`,
    "",
    "def wrapped_decorate(function):",
    "    @functools.wraps(function)",
    "    def wrapper():",
    "        return function()",
    "    return wrapper",
    "",
    "@wrapped_decorate",
    "def wrapped():",
    `    return ${JSON.stringify(value)}`,
    "",
    "class Example:",
    "    @classmethod",
    "    def class_value(cls):",
    `        return ${JSON.stringify(value)}`,
    "",
    "    @staticmethod",
    "    def static_value():",
    `        return ${JSON.stringify(value)}`,
    "",
    "    @property",
    "    def value(self):",
    `        return ${JSON.stringify(value)}`,
    ""
  ].join("\n");
}

/** Returns two generations whose decorator wrapper changes its closure freevar count. */
function partialTargetSource(withPrefix) {
  return [
    `def stable():`,
    `    return ${JSON.stringify(withPrefix ? "stable-old" : "stable-new")}`,
    "",
    "def decorate(function):",
    ...(withPrefix ? ["    prefix = 'old:'"] : []),
    "    def wrapper():",
    `        return ${withPrefix ? "prefix + function()" : "function()"}`,
    "    return wrapper",
    "",
    "@decorate",
    "def fragile():",
    `    return ${JSON.stringify(withPrefix ? "value-old" : "value-new")}`,
    ""
  ].join("\n");
}

/** Returns a working Python command for backend subprocess tests. */
function pythonExecutable() {
  for (const candidate of [process.env.DJANGO_SHELL_E2E_PYTHON, "python3", "python"].filter(Boolean)) {
    if (childProcess.spawnSync(candidate, ["-c", "import sys"], { stdio: "ignore" }).status === 0) { return candidate; }
  }
  return undefined;
}

// Verifies Django Shell's backend integration with the shared native tracer contract.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PYTHON = pythonExecutable();

test("opts only debug executions into the native tracer and exempts service threads", { skip: !PYTHON }, () => {
  const script = [
    "import ast, importlib.util, json, sys, threading, types",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "backend=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(backend)",
    "calls=[]",
    "native=types.SimpleNamespace(status=lambda: {'active': True}, trace_this_thread=lambda enabled: calls.append(bool(enabled)))",
    "sys.modules['_django_shell_native_tracer']=native",
    "thread=backend._debugger_exempt_thread(threading.Thread())",
    "tree=ast.parse('value = 1')",
    "same_tree=backend._debug_breakpoint_tree(tree, [1]) is tree",
    "result=backend._execute_code({}, 'value = 1', '/tmp/native-cell.py', 0, 'value = 1', [1])",
    "print(json.dumps({'calls':calls,'neutral':getattr(thread,'django_debugger_do_not_trace',False),'pydev':getattr(thread,'pydev_do_not_trace',False),'ok':result['ok'],'sameTree':same_tree,'shouldBreak':backend._debug_should_break(1,1)}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.calls, [true, false]);
  assert.equal(payload.neutral, true);
  assert.equal(payload.pydev, true);
  assert.equal(payload.ok, true);
  assert.equal(payload.sameTree, true);
  assert.equal(payload.shouldBreak, false);
});

test("loads and reuses the vendored tracer under Django Shell-private aliases", { skip: !PYTHON }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-native-loader-"));
  const tracerPath = path.join(directory, "tracer.py");
  fs.writeFileSync(tracerPath, [
    "TRACER_API_VERSION = 1",
    "TRACER_VERSION = 'test-v1'",
    "_active = False",
    "_endpoint = None",
    "trace_calls = []",
    "def status():",
    "    return {'active': _active, 'endpoint': _endpoint, 'apiVersion': TRACER_API_VERSION, 'version': TRACER_VERSION}",
    "def start(host='127.0.0.1', port=0):",
    "    global _active, _endpoint",
    "    if not _active:",
    "        _active = True",
    "        _endpoint = (host, port or 45678)",
    "    return _endpoint",
    "def trace_this_thread(enabled):",
    "    trace_calls.append(bool(enabled))"
  ].join("\n"));
  try {
    const script = [
      "import importlib.util, json, sys",
      `backend_path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
      `tracer_path=${JSON.stringify(tracerPath)}`,
      "spec=importlib.util.spec_from_file_location('django_shell_backend', backend_path)",
      "backend=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(backend)",
      "namespace={}",
      "request={'token':'secret','kind':'nativeDebugger','expectedVersion':'test-v1','host':'127.0.0.1','port':0,'tracerPath':tracer_path}",
      "first=backend._run_request(namespace,'secret',request,set())",
      "second=backend._run_request(namespace,'secret',request,set())",
      "module=sys.modules['django_shell_native_tracer']",
      "same_alias=module is sys.modules['_django_shell_native_tracer']",
      "blocked=backend._run_request(namespace,'secret',{'token':'secret','kind':'debugpy','code':'debugpy_ran = True'},set())",
      "print(json.dumps({'first':first,'second':second,'sameAlias':same_alias,'traceCalls':module.trace_calls,'owner':backend._STATE.get('debug_engine'),'blocked':blocked,'debugpyRan':namespace.get('debugpy_ran',False)}))"
    ].join("\n");
    const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.first, { apiVersion: 1, engine: "experimental", host: "127.0.0.1", ok: true, port: 45678, reused: false, version: "test-v1" });
    assert.deepEqual(payload.second, { apiVersion: 1, engine: "experimental", host: "127.0.0.1", ok: true, port: 45678, reused: true, version: "test-v1" });
    assert.equal(payload.sameAlias, true);
    assert.deepEqual(payload.traceCalls, [false, false]);
    assert.equal(payload.owner, "native");
    assert.equal(payload.blocked.ok, false);
    assert.match(payload.blocked.error, /restart the Django shell/i);
    assert.equal(payload.debugpyRan, false);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("cleans failed native loads and blocks native activation after debugpy claims the process", { skip: !PYTHON }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-native-conflict-"));
  const tracerPath = path.join(directory, "tracer.py");
  fs.writeFileSync(tracerPath, [
    "TRACER_API_VERSION = 1",
    "TRACER_VERSION = 'test-v1'",
    "def status(): return {'active': False, 'endpoint': None}",
    "def start(host='127.0.0.1', port=0): return (host, port or 45679)",
    "def trace_this_thread(enabled): pass"
  ].join("\n"));
  try {
    const script = [
      "import importlib.util, json, sys",
      `backend_path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
      `tracer_path=${JSON.stringify(tracerPath)}`,
      "spec=importlib.util.spec_from_file_location('django_shell_backend', backend_path)",
      "backend=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(backend)",
      "namespace={}",
      "base={'token':'secret','kind':'nativeDebugger','host':'127.0.0.1','port':0,'tracerPath':tracer_path}",
      "mismatch=backend._run_request(namespace,'secret',dict(base,expectedVersion='other-v1'),set())",
      "cleaned=all(name not in sys.modules for name in ('django_shell_native_tracer','_django_shell_native_tracer'))",
      "wide=backend._run_request(namespace,'secret',dict(base,expectedVersion='test-v1',host='0.0.0.0'),set())",
      "debugpy=backend._run_request(namespace,'secret',{'token':'secret','kind':'debugpy','code':'debugpy_ran = True'},set())",
      "blocked=backend._run_request(namespace,'secret',dict(base,expectedVersion='test-v1'),set())",
      "print(json.dumps({'mismatch':mismatch,'cleaned':cleaned,'wide':wide,'debugpy':debugpy,'blocked':blocked,'owner':backend._STATE.get('debug_engine'),'debugpyRan':namespace.get('debugpy_ran',False),'aliases':any(name in sys.modules for name in ('django_shell_native_tracer','_django_shell_native_tracer'))}))"
    ].join("\n");
    const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mismatch.ok, false);
    assert.match(payload.mismatch.error, /version mismatch/i);
    assert.equal(payload.cleaned, true);
    assert.equal(payload.wide.ok, false);
    assert.match(payload.wide.error, /127\.0\.0\.1/);
    assert.equal(payload.debugpy.ok, true);
    assert.equal(payload.debugpyRan, true);
    assert.equal(payload.owner, "debugpy");
    assert.equal(payload.blocked.ok, false);
    assert.match(payload.blocked.error, /restart the Django shell/i);
    assert.equal(payload.aliases, false);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("surfaces native trace opt-in failures while still disabling in finally", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, json, sys, types",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "backend=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(backend)",
    "calls=[]",
    "def trace(enabled):",
    "    calls.append(bool(enabled))",
    "    if enabled: raise RuntimeError('native trace opt-in failed')",
    "native=types.SimpleNamespace(status=lambda: {'active': True}, trace_this_thread=trace)",
    "sys.modules['django_shell_native_tracer']=native",
    "result=backend._execute_code({}, 'value = 1', '/tmp/native-cell.py', 0, 'value = 1', [1])",
    "print(json.dumps({'calls':calls,'ok':result['ok'],'traceback':result.get('traceback','')}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.calls, [true, false]);
  assert.equal(payload.ok, false);
  assert.match(payload.traceback, /native trace opt-in failed/);
});

/** Returns a working Python command for backend subprocess tests. */
function pythonExecutable() {
  for (const candidate of [process.env.DJANGO_SHELL_E2E_PYTHON, "python3", "python"].filter(Boolean)) {
    const probe = childProcess.spawnSync(candidate, ["-c", "import sys"], { stdio: "ignore" });
    if (probe.status === 0) { return candidate; }
  }
  return undefined;
}

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
    "gate_calls = []",
    "def status():",
    "    return {'active': _active, 'endpoint': _endpoint, 'apiVersion': TRACER_API_VERSION, 'version': TRACER_VERSION}",
    "def start(host='127.0.0.1', port=0):",
    "    global _active, _endpoint",
    "    if not _active:",
    "        _active = True",
    "        _endpoint = (host, port or 45678)",
    "    return _endpoint",
    "def trace_this_thread(enabled):",
    "    trace_calls.append(bool(enabled))",
    "def set_hot_reload_gate(gate):",
    "    gate_calls.append(gate is not None)"
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
      "print(json.dumps({'first':first,'second':second,'sameAlias':same_alias,'traceCalls':module.trace_calls,'gateCalls':module.gate_calls,'owner':backend._STATE.get('debug_engine'),'blocked':blocked,'debugpyRan':namespace.get('debugpy_ran',False)}))"
    ].join("\n");
    const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.first, { apiVersion: 1, engine: "experimental", host: "127.0.0.1", ok: true, port: 45678, reused: false, version: "test-v1" });
    assert.deepEqual(payload.second, { apiVersion: 1, engine: "experimental", host: "127.0.0.1", ok: true, port: 45678, reused: true, version: "test-v1" });
    assert.equal(payload.sameAlias, true);
    assert.deepEqual(payload.traceCalls, [false, false]);
    assert.deepEqual(payload.gateCalls, [true, true]);
    assert.equal(payload.owner, "native");
    assert.equal(payload.blocked.ok, false);
    assert.match(payload.blocked.error, /restart the Django shell/i);
    assert.equal(payload.debugpyRan, false);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("validates fresh and reused tracer endpoints before exposing a debug socket", { skip: !PYTHON }, () => {
  const cases = [
    { active: false, endpoint: ["203.0.113.10", 45680], name: "fresh-external" },
    { active: true, endpoint: ["0.0.0.0", 45681], name: "reused-wildcard" },
    { active: false, endpoint: ["127.0.0.1", true], name: "fresh-bool-port" },
    { active: true, endpoint: ["127.0.0.1", 0], name: "reused-zero-port" },
    { active: false, endpoint: "127.0.0.1:45682", name: "fresh-malformed" },
    { active: false, endpoint: ["localhost", 45683], name: "fresh-localhost" },
    { active: true, endpoint: ["127.0.0.1", 45684], name: "reused-loopback" },
    { active: false, endpoint: ["127.96.137.83", 45685], name: "fresh-routed-loopback" },
    { active: true, endpoint: ["127.96.137.83", 45686], name: "reused-routed-loopback" }
  ];
  const script = [
    "import importlib.util, json, sys, types",
    `backend_path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', backend_path)",
    "backend=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(backend)",
    `cases=json.loads(${JSON.stringify(JSON.stringify(cases))})`,
    "results={}",
    "for case in cases:",
    "    module=types.SimpleNamespace(",
    "        TRACER_API_VERSION=1,",
    "        TRACER_VERSION='test-v1',",
    "        status=lambda case=case: {'active': case['active'], 'endpoint': case['endpoint'] if case['active'] else None},",
    "        start=lambda host, port, case=case: case['endpoint'],",
    "        trace_this_thread=lambda enabled: None,",
    "        set_hot_reload_gate=lambda gate: None,",
    "    )",
    "    backend._STATE.pop('debug_engine', None)",
    "    sys.modules['django_shell_native_tracer']=module",
    "    sys.modules['_django_shell_native_tracer']=module",
    "    request={'token':'secret','kind':'nativeDebugger','expectedVersion':'test-v1','host':'127.0.0.1','port':0,'tracerPath':'/unused/tracer.py'}",
    "    results[case['name']]=backend._run_request({},'secret',request,set())",
    "    sys.modules.pop('django_shell_native_tracer', None)",
    "    sys.modules.pop('_django_shell_native_tracer', None)",
    "print(json.dumps(results, sort_keys=True))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);

  for (const name of ["fresh-external", "reused-wildcard", "fresh-bool-port", "reused-zero-port", "fresh-malformed"]) {
    assert.equal(payload[name].ok, false, `${name} must not expose an attach endpoint`);
    assert.match(payload[name].error, /invalid endpoint/i);
    assert.equal(payload[name].host, "127.0.0.1");
    assert.equal(payload[name].port, 0, `${name} must not echo the tracer's untrusted port`);
  }
  assert.deepEqual(payload["fresh-localhost"], { apiVersion: 1, engine: "experimental", host: "127.0.0.1", ok: true, port: 45683, reused: false, version: "test-v1" });
  assert.deepEqual(payload["reused-loopback"], { apiVersion: 1, engine: "experimental", host: "127.0.0.1", ok: true, port: 45684, reused: true, version: "test-v1" });
  assert.deepEqual(payload["fresh-routed-loopback"], { apiVersion: 1, engine: "experimental", host: "127.96.137.83", ok: true, port: 45685, reused: false, version: "test-v1" });
  assert.deepEqual(payload["reused-routed-loopback"], { apiVersion: 1, engine: "experimental", host: "127.96.137.83", ok: true, port: 45686, reused: true, version: "test-v1" });
});

test("cleans failed native loads and blocks native activation after debugpy claims the process", { skip: !PYTHON }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-native-conflict-"));
  const tracerPath = path.join(directory, "tracer.py");
  fs.writeFileSync(tracerPath, [
    "TRACER_API_VERSION = 1",
    "TRACER_VERSION = 'test-v1'",
    "def status(): return {'active': False, 'endpoint': None}",
    "def start(host='127.0.0.1', port=0): return (host, port or 45679)",
    "def trace_this_thread(enabled): pass",
    "def set_hot_reload_gate(gate): pass"
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

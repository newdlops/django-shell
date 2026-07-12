// Verifies that IPython backend warmup leaves READY on the fast path without exposing a partial namespace.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import test from "node:test";

const PYTHON = pythonExecutable();

test("backend control socket bypasses Port Manager only for bind and restores its environment", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, json, os",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "seen=[]",
    "class SuccessServer:",
    "    def __init__(self, address, handler): seen.append([os.environ.get('PORT_MANAGER_HOOK'),os.environ.get('PORT_MANAGER_HOOK_DISABLED')])",
    "os.environ['PORT_MANAGER_HOOK']='original-hook'",
    "os.environ['PORT_MANAGER_HOOK_DISABLED']='original-disabled'",
    "mod._Server=SuccessServer",
    "mod._create_control_server()",
    "success_after=[os.environ.get('PORT_MANAGER_HOOK'),os.environ.get('PORT_MANAGER_HOOK_DISABLED')]",
    "os.environ.pop('PORT_MANAGER_HOOK',None)",
    "os.environ.pop('PORT_MANAGER_HOOK_DISABLED',None)",
    "class FailureServer:",
    "    def __init__(self, address, handler): seen.append([os.environ.get('PORT_MANAGER_HOOK'),os.environ.get('PORT_MANAGER_HOOK_DISABLED')]); raise RuntimeError('bind failed')",
    "mod._Server=FailureServer",
    "try: mod._create_control_server()",
    "except RuntimeError: pass",
    "failure_after=['PORT_MANAGER_HOOK' in os.environ,'PORT_MANAGER_HOOK_DISABLED' in os.environ]",
    "print(json.dumps({'seen':seen,'successAfter':success_after,'failureAfter':failure_after}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.seen, [["0", "1"], ["0", "1"]]);
  assert.deepEqual(payload.successAfter, ["original-hook", "original-disabled"]);
  assert.deepEqual(payload.failureAfter, [false, false]);
});

test("IPython READY precedes deferred warmup while user cells wait", { skip: !PYTHON }, () => {
  const script = [
    "import builtins, importlib.util, json, threading, time, types",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "namespace={}",
    "callbacks={}",
    "class Events:",
    "    def register(self, name, callback): callbacks[name]=callback",
    "shell=types.SimpleNamespace(events=Events(), user_ns=namespace)",
    "builtins.get_ipython=lambda: shell",
    "class Server:",
    "    def __init__(self, address, handler): self.server_address=('127.0.0.1',32100)",
    "    def serve_forever(self): pass",
    "    def shutdown(self): pass",
    "    def server_close(self): pass",
    "mod._Server=Server",
    "markers=[]",
    "gate=threading.Event()",
    "warmup_entered=threading.Event()",
    "marker_seen_by_warmup=[]",
    "steps=[]",
    "def base_names(target):",
    "    marker_seen_by_warmup.append(bool(markers))",
    "    warmup_entered.set()",
    "    gate.wait(5)",
    "    target['base_name']=object()",
    "    return 1",
    "def registered_models(target):",
    "    target['LateModel']=type('LateModel',(),{'__module__':'late.models'})",
    "    return 1",
    "mod._autoimport_base_names=base_names",
    "mod._autoimport_registered_models=registered_models",
    "mod._autoimport_enabled=lambda: False",
    "mod._register_transform_lookups=lambda: steps.append('transforms')",
    "mod._install_queryset_progress=lambda: steps.append('progress')",
    "mod._print_marker=lambda prefix,payload: markers.append({'prefix':prefix,'payload':payload})",
    "started=time.monotonic()",
    "mod.start(namespace,'tok')",
    "start_ms=int((time.monotonic()-started)*1000)",
    "warmup_entered.wait(1)",
    "if 'server' not in mod._STATE: print(json.dumps({'startupError':markers})); raise SystemExit(0)",
    "server=mod._STATE['server']",
    "cell_done=threading.Event()",
    "def run_cell_pre_hook(): callbacks['pre_run_cell'](types.SimpleNamespace(raw_cell='_djs_rpc(1, 2)')); cell_done.set()",
    "cell_thread=threading.Thread(target=run_cell_pre_hook)",
    "cell_thread.start()",
    "time.sleep(0.08)",
    "cell_blocked=not cell_done.is_set()",
    "gate.set()",
    "cell_thread.join(2)",
    "warmup=mod._STATE['warmup']",
    "response=mod._run_request(namespace,'tok',{'kind':'prelude','token':'tok'},server.initial_names)",
    "prelude_names=[item['name'] for item in response.get('variables',[])]",
    "payload={",
    "  'autoImportedAfter':warmup.get('autoImported'),",
    "  'cellBlocked':cell_blocked,",
    "  'cellFinished':cell_done.is_set(),",
    "  'debuggerExempt':bool(getattr(warmup.get('thread'),'django_debugger_do_not_trace',False)),",
    "  'helperCurrent':namespace.get('_djs_backend_initial_names') is server.initial_names,",
    "  'initialNames':sorted(name for name in server.initial_names if name in ('base_name','LateModel')),",
    "  'marker':markers[0]['payload'],",
    "  'markerBeforeWarmup':marker_seen_by_warmup == [True],",
    "  'preludeNames':prelude_names,",
    "  'ptyInitialNames':sorted(name for name in namespace.get('_djs_initial_names',()) if name in ('base_name','LateModel')),",
    "  'startMs':start_ms,",
    "  'steps':steps,",
    "  'warmupPendingAfter':warmup.get('pending'),",
    "}",
    "server.shutdown()",
    "server.server_close()",
    "print(json.dumps(payload))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.startupError, undefined, JSON.stringify(payload.startupError));

  assert.equal(payload.marker.warmupPending, true);
  assert.equal(payload.marker.autoImported, 0, "READY does no Django namespace imports on its critical path");
  assert.equal(typeof payload.marker.readyMs, "number");
  assert.deepEqual(Object.keys(payload.marker.readyPhases), ["shell", "namespace", "server", "capture"]);
  assert.equal(payload.markerBeforeWarmup, true, "even common Django imports start only after READY is emitted");
  assert.ok(payload.startMs < 1000, `READY waited ${payload.startMs}ms for deferred namespace imports`);
  assert.equal(payload.cellBlocked, true, "the next IPython cell must not overtake warmup");
  assert.equal(payload.cellFinished, true);
  assert.equal(payload.warmupPendingAfter, false);
  assert.equal(payload.autoImportedAfter, 2);
  assert.equal(payload.debuggerExempt, true);
  assert.deepEqual(payload.steps, ["transforms", "progress"]);
  assert.deepEqual(payload.initialNames, ["LateModel", "base_name"]);
  assert.deepEqual(payload.ptyInitialNames, ["LateModel", "base_name"]);
  assert.equal(payload.helperCurrent, true);
  assert.ok(payload.preludeNames.includes("LateModel"));
});

/** Returns the first usable local Python executable. */
function pythonExecutable() {
  for (const candidate of [process.env.PYTHON, "python3", "python"].filter(Boolean)) {
    const result = childProcess.spawnSync(candidate, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
    if (result.status === 0) {
      return candidate;
    }
  }
  return undefined;
}

// Focused contract tests for Django Shell's vendored, explicit-opt-in tracer.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import test from "node:test";

const PYTHON = pythonExecutable();
const TRACER_PATH = path.resolve("python", "django_shell_native_tracer.py");

test("starts transport-only and traces only explicitly opted-in threads", { skip: !PYTHON, timeout: 20_000 }, () => {
  const script = String.raw`
import importlib.util
import json
import sys
import threading
import types

tracer_path = sys.argv[1]
dpd_canonical = types.ModuleType("django_process_debugger_tracer")
dpd_legacy = types.ModuleType("_django_debug_tracer")
sys.modules["django_process_debugger_tracer"] = dpd_canonical
sys.modules["_django_debug_tracer"] = dpd_legacy

spec = importlib.util.spec_from_file_location("django_shell_native_tracer", tracer_path)
module = importlib.util.module_from_spec(spec)
sys.modules["django_shell_native_tracer"] = module
spec.loader.exec_module(module)

assert module.TRACER_API_VERSION == 1
assert module.TRACER_VERSION == "2026.07.11.1"
assert module.OPT_IN_THREAD_ATTRIBUTE == "django_shell_debugger_trace_enabled"
assert sys.modules["django_shell_native_tracer"] is module
assert sys.modules["_django_shell_native_tracer"] is module
assert sys.modules["django_process_debugger_tracer"] is dpd_canonical
assert sys.modules["_django_debug_tracer"] is dpd_legacy

trace_install_calls = []
real_sys_settrace = sys.settrace
real_threading_settrace = threading.settrace
real_all_threads = getattr(threading, "settrace_all_threads", None)
try:
    sys.settrace = lambda value: trace_install_calls.append(("sys", value))
    threading.settrace = lambda value: trace_install_calls.append(("threading", value))
    if real_all_threads is not None:
        threading.settrace_all_threads = lambda value: trace_install_calls.append(("all", value))
    endpoint = module.start("127.0.0.1", 0)
finally:
    sys.settrace = real_sys_settrace
    threading.settrace = real_threading_settrace
    if real_all_threads is not None:
        threading.settrace_all_threads = real_all_threads

assert trace_install_calls == []
assert endpoint[0] == "127.0.0.1"
assert isinstance(endpoint[1], int) and endpoint[1] > 0
assert sys.gettrace() is None
assert not hasattr(threading.current_thread(), module.OPT_IN_THREAD_ATTRIBUTE)

tracer = module._ACTIVE_TRACER
assert tracer is not None
status = module.status()
assert status["active"] is True
assert tuple(status["endpoint"]) == endpoint

background_ready = threading.Event()
background_release = threading.Event()
background_observed = {}

def ordinary_background():
    current = threading.current_thread()
    background_observed["trace"] = sys.gettrace()
    background_observed["opted"] = hasattr(current, module.OPT_IN_THREAD_ATTRIBUTE)
    background_ready.set()
    background_release.wait(5)

background = threading.Thread(target=ordinary_background, name="ordinary-background")
background.start()
assert background_ready.wait(5)
assert background_observed == {"trace": None, "opted": False}
assert tracer._thread_id_for_snapshot(background.ident, background) is None

captured = {}
real_response = tracer._response
tracer._response = lambda _request, body=None, **_kwargs: captured.update(body or {}) or True
tracer._request({"seq": 1, "type": "request", "command": "threads", "arguments": {}})
assert captured["threads"] == []

module.trace_this_thread(True)
current = threading.current_thread()
assert getattr(current, module.OPT_IN_THREAD_ATTRIBUTE, None) is True
assert getattr(sys.gettrace(), "__self__", None) is tracer
assert tracer._thread_id_for_snapshot(threading.get_ident(), current) is not None

captured.clear()
tracer._request({"seq": 2, "type": "request", "command": "threads", "arguments": {}})
assert [row["name"] for row in captured["threads"]] == [current.name]
tracer._response = real_response

tracer.configured = True
tracer.client = object()
tracer.exception_filters = {"uncaught", "djangoRequestUnhandled"}
pauses = []
real_pause = tracer._pause
tracer._pause = lambda *args, **kwargs: pauses.append((args[2], kwargs.get("exception_stop").filter_id)) or True

error_value = None
try:
    raise RuntimeError("unopted")
except RuntimeError as caught:
    error_value = caught
    traceback_value = caught.__traceback__
module.trace_this_thread(False)
tracer._handle_uncaught_exception(threading.get_ident(), error_value, traceback_value)
assert pauses == []

try:
    raise RuntimeError("unopted-django")
except RuntimeError:
    tracer._handle_django_request_exception(threading.get_ident(), object())
assert pauses == []

module.trace_this_thread(True)
tracer._handle_uncaught_exception(threading.get_ident(), error_value, traceback_value)
try:
    raise RuntimeError("opted-django")
except RuntimeError:
    tracer._handle_django_request_exception(threading.get_ident(), object())
assert [entry[1] for entry in pauses] == ["uncaught", "djangoRequestUnhandled"]
module.trace_this_thread(False)
assert sys.gettrace() is None
assert not hasattr(current, module.OPT_IN_THREAD_ATTRIBUTE)

tracer._pause = real_pause
tracer.client = None
tracer.configured = False
background_release.set()
background.join(5)
assert not background.is_alive()
tracer._shutdown()

print(json.dumps({"endpoint": endpoint, "status": status, "pauses": pauses}))
`;

  const result = childProcess.spawnSync(PYTHON, ["-u", "-c", script, TRACER_PATH], {
    encoding: "utf8",
    env: cleanPythonEnv(),
    timeout: 15_000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.status.version, "2026.07.11.1");
  assert.equal(payload.pauses.length, 2);
});

/** Returns a usable Python executable without requiring a project virtualenv. */
function pythonExecutable() {
  for (const candidate of [process.env.DJANGO_SHELL_E2E_PYTHON, process.env.DJLS_E2E_BASE_PYTHON, "python3", "python"].filter(Boolean)) {
    if (childProcess.spawnSync(candidate, ["-c", "import sys"], { stdio: "ignore" }).status === 0) {
      return candidate;
    }
  }
  return undefined;
}

/** Removes unrelated process injection hooks from the child test runtime. */
function cleanPythonEnv() {
  const env = { ...process.env, PORT_MANAGER_HOOK: "0", PORT_MANAGER_HOOK_DISABLED: "1" };
  delete env.DYLD_INSERT_LIBRARIES;
  delete env.LD_PRELOAD;
  return env;
}

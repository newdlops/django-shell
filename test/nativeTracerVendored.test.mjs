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
assert module.TRACER_VERSION == "2026.07.11.4"
assert module.OPT_IN_THREAD_ATTRIBUTE == "django_shell_debugger_trace_enabled"
assert sys.modules["django_shell_native_tracer"] is module
assert sys.modules["_django_shell_native_tracer"] is module
assert sys.modules["django_process_debugger_tracer"] is dpd_canonical
assert sys.modules["_django_debug_tracer"] is dpd_legacy

try:
    module.set_hot_reload_gate(threading.Lock())
except RuntimeError:
    pass
else:
    raise AssertionError("a resume gate must not outlive an active tracer")

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
assert status["pausedThreads"] == 0

for invalid_gate in (object(), types.SimpleNamespace(acquire=None, release=lambda: None)):
    try:
        module.set_hot_reload_gate(invalid_gate)
    except TypeError:
        pass
    else:
        raise AssertionError("invalid resume gate was accepted")

class ProbeGate:
    def __init__(self):
        self.lock = threading.Lock()
        self.attempted = threading.Event()
        self.acquisitions = []

    def acquire(self, *args, **kwargs):
        self.acquisitions.append(threading.current_thread().name)
        self.attempted.set()
        return self.lock.acquire(*args, **kwargs)

    def release(self):
        self.lock.release()

gate = ProbeGate()
module.set_hot_reload_gate(gate)
assert tracer.hot_reload_gate is gate
assert module.NativeDapTracer().hot_reload_gate is None

resume_responses = []
resume_events = []
real_response = tracer._response
real_event = tracer._event
tracer._response = lambda request, body=None, **kwargs: resume_responses.append((request["command"], body)) or True
tracer._event = lambda event, body=None, **kwargs: resume_events.append((event, body)) or True

for offset, command in enumerate(("continue", "next", "stepIn", "stepOut"), start=1):
    native_id = 910_000 + offset
    dap_id = 920_000 + offset
    context = module.StopContext(native_id, dap_id, sys._getframe(), "breakpoint")
    with tracer.condition:
        tracer.stops[native_id] = context
        tracer.native_to_dap[native_id] = dap_id
        tracer.dap_to_native[dap_id] = native_id

    gate.acquire()
    gate.attempted.clear()
    worker = threading.Thread(
        target=tracer._resume,
        args=(
            {"seq": offset, "type": "request", "command": command},
            {"threadId": dap_id},
            command,
        ),
        name="resume-" + command,
    )
    worker.start()
    assert gate.attempted.wait(5), command
    assert worker.is_alive(), command
    assert context.paused is True, command
    assert module.status()["pausedThreads"] == 1, command
    gate.release()
    worker.join(5)
    assert not worker.is_alive(), command
    assert context.paused is False, command
    assert module.status()["pausedThreads"] == 0, command
    with tracer.condition:
        tracer.stops.pop(native_id, None)
        tracer.native_to_dap.pop(native_id, None)
        tracer.dap_to_native.pop(dap_id, None)
        tracer.steps.pop(native_id, None)

assert [name for name, _body in resume_responses] == [
    "continue",
    "next",
    "stepIn",
    "stepOut",
]
assert [event for event, _body in resume_events] == ["continued"] * 4
module.set_hot_reload_gate(None)
assert tracer.hot_reload_gate is None
tracer._response = real_response
tracer._event = real_event

fork_tracer = module.NativeDapTracer()
fork_tracer.hot_reload_gate = gate
fork_tracer._after_fork_child()
assert fork_tracer.hot_reload_gate is None

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

native_id = threading.get_ident()
tracer.steps[native_id] = ("next", 1)
tracer.pause_requests.add(native_id)
tracer.call_breakpoint_locations[native_id] = (sys._getframe(), 1, {})
module.trace_this_thread(False)
assert native_id not in tracer.steps
assert native_id not in tracer.pause_requests
assert native_id not in tracer.call_breakpoint_locations
module.trace_this_thread(True)

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
module.set_hot_reload_gate(gate)
tracer._shutdown()
assert tracer.hot_reload_gate is None

print(json.dumps({
    "endpoint": endpoint,
    "status": status,
    "pauses": pauses,
    "gateAcquisitions": gate.acquisitions,
}))
`;

  const result = childProcess.spawnSync(PYTHON, ["-u", "-c", script, TRACER_PATH], {
    encoding: "utf8",
    env: cleanPythonEnv(),
    timeout: 15_000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.status.version, "2026.07.11.4");
  assert.equal(payload.status.pausedThreads, 0);
  assert.equal(payload.pauses.length, 2);
  assert.deepEqual(
    payload.gateAcquisitions.filter((name) => name.startsWith("resume-")),
    ["resume-continue", "resume-next", "resume-stepIn", "resume-stepOut"]
  );
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

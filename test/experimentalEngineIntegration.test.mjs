// End-to-end coverage for Django Shell's vendored experimental tracer and backend.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { DirectDebugAdapterSession } = require("../out/directDebugAdapterSession.js");
const PYTHON = pythonExecutable();
const BACKEND_PATH = path.resolve("python", "django_shell_backend.py");
const TRACER_PATH = path.resolve("python", "django_shell_native_tracer.py");
const TRACER_VERSION = "2026.07.11.2";

test("debugs and hot-reloads only opted-in backend work with the vendored experimental engine", { skip: !PYTHON, timeout: 25_000 }, async () => {
  assert.equal(fs.existsSync(BACKEND_PATH), true, `Missing backend: ${BACKEND_PATH}`);
  assert.equal(fs.existsSync(TRACER_PATH), true, `Missing vendored tracer: ${TRACER_PATH}`);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-experimental-"));
  const sourcePath = path.join(directory, "console-cell.py");
  const hotSourcePath = path.join(directory, "hot_reload_target.py");
  const reloadEnteredPath = path.join(directory, "reload-entered");
  const reloadReleasePath = path.join(directory, "reload-release");
  const source = "value = 1\nvalue = value + 1\nvalue\n";
  fs.writeFileSync(sourcePath, source);
  fs.writeFileSync(hotSourcePath, "def current():\n    return 'before'\n");

  const script = pythonHarness(BACKEND_PATH, TRACER_PATH, hotSourcePath);
  const child = childProcess.spawn(PYTHON, ["-u", "-c", script], { env: { ...process.env, PORT_MANAGER_HOOK: "0", PORT_MANAGER_HOOK_DISABLED: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = lineReader(child);
  let session;

  try {
    const ready = JSON.parse((await lines.next("READY:", 5000)).slice(6));
    assert.deepEqual(ready.native, {
      apiVersion: 1,
      engine: "experimental",
      host: "127.0.0.1",
      ok: true,
      port: ready.native.port,
      reused: false,
      version: TRACER_VERSION
    });
    assert.ok(Number.isInteger(ready.native.port) && ready.native.port > 0);
    assert.equal(ready.unauthorized.ok, false);
    assert.match(ready.unauthorized.stderr, /invalid backend token/i);
    assert.equal(ready.owner, "native");
    assert.equal(ready.conflict.ok, false);
    assert.match(ready.conflict.error, /already owns this Django shell process/i);
    assert.equal(ready.debugpyRan, false);

    let stopCount = 0;
    let firstStopResolve;
    let firstStopReject;
    const firstStop = new Promise((resolve, reject) => {
      firstStopResolve = resolve;
      firstStopReject = reject;
    });
    const stopTimer = setTimeout(() => firstStopReject(new Error("Timed out waiting for the conditional breakpoint")), 5000);

    session = new DirectDebugAdapterSession({
      onStopped: (body) => {
        stopCount += 1;
        if (stopCount === 1) {
          clearTimeout(stopTimer);
          firstStopResolve(body);
        } else if (body.threadId) {
          void session.customRequest("continue", { singleThread: true, threadId: body.threadId });
        }
      }
    });

    await session.attach(
      { host: ready.native.host, port: ready.native.port, reused: ready.native.reused },
      async () => {
        const response = await session.customRequest("setBreakpoints", {
          breakpoints: [{ condition: "value == 1", line: 2 }],
          lines: [2],
          source: { name: path.basename(sourcePath), path: sourcePath }
        });
        assert.equal(response.breakpoints?.[0]?.verified, true);
        assert.equal(response.breakpoints?.[0]?.line, 2);
      },
      { cwd: directory, django: true, engine: "experimental", justMyCode: false, name: "Django Shell Experimental" }
    );

    const debugResponse = backendRequest(ready.backend, {
      breakpointLines: [2],
      code: source,
      filename: sourcePath,
      kind: "execute",
      lineOffset: 0,
      sourceText: source,
      token: ready.token
    }, 10_000);
    const stopped = await firstStop;
    assert.equal(stopped.reason, "breakpoint");
    assert.ok(Number.isInteger(stopped.threadId));

    const stack = await session.customRequest("stackTrace", { threadId: stopped.threadId });
    assert.equal(stack.stackFrames?.[0]?.source?.path, fs.realpathSync(sourcePath));
    const scopes = await session.customRequest("scopes", { frameId: stack.stackFrames[0].id });
    const globals = scopes.scopes.find((scope) => scope.name === "Globals");
    assert.ok(globals?.variablesReference);

    const variables = await session.customRequest("variables", { variablesReference: globals.variablesReference });
    assert.equal(variables.variables.find((variable) => variable.name === "value")?.value, "1");
    const changed = await session.customRequest("setVariable", {
      name: "value",
      value: "40",
      variablesReference: globals.variablesReference
    });
    assert.equal(changed.value, "40");

    fs.writeFileSync(hotSourcePath, [
      "import os, time",
      `open(${JSON.stringify(reloadEnteredPath)}, "w").close()`,
      `while not os.path.exists(${JSON.stringify(reloadReleasePath)}):`,
      "    time.sleep(0.01)",
      "def current():",
      "    return 'after!'",
      ""
    ].join("\n"));
    const reloadResponse = backendRequest(ready.backend, { kind: "hotReload", paths: [hotSourcePath], token: ready.token }, 10_000);
    await waitFor(() => fs.existsSync(reloadEnteredPath), 5000, "hot reload to enter module execution");
    let continueSettled = false;
    const continueResponse = session.customRequest("continue", { singleThread: true, threadId: stopped.threadId }).then((response) => {
      continueSettled = true;
      return response;
    });
    await delay(100);
    assert.equal(continueSettled, false, "Continue must wait behind the server-side hot-reload gate");
    fs.writeFileSync(reloadReleasePath, "release");
    const reloaded = await reloadResponse;
    assert.equal(reloaded.ok, true, `hot reload failed while paused: ${JSON.stringify(reloaded)}`);
    assert.equal(reloaded.results?.[0]?.status, "ok");
    assert.equal(reloaded.results?.[0]?.module, "hot_reload_target");
    assert.ok(reloaded.results?.[0]?.patched?.includes("current"));

    await continueResponse;
    const debugResult = await debugResponse;
    assert.equal(debugResult.ok, true);
    assert.equal(debugResult.result, "41");

    const heldResult = await backendRequest(ready.backend, { code: "held_hot()", kind: "execute", token: ready.token });
    assert.equal(heldResult.ok, true);
    assert.equal(heldResult.result, "'after!'");

    const cleared = await session.customRequest("setBreakpoints", {
      breakpoints: [],
      lines: [],
      source: { name: path.basename(sourcePath), path: sourcePath }
    });
    assert.deepEqual(cleared.breakpoints ?? [], []);

    const plainResult = await backendRequest(ready.backend, { code: source, filename: sourcePath, kind: "execute", lineOffset: 0, sourceText: source, token: ready.token });
    assert.equal(plainResult.ok, true);
    assert.equal(plainResult.result, "2");
    await delay(100);
    assert.equal(stopCount, 1, "a breakpoint-free ordinary cell must not opt into native tracing");
  } finally {
    try { fs.writeFileSync(reloadReleasePath, "release"); } catch {}
    await session?.disconnect().catch(() => undefined);
    if (child.exitCode === null && !child.killed) {
      child.stdin.write("EXIT\n");
      await lines.next("EXIT:", 1000).catch(() => undefined);
    }
    child.stdin.end();
    if (child.exitCode === null && !child.killed) { child.kill("SIGTERM"); }
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

/** Builds a real threaded backend server that starts the vendored tracer through its authenticated contract. */
function pythonHarness(backendPath, tracerPath, hotSourcePath) {
  return [
    "import importlib.util, json, os, sys",
    `backend_path=${JSON.stringify(backendPath)}`,
    `tracer_path=${JSON.stringify(tracerPath)}`,
    `hot_source_path=${JSON.stringify(hotSourcePath)}`,
    "token='experimental-integration-token'",
    "sys.path.insert(0,os.path.dirname(hot_source_path))",
    "backend_spec=importlib.util.spec_from_file_location('django_shell_backend',backend_path)",
    "backend=importlib.util.module_from_spec(backend_spec)",
    "backend_spec.loader.exec_module(backend)",
    "hot_spec=importlib.util.spec_from_file_location('hot_reload_target',hot_source_path)",
    "hot_module=importlib.util.module_from_spec(hot_spec)",
    "sys.modules['hot_reload_target']=hot_module",
    "hot_spec.loader.exec_module(hot_module)",
    "namespace={'held_hot':hot_module.current}",
    "backend.start(namespace,token)",
    "server=backend._STATE['server']",
    "initial_names=server.initial_names",
    "native_request={'token':token,'kind':'nativeDebugger','tracerPath':tracer_path,'expectedVersion':'2026.07.11.2','host':'127.0.0.1','port':0}",
    "unauthorized=backend._run_request(namespace,token,dict(native_request,token='wrong-token'),initial_names)",
    "native=backend._run_request(namespace,token,native_request,initial_names)",
    "conflict=backend._run_request(namespace,token,{'token':token,'kind':'debugpy','code':'debugpy_ran = True'},initial_names)",
    "ready={'backend':{'host':server.server_address[0],'port':server.server_address[1]},'token':token,'native':native,'unauthorized':unauthorized,'conflict':conflict,'owner':backend._STATE.get('debug_engine'),'debugpyRan':namespace.get('debugpy_ran',False)}",
    "print('READY:'+json.dumps(ready),flush=True)",
    "for command in sys.stdin:",
    "    command=command.strip()",
    "    if command == 'EXIT':",
    "        print('EXIT:{}',flush=True)",
    "        break"
  ].join("\n");
}

/** Sends one newline-delimited JSON request over a fresh production backend socket. */
function backendRequest(endpoint, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`Backend request timed out after ${timeoutMs}ms: ${payload.kind}`)), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        try { finish(undefined, JSON.parse(buffer.slice(0, newline))); } catch (error) { finish(error); }
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => { if (!settled) { finish(new Error("Backend socket closed before its response.")); } });

    /** Settles this one-shot request and releases its socket/timer. */
    function finish(error, value) {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) { reject(error); } else { resolve(value); }
    }
  });
}

/** Returns a prefix-aware stdout line reader with bounded waits. */
function lineReader(child) {
  let buffer = "";
  const lines = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) { break; }
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      const waiter = waiters.find((item) => line.startsWith(item.prefix));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        lines.push(line);
      }
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[experimental harness] ${chunk}`));
  return {
    next(prefix, timeoutMs) {
      const existing = lines.findIndex((line) => line.startsWith(prefix));
      if (existing >= 0) { return Promise.resolve(lines.splice(existing, 1)[0]); }
      return new Promise((resolve, reject) => {
        const waiter = { prefix, reject, resolve, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) { waiters.splice(index, 1); }
          reject(new Error(`No ${prefix} line within ${timeoutMs}ms; buffered=${JSON.stringify(lines)}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    }
  };
}

/** Returns a working Python command for the integration harness. */
function pythonExecutable() {
  for (const candidate of [process.env.DJANGO_SHELL_E2E_PYTHON, "python3", "python"].filter(Boolean)) {
    if (childProcess.spawnSync(candidate, ["-c", "import sys"], { stdio: "ignore" }).status === 0) { return candidate; }
  }
  return undefined;
}

/** Waits long enough for an unexpected stopped event to reach the client. */
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Waits for one asynchronous filesystem/runtime condition with a bounded diagnostic. */
async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) { throw new Error(`Timed out waiting for ${description}.`); }
    await delay(10);
  }
}

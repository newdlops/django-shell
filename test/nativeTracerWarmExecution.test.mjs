// Real-DAP regression coverage for warm same-thread native-debugger executions.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { DirectDebugAdapterSession } = require("../out/directDebugAdapterSession.js");
const PYTHON = pythonExecutable();
const BACKEND_PATH = path.resolve("python", "django_shell_backend.py");
const TRACER_PATH = path.resolve("python", "django_shell_native_tracer.py");
const TRACER_VERSION = "2026.07.11.4";

test("an expression-line breakpoint stops before evaluation and captured output", { skip: !PYTHON, timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-native-expression-"));
  const sourcePath = path.join(directory, "console-cell.py");
  const source = "marker = []\n(print('EXPRESSION_OUTPUT'), marker.append('evaluated'), 42)[-1]\n";
  fs.writeFileSync(sourcePath, source);

  const child = childProcess.spawn(PYTHON, ["-u", "-c", sameThreadHarness(BACKEND_PATH, TRACER_PATH)], {
    env: cleanPythonEnv(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = lineReader(child);
  const stops = eventQueue("stopped");
  let session;

  try {
    const ready = JSON.parse((await lines.next("READY:", 5000)).slice(6));
    assert.equal(ready.native.ok, true, JSON.stringify(ready.native));
    session = new DirectDebugAdapterSession({ onStopped: (body) => stops.push(body) });
    await session.attach(
      { host: ready.native.host, port: ready.native.port, reused: ready.native.reused },
      async () => {
        const response = await session.customRequest("setBreakpoints", {
          breakpoints: [{ line: 2 }],
          lines: [2],
          source: { name: path.basename(sourcePath), path: sourcePath }
        });
        assert.deepEqual(response.breakpoints?.map((breakpoint) => [breakpoint.verified, breakpoint.line]), [[true, 2]]);
      },
      { cwd: directory, django: true, engine: "experimental", justMyCode: false, name: "Django Shell Native Expression Ordering" }
    );

    let executionSettled = false;
    const execution = executeOnHarnessThread(child, lines, "expression", {
      breakpointLines: [2],
      code: source,
      filename: sourcePath,
      kind: "execute",
      lineOffset: 0,
      sourceText: source
    }).finally(() => { executionSettled = true; });
    const stop = await stops.next(5000);
    assert.equal(stop.reason, "breakpoint");
    const frame = await topFrame(session, stop);
    assert.equal(frame.line, 2);
    const marker = await session.customRequest("evaluate", { context: "watch", expression: "marker", frameId: frame.id });
    assert.equal(marker.result, "[]", "the expression must not mutate state before its line breakpoint");
    assert.equal(executionSettled, false, "the backend result and captured output must remain pending while stopped");

    await session.customRequest("continue", { singleThread: true, threadId: stop.threadId });
    const result = await execution;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result, "42");
    assert.equal(result.stdout, "EXPRESSION_OUTPUT\n");
  } finally {
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

test("a selected unit pauses even when an unexecuted unit makes the full editor invalid", { skip: !PYTHON, timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-native-unit-"));
  const sourcePath = path.join(directory, "console-cell.py");
  const source = "upper_only = 'must not run'\n\n\nselected = []\nselected.append('ran')\nselected\n\n\nlower_only = (,)\n";
  const code = "selected = []\nselected.append('ran')\nselected";
  const projectedSource = `${"\n".repeat(3)}${code}\n`;
  fs.writeFileSync(sourcePath, source);

  const child = childProcess.spawn(PYTHON, ["-u", "-c", sameThreadHarness(BACKEND_PATH, TRACER_PATH)], {
    env: cleanPythonEnv(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = lineReader(child);
  const stops = eventQueue("stopped");
  let session;

  try {
    const ready = JSON.parse((await lines.next("READY:", 5000)).slice(6));
    assert.equal(ready.native.ok, true, JSON.stringify(ready.native));
    session = new DirectDebugAdapterSession({ onStopped: (body) => stops.push(body) });
    await session.attach(
      { host: ready.native.host, port: ready.native.port, reused: ready.native.reused },
      async () => {
        const response = await session.customRequest("setBreakpoints", {
          breakpoints: [{ line: 5 }],
          lines: [5],
          source: { name: path.basename(sourcePath), path: sourcePath },
          sourceText: projectedSource
        });
        assert.deepEqual(response.breakpoints?.map((breakpoint) => [breakpoint.verified, breakpoint.line]), [[true, 5]]);
      },
      { cwd: directory, django: true, engine: "experimental", justMyCode: false, name: "Django Shell Native Unit Isolation" }
    );

    let executionSettled = false;
    const execution = executeOnHarnessThread(child, lines, "selected", {
      breakpointLines: [5],
      code,
      filename: sourcePath,
      kind: "execute",
      lineOffset: 3,
      sourceText: source
    }).finally(() => { executionSettled = true; });
    const stop = await stops.next(5000);
    assert.equal(stop.reason, "breakpoint");
    const frame = await topFrame(session, stop);
    assert.equal(frame.line, 5);
    const selected = await session.customRequest("evaluate", { context: "watch", expression: "selected", frameId: frame.id });
    assert.equal(selected.result, "[]", "the selected statement must not run before its breakpoint pause");
    assert.equal(executionSettled, false);

    await session.customRequest("continue", { singleThread: true, threadId: stop.threadId });
    const result = await execution;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result, "['ran']");
    const isolation = await executeOnHarnessThread(child, lines, "isolation", {
      code: "('upper_only' in globals(), 'lower_only' in globals())",
      kind: "execute"
    });
    assert.equal(isolation.result, "(False, False)", "unselected units must not mutate the shared shell namespace");
  } finally {
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

test("a final-line next does not leak into the next warm execution", { skip: !PYTHON, timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-native-warm-"));
  const sourcePath = path.join(directory, "console-cell.py");
  const source = "first = 1\nfirst += 1\n\n\nsecond = 2\nsecond += 1\nsecond\n";
  fs.writeFileSync(sourcePath, source);

  const child = childProcess.spawn(PYTHON, ["-u", "-c", sameThreadHarness(BACKEND_PATH, TRACER_PATH)], {
    env: cleanPythonEnv(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = lineReader(child);
  const stops = eventQueue("stopped");
  let session;

  try {
    const ready = JSON.parse((await lines.next("READY:", 5000)).slice(6));
    assert.equal(ready.native.ok, true, JSON.stringify(ready.native));
    session = new DirectDebugAdapterSession({ onStopped: (body) => stops.push(body) });
    await session.attach(
      { host: ready.native.host, port: ready.native.port, reused: ready.native.reused },
      async () => {
        const response = await session.customRequest("setBreakpoints", {
          breakpoints: [{ line: 2 }, { line: 6 }],
          lines: [2, 6],
          source: { name: path.basename(sourcePath), path: sourcePath }
        });
        assert.deepEqual(response.breakpoints?.map((breakpoint) => [breakpoint.verified, breakpoint.line]), [[true, 2], [true, 6]]);
      },
      { cwd: directory, django: true, engine: "experimental", justMyCode: false, name: "Django Shell Native Warm Execution" }
    );

    const firstExecution = executeOnHarnessThread(child, lines, "first", {
      breakpointLines: [2, 6],
      code: "first = 1\nfirst += 1\n",
      filename: sourcePath,
      kind: "execute",
      lineOffset: 0,
      sourceText: source
    });
    const firstStop = await stops.next(5000);
    assert.equal(firstStop.reason, "breakpoint");
    const firstFrame = await topFrame(session, firstStop);
    assert.equal(firstFrame.source?.path, fs.realpathSync(sourcePath));
    assert.equal(firstFrame.line, 2);

    await session.customRequest("next", { singleThread: true, threadId: firstStop.threadId });
    const firstResult = await firstExecution;
    assert.equal(firstResult.ok, true, JSON.stringify(firstResult));
    assert.equal(stops.pending(), 0, "Stepping over the final user line produced an extra stopped event");

    const secondExecution = executeOnHarnessThread(child, lines, "second", {
      breakpointLines: [2, 6],
      code: "second = 2\nsecond += 1\nsecond\n",
      filename: sourcePath,
      kind: "execute",
      lineOffset: 4,
      sourceText: source
    });
    const secondStop = await stops.next(5000);
    const secondFrame = await topFrame(session, secondStop);
    assert.equal(secondStop.reason, "breakpoint", `Warm execution first stopped as ${secondStop.reason} at ${secondFrame.source?.path}:${secondFrame.line}`);
    assert.equal(secondFrame.source?.path, fs.realpathSync(sourcePath));
    assert.equal(secondFrame.line, 6);

    await session.customRequest("continue", { singleThread: true, threadId: secondStop.threadId });
    const secondResult = await secondExecution;
    assert.equal(secondResult.ok, true, JSON.stringify(secondResult));
    assert.equal(secondResult.result, "3");
  } finally {
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

/** Returns the top DAP frame for one stop. */
async function topFrame(session, stopped) {
  const stack = await session.customRequest("stackTrace", { threadId: stopped.threadId });
  assert.ok(stack.stackFrames?.[0], JSON.stringify(stack));
  return stack.stackFrames[0];
}

/** Sends one backend execution through the harness's persistent main thread. */
function executeOnHarnessThread(child, lines, id, payload) {
  const prefix = `RESULT:${id}:`;
  const response = lines.next(prefix, 5000).then((line) => JSON.parse(line.slice(prefix.length)));
  child.stdin.write(`EXEC:${JSON.stringify({ id, payload })}\n`);
  return response;
}

/** Builds a Python harness that executes every cell on the same main thread. */
function sameThreadHarness(backendPath, tracerPath) {
  return [
    "import importlib.util, json, sys",
    `backend_path=${JSON.stringify(backendPath)}`,
    `tracer_path=${JSON.stringify(tracerPath)}`,
    "token='native-warm-execution-token'",
    "spec=importlib.util.spec_from_file_location('django_shell_backend',backend_path)",
    "backend=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(backend)",
    "namespace={}",
    "backend.start(namespace,token)",
    "server=backend._STATE['server']",
    `request={'token':token,'kind':'nativeDebugger','tracerPath':tracer_path,'expectedVersion':'${TRACER_VERSION}','host':'127.0.0.1','port':0}`,
    "native=backend._run_request(namespace,token,request,server.initial_names)",
    "print('READY:'+json.dumps({'native':native}),flush=True)",
    "for command in sys.stdin:",
    "    command=command.strip()",
    "    if command == 'EXIT':",
    "        print('EXIT:{}',flush=True)",
    "        break",
    "    if not command.startswith('EXEC:'):",
    "        continue",
    "    envelope=json.loads(command[5:])",
    "    payload=dict(envelope['payload'],token=token)",
    "    result=backend._run_request(namespace,token,payload,server.initial_names)",
    "    print('RESULT:'+str(envelope['id'])+':'+json.dumps(result),flush=True)"
  ].join("\n");
}

/** Returns a FIFO for debugger events with bounded asynchronous reads. */
function eventQueue(label) {
  const events = [];
  const waiters = [];
  return {
    pending: () => events.length,
    push(value) {
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      } else {
        events.push(value);
      }
    },
    next(timeoutMs) {
      if (events.length) { return Promise.resolve(events.shift()); }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) { waiters.splice(index, 1); }
          reject(new Error(`Timed out waiting for ${label} event`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    }
  };
}

/** Returns a prefix-aware stdout line reader. */
function lineReader(child) {
  let buffer = "";
  const buffered = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) { break; }
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      const waiter = waiters.find((candidate) => line.startsWith(candidate.prefix));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        buffered.push(line);
      }
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[native warm harness] ${chunk}`));
  return {
    next(prefix, timeoutMs) {
      const existing = buffered.findIndex((line) => line.startsWith(prefix));
      if (existing >= 0) { return Promise.resolve(buffered.splice(existing, 1)[0]); }
      return new Promise((resolve, reject) => {
        const waiter = { prefix, resolve, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) { waiters.splice(index, 1); }
          reject(new Error(`No ${prefix} line within ${timeoutMs}ms; buffered=${JSON.stringify(buffered)}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    }
  };
}

/** Returns a working Python executable. */
function pythonExecutable() {
  for (const candidate of [process.env.DJANGO_SHELL_E2E_PYTHON, "python3", "python"].filter(Boolean)) {
    if (childProcess.spawnSync(candidate, ["-c", "import sys"], { stdio: "ignore" }).status === 0) { return candidate; }
  }
  return undefined;
}

/** Removes unrelated injection hooks from the child runtime. */
function cleanPythonEnv() {
  const env = { ...process.env, PORT_MANAGER_HOOK: "0", PORT_MANAGER_HOOK_DISABLED: "1" };
  delete env.DYLD_INSERT_LIBRARIES;
  delete env.LD_PRELOAD;
  return env;
}

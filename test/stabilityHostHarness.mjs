// Provides isolated VS Code, PTY, and clock fixtures for extension lifecycle regression tests.

import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);

/** Creates a manually settled promise for deterministic asynchronous ordering. */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, reject, resolve };
}

/** Flushes queued promise continuations and terminal queue releases. */
export async function flush() { await new Promise((resolve) => setImmediate(resolve)); }

/** Creates a clock that can advance production deadlines without sleeping. */
export function fakeClock() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(callback, delay) { const timer = { at: now + delay, callback }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); },
    count: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) { break; }
        now = next.at; timers.delete(next); next.callback();
      }
      now = end;
    }
  };
}

/** Replaces global deadlines only for the duration of a PTY state-machine test. */
export async function withClock(run) {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const clock = fakeClock();
  globalThis.setTimeout = clock.setTimer; globalThis.clearTimeout = clock.clearTimer;
  try { return await run(clock); }
  finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
}

/** Loads host classes with fake application APIs and returns their observable message boundary. */
export function hostHarness() {
  const Module = require("node:module"), originalLoad = Module._load;
  const posted = [], processes = [];
  /** Creates a process that records writes without starting a shell. */
  function processFixture() {
    const process = { writes: [], killed: false, write(data) { this.writes.push(data); }, kill() { this.killed = true; }, resize() {}, onData(callback) { this.dataCallback = callback; }, onExit(callback) { this.exitCallback = callback; } };
    processes.push(process); return process;
  }
  const vscode = {
    EventEmitter: class {
      /** Initializes a minimal synchronous event stream. */
      constructor() { this.listeners = []; this.event = (listener) => { this.listeners.push(listener); return { dispose() {} }; }; }
      /** Delivers one snapshot to test subscribers. */
      fire(value) { for (const listener of this.listeners) { listener(value); } }
      /** Releases all test subscribers. */
      dispose() { this.listeners = []; }
    },
    Uri: { file: (fsPath) => ({ fsPath, scheme: "file", toString: () => `file://${fsPath}` }) },
    ViewColumn: { Active: 1 },
    commands: { executeCommand: async () => undefined, registerCommand: () => ({ dispose() {} }) },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { createWebviewPanel: (_viewType, title) => ({
      dispose() { this.close?.(); }, onDidDispose(callback) { this.close = callback; return { dispose() {} }; }, title,
      webview: { asWebviewUri: (value) => value, cspSource: "vscode-webview:", html: "", onDidReceiveMessage() { return { dispose() {} }; }, postMessage: async (message) => { posted.push(structuredClone(message)); return true; } }
    }) }
  };
  try {
    Module._load = function load(request, parent, isMain) {
      if (request === "vscode") { return vscode; }
      if (request === "node-pty") { return { spawn: processFixture }; }
      if (request === "./ptyHelper" && parent?.filename.endsWith("notebookPtySession.js")) { return { ensureNodePtyHelperExecutable() {} }; }
      return originalLoad.call(this, request, parent, isMain);
    };
    for (const module of ["../out/modelBrowser.js", "../out/modelQueryConsole.js", "../out/notebookPtySession.js", "../out/extension.js"]) { delete require.cache[require.resolve(module)]; }
    const { NotebookPtySession } = require("../out/notebookPtySession.js");
    const { ModelBrowser } = require("../out/modelBrowser.js");
    const { ModelQueryConsole } = require("../out/modelQueryConsole.js");
    const { LazyRuntimeSource } = require("../out/extension.js");
    const { BackendClient } = require("../out/backendClient.js");
    return { BackendClient, ModelBrowser, ModelQueryConsole, LazyRuntimeSource, posted, processes, processFixture,
      session() {
        const session = new NotebookPtySession({ autoActivateWorkspaceVenv: false, backendRuntimePath: path.resolve("missing-stability-runtime.py"), cwd: process.cwd(), djangoSettingsModule: "stability_fixture.settings", sessionId: "stability-fixture" });
        session.process = processFixture(); session.started = true; session.cellCapture = true; session.ipython = true;
        session.client = new BackendClient({ host: "127.0.0.1", port: 9, token: "fixture" }); session.token = "fixture";
        return session;
      }
    };
  } finally { Module._load = originalLoad; }
}

// Source guards for console progress and model browser lifecycle behavior.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import test from "node:test";
import { readComposedBackendSource } from "./backendComposedSourceHelper.mjs";

const customConsoleSource = fs.readFileSync(new URL("../src/customConsole.ts", import.meta.url), "utf8");
const customConsoleClientSource = fs.readFileSync(new URL("../media/customConsoleSource.js", import.meta.url), "utf8");
const debugEventsSource = fs.readFileSync(new URL("../src/customConsoleDebugEvents.ts", import.meta.url), "utf8");
const modelBrowserSource = fs.readFileSync(new URL("../src/modelBrowser.ts", import.meta.url), "utf8");
const modelBrowserClientSource = fs.readFileSync(new URL("../media/modelBrowserSource.js", import.meta.url), "utf8");
const modelCatalogSource = fs.readFileSync(new URL("../src/modelCatalog.ts", import.meta.url), "utf8");
const notebookPtySessionSource = fs.readFileSync(new URL("../src/notebookPtySession.ts", import.meta.url), "utf8");
const overlaySource = fs.readFileSync(new URL("../src/workbenchOverlay.ts", import.meta.url), "utf8");
const pythonBackendSource = readComposedBackendSource();
const require = createRequire(import.meta.url);

/** Loads the compiled browser with a minimal Webview API fixture for lifecycle-only E2E harness tests. */
function loadBrowserHarness() {
  const Module = require("node:module");
  const originalLoad = Module._load;
  let receiveMessage;
  const posted = [];
  const panel = {
    dispose() {},
    onDidDispose() { return { dispose() {} }; },
    title: "",
    webview: {
      asWebviewUri(value) { return value; },
      cspSource: "vscode-webview:",
      html: "",
      onDidReceiveMessage(listener) { receiveMessage = listener; return { dispose() {} }; },
      postMessage(message) { posted.push(message); return Promise.resolve(true); }
    }
  };
  const vscode = {
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } dispose() {} },
    Uri: { file: (fsPath) => ({ fsPath, scheme: "file", toString: () => `file://${fsPath}` }) },
    ViewColumn: { Active: 1 },
    commands: { executeCommand: async () => undefined, registerCommand: () => ({ dispose() {} }) },
    window: { createWebviewPanel: () => panel, showQuickPick: async () => undefined, showWarningMessage: async () => undefined }
  };
  try {
    Module._load = function load(request, parent, isMain) { return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain); };
    const modulePath = require.resolve("../out/modelBrowser.js");
    delete require.cache[modulePath];
    const browserModule = require(modulePath);
    return { ModelBrowser: browserModule.ModelBrowser, posted, receive: (message) => receiveMessage(message) };
  } finally {
    Module._load = originalLoad;
  }
}

/** Returns a read-only data source that lets the test harness reach the webview-ready handshake. */
function harnessSource() {
  return {
    interruptModelQuery: async () => ({ interrupted: false, ok: true }),
    listModels: async () => ({ models: [], ok: true }),
    modelAggregate: async () => ({ columns: [], ok: true, orm: "", rows: [], sql: [] }),
    modelCommit: async () => ({ ok: false }),
    modelComputed: async () => ({ columns: [], ok: true, orm: "", rows: [], sql: [] }),
    modelCount: async () => ({ count: 0, ok: true, orm: "", sql: [] }),
    modelFilterFields: async () => ({ fields: [], ok: true, relations: [] }),
    modelLookup: async () => ({ columns: [], ok: true, rows: [], sql: [] }),
    modelQuery: async () => ({ columns: [], ok: true, orm: "", rows: [], sql: [] }),
    modelRelated: async () => ({ columns: [], hasMore: false, ok: true, orm: "", rows: [], single: false, sql: [] }),
    modelRows: async () => ({ columns: [], hasMore: false, nextOffset: null, ok: true, orm: "", pk: "id", relations: [], rows: [], sql: [] }),
    modelSchema: async () => ({ app: "db", columns: [], label: "App user", model: "AppUser", ok: true, pk: "id", relations: [], table: "db_app_user" }),
    modelTransportInfo: () => ({ active: "tcp", mode: "auto" }),
    onDidChangeRuntime: () => ({ dispose() {} }),
    setModelTransport() {}
  };
}

/** Loads the DOM-only probe once so each test exercises its public message boundary. */
async function loadProbe() {
  return import(new URL("../media/modelQueryBuilderE2eProbe.js", import.meta.url));
}

/** Runs a probe with isolated global DOM shims and restores them after the assertion. */
async function withProbeGlobals(overrides, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, globalThis[key]);
    globalThis[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) { delete globalThis[key]; } else { globalThis[key] = value; }
    }
  }
}

/** Waits for an asynchronously routed fake-webview message without relying on the harness timeout. */
async function waitForPosted(messages, type) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const message = messages.find((candidate) => candidate.type === type);
    if (message) { return message; }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Missing fake-webview message: ${type}`);
}

test("Query Builder probe reports bootstrap and wait failures as one correlated terminal result", async () => {
  const { runModelQueryBuilderE2eProbe } = await loadProbe();
  const bootstrapMessages = [];
  await withProbeGlobals({ HTMLSelectElement: { get prototype() { throw new Error("bootstrap failed"); } } }, async () => {
    await runModelQueryBuilderE2eProbe({ document: {}, postMessage: (message) => bootstrapMessages.push(message), requestId: "bootstrap-request" });
  });
  assert.deepEqual(bootstrapMessages, [{ requestId: "bootstrap-request", snapshot: { error: "bootstrap failed", showPickerCalls: 0 }, type: "e2eQueryBuilderProbeResult" }]);

  const timeoutMessages = [];
  let clock = 0;
  const examples = ["Aggregate summary", "Correlated Exists", "Chained Formula", "Window RowNumber"].map((label) => ({ click() {}, getAttribute: () => label }));
  const document = { getElementById: () => undefined, querySelectorAll: () => examples };
  await withProbeGlobals({ HTMLSelectElement: { prototype: {} }, Date: { now: () => { clock += 1000; return clock; } }, setTimeout: (resolve) => { queueMicrotask(resolve); return 1; } }, async () => {
    await runModelQueryBuilderE2eProbe({ document, postMessage: (message) => timeoutMessages.push(message), requestId: "wait-request" });
  });
  const terminal = timeoutMessages.filter((message) => message.type === "e2eQueryBuilderProbeResult");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].requestId, "wait-request");
  assert.match(terminal[0].snapshot.error, /Timed out waiting for aggregate example controls/);
});

test("Query Builder probe survives restoration errors without duplicate terminal output", async () => {
  const { runModelQueryBuilderE2eProbe } = await loadProbe();
  const messages = [];
  const selectPrototype = new Proxy({}, { deleteProperty: () => false });
  await withProbeGlobals({ HTMLSelectElement: { prototype: selectPrototype } }, async () => {
    await runModelQueryBuilderE2eProbe({ document: { getElementById: () => undefined, querySelectorAll: () => [] }, postMessage: (message) => messages.push(message), requestId: "cleanup-request" });
  });
  const terminal = messages.filter((message) => message.type === "e2eQueryBuilderProbeResult");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].requestId, "cleanup-request");
  assert.match(terminal[0].snapshot.error, /Progressive examples are missing or unordered/);
});

test("Model Browser probe ignores stale and late results while preserving bounded correlated progress", async () => {
  const harness = loadBrowserHarness();
  const browser = new harness.ModelBrowser("/extension", harnessSource());
  const probe = browser.e2eProbeQueryBuilder({ app: "db", model: "AppUser" });
  await harness.receive({ type: "ready" });
  const request = await waitForPosted(harness.posted, "e2eQueryBuilderProbe");
  assert.ok(request.requestId);
  await harness.receive({ requestId: "stale-request", stage: "ignored", type: "e2eQueryBuilderProbeProgress" });
  await harness.receive({ requestId: request.requestId, stage: "x".repeat(120), type: "e2eQueryBuilderProbeProgress" });
  await harness.receive({ requestId: "stale-request", snapshot: { stale: true }, type: "e2eQueryBuilderProbeResult" });
  await harness.receive({ requestId: request.requestId, snapshot: { settled: true }, type: "e2eQueryBuilderProbeResult" });
  await harness.receive({ requestId: request.requestId, snapshot: { late: true }, type: "e2eQueryBuilderProbeResult" });
  assert.deepEqual(await probe, { settled: true });
  browser.dispose();
});

test("Model Browser timeout reports the latest bounded stage and elapsed time", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback) => { const timer = { callback, cleared: false }; timers.push(timer); return timer; };
  globalThis.clearTimeout = (timer) => { timer.cleared = true; };
  try {
    const harness = loadBrowserHarness();
    const browser = new harness.ModelBrowser("/extension", harnessSource());
    const probe = browser.e2eProbeQueryBuilder({ app: "db", model: "AppUser" });
    await harness.receive({ type: "ready" });
    const request = await waitForPosted(harness.posted, "e2eQueryBuilderProbe");
    const latestStage = "assistant-generation-".repeat(6);
    await harness.receive({ requestId: request.requestId, stage: latestStage, type: "e2eQueryBuilderProbeProgress" });
    const timeout = timers.findLast((timer) => !timer.cleared);
    timeout.callback();
    await assert.rejects(probe, new RegExp(`${latestStage.slice(0, 80)} after \\d+ms`));
    await harness.receive({ requestId: request.requestId, snapshot: { late: true }, type: "e2eQueryBuilderProbeResult" });
    browser.dispose();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("debug session restart does not automatically rerun the current cell", () => {
  assert.ok(customConsoleSource.includes("runOnNextDebugSessionStart"));
  assert.ok(customConsoleSource.includes("consumeRunOnDebugSessionStart"));
  assert.ok(debugEventsSource.includes("consumeRunOnSessionStart"));
  assert.ok(debugEventsSource.includes("debug.session.start.skipRun"));
});

test("debug execution does not publish or advance its expression before the run settles", () => {
  const directRun = overlaySource.slice(overlaySource.indexOf("async runCurrentInput()"), overlaySource.indexOf("async skipCurrentInput()"));
  const bridgeRun = overlaySource.slice(overlaySource.indexOf('if (payload?.type === "run"'), overlaySource.indexOf("res.writeHead(204", overlaySource.indexOf('if (payload?.type === "run"')));
  assert.ok(customConsoleSource.includes('this.post({ code, debugRun, execution, type: "pythonStarted" })'));
  assert.ok(customConsoleClientSource.includes("if (!message.debugRun)"), "a paused debug cell must not appear in Outputs as already executed");
  assert.ok(directRun.includes("await this.runHandler?."), "Debug Current waits for the debug execution lifecycle");
  assert.equal(directRun.includes("void this.runHandler?."), false);
  assert.ok(bridgeRun.includes("const executed = await this.runHandler?."), "the renderer bridge keeps its response pending while the debugger is paused");
  assert.ok(bridgeRun.includes("cancelled: executed === undefined") && bridgeRun.includes("executed: executed === true"), "the renderer distinguishes a cancelled readiness gate from incomplete Python");
});

test("model browser leaves loading state when the shell is busy or paused in debug", () => {
  assert.ok(modelBrowserSource.includes("MODEL_REQUEST_TIMEOUT_MS"));
  assert.ok(modelBrowserSource.includes("loadGeneration"));
  assert.ok(modelBrowserSource.includes("withRequestTimeout"));
  assert.ok(modelBrowserSource.includes("model.browser.timeout"));
  assert.ok(modelBrowserSource.includes('type: "busy"'));
  assert.ok(modelBrowserClientSource.includes('message.type === "busy"'));
  assert.ok(modelBrowserClientSource.includes("function renderBusy"));
  assert.ok(modelCatalogSource.includes("CATALOG_REQUEST_TIMEOUT_MS"));
  assert.ok(modelCatalogSource.includes("model.catalog.timeout"));
});

test("strictly parsed assistant generation is the only path that adopts draft revision state", () => {
  const handler = modelBrowserSource.slice(modelBrowserSource.indexOf("private async handleMessage"), modelBrowserSource.indexOf("if (typeof message.pageSize"));
  assert.ok(handler.includes("const assistantMessage = parseQueryAssistantMessage(message)"));
  assert.ok(handler.indexOf("assistantMessage?.type === \"generateQueryAssistantSuggestion\"") < handler.indexOf("this.acceptRecipeRevision(assistantMessage.revision)"));
  assert.equal(handler.includes("this.acceptRecipeRevision(message.revision)"), false);
});

test("model catalog refresh survives busy shells and debug pauses", () => {
  const backendClientSource = fs.readFileSync(new URL("../src/backendClient.ts", import.meta.url), "utf8");
  const modelCatalogClientSource = fs.readFileSync(new URL("../media/modelCatalogSource.js", import.meta.url), "utf8");
  // A timed-out catalog read applies its late result instead of discarding the already-queued work.
  assert.ok(modelCatalogSource.includes("result = await pendingList"));
  // The webview keeps the last loaded catalog browsable through transient busy/timeout refreshes.
  assert.ok(modelCatalogClientSource.includes("state.ok = state.groups.length > 0"));
  // Transient socket failures cool down and re-probe instead of disabling parallel reads for the session.
  assert.ok(backendClientSource.includes("TCP_RETRY_COOLDOWN_MS"));
  assert.ok(backendClientSource.includes("this.tcpFailedAt = Date.now()"));
  assert.ok(backendClientSource.includes("this.tcpFailedAt = 0"));
  assert.ok(backendClientSource.includes("remoteSocketUnavailable"));
  // Busy-time parallel reads reject after a bounded wait instead of hanging on a paused backend.
  assert.ok(backendClientSource.includes("PARALLEL_READ_RESPONSE_TIMEOUT_MS"));
  // Backend socket threads keep serving reads while debugpy is paused; cell executes restore tracing for breakpoints.
  assert.ok(pythonBackendSource.includes("def _debugger_exempt_thread"));
  assert.ok(pythonBackendSource.includes("def _restore_debugger_tracing"));
  assert.ok(pythonBackendSource.includes("_restore_debugger_tracing()"));
  assert.ok(pythonBackendSource.includes("daemon_threads = True"));
  assert.ok(pythonBackendSource.includes("pydev_do_not_trace"));
});

test("remote SSH/kubectl shells tunnel the backend socket for parallel model reads", () => {
  const backendClientSource = fs.readFileSync(new URL("../src/backendClient.ts", import.meta.url), "utf8");
  // The remote-ready path starts a backend tunnel beside the PTY instead of leaving the socket off for the session,
  // and only REGISTERS the deferred feature loader — nothing is exchanged until the first browse request needs it.
  assert.ok(notebookPtySessionSource.includes("const forward = this.forwardBackendSocket(ready.port, client)"));
  assert.ok(notebookPtySessionSource.includes("client.setModelBrowserFeatureLoader(() => forward.then(() => this.deliverModelBrowserFeature(client)))"));
  assert.ok(backendClientSource.includes("ensureModelBrowserFeature"));
  assert.ok(notebookPtySessionSource.includes("startKubectlPortForward(kubectl, remotePort"));
  assert.ok(notebookPtySessionSource.includes("startSshPortForward(ssh as SshExecTarget, remotePort"));
  assert.ok(notebookPtySessionSource.includes("backend.portForward.ready"));
  assert.ok(notebookPtySessionSource.includes("backend.portForward.error"));
  // The tunnel is torn down whenever the backend detaches or the session resets.
  assert.ok(notebookPtySessionSource.includes("clearBackendPortForward"));
  assert.ok(backendClientSource.includes("useForwardedEndpoint"));
  assert.ok(backendClientSource.includes("this.forwardedEndpoint?.host"));
  assert.ok(backendClientSource.includes("this.forwardedEndpoint?.port"));
  // Debug cell runs stay pinned to the interactive PTY main thread; only reads ride the socket/tunnel.
  assert.ok(backendClientSource.includes("if (this.fallback && hasDebugExecutionPayload(payload))"));
  // Deliberate PTY fallbacks must not extend the socket retry cooldown.
  assert.ok(backendClientSource.includes("if (error !== undefined) {"));
});

test("read-only model browser backend requests can run beside long cell execution", () => {
  const backendClientSource = fs.readFileSync(new URL("../src/backendClient.ts", import.meta.url), "utf8");
  const extensionSource = fs.readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
  assert.ok(pythonBackendSource.includes("def _browse_parallel_context"));
  assert.ok(pythonBackendSource.includes("contextlib.nullcontext()"));
  assert.ok(pythonBackendSource.includes("def _browse_rows_context"));
  assert.ok(pythonBackendSource.includes('item.get("kind") == "annotate"'));
  assert.ok(pythonBackendSource.includes("with _browse_rows_context(request):"));
  assert.ok(pythonBackendSource.includes("with _browse_parallel_context():"));
  assert.ok(customConsoleSource.includes("get pythonBusy()"));
  assert.ok(backendClientSource.includes("withParallelModelReads"));
  assert.ok(backendClientSource.includes("PARALLEL_MODEL_READ_KINDS"));
  assert.ok(extensionSource.includes("backend.withParallelModelReads(Boolean(this.console?.pythonBusy)"));
});

test("remote terminal ORM mode avoids unbounded inline input and result capture", () => {
  assert.ok(notebookPtySessionSource.includes("writeInlineBootstrapPaced"));
  assert.ok(notebookPtySessionSource.includes('const delay = index === 0 ? 350 : 20'));
  assert.ok(pythonBackendSource.includes("_PTY_ORM_TABULATE_LIMIT = 1000"));
  assert.ok(pythonBackendSource.includes("itertools.islice(value, _PTY_ORM_TABULATE_LIMIT + 1)"));
  assert.ok(pythonBackendSource.includes('return {"app": model._meta.app_label, "columns": columns, "editable": True, "hasMore": has_more'));
});

test("streamed backend progress markers are parsed outside PTY request mode", () => {
  assert.ok(notebookPtySessionSource.includes("BACKEND_PROGRESS_PREFIX"));
  assert.ok(notebookPtySessionSource.includes("data.includes(BACKEND_PROGRESS_PREFIX)"));
  assert.ok(notebookPtySessionSource.includes("progressMarkerTail(data)"));
  assert.ok(notebookPtySessionSource.includes("progressMarkerTail(parsed.rest)"));
  assert.ok(notebookPtySessionSource.includes("this.inspectPtyProgress();"));
  assert.ok(notebookPtySessionSource.includes("\\btqdm\\s*\\("));
});

test("remote PTY stdout and stderr progress chunks stay visible in running output", () => {
  assert.ok(pythonBackendSource.includes("class _StreamingCapture"));
  assert.ok(pythonBackendSource.includes('{"active": True, "kind": "output"'));
  assert.ok(customConsoleClientSource.includes("function appendLiveOutput"));
  assert.ok(customConsoleClientSource.includes('typeof progress.output === "string"'));
  assert.ok(customConsoleClientSource.includes("pendingExecutionCodes.set"), "debug source is retained without rendering an output before execution reaches print");
  assert.ok(customConsoleClientSource.includes("showRunningOutput(count, pendingExecutionCodes.get(count)"), "the first live debug output lazily creates its output item");
});

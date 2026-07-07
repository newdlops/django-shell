// Source guards for console progress and model browser lifecycle behavior.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const customConsoleSource = fs.readFileSync(new URL("../src/customConsole.ts", import.meta.url), "utf8");
const customConsoleClientSource = fs.readFileSync(new URL("../media/customConsoleSource.js", import.meta.url), "utf8");
const debugEventsSource = fs.readFileSync(new URL("../src/customConsoleDebugEvents.ts", import.meta.url), "utf8");
const modelBrowserSource = fs.readFileSync(new URL("../src/modelBrowser.ts", import.meta.url), "utf8");
const modelBrowserClientSource = fs.readFileSync(new URL("../media/modelBrowserSource.js", import.meta.url), "utf8");
const modelCatalogSource = fs.readFileSync(new URL("../src/modelCatalog.ts", import.meta.url), "utf8");
const notebookPtySessionSource = fs.readFileSync(new URL("../src/notebookPtySession.ts", import.meta.url), "utf8");
const pythonBackendSource = fs.readFileSync(new URL("../python/django_shell_backend.py", import.meta.url), "utf8");

test("debug session restart does not automatically rerun the current cell", () => {
  assert.ok(customConsoleSource.includes("runOnNextDebugSessionStart"));
  assert.ok(customConsoleSource.includes("consumeRunOnDebugSessionStart"));
  assert.ok(debugEventsSource.includes("consumeRunOnSessionStart"));
  assert.ok(debugEventsSource.includes("debug.session.start.skipRun"));
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
});

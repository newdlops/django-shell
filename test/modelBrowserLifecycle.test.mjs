// Source guards for console progress and model browser lifecycle behavior.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const customConsoleSource = fs.readFileSync(new URL("../src/customConsole.ts", import.meta.url), "utf8");
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

test("read-only model browser backend requests can run beside long cell execution", () => {
  assert.ok(pythonBackendSource.includes("def _browse_parallel_context"));
  assert.ok(pythonBackendSource.includes("contextlib.nullcontext()"));
  assert.ok(pythonBackendSource.includes("def _browse_rows_context"));
  assert.ok(pythonBackendSource.includes('item.get("kind") == "annotate"'));
  assert.ok(pythonBackendSource.includes("with _browse_rows_context(request):"));
  assert.ok(pythonBackendSource.includes("with _browse_parallel_context():"));
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
});

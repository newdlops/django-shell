// Regression and bounded-work tests for Python-cell metadata and overlay warmup.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const NodeModule = require("node:module");
const mockState = { tree: undefined, writeHook: undefined, writes: [] };
const vscodeMock = createVscodeMock();
const originalLoad = NodeModule._load;
let ModelCatalog;
let OverlayMemoryDocument;
let RuntimeInspector;

try {
  NodeModule._load = function loadWithVscodeMock(request, parent, isMain) {
    return request === "vscode" ? vscodeMock : originalLoad.call(this, request, parent, isMain);
  };
  ({ ModelCatalog } = require("../out/modelCatalog.js"));
  ({ OverlayMemoryDocument } = require("../out/overlayMemoryDocument.js"));
  ({ RuntimeInspector } = require("../out/runtimeInspector.js"));
} finally {
  NodeModule._load = originalLoad;
}

const { runtimePreludeLines } = require("../out/runtimePrelude.js");

test("console overlaps shell startup with backing reset but gates overlay construction", () => {
  const source = fs.readFileSync(new URL("../src/customConsole.ts", import.meta.url), "utf8");
  const start = source.indexOf("async openConsole(): Promise<void>");
  const end = source.indexOf("async showOverlayEditor", start);
  const body = source.slice(start, end);
  const resetStart = body.indexOf("this.ensureOverlayBackingFilesReset()");
  const session = body.indexOf("this.ensureSession()");
  const resetAwait = body.indexOf("await backingReset", session);
  const ensureOverlayStart = source.indexOf("private async ensureOverlay(): Promise<WorkbenchOverlay>");
  const ensureOverlayEnd = source.indexOf("private releaseOverlay", ensureOverlayStart);
  const ensureOverlayBody = source.slice(ensureOverlayStart, ensureOverlayEnd);
  const overlayResetAwait = ensureOverlayBody.indexOf("await this.ensureOverlayBackingFilesReset()");
  const overlayImport = ensureOverlayBody.indexOf('import("./workbenchOverlay")');

  assert.ok(resetStart >= 0 && session > resetStart && resetAwait > session, "terminal startup overlaps the unresolved cleanup promise");
  assert.ok(overlayResetAwait >= 0 && overlayImport > overlayResetAwait, "WorkbenchOverlay creation waits for stale-file cleanup");
});

test("runtime prelude output stays bounded without starving late model imports", () => {
  const variables = [
    ...Array.from({ length: 4000 }, (_, index) => ({
      importLine: `from factory.module_${index} import Factory${index}`,
      kind: "class",
      name: `Factory${index}`,
      preview: `class factory.module_${index}.Factory${index}`
    })),
    ...Array.from({ length: 4000 }, (_, index) => ({ kind: "primitive", name: `runtime_value_${index}`, preview: String(index) })),
    { importLine: "from payroll.models import Employee", kind: "class", name: "Employee", preview: "class payroll.models.Employee" }
  ];

  const lines = runtimePreludeLines(variables);

  assert.ok(lines.length <= 341, `runtime prelude grew to ${lines.length} lines`);
  assert.ok(lines.includes("from payroll.models import Employee"), "model imports remain ahead of the general import cap");
  assert.equal(new Set(lines).size, lines.length, "warmup never writes duplicate prelude lines");
});

test("runtime inspector stays idle while hidden and coalesces visible invalidations", async () => {
  const runtimeEvents = new MockEventEmitter();
  const inspection = { loadedModuleCount: 0, modules: [], ok: true, variables: [] };
  let firstResolve;
  let inspections = 0;
  const source = {
    inspectActiveRuntime() {
      inspections += 1;
      if (inspections === 1) { return new Promise((resolve) => { firstResolve = resolve; }); }
      return Promise.resolve(inspection);
    },
    inspectRuntimeChildren() { return Promise.resolve({ children: [], ok: true }); },
    onDidChangeRuntime: runtimeEvents.event
  };
  const inspector = new RuntimeInspector(source);
  inspector.activate({ subscriptions: [] });

  runtimeEvents.fire();
  await delay(20);
  assert.equal(inspections, 0, "a hidden Activity Bar view must not join startup metadata fan-out");

  mockState.tree.visible = true;
  mockState.tree.fireVisibility(true);
  await delay(20);
  assert.equal(inspections, 1);
  const left = inspector.refresh();
  const right = inspector.refresh();
  assert.equal(inspections, 1, "concurrent refresh callers share the active inspection");
  firstResolve(inspection);
  await Promise.all([left, right]);

  runtimeEvents.fire();
  runtimeEvents.fire();
  runtimeEvents.fire();
  await delay(220);
  assert.equal(inspections, 2, "bursty runtime changes collapse into one visible refresh");
  inspector.dispose();
});

test("model catalog defers runtime loads while hidden", async () => {
  const runtimeEvents = new MockEventEmitter();
  let loads = 0;
  const source = {
    listModels() { loads += 1; return Promise.resolve({ models: [], ok: true }); },
    onDidChangeRuntime: runtimeEvents.event
  };
  const catalog = new ModelCatalog("/extension", source);
  catalog.activate({ subscriptions: [] });
  const view = createCatalogView(false);
  catalog.resolveWebviewView(view);

  runtimeEvents.fire();
  await delay(10);
  assert.equal(loads, 0);

  view.visible = true;
  view.fireVisibility();
  await delay(10);
  assert.equal(loads, 1, "revealing one stale catalog starts one load");

  view.visible = false;
  view.fireVisibility();
  runtimeEvents.fire();
  await delay(10);
  assert.equal(loads, 1, "hidden runtime changes only mark the catalog stale");
  catalog.dispose();
});

test("overlay memory skips no-op writes and flushes volatile edits only once", async () => {
  mockState.writes.length = 0;
  const document = new OverlayMemoryDocument(undefined, "warmup-cell", "warmup-analysis");

  await document.sync("");
  assert.equal(mockState.writes.length, 0);

  await document.sync("value = 1\n");
  const afterInitialSync = mockState.writes.length;
  assert.equal(afterInitialSync, 2);
  await document.sync("value = 1\n");
  assert.equal(mockState.writes.length, afterInitialSync, "identical editor snapshots cause no filesystem work");

  const prelude = "from payroll.models import Employee\n";
  await document.updatePrelude(prelude);
  const afterPrelude = mockState.writes.length;
  await document.updatePrelude(prelude);
  assert.equal(mockState.writes.length, afterPrelude, "identical warmup preludes are not rewritten");

  await document.syncVolatile("value = 2\n");
  assert.equal(mockState.writes.length, afterPrelude, "typing remains memory-only");
  await document.sync("value = 2\n");
  assert.equal(mockState.writes.length, afterPrelude + 2, "execution flushes each dirty backing file once");

  const latest = new Map(mockState.writes.map((write) => [path.basename(write.path), write.text]));
  assert.equal(latest.get("warmup-cell.py"), "value = 2\n");
  assert.equal(latest.get("warmup-analysis.py"), `${prelude}value = 2\n`);
});

test("overlay memory preserves a newer dirty analysis snapshot during an older write", async () => {
  mockState.writes.length = 0;
  const document = new OverlayMemoryDocument(undefined, "race-cell", "race-analysis");
  await document.sync("value = 1\n");
  await document.syncVolatile("value = 2\n");
  const writeStarted = deferred();
  const releaseWrite = deferred();
  mockState.writeHook = async (uri) => {
    if (path.basename(uri.fsPath) === "race-analysis.py") {
      writeStarted.resolve();
      await releaseWrite.promise;
    }
  };

  const olderSync = document.syncAnalysis("value = 2\n");
  await writeStarted.promise;
  await document.syncVolatile("value = 3\n");
  releaseWrite.resolve();
  await olderSync;
  mockState.writeHook = undefined;
  await document.syncAnalysis("value = 3\n");

  const analysisWrites = mockState.writes.filter((write) => path.basename(write.path) === "race-analysis.py");
  assert.equal(analysisWrites.at(-1).text, "value = 3\n");
  assert.equal(analysisWrites.length, 3, "initial, older, and latest analysis snapshots are each written once");
});

/** Minimal event emitter matching the VS Code event subscription contract. */
function MockEventEmitter() {
  this.listeners = new Set();
  this.event = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
}

/** Delivers one event to a stable listener snapshot. */
MockEventEmitter.prototype.fire = function fire(value) {
  for (const listener of [...this.listeners]) { listener(value); }
};

/** Releases every listener held by the mock emitter. */
MockEventEmitter.prototype.dispose = function dispose() { this.listeners.clear(); };

/** Builds the narrow VS Code API surface used by the initialization components. */
function createVscodeMock() {
  const disposable = () => ({ dispose() {} });
  const uri = (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` });
  return {
    commands: { executeCommand: async () => undefined, registerCommand: disposable },
    EventEmitter: MockEventEmitter,
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    window: {
      createTreeView() {
        let visibilityListener = () => undefined;
        mockState.tree = {
          dispose() {},
          fireVisibility(visible) { visibilityListener({ visible }); },
          onDidChangeVisibility(listener) { visibilityListener = listener; return disposable(); },
          visible: false
        };
        return mockState.tree;
      },
      registerWebviewViewProvider: disposable
    },
    workspace: {
      fs: {
        async createDirectory() {},
        async writeFile(uriValue, bytes) {
          await mockState.writeHook?.(uriValue, bytes);
          mockState.writes.push({ path: uriValue.fsPath, text: Buffer.from(bytes).toString("utf8") });
        }
      },
      workspaceFolders: [{ uri: uri(path.join("/tmp", "django-shell-initialization")) }]
    }
  };
}

/** Creates a deferred promise for deterministic file-write overlap. */
function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

/** Builds a sidebar view mock with controllable visibility. */
function createCatalogView(visible) {
  let visibilityListener = () => undefined;
  return {
    fireVisibility() { visibilityListener(); },
    onDidChangeVisibility(listener) { visibilityListener = listener; return { dispose() {} }; },
    onDidDispose() { return { dispose() {} }; },
    visible,
    webview: {
      asWebviewUri: (uri) => uri,
      cspSource: "mock-webview",
      html: "",
      onDidReceiveMessage() { return { dispose() {} }; },
      options: {},
      async postMessage() { return true; }
    }
  };
}

/** Waits for timers and promise callbacks used by the visibility schedulers. */
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

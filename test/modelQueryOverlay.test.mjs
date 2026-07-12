// Source-level regression tests for the ORM Query workbench overlay integration.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const { overlayFrameRendererSource } = require("../out/workbenchOverlayFrameRenderer.js");
const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const extensionSource = fs.readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
const gridQuerySource = fs.readFileSync(new URL("../media/gridQuery.js", import.meta.url), "utf8");
const modelBrowserClientSource = fs.readFileSync(new URL("../media/modelBrowserSource.js", import.meta.url), "utf8");
const modelQuerySource = fs.readFileSync(new URL("../src/modelQueryConsole.ts", import.meta.url), "utf8");
const overlaySource = fs.readFileSync(new URL("../src/workbenchOverlay.ts", import.meta.url), "utf8");

test("parameterizes overlay frame targeting for the owning panel title", () => {
  const consoleFrame = overlayFrameRendererSource();
  const queryFrame = overlayFrameRendererSource("ORM Query");
  const shellGroup = { getBoundingClientRect: () => ({ bottom: 500, left: 0, right: 900, top: 0 }) };
  const queryGroup = { getBoundingClientRect: () => ({ bottom: 1000, left: 0, right: 900, top: 500 }) };
  const tabs = [
    { closest: () => shellGroup, getAttribute: (name) => name === "aria-label" ? "Django Shell" : "" },
    { closest: () => queryGroup, getAttribute: (name) => name === "aria-label" ? "ORM Query" : "" }
  ];
  const shellWebview = { getBoundingClientRect: () => ({ bottom: 500, left: 0, right: 900, top: 0 }) };
  const queryWebview = { getBoundingClientRect: () => ({ bottom: 1000, left: 0, right: 900, top: 500 }) };
  const document = { body: {}, documentElement: {}, querySelectorAll: (selector) => selector.startsWith(".tab") ? tabs : [shellWebview, queryWebview] };
  const window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }), innerHeight: 1000, innerWidth: 900 };
  const api = Function("document", "window", `${queryFrame}\nreturn { entries: __dsoConsoleGroupEntries, frame: __dsoConsoleFrame };`)(document, window);
  const entries = api.entries();

  assert.ok(consoleFrame.includes('const __dsoTargetPanelTitle = "Django Shell"'));
  assert.ok(queryFrame.includes('const __dsoTargetPanelTitle = "ORM Query"'));
  assert.ok(queryFrame.includes("label.indexOf(__dsoTargetPanelTitle)"));
  assert.equal(queryFrame.includes('label.indexOf("Django Shell")'), false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].element, queryGroup);
  assert.equal(api.frame(entries.map((entry) => entry.rect)), queryWebview);
});

test("uses query-specific files, submit behavior, context, and panel lifecycle", () => {
  const releaseBody = modelQuerySource.slice(modelQuerySource.indexOf("private releaseOverlay"), modelQuerySource.indexOf("private trackOverlayShutdown"));
  const runBody = modelQuerySource.slice(modelQuerySource.indexOf("private async runQuery"), modelQuerySource.indexOf("private async runCurrentQuery"));

  assert.ok(modelQuerySource.includes('analysisName: "query-analysis"'));
  assert.ok(modelQuerySource.includes('editorName: "query-cell"'));
  assert.ok(modelQuerySource.includes('executionMode: "submit"'));
  assert.ok(modelQuerySource.includes("registerWithContext: false"));
  assert.ok(modelQuerySource.includes('panelTitle: "ORM Query"'));
  assert.ok(modelQuerySource.includes('contextKey: "djangoShell.queryOverlayVisible"'));
  assert.ok(modelQuerySource.includes("onDidChangeViewState"));
  assert.ok(modelQuerySource.includes("currentVisibleText()"));
  assert.ok(modelQuerySource.includes("releaseOverlay()"));
  assert.ok(modelQuerySource.includes("modelQueryPrelude"));
  assert.ok(modelQuerySource.includes('private draftCode = ""'));
  assert.ok(modelQuerySource.includes("private lastQueryResult:"));
  assert.ok(modelQuerySource.includes('private inputAuthority: "fallback" | "overlay" = "fallback"'));
  assert.ok(modelQuerySource.includes('message.type === "queryDraftChanged"'));
  assert.ok(modelQuerySource.includes("const requestId = ++this.queryRequestId"));
  assert.ok(modelQuerySource.includes("panel !== this.panel || requestId !== this.queryRequestId"));
  assert.ok(modelQuerySource.includes("while (syncedDraft !== this.draftCode)"));
  assert.ok(runBody.indexOf("this.nextOffset = null") < runBody.indexOf("await this.source.modelQuery"));
  assert.equal((runBody.match(/setQueryResult/g) || []).length, 2);
  assert.equal(runBody.includes("await this.overlay?.setQueryResult"), false, "result decoration must not block the backend or grid critical path");
  assert.ok(overlaySource.includes("private queryResultQueue: Promise<void> = Promise.resolve()"));
  assert.ok(overlaySource.includes("this.queryResultQueue = this.queryResultQueue.then"), "renderer updates stay ordered off the critical path");
  assert.ok(modelQuerySource.includes("overlay.setQueryResult(this.lastQueryResult.result, this.lastQueryResult.source)"), "a newly shown overlay receives the last confirmed query result");
  assert.ok(releaseBody.includes("this.draftCode = text"));
  assert.equal(releaseBody.includes("this.lastCode = text"), false);
  assert.ok(extensionSource.includes("backend.supportsHiddenPrelude()"));
  assert.ok(extensionSource.includes("await backend.prelude()"));
  assert.equal(extensionSource.slice(extensionSource.indexOf("async modelQueryPrelude"), extensionSource.indexOf("setModelTransport")).includes("inspectActiveRuntime"), false);
});

test("query webview measures the overlay anchor and keeps a whole-document fallback", () => {
  assert.ok(gridQuerySource.includes('type: show ? "showQueryOverlay" : "queryEditorGeometry"'));
  assert.ok(gridQuerySource.includes('type: "runQuery", useOverlay: true'));
  assert.ok(gridQuerySource.includes('type: "queryDraftChanged"'));
  assert.ok(gridQuerySource.includes("new ResizeObserver"));
  assert.ok(modelBrowserClientSource.includes('message.type === "measureQueryEditor"'));
  assert.ok(modelBrowserClientSource.includes('message.type === "overlayRunPython"'));
  assert.ok(modelBrowserClientSource.includes('useOverlay: false'));
});

test("guards cross-panel overlay updates with owner tokens and a query keybinding", () => {
  const staleCleanup = overlaySource.indexOf('var stale = document.getElementById("django-shell-overlay")');
  const bridgeInstall = overlaySource.indexOf("window.__djangoShellOverlayBridge =");
  const binding = manifest.contributes.keybindings.find((item) => item.command === "djangoShell.runCurrentModelQuery");

  assert.ok(staleCleanup >= 0 && staleCleanup < bridgeInstall);
  assert.ok(overlaySource.includes("stale && stale.__dsoOwnerToken !=="));
  assert.equal(overlaySource.includes("stale && stale.__dsoOwnerToken &&"), false);
  assert.ok(overlaySource.includes("geometryExpression(geometry, this.token)"));
  assert.ok(overlaySource.includes("visibleTextReadExpression(this.token)"));
  assert.ok(manifest.activationEvents.includes("onCommand:djangoShell.runCurrentModelQuery"));
  assert.equal(binding?.key, "ctrl+enter");
  assert.equal(binding?.mac, "cmd+enter");
  assert.match(binding?.when ?? "", /djangoShell\.queryOverlayVisible/);
  assert.match(binding?.when ?? "", /query-cell\.py/);
});

// Unit tests for workbench overlay shutdown lifecycle source guards.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const { overlayPreludeText } = require("../out/overlayPrelude.js");
const customConsoleSource = fs.readFileSync(new URL("../src/customConsole.ts", import.meta.url), "utf8");
const customConsoleHtmlSource = fs.readFileSync(new URL("../src/customConsoleHtml.ts", import.meta.url), "utf8");
const debugBreakpointsSource = fs.readFileSync(new URL("../src/debugBreakpoints.ts", import.meta.url), "utf8");
const debugControlsSource = fs.readFileSync(new URL("../src/debugControls.ts", import.meta.url), "utf8");
const debugEventsSource = fs.readFileSync(new URL("../src/customConsoleDebugEvents.ts", import.meta.url), "utf8");
const debugInspectorSource = fs.readFileSync(new URL("../src/debugInspector.ts", import.meta.url), "utf8");
const generatedTabsSource = fs.readFileSync(new URL("../src/generatedOverlayTabs.ts", import.meta.url), "utf8");
const overlayMemorySource = fs.readFileSync(new URL("../src/overlayMemoryDocument.ts", import.meta.url), "utf8");
const overlaySource = fs.readFileSync(new URL("../src/workbenchOverlay.ts", import.meta.url), "utf8");
const frameRendererSource = fs.readFileSync(new URL("../src/workbenchOverlayFrameRenderer.ts", import.meta.url), "utf8");

test("console panel close releases the overlay instance instead of only hiding it", () => {
  const closePanelBody = customConsoleSource.slice(customConsoleSource.indexOf("private closePanel()"));
  assert.ok(customConsoleSource.includes("private releaseOverlay(): void"));
  assert.ok(closePanelBody.includes("this.releaseOverlay();"));
  assert.equal(closePanelBody.includes("this.overlay?.hide();"), false);
});

test("overlay shutdown waits for renderer disposal before closing the CDP socket", () => {
  const rendererDispose = overlaySource.indexOf("await this.disposeRendererOverlay(true");
  const socketClose = overlaySource.indexOf('this.closeSocket("dispose")');
  assert.ok(overlaySource.includes("async shutdown(): Promise<void>"));
  assert.ok(rendererDispose >= 0, "shutdown should request renderer cleanup");
  assert.ok(socketClose > rendererDispose, "socket should close after renderer cleanup is requested");
});

test("confirmed console overlays do not fall back to unrelated webview frames", () => {
  assert.ok(frameRendererSource.includes("root.__dsoHadConsoleFrame = true"));
  assert.ok(frameRendererSource.includes("!owned && root.__dsoHadConsoleFrame && !rects.length"));
});

test("overlay CDP evaluation stays bound to the owning VS Code window", () => {
  assert.ok(overlaySource.includes("private workbenchWindowId"));
  assert.ok(overlaySource.includes("BW.fromId(requestedId)"));
  assert.ok(overlaySource.includes("no-focused-workbench-window"));
  assert.ok(overlaySource.includes("root&&!root.__dsoOwnerToken"));
  assert.equal(overlaySource.includes("wins.includes(focused) ? focused : wins[0]"), false);
});

test("renderer overlay root carries an owner token before reuse or disposal", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const cleanupSource = fs.readFileSync(new URL("../src/workbenchOverlayCleanupRenderer.ts", import.meta.url), "utf8");

  assert.ok(overlaySource.includes("__djangoShellOverlayOwnerToken"));
  assert.ok(rendererSource.includes("root.__dsoOwnerToken = window.__djangoShellOverlayOwnerToken"));
  assert.ok(rendererSource.includes("owner-mismatch"));
  assert.ok(cleanupSource.includes("owner-mismatch"));
});

test("renderer relative ranges map directly to visible console-cell.py lines", () => {
  const offsetHelper = overlaySource.slice(overlaySource.indexOf("private relativeLineOffset"));

  assert.equal(offsetHelper.includes("this.memoryDocument.inputStartLine()"), false);
  assert.ok(offsetHelper.includes("Math.max(0, Math.floor(relativeLine) - 1)"));
  assert.ok(overlaySource.includes("this.relativeLineOffset(payload.start ?? 1)"));
  assert.ok(overlaySource.includes("this.relativeLineOffset(range?.start)"));
});

test("overlay bridge toggles generated console source breakpoints", () => {
  assert.ok(overlaySource.includes('payload?.type === "toggleBreakpoint"'));
  assert.ok(overlaySource.includes("new vscode.SourceBreakpoint"));
  assert.ok(overlaySource.includes("vscode.Position(sourceLine, sourceColumn)"));
});

test("overlay reinjects when the renderer bridge port is stale", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");

  assert.ok(overlaySource.includes("private async rendererPatchState()"));
  assert.ok(overlaySource.includes("state.bridgePort !== String(bridge.port)"));
  assert.ok(rendererSource.includes("__djangoShellOverlayBridgeFailedPort"));
});

test("overlay renderer exposes a paused debug line marker", () => {
  const syncSource = fs.readFileSync(new URL("../src/workbenchOverlaySyncRenderer.ts", import.meta.url), "utf8");

  assert.ok(overlaySource.includes("updateDebugFrame"));
  assert.ok(overlaySource.includes("debugLineExpression"));
  assert.ok(syncSource.includes("__dsoSetOverlayDebugLine"));
  assert.ok(syncSource.includes("dso-debug-line"));
});

test("overlay prompt gutter stays compact after breakpoint controls install", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const breakpointSource = fs.readFileSync(new URL("../src/workbenchOverlayBreakpointRenderer.ts", import.meta.url), "utf8");

  assert.ok(rendererSource.includes("lineDecorationsWidth: 0"));
  assert.ok(breakpointSource.includes("lineDecorationsWidth: 0"));
  assert.ok(rendererSource.includes("lineNumbersMinChars: 1"));
  assert.ok(breakpointSource.includes("lineNumbersMinChars: 1"));
  assert.ok(rendererSource.includes(".margin-view-overlays .line-numbers{min-width:0!important;overflow:visible!important;padding-right:1ch!important}"));
  assert.ok(rendererSource.includes('let style = document.getElementById("django-shell-overlay-style")'));
  assert.equal(rendererSource.includes('if (document.getElementById("django-shell-overlay-style")) { return; }'), false);
  assert.equal(rendererSource.includes("lineDecorationsWidth: 14"), false);
  assert.equal(breakpointSource.includes("lineDecorationsWidth: 16"), false);
  assert.equal(breakpointSource.includes("dso-breakpoint-rail"), false);
  assert.equal(breakpointSource.includes("dso-inline-breakpoint-rail"), false);
  assert.equal(breakpointSource.includes("linesDecorationsClassName"), false);
});

test("debugger controls live in the Python cell toolbar", () => {
  const header = customConsoleHtmlSource.slice(customConsoleHtmlSource.indexOf("<header"), customConsoleHtmlSource.indexOf("<main"));
  const pythonToolbar = customConsoleHtmlSource.slice(customConsoleHtmlSource.indexOf('id="pythonTabs"'), customConsoleHtmlSource.indexOf('id="editorAnchor"'));

  assert.equal(header.includes("data-debug-control"), false);
  assert.equal(header.includes('data-action="debug-shell"'), false);
  assert.ok(pythonToolbar.includes('data-action="debug-shell"'));
  assert.ok(pythonToolbar.includes('data-debug-control="stepOver"'));
  assert.ok(pythonToolbar.includes('data-debug-control="stop"'));
});

test("debug start clicks always reach the extension host for diagnostics", () => {
  const customConsoleClientSource = fs.readFileSync(new URL("../media/customConsoleSource.js", import.meta.url), "utf8");
  const debugStart = customConsoleClientSource.slice(customConsoleClientSource.indexOf("function requestDebugShell"), customConsoleClientSource.indexOf("function requestDebugControl"));

  assert.equal(debugStart.includes("if (!runtimeReady || debugBusy)"), false);
  assert.ok(debugStart.includes('type: "debugShell"'));
  assert.ok(debugStart.includes("runtimeReady"));
  assert.equal(customConsoleClientSource.includes("button.disabled = !runtimeReady || debugBusy"), false);
  assert.ok(customConsoleClientSource.includes("button.disabled = false"));
  assert.ok(customConsoleSource.includes("debug.webview.request"));
  assert.ok(customConsoleSource.includes("debug.shell.request"));
  assert.ok(customConsoleSource.includes("debug.shell.alreadyAttached"));
  assert.ok(customConsoleSource.includes("debug.shell.noBackend"));
});

test("debug inspection prefers the generated overlay frame from stopped stacks", () => {
  assert.ok(debugInspectorSource.includes("OVERLAY_SOURCE_SUFFIX"));
  assert.ok(debugInspectorSource.includes("preferredStackFrame"));
  assert.ok(debugInspectorSource.includes("frames.find(isOverlayStackFrame)"));
  assert.ok(debugInspectorSource.includes("options.preferOverlay === false"));
  assert.ok(debugInspectorSource.includes("normalizeSourcePath"));
});

test("debug step-over refocus stays conditional so step-into can open source", () => {
  assert.ok(customConsoleSource.includes("debugControlOriginOverlay"));
  assert.ok(customConsoleSource.includes("this.debugControlOriginOverlay && this.lastDebugFrameOverlay"));
  assert.ok(customConsoleSource.includes("debug.overlay.refocus"));
  assert.ok(debugEventsSource.includes('preferOverlay: hooks.lastControlAction() !== "stepInto"'));
});

test("debug controls reuse the stopped thread instead of the first debugpy thread", () => {
  assert.ok(customConsoleSource.includes("setPausedThread: (threadId) => { this.debugThreadId = threadId; }"));
  assert.ok(customConsoleSource.includes("runDebugControl(action, this.debugSession, this.debugThreadId)"));
  assert.ok(debugControlsSource.includes("preferredThreadId ?? await firstThreadId(session)"));
  assert.ok(debugEventsSource.includes("hooks.setPausedThread(body?.threadId)"));
});

test("paused debug refocus does not close the executable console source tab", () => {
  assert.ok(customConsoleSource.includes("closeWorkspaceGeneratedOverlayTabs(false)"));
  assert.ok(generatedTabsSource.includes("includeExecutable = true"));
  assert.ok(generatedTabsSource.includes("if (includeExecutable)"));
  assert.ok(debugEventsSource.includes("debug.session.terminate"));
});

test("analysis-only overlay sync keeps the executable console-cell file dirty", () => {
  assert.ok(overlayMemorySource.includes("private editorDirty"));
  assert.ok(overlayMemorySource.includes("this.editorDirty = true"));
  assert.ok(overlayMemorySource.includes("changed || this.editorDirty"));
  assert.ok(overlayMemorySource.includes("this.editorDirty = false"));
});

test("generated overlay breakpoints are sent directly to the debug adapter", () => {
  assert.ok(customConsoleSource.includes('syncActiveDebugBreakpoints("execute"'));
  assert.ok(customConsoleSource.includes("normalizeOverlayBreakpointLine"));
  assert.ok(debugBreakpointsSource.includes('customRequest("setBreakpoints"'));
  assert.ok(debugBreakpointsSource.includes("requestedBreakpoints.length - breakpoints.length"));
  assert.ok(debugBreakpointsSource.includes("sourceModified: true"));
  assert.ok(debugBreakpointsSource.includes("debug.breakpoints.response"));
});

test("debug attach runs the current overlay input after breakpoint sync", () => {
  assert.ok(customConsoleSource.includes("runCurrentInput: () => this.runCurrentOverlayInput()"));
  assert.ok(debugEventsSource.includes("startDebuggedInput"));
  assert.ok(debugEventsSource.includes('hooks.syncBreakpoints("sessionStart")'));
  assert.ok(debugEventsSource.includes("hooks.runCurrentInput()"));
});

test("shared overlay prelude offset includes generated headers and the input marker", () => {
  const prelude = overlayPreludeText(["from a import A", "from a import A", "import b"]);

  assert.equal((prelude.match(/from a import A/g) ?? []).length, 1);
  assert.equal(customConsoleSource.includes("overlayInputLineOffset(this.overlayPrelude)"), false);
  assert.ok(overlaySource.includes("overlayPreludeText(importLines)"));
});

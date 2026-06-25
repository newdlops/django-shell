// Unit tests for workbench overlay shutdown lifecycle source guards.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const customConsoleSource = fs.readFileSync(new URL("../src/customConsole.ts", import.meta.url), "utf8");
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

test("renderer relative ranges are offset to backing console file lines", () => {
  const offsetHelper = overlaySource.slice(overlaySource.indexOf("private relativeLineOffset"));

  assert.ok(offsetHelper.includes("this.memoryDocument.inputStartLine()"));
  assert.ok(overlaySource.includes("this.relativeLineOffset(payload.start ?? 1)"));
  assert.ok(overlaySource.includes("this.relativeLineOffset(range?.start)"));
});

test("overlay bridge toggles generated console source breakpoints", () => {
  assert.ok(overlaySource.includes('payload?.type === "toggleBreakpoint"'));
  assert.ok(overlaySource.includes("new vscode.SourceBreakpoint"));
  assert.ok(overlaySource.includes("this.memoryDocument.inputStartLine()"));
});

test("overlay renderer exposes a paused debug line marker", () => {
  const syncSource = fs.readFileSync(new URL("../src/workbenchOverlaySyncRenderer.ts", import.meta.url), "utf8");

  assert.ok(overlaySource.includes("updateDebugFrame"));
  assert.ok(overlaySource.includes("debugLineExpression"));
  assert.ok(syncSource.includes("__dsoSetOverlayDebugLine"));
  assert.ok(syncSource.includes("dso-debug-line"));
});

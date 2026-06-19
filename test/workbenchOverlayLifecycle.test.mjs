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

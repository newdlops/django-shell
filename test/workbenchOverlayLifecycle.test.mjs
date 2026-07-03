// Unit tests for workbench overlay shutdown lifecycle source guards.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const { overlayPreludeText } = require("../out/overlayPrelude.js");
const backendClientSource = fs.readFileSync(new URL("../src/backendClient.ts", import.meta.url), "utf8");
const customConsoleSource = fs.readFileSync(new URL("../src/customConsole.ts", import.meta.url), "utf8");
const customConsoleHtmlSource = fs.readFileSync(new URL("../src/customConsoleHtml.ts", import.meta.url), "utf8");
const debugBreakpointsSource = fs.readFileSync(new URL("../src/debugBreakpoints.ts", import.meta.url), "utf8");
const debugControlsSource = fs.readFileSync(new URL("../src/debugControls.ts", import.meta.url), "utf8");
const directDebugAdapterSource = fs.readFileSync(new URL("../src/directDebugAdapterSession.ts", import.meta.url), "utf8");
const debugSourceFramesSource = fs.readFileSync(new URL("../src/debugSourceFrames.ts", import.meta.url), "utf8");
const debugStepTargetsSource = fs.readFileSync(new URL("../src/debugStepTargets.ts", import.meta.url), "utf8");
const debugStepTargetSelectionSource = fs.readFileSync(new URL("../src/debugStepTargetSelection.ts", import.meta.url), "utf8");
const debugSteppingRulesSource = fs.readFileSync(new URL("../src/debugSteppingRules.ts", import.meta.url), "utf8");
const debugEventsSource = fs.readFileSync(new URL("../src/customConsoleDebugEvents.ts", import.meta.url), "utf8");
const debugFileModeSource = fs.readFileSync(new URL("../src/debugFileMode.ts", import.meta.url), "utf8");
const debugFrameNavigationSource = fs.readFileSync(new URL("../src/debugFrameNavigation.ts", import.meta.url), "utf8");
const debugAnalysisPanelSource = fs.readFileSync(new URL("../src/debugAnalysisPanel.ts", import.meta.url), "utf8");
const debugAnalysisStoreSource = fs.readFileSync(new URL("../src/debugAnalysisStore.ts", import.meta.url), "utf8");
const debugShellSource = fs.readFileSync(new URL("../src/debugShell.ts", import.meta.url), "utf8");
const debugInspectorSource = fs.readFileSync(new URL("../src/debugInspector.ts", import.meta.url), "utf8");
const generatedTabsSource = fs.readFileSync(new URL("../src/generatedOverlayTabs.ts", import.meta.url), "utf8");
const notebookPtySessionSource = fs.readFileSync(new URL("../src/notebookPtySession.ts", import.meta.url), "utf8");
const overlayMemorySource = fs.readFileSync(new URL("../src/overlayMemoryDocument.ts", import.meta.url), "utf8");
const overlaySource = fs.readFileSync(new URL("../src/workbenchOverlay.ts", import.meta.url), "utf8");
const frameRendererSource = fs.readFileSync(new URL("../src/workbenchOverlayFrameRenderer.ts", import.meta.url), "utf8");
const customConsoleClientSource = fs.readFileSync(new URL("../media/customConsoleSource.js", import.meta.url), "utf8");

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

test("overlay geometry coalesces scroll updates while keeping a settle pass", () => {
  const updateGeometryBody = overlaySource.slice(overlaySource.indexOf("updateGeometry(geometry"), overlaySource.indexOf("private queueGeometryFlush"));
  const queueGeometryBody = overlaySource.slice(overlaySource.indexOf("private queueGeometryFlush"), overlaySource.indexOf("private flushGeometry"));
  const flushGeometryBody = overlaySource.slice(overlaySource.indexOf("private flushGeometry"), overlaySource.indexOf("async updatePrelude"));
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const cleanupSource = fs.readFileSync(new URL("../src/workbenchOverlayCleanupRenderer.ts", import.meta.url), "utf8");

  assert.ok(overlaySource.includes("const GEOMETRY_SETTLE_MS = 80"));
  assert.ok(updateGeometryBody.includes("this.queueGeometryFlush(0);"), "scroll geometry should not wait until scrolling stops");
  assert.ok(updateGeometryBody.includes("this.geometrySettleTimer = setTimeout"));
  assert.ok(queueGeometryBody.includes("this.geometryFlushInFlight || this.geometryTimer"));
  assert.ok(flushGeometryBody.includes("if (this.geometryFlushPending) { this.queueGeometryFlush(0); }"));
  assert.ok(rendererSource.includes("function __dsoInstallGeometrySync(root)"));
  assert.ok(rendererSource.includes('document.addEventListener("scroll", schedule, true)'));
  assert.ok(rendererSource.includes("__dsoApplyGeometry(root, window.__djangoShellOverlayGeometry)"));
  assert.ok(cleanupSource.includes("__dsoGeometrySyncCleanup"));
  assert.equal(overlaySource.includes("GEOMETRY_FRAME_MS"), false);
  assert.equal(updateGeometryBody.includes("this.flushGeometry();"), false);
  assert.equal(updateGeometryBody.includes("setTimeout(() => this.flushGeometry(), 80)"), false);
});

test("overlay geometry moves with transform to avoid relayouting editor lines", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");

  assert.ok(overlaySource.includes("const RENDERER_PATCH_VERSION = 84"));
  assert.ok(rendererSource.includes('root.style.left = "0px"; root.style.top = "0px"; root.style.transform = "translate3d("'));
  assert.ok(rendererSource.includes("will-change:transform"));
  assert.ok(rendererSource.includes("const left = Math.round(rect.left), top = Math.round(rect.top), width = Math.round(rect.width), height = Math.round(rect.height);"));
  assert.equal(rendererSource.includes('root.style.left = rect.left + "px"; root.style.top = rect.top + "px";'), false);
});

test("overlay Monaco layout clamps dimensions instead of trusting transient DOM size", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");

  assert.ok(rendererSource.includes("automaticLayout: false"));
  assert.ok(rendererSource.includes("function __dsoLayoutSize(root, host)"));
  assert.ok(rendererSource.includes("function __dsoMaxEditorHeight(viewportHeight)"));
  assert.ok(rendererSource.includes("availableHeight"));
  assert.ok(rendererSource.includes("boundaryLeft"));
  assert.ok(rendererSource.includes("boundaryRight"));
  assert.ok(rendererSource.includes("Math.min(rawWidth, boundaryRight - left, viewportWidth)"));
  assert.equal(rendererSource.includes("hostWidth - left"), false);
  assert.ok(rendererSource.includes("Math.min(viewportWidth, 8192)"));
  assert.ok(rendererSource.includes("editor.layout(__dsoLayoutSize(root, host))"));
  assert.ok(rendererSource.includes("__dsoLayoutOverlayEditor(root)"));
  assert.ok(rendererSource.includes("contain:layout style"));
  assert.ok(rendererSource.includes(".django-shell-overlay .overflowingContentWidgets{overflow:visible!important;z-index:35}"));
  assert.ok(rendererSource.includes(".django-shell-overlay .margin-view-overlays .line-numbers{color:var(--vscode-editorLineNumber-foreground"));
  assert.equal(rendererSource.includes("contain:strict"), false);
  assert.equal(rendererSource.includes("editor.layout({ width: Math.max(100, rect.width), height: Math.max(80, rect.height) })"), false);
  assert.equal(rendererSource.includes("automaticLayout: true"), false);
});

test("overlay hover widgets use a constructor-time body portal outside the webview host", () => {
  const widgetSource = fs.readFileSync(new URL("../src/workbenchOverlayWidgetRenderer.ts", import.meta.url), "utf8");
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");

  assert.ok(rendererSource.includes("overflow:visible;background:var(--vscode-editor-background)"));
  assert.ok(rendererSource.includes("z-index:2147483646"));
  assert.ok(rendererSource.includes("__dsoSyncWidgetTheme(root, true)"));
  assert.ok(rendererSource.includes("function __dsoOverflowWidgetsNode(root)"));
  assert.ok(rendererSource.includes("function __dsoNeedsWidgetPortalRebuild(root)"));
  assert.ok(rendererSource.includes("overflowWidgetsDomNode: overflowWidgetsNode"));
  assert.ok(rendererSource.includes("root.__dsoWidgetPortalVersion = \"body-constructor-v1\""));
  assert.ok(rendererSource.includes("fixedOverflowWidgets: false"));
  assert.ok(rendererSource.includes(".django-shell-overlay-editor{width:100%;height:100%;min-height:80px;box-sizing:border-box;overflow:visible;contain:layout style}"));
  assert.ok(rendererSource.includes(".django-shell-overlay .monaco-editor{overflow:visible!important}"));
  assert.ok(rendererSource.includes("window.__dsoSyncOverlayWidgetLayer && window.__dsoSyncOverlayWidgetLayer(root)"));
  assert.ok(widgetSource.includes('position:fixed;left:0;top:0;width:0;height:0'));
  assert.ok(widgetSource.includes('width:100vw;height:100vh'));
  assert.ok(widgetSource.includes("z-index:2147483647!important"));
  assert.ok(widgetSource.includes(".django-shell-overlay-widget-layer .overflowingContentWidgets{overflow:visible!important;z-index:2147483647!important}"));
  assert.ok(widgetSource.includes(".django-shell-overlay-widget-layer .monaco-hover,.django-shell-overlay-widget-layer .monaco-editor-hover{background:var(--vscode-editorHoverWidget-background"));
  assert.ok(widgetSource.includes("opacity:1!important;overflow:visible!important;z-index:2147483647!important"));
  assert.ok(widgetSource.includes(".django-shell-overlay-widget-layer .monaco-hover .monaco-sash,.django-shell-overlay-widget-layer .monaco-editor-hover .monaco-sash"));
  assert.ok(widgetSource.includes("function __dsoThemeSource()"));
  assert.ok(widgetSource.includes("function __dsoSyncThemeClasses(node, includeWorkbenchClass)"));
  assert.ok(widgetSource.includes('add("monaco-workbench")'));
  assert.ok(widgetSource.includes('name === "vs" || name.indexOf("vs-") === 0 || name.indexOf("hc-") === 0'));
  assert.ok(widgetSource.includes("window.__dsoSyncOverlayWidgetLayer = function (root)"));
  assert.ok(widgetSource.includes("root.getBoundingClientRect()"));
  assert.ok(widgetSource.includes("viewportWidth = Math.max(1, Math.round(window.innerWidth"));
  assert.ok(widgetSource.includes('layerRoot.style.left = "0px"; layerRoot.style.top = "0px"'));
  assert.ok(widgetSource.includes('layer.style.left = left + "px"; layer.style.top = top + "px"'));
  assert.ok(widgetSource.includes("function __dsoWidgetPortalHost()"));
  assert.ok(widgetSource.includes("return document.body"));
  assert.ok(widgetSource.includes("const portalHost = __dsoWidgetPortalHost()"));
  assert.ok(widgetSource.includes("window.__dsoPrepareOverlayWidgetNode = function (root)"));
  assert.ok(widgetSource.includes('document.getElementById("django-shell-overlay-widget-root")'));
  assert.ok(widgetSource.includes('host.querySelector(".django-shell-overlay-widget-root")'));
  assert.ok(widgetSource.includes('layerRoot.className = "monaco-workbench django-shell-overlay-widget-root"'));
  assert.ok(widgetSource.includes("__dsoSyncWidgetTheme(layerRoot, true)"));
  assert.ok(widgetSource.includes("portalHost.appendChild(layerRoot)"));
  assert.ok(widgetSource.includes("editor.updateOptions({ fixedOverflowWidgets: false })"));
  assert.ok(widgetSource.includes("return { bottom: window.innerHeight, left: 0, right: window.innerWidth, top: 0 }"));
  assert.ok(widgetSource.includes('const selectors = ".suggest-widget,.parameter-hints-widget,.context-view"'));
  assert.ok(widgetSource.includes('node.closest(".monaco-hover,.monaco-editor-hover")'));
  assert.ok(widgetSource.includes("data-dso-applied-transform"));
  assert.ok(widgetSource.includes("hasAppliedTransform ? Number"));
  assert.equal(widgetSource.includes("host.appendChild(layerRoot)"), false);
  assert.equal(widgetSource.includes("root.appendChild(layerRoot)"), false);
  assert.equal(widgetSource.includes('classList.remove("monaco-workbench")'), false);
  assert.equal(widgetSource.includes("document.body.appendChild(layerRoot)"), false);
  assert.equal(widgetSource.includes("overflowWidgetsDomNode: node"), false);
  assert.equal(widgetSource.includes("fixedOverflowWidgets: true"), false);
});

test("overlay model stays user-only instead of hiding generated prelude DOM", () => {
  const preludeViewSource = fs.readFileSync(new URL("../src/workbenchOverlayPreludeViewRenderer.ts", import.meta.url), "utf8");
  const syncSource = fs.readFileSync(new URL("../src/workbenchOverlaySyncRenderer.ts", import.meta.url), "utf8");

  assert.ok(preludeViewSource.includes("Applies shell prompt metadata without adding hidden prelude lines to the model"));
  assert.ok(preludeViewSource.includes("editor.setHiddenAreas([], \"django-shell-prelude\")"));
  assert.ok(syncSource.includes("model.setValue(userText)"));
  assert.ok(syncSource.includes("prelude.guard.strip"));
  assert.equal(syncSource.includes("overlayDiagnosticPrefixRendererSource"), false);
  assert.equal(syncSource.includes("__dsoDiagnosticPrefix"), false);
  assert.equal(preludeViewSource.includes("protectedLines.indexOf"), false);
  assert.equal(preludeViewSource.includes("leadingPrefix"), false);
  assert.equal(preludeViewSource.includes("topOf(line)"), false);
});

test("execution preview decorations stay out of the prompt gutter", () => {
  const syncSource = fs.readFileSync(new URL("../src/workbenchOverlaySyncRenderer.ts", import.meta.url), "utf8");
  const executionDecorationBody = syncSource.slice(syncSource.indexOf("function __dsoExecutionRangeDecorations"), syncSource.indexOf("/** Refreshes the visible preview"));

  assert.ok(executionDecorationBody.includes('options: { className: "dso-exec-range", isWholeLine: true }'));
  assert.ok(executionDecorationBody.includes("startColumn: 1"));
  assert.equal(executionDecorationBody.includes("linesDecorationsClassName"), false);
});

test("overlay input keeps the cursor visible while typing grows the model", () => {
  const syncSource = fs.readFileSync(new URL("../src/workbenchOverlaySyncRenderer.ts", import.meta.url), "utf8");
  const cleanupSource = fs.readFileSync(new URL("../src/workbenchOverlayCleanupRenderer.ts", import.meta.url), "utf8");

  assert.ok(syncSource.includes("function __dsoScheduleCursorReveal(root, editor)"));
  assert.ok(syncSource.includes("revealPositionInCenterIfOutsideViewport(position)"));
  assert.ok(syncSource.includes("__dsoScheduleCursorReveal(root, editor);"));
  assert.ok(cleanupSource.includes("__dsoCursorRevealTimer"));
});

test("confirmed console overlays do not fall back to unrelated webview frames", () => {
  assert.ok(frameRendererSource.includes("root.__dsoHadConsoleFrame = true"));
  assert.ok(frameRendererSource.includes("if (!rects.length) { root.__dsoFrame = null; return null; }"));
  assert.ok(frameRendererSource.includes("__dsoFrameIsConsole(root.__dsoFrame, rects)"));
  assert.ok(frameRendererSource.includes("function __dsoConsoleGroupEntries()"));
  assert.ok(frameRendererSource.includes("function __dsoConsoleGroupForFrame(frame, entries)"));
  assert.ok(frameRendererSource.includes("function __dsoWebviewLayerHost(frame)"));
  assert.ok(frameRendererSource.includes("function __dsoOverlayPortalHost(frame, entries)"));
  assert.ok(frameRendererSource.includes("return __dsoWebviewLayerHost(frame) || __dsoConsoleGroupForFrame(frame, entries) || document.body || document.documentElement"));
  assert.ok(frameRendererSource.includes("const host = __dsoOverlayPortalHost(frame, entries)"));
  assert.ok(frameRendererSource.includes("host !== document.body && host !== document.documentElement"));
  assert.equal(frameRendererSource.includes("function __dsoFindWebviewHost"), false);
  assert.equal(frameRendererSource.includes("otherwise the largest visible webview"), false);
  assert.equal(frameRendererSource.includes("bestArea > 4000 ? best : null"), false);
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

test("overlay breakpoints use native VS Code breakpoint handling instead of custom renderer controls", () => {
  const syncSource = fs.readFileSync(new URL("../src/workbenchOverlaySyncRenderer.ts", import.meta.url), "utf8");
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const preludeViewSource = fs.readFileSync(new URL("../src/workbenchOverlayPreludeViewRenderer.ts", import.meta.url), "utf8");

  assert.ok(rendererSource.includes("glyphMargin: true"));
  assert.ok(syncSource.includes("glyphMargin: true"));
  assert.ok(preludeViewSource.includes("glyphMargin: true"));
  assert.ok(customConsoleSource.includes("sourceBreakpointLocations"));
  assert.equal(syncSource.includes("overlayBreakpointRendererSource"), false);
  assert.equal(overlaySource.includes('payload?.type === "toggleBreakpoint"'), false);
  assert.equal(customConsoleClientSource.includes('message.type === "overlayToggleBreakpoint"'), false);
  assert.equal(customConsoleSource.includes('typed.type === "overlayToggleBreakpoint"'), false);
  assert.equal(overlaySource.includes("toggleBreakpointFromVisibleLine"), false);
  assert.equal(overlaySource.includes("lastBreakpointToggleKey"), false);
});

test("overlay reinjects when the renderer bridge port is stale", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");

  assert.ok(overlaySource.includes("private async rendererPatchState()"));
  assert.ok(overlaySource.includes("state.bridgePort !== String(bridge.port)"));
  assert.ok(rendererSource.includes("__djangoShellOverlayBridgeFailedPort"));
});

test("overlay renderer exposes a paused debug line marker", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const syncSource = fs.readFileSync(new URL("../src/workbenchOverlaySyncRenderer.ts", import.meta.url), "utf8");

  assert.ok(overlaySource.includes("updateDebugInfo"));
  assert.ok(overlaySource.includes("debugLineExpression"));
  assert.ok(syncSource.includes("__dsoSetOverlayDebugLine"));
  assert.ok(syncSource.includes("dso-debug-line"));
  assert.ok(syncSource.includes('glyphMarginClassName: "dso-debug-indicator"'));
  assert.ok(rendererSource.includes(".dso-debug-indicator"));
  assert.equal(syncSource.includes('linesDecorationsClassName: "dso-debug-rail"'), false);
  assert.equal(rendererSource.includes("overlayDebugRendererSource"), false);
  assert.equal(rendererSource.includes("__dsoBuildOverlayDebugPanel"), false);
  assert.equal(overlaySource.includes('type === "debugVariables"'), false);
});

test("overlay prompt gutter keeps the native breakpoint glyph margin", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const syncSource = fs.readFileSync(new URL("../src/workbenchOverlaySyncRenderer.ts", import.meta.url), "utf8");

  assert.ok(rendererSource.includes("glyphMargin: true"));
  assert.ok(syncSource.includes("glyphMargin: true"));
  assert.ok(rendererSource.includes("lineDecorationsWidth: 0"));
  assert.ok(rendererSource.includes("lineNumbersMinChars: 1"));
  assert.ok(rendererSource.includes(".margin-view-overlays .line-numbers{color:var(--vscode-editorLineNumber-foreground"));
  assert.ok(rendererSource.includes('let style = document.getElementById("django-shell-overlay-style")'));
  assert.equal(rendererSource.includes('if (document.getElementById("django-shell-overlay-style")) { return; }'), false);
  assert.equal(rendererSource.includes("lineDecorationsWidth: 14"), false);
  assert.equal(rendererSource.includes("dso-breakpoint"), false);
  assert.equal(syncSource.includes("dso-breakpoint"), false);
});

test("overlay renderer caches expensive widget layout work", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");

  assert.ok(rendererSource.includes("window.__dsoWidgetCache"));
  assert.ok(rendererSource.includes("if (__dsoIsWidget(cached))"));
  assert.ok(rendererSource.includes("cache && start && cache.set(start, widget)"));
  assert.ok(rendererSource.includes("root.__dsoLastEditorLayoutKey === layoutKey"));
  assert.equal(rendererSource.includes("__dsoBreakpointLayer"), false);
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

test("debugger display mode can switch between file and overlay debugging", () => {
  const customConsoleClientSource = fs.readFileSync(new URL("../media/customConsoleSource.js", import.meta.url), "utf8");

  assert.ok(customConsoleHtmlSource.includes('id="debugMode"'));
  assert.ok(customConsoleHtmlSource.includes('value="file">Debug: File'));
  assert.ok(customConsoleHtmlSource.includes('value="overlay">Debug: Overlay'));
  assert.ok(customConsoleClientSource.includes('type: "setDebugMode"'));
  assert.ok(customConsoleSource.includes('debugMode: DjangoShellDebugMode = DEFAULT_DEBUG_MODE'));
  assert.ok(customConsoleSource.includes('this.debugMode === "file"'));
  assert.ok(customConsoleSource.includes("prepareFileDebugInput"));
  assert.ok(customConsoleSource.includes("set breakpoints"));
  assert.ok(customConsoleSource.includes("runCurrentDebugInput"));
  assert.ok(debugFileModeSource.includes("debug-cell.py"));
  assert.ok(debugFileModeSource.includes("mirrorOverlayBreakpointsToDebugFile"));
  assert.ok(debugFileModeSource.includes("existingKeys"));
  assert.equal(debugFileModeSource.includes("removeBreakpoints(existing)"), false);
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
  assert.ok(customConsoleSource.includes("debugAttachPromise"));
  assert.ok(customConsoleSource.includes("debug.shell.inFlight"));
  assert.ok(customConsoleSource.includes("startDebugpyWithTimeout"));
  assert.ok(customConsoleSource.includes("DEBUG_ATTACH_TIMEOUT_MS"));
  assert.ok(customConsoleSource.includes("debugpyEndpoint = undefined"));
});

test("debug attach keeps model-browser transport independent from debugpy", () => {
  assert.ok(customConsoleSource.includes("readDjangoShellDebugOptions"));
  assert.ok(customConsoleSource.includes("debugOptions.listenPort"));
  assert.ok(customConsoleSource.includes("effectiveDebugpyListenHost"));
  assert.ok(customConsoleSource.includes("forwardDebugpy(endpoint.endpoint.port)"));
  assert.ok(customConsoleSource.includes("clearDebugpyPortForward()"));
  assert.equal(customConsoleSource.includes('backend.setTransportMode("tcp")'), false);
  assert.equal(customConsoleSource.includes('this.selectedTransport = "tcp"'), false);
});

test("debug inspection prefers user source frames after step-in over selected library frames", () => {
  assert.ok(debugSourceFramesSource.includes("OVERLAY_SOURCE_SUFFIX"));
  assert.ok(debugInspectorSource.includes("preferredStackFrame"));
  assert.ok(debugInspectorSource.includes("const selected = frames.find((frame) => frame.id === item.frameId)"));
  assert.ok(debugInspectorSource.includes("isUserDebugSourceFrame(selected)"));
  assert.ok(debugInspectorSource.includes("choosePreferredDebugSourceFrame"));
  assert.ok(debugInspectorSource.includes("workspaceRootPaths()"));
  assert.ok(debugSourceFramesSource.includes("preferUserSource"));
  assert.ok(debugSourceFramesSource.includes("isWorkspaceDebugSourceFrame"));
  assert.ok(debugSourceFramesSource.includes("isUserDebugSourceFrame"));
  assert.ok(debugSourceFramesSource.includes("site-packages|dist-packages"));
  assert.equal(debugInspectorSource.includes("if (item.frameId && options.preferOverlay !== false)"), false);
  assert.ok(debugSourceFramesSource.includes("normalizeDebugSourcePath"));
});

test("overlay debug uses a direct DAP session so the shell overlay stays focused", () => {
  assert.ok(customConsoleSource.includes("overlayDebugSession"));
  assert.ok(customConsoleSource.includes("new DirectDebugAdapterSession"));
  assert.ok(customConsoleSource.includes("debug.direct."));
  assert.ok(customConsoleSource.includes("vscode.debug.startDebugging"));
  assert.ok(customConsoleSource.includes("runCurrentInput: () => this.runCurrentDebugInput()"));
  assert.ok(customConsoleSource.includes("await this.showOverlay(); try { await direct.attach"));
  assert.ok(customConsoleSource.includes('direct), configuration)'));
  assert.ok(customConsoleSource.includes('if (this.debugMode === "overlay") { const direct = new DirectDebugAdapterSession'));
  assert.ok(customConsoleSource.includes('await this.runCurrentDebugInput(); return;'));
  assert.ok(customConsoleSource.includes("this.debugpyEndpoint = undefined"));
  assert.equal(debugShellSource.includes("_djs_debug_socket.create_connection"), false);
  assert.ok(debugShellSource.includes("_djs_debug_reused = True"));
  assert.ok(directDebugAdapterSource.includes(`customRequest("disconnect"`));
  assert.ok(directDebugAdapterSource.includes("terminateDebuggee: false"));
  assert.ok(directDebugAdapterSource.includes("justMyCode: options.justMyCode ?? false"));
  assert.ok(directDebugAdapterSource.includes("buildDebugpySteppingRules()"));
  assert.ok(directDebugAdapterSource.includes("showReturnValue: true"));
  assert.ok(debugShellSource.includes("rules: buildDebugpySteppingRules()"));
  assert.ok(debugShellSource.includes("showReturnValue: true"));
  assert.ok(debugSteppingRulesSource.includes('path: "**/site-packages/**"'));
  assert.ok(debugSteppingRulesSource.includes('path: "**/dist-packages/**"'));
  assert.ok(debugSteppingRulesSource.includes('path: "**/lib/python*/**"'));
  assert.ok(debugSteppingRulesSource.includes('path: "**/manage.py"'));
  assert.ok(directDebugAdapterSource.includes("args.cwd = options.cwd"));
  assert.ok(directDebugAdapterSource.includes("args.pathMappings = options.pathMappings"));
  assert.ok(debugSteppingRulesSource.includes('path: "**/django_shell_backend.py"'));
  assert.ok(customConsoleSource.includes('this.debugMode === "overlay" && this.debugControlOriginOverlay'));
  assert.ok(customConsoleSource.includes('this.debugMode === "overlay" || this.lastDebugFrameOverlay'));
  assert.ok(customConsoleSource.includes('wasVisible || (this.debugMode === "overlay" && (this.debugSession || this.overlayDebugSession))'));
  assert.ok(customConsoleSource.includes('if (!(this.debugMode === "overlay" && (this.debugSession || this.overlayDebugSession))) { this.overlay?.hide(); }'));
  assert.equal(customConsoleSource.includes("debug.overlay.refocus"), false);
  assert.equal(customConsoleSource.includes("refocusDebugOverlay"), false);
  assert.ok(customConsoleSource.includes("shouldRefocusOverlay"));
  assert.ok(debugEventsSource.includes("hooks.shouldRefocusOverlay()"));
  assert.equal(debugEventsSource.includes("hooks.refocusOverlay()"), false);
  assert.ok(debugEventsSource.includes('const stepInto = hooks.lastControlAction() === "stepInto"'));
  assert.ok(debugEventsSource.includes("preferUserSource: stepInto"));
});

test("debug controls reuse the stopped thread instead of the first debugpy thread", () => {
  assert.ok(customConsoleSource.includes("setPausedThread: (threadId) => { this.debugThreadId = threadId; }"));
  assert.ok(customConsoleSource.includes("let activeSession = this.overlayDebugSession ?? this.debugSession"));
  assert.ok(customConsoleSource.includes("runDebugControl(action, activeSession, this.debugThreadId"));
  assert.ok(debugControlsSource.includes("preferredThreadId ?? await firstThreadId(session)"));
  assert.ok(debugControlsSource.includes("buildStepInArguments(session, threadId, logger)"));
  assert.ok(debugControlsSource.includes("targetId"));
  assert.ok(debugStepTargetsSource.includes('customRequest("stepInTargets"'));
  assert.ok(debugStepTargetsSource.includes('vscode.executeDefinitionProvider'));
  assert.ok(debugStepTargetsSource.includes("fallbackDirectCallNames"));
  assert.ok(debugStepTargetsSource.includes("pythonImportedOrDefinedNames"));
  assert.ok(debugStepTargetsSource.includes("callCandidates"));
  assert.ok(debugStepTargetsSource.includes("overlayAnalysisUri()"));
  assert.ok(debugStepTargetsSource.includes("analysis.lineCount - editor.lineCount"));
  assert.ok(debugStepTargetsSource.includes("debug.stepTargets"));
  assert.ok(debugStepTargetsSource.includes("chooseStepInTarget"));
  assert.ok(debugStepTargetSelectionSource.includes("pythonDirectCallIdentifierSpans"));
  assert.ok(debugStepTargetSelectionSource.includes("pythonImportedOrDefinedNames"));
  assert.ok(debugStepTargetSelectionSource.includes("targetLabelMatchesNames"));
  assert.ok(debugStepTargetSelectionSource.includes("targetRangeName"));
  assert.ok(debugControlsSource.includes('"disconnect" in session'));
  assert.ok(debugEventsSource.includes("hooks.setPausedThread(pausedThreadId)"));
});

test("overlay debug ignores debugpy events from non-overlay paused threads", () => {
  assert.ok(debugEventsSource.includes("let pausedThreadId"));
  assert.ok(debugEventsSource.includes("shouldIgnoreOverlayThreadEvent"));
  assert.ok(debugEventsSource.includes("debug.dap.continued.ignore"));
  assert.ok(debugEventsSource.includes("debug.dap.stopped.ignore"));
  assert.ok(debugEventsSource.includes("debug.active.frame.ignore"));
  assert.ok(debugEventsSource.includes("hooks.setPausedThread(undefined)"));
  assert.ok(debugEventsSource.includes("preferUserSource: stepInto"));
  assert.ok(debugInspectorSource.includes("choosePreferredDebugSourceFrame"));
});

test("overlay step-in can reveal external source frames", () => {
  assert.ok(customConsoleSource.includes('const stepInto = this.lastDebugControlAction === "stepInto"'));
  assert.ok(customConsoleSource.includes("preferUserSource: stepInto"));
  assert.ok(customConsoleSource.includes("clearExternalDebugFrameDecoration"));
  assert.ok(customConsoleSource.includes('"djangoShell.externalDebugFrame", true'));
  assert.ok(customConsoleSource.includes('"djangoShell.externalDebugFrame", false'));
  assert.ok(customConsoleSource.includes('!this.panel?.visible && !(this.debugMode === "overlay"'));
  assert.ok(customConsoleSource.includes("this.lastDebugFrameOverlay) { this.panel?.reveal(vscode.ViewColumn.One); void this.showOverlay(); }"));
  assert.ok(customConsoleSource.includes("this.overlay?.park();"));
  assert.ok(customConsoleSource.includes('revealed && this.debugMode === "overlay" && !this.lastDebugFrameOverlay'));
  assert.ok(overlaySource.includes("park(): void"));
  assert.ok(overlaySource.includes("parkExpression(this.token)"));
  assert.ok(overlaySource.includes("overlay.park.renderer"));
  assert.equal(customConsoleSource.includes("if (revealed) { this.overlay?.hide(); }"), false);
  assert.equal(customConsoleSource.includes("switchExternalFrameToNativeDebug"), false);
  assert.equal(customConsoleSource.includes("debug.native.switch"), false);
  assert.ok(customConsoleSource.includes("revealExternalDebugFrame(info, this.logger)"));
  assert.ok(customConsoleSource.includes("isOverlayDebugFramePath(path)"));
  assert.ok(debugFrameNavigationSource.includes("vscode.window.showTextDocument"));
  assert.ok(debugFrameNavigationSource.includes("decorateExternalDebugFrame(editor, position)"));
  assert.equal(debugFrameNavigationSource.includes("contentText"), false);
  assert.equal(debugFrameNavigationSource.includes("before:"), false);
  assert.ok(debugFrameNavigationSource.includes("overviewRulerLane"));
  assert.ok(debugFrameNavigationSource.includes("console-cell.py"));
});

test("overlay debug analysis renders in the Django Shell Activity Bar panel", () => {
  assert.equal(customConsoleHtmlSource.includes('id="debugInfo"'), false);
  assert.equal(customConsoleHtmlSource.includes(".debugPanel"), false);
  assert.equal(customConsoleClientSource.includes('type: "debugVariables"'), false);
  assert.ok(debugAnalysisPanelSource.includes('const VIEW_ID = "djangoShell.debugAnalysis"'));
  assert.ok(debugAnalysisPanelSource.includes("implements vscode.TreeDataProvider<DebugAnalysisNode>"));
  assert.ok(debugAnalysisPanelSource.includes("inspectDebugVariableChildren(reference)"));
  assert.ok(debugAnalysisPanelSource.includes("scope.variables.map(variableNode)"));
  assert.ok(debugAnalysisPanelSource.includes('label: "Trace"'));
  assert.ok(debugAnalysisPanelSource.includes("traceTreeItem"));
  assert.ok(debugAnalysisStoreSource.includes("setDebugAnalysisInfo(info: DebugFrameInfo)"));
  assert.ok(debugAnalysisStoreSource.includes("setDebugAnalysisVariableResolver"));
  assert.ok(debugAnalysisStoreSource.includes("trace: DebugTraceEntry[]"));
  assert.ok(debugAnalysisStoreSource.includes("debugTraceEntry(info)"));
  assert.ok(debugInspectorSource.includes(`customRequest("variables"`));
  assert.ok(debugInspectorSource.includes(`customRequest("scopes"`));
  assert.ok(debugInspectorSource.includes("debugScopeCandidates"));
  assert.ok(debugInspectorSource.includes("GLOBAL_SCOPE.test(scope.name)"));
  assert.ok(debugInspectorSource.includes("LOCAL_SCOPE.test(scope.name)"));
  assert.ok(debugInspectorSource.includes("variablesWithLocalCandidates"));
  assert.ok(debugInspectorSource.includes("evaluateLocalCandidate"));
  assert.ok(debugInspectorSource.includes("collectForTargetNames"));
  assert.ok(debugInspectorSource.includes("collectAssignmentTargetNames"));
  assert.ok(debugInspectorSource.includes('DISPLAY_DEBUG_VARIABLE_NAMES = new Map([["__m", "receiver"]])'));
  assert.ok(debugInspectorSource.includes('VISIBLE_DEBUG_INTERNAL_VARIABLES = new Set(["__m"])'));
  assert.ok(debugInspectorSource.includes("isHiddenDebugVariable"));
  assert.ok(debugInspectorSource.includes("displayVariableValue(variable.value, variable.variablesReference)"));
  assert.ok(debugInspectorSource.includes("`${text}<${ref}>`"));
  assert.ok(customConsoleSource.includes("inspectDebugVariables(session"));
  assert.ok(customConsoleSource.includes("setDebugAnalysisInfo(info)"));
  assert.ok(customConsoleSource.includes("setDebugAnalysisVariableResolver"));
  assert.ok(debugInspectorSource.includes("export interface DebugStackFrameInfo"));
  assert.ok(debugInspectorSource.includes("frames: frames.slice(0, 8).map(stackFrameInfo)"));
});

test("debug variable analysis previews bounded QuerySet result lists", () => {
  assert.ok(debugInspectorSource.includes("variablesWithQuerySetPreviews"));
  assert.ok(debugInspectorSource.includes('customRequest("evaluate"'));
  assert.ok(debugInspectorSource.includes("__import__('builtins').list"));
  assert.ok(debugInspectorSource.includes("_djs_backend_module._debug_model_value_map"));
  assert.ok(debugInspectorSource.includes("evaluateDjangoModelPreview"));
  assert.ok(debugInspectorSource.includes("model values"));
  assert.ok(debugInspectorSource.includes("[:10]"));
  assert.ok(debugInspectorSource.includes("querysetPreview: true"));
  // Chain intermediates surfaced as pydevd "(return) name" step results get list previews next to the variable itself.
  assert.ok(debugInspectorSource.includes("debugVariableExpression"));
  assert.ok(debugInspectorSource.includes("returnValueEvaluateExpression"));
  assert.ok(debugInspectorSource.includes("__pydevd_ret_val_dict["));
  assert.ok(debugInspectorSource.includes("/^\\(return\\)\\s+(.+)$/"));
  // Step results render as chain-friendly labels instead of raw pydevd "(return) ..." names.
  assert.ok(debugInspectorSource.includes("displayVariableName"));
  assert.ok(debugInspectorSource.includes("`${method}() receiver`"));
  assert.ok(debugInspectorSource.includes("`${method}() result`"));
});

test("PTY fallback preserves debug metadata instead of typing overlay debug cells literally", () => {
  assert.ok(backendClientSource.includes("hasDebugExecutionPayload(payload) ? payload"));
  assert.ok(backendClientSource.includes('payload.kind === "execute" && Array.isArray(payload.breakpointLines)'));
  assert.ok(notebookPtySessionSource.includes("!wantsPtyDebugWrapper(payload)"));
  assert.ok(notebookPtySessionSource.includes("function wantsPtyDebugWrapper"));
});

test("debug stop interrupts the active backend execution instead of only detaching", () => {
  assert.ok(customConsoleSource.includes("backend?.interrupt(\"debugControl.stop\")"));
  assert.ok(customConsoleSource.includes("backend?.interrupt(\"debugWebview.stop\")"));
  assert.ok(customConsoleSource.includes("interruptExecution: (reason) => this.session?.backend?.interrupt(reason)"));
  assert.ok(debugControlsSource.includes("await interruptExecution?.();"));
  assert.ok(debugEventsSource.includes("onWillReceiveMessage(message)"));
  assert.ok(debugEventsSource.includes("debugAdapter.${request.command}"));
  assert.ok(debugEventsSource.includes("debugSessionTerminate"));
});

test("paused overlay debug keeps the executable console source tab out of cleanup", () => {
  assert.ok(customConsoleSource.includes('closeWorkspaceGeneratedOverlayTabs(this.debugMode !== "overlay")'));
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
  assert.ok(debugFileModeSource.includes("normalizeOverlayBreakpointLine"));
  assert.ok(debugBreakpointsSource.includes('customRequest("setBreakpoints"'));
  assert.ok(debugBreakpointsSource.includes("requestedBreakpoints.length - breakpoints.length"));
  assert.ok(debugBreakpointsSource.includes("sourceModified: true"));
  assert.ok(debugBreakpointsSource.includes("debug.breakpoints.response"));
  assert.ok(customConsoleSource.includes("debugBreakpoints(activeLines)"));
  assert.ok(backendClientSource.includes('kind: "debugBreakpoints"'));
});

test("direct overlay debug syncs workspace Python breakpoints for continue", () => {
  assert.ok(customConsoleSource.includes("debugBreakpointSyncUris"));
  assert.ok(customConsoleSource.includes("syncedDebugBreakpointUris"));
  assert.ok(customConsoleSource.includes("isPythonDebugSourceUri"));
  assert.ok(customConsoleSource.includes("vscode.debug.breakpoints"));
  assert.ok(customConsoleSource.includes("sourceBreakpointLocations(uri, lineOffset)"));
  assert.ok(customConsoleSource.includes('fsPath.endsWith(".py")'));
});

test("failed debug execution exits debugging and returns focus to output", () => {
  assert.ok(customConsoleSource.includes("stopDebugAfterFailedExecution"));
  assert.ok(customConsoleSource.includes("await direct.disconnect()"));
  assert.ok(customConsoleSource.includes("await vscode.debug.stopDebugging(session)"));
  assert.ok(customConsoleSource.includes("this.lastDebugControlAction = undefined"));
  assert.ok(customConsoleSource.includes("this.debugControlOriginOverlay = false"));
  assert.ok(customConsoleSource.includes("this.lastDebugFrameOverlay = false"));
  assert.ok(customConsoleSource.includes('this.postDebugStatus("idle")'));
  assert.ok(customConsoleSource.includes("clearExternalDebugFrameDecoration();"));
  assert.ok(customConsoleSource.includes("this.panel?.reveal(vscode.ViewColumn.One)"));
  assert.ok(customConsoleSource.includes('"djangoShell.externalDebugFrame", false'));
});

test("debug attach runs the current overlay input after breakpoint sync", () => {
  assert.ok(customConsoleSource.includes("runCurrentInput: () => this.runCurrentDebugInput()"));
  assert.ok(customConsoleSource.includes("return this.runCurrentOverlayInput()"));
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

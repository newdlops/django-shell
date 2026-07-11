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
const captureRendererSource = fs.readFileSync(new URL("../src/workbenchOverlayCaptureRenderer.ts", import.meta.url), "utf8");
const frameRendererSource = fs.readFileSync(new URL("../src/workbenchOverlayFrameRenderer.ts", import.meta.url), "utf8");
const workbenchWindowEvalSource = fs.readFileSync(new URL("../src/workbenchWindowEval.ts", import.meta.url), "utf8");
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

test("overlay hide parks Monaco while final shutdown disposes renderer resources", () => {
  const publicLifecycle = overlaySource.slice(overlaySource.indexOf("park(): void"), overlaySource.indexOf("async reset(): Promise<void>"));
  const shutdownBody = overlaySource.slice(overlaySource.indexOf("private async shutdownNow()"), overlaySource.indexOf("private async disposeRendererOverlay"));

  assert.ok(publicLifecycle.includes("hide(): void { void this.parkRendererOverlay(); }"));
  assert.equal(publicLifecycle.includes("disposeRendererOverlay"), false, "ordinary tab visibility changes must preserve Monaco");
  assert.ok(shutdownBody.includes('await this.disposeRendererOverlay(true, "overlay.dispose.error")'));
});

test("host park and disposal clean owner-matched body widget portals", () => {
  const cleanupSource = fs.readFileSync(new URL("../src/workbenchOverlayCleanupRenderer.ts", import.meta.url), "utf8");
  const disposeStart = overlaySource.indexOf("function disposeExpression");
  const parkStart = overlaySource.indexOf("function parkExpression", disposeStart);
  const disposeBody = overlaySource.slice(disposeStart, parkStart);
  const parkBody = overlaySource.slice(parkStart, overlaySource.indexOf("function resetExpression", parkStart));

  assert.ok(disposeBody.includes("__dsoRemoveOverlayWidgetPortal(null"), "missing roots still remove their owner-matched orphan portal");
  assert.ok(disposeBody.includes("__dsoStopOverlayCapture(owner)"), "missing roots still restore temporary capture hooks");
  assert.ok(parkBody.includes("__dsoRemoveOverlayWidgetPortal(null"), "missing roots cannot leave a floating portal behind");
  assert.match(parkBody, /root\.__dsoExplicitlyParked\s*=\s*true/);
  assert.match(parkBody, /root\.style\.setProperty\("display",\s*"none",\s*"important"\)/);
  assert.match(parkBody, /root\.style\.setProperty\("visibility",\s*"hidden",\s*"important"\)/);
  assert.match(parkBody, /__dsoSetOverlayWidgetVisibility\(root,\s*false,\s*true\)/);
  assert.ok(cleanupSource.includes("window.__dsoRemoveOverlayWidgetPortal(root"), "renderer cleanup uses the same owner-aware portal removal path");
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
  assert.ok(updateGeometryBody.includes("this.rendererTransactionPending()"), "geometry waits until show or injection completes");
  assert.ok(queueGeometryBody.includes("this.geometryFlushInFlight || this.geometryTimer || this.rendererTransactionPending()"));
  assert.ok(flushGeometryBody.includes("this.resumeHeldGeometry()"), "a completed request resumes only the latest held geometry");
  assert.equal(flushGeometryBody.includes("if (this.geometryFlushPending) { this.queueGeometryFlush(0); }"), false, "timeout completion must not recurse immediately");
  assert.ok(overlaySource.includes("const RENDERER_RECOVERY_DELAY_MS"));
  assert.ok(overlaySource.includes("this.lastEvaluationTimeoutAt + RENDERER_RECOVERY_DELAY_MS - Date.now()"));
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

  assert.ok(overlaySource.includes("const RENDERER_PATCH_VERSION = 98"));
  assert.ok(rendererSource.includes('root.style.left = "0px"; root.style.top = "0px"; root.style.transform = "translate3d("'));
  assert.ok(rendererSource.includes("will-change:transform"));
  assert.ok(rendererSource.includes("const left = Math.round(rect.left), top = Math.round(rect.top), width = Math.round(rect.width), height = Math.round(rect.height);"));
  assert.equal(rendererSource.includes('root.style.left = rect.left + "px"; root.style.top = rect.top + "px";'), false);
});

test("overlay Monaco layout clamps dimensions instead of trusting transient DOM size", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");

  assert.ok(rendererSource.includes("automaticLayout: false"));
  assert.ok(rendererSource.includes("quickSuggestionsDelay: 80"), "typing bursts wait briefly before starting heavyweight completion providers");
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
  assert.equal(widgetSource.includes("opacity:1!important"), false, "stale hover nodes keep Monaco's native hidden opacity");
  assert.ok(widgetSource.includes(".django-shell-overlay-widget-layer .monaco-hover .monaco-sash:not(.disabled),.django-shell-overlay-widget-layer .monaco-editor-hover .monaco-sash:not(.disabled)"));
  assert.ok(widgetSource.includes(".monaco-resizable-hover .monaco-sash.disabled"), "disabled native resize edges stay non-interactive");
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

test("body widget portals become important-hidden and dismiss native popup state", () => {
  const widgetSource = fs.readFileSync(new URL("../src/workbenchOverlayWidgetRenderer.ts", import.meta.url), "utf8");
  const visibilityStart = widgetSource.indexOf("window.__dsoSetOverlayWidgetVisibility");
  const visibilityEnd = widgetSource.indexOf("window.__dsoRemoveOverlayWidgetPortal", visibilityStart);
  const visibilityBody = widgetSource.slice(visibilityStart, visibilityEnd);

  for (const [name, value] of [["display", "none"], ["visibility", "hidden"], ["opacity", "0"], ["pointer-events", "none"]]) {
    assert.ok(visibilityBody.includes(`layerRoot.style.setProperty("${name}", "${value}", "important")`), `${name} must override workbench widget styles while parked`);
  }
  assert.ok(visibilityBody.includes('layerRoot.setAttribute("aria-hidden", "true")'));
  assert.ok(visibilityBody.includes("__dsoDismissOverlayWidgets(root)"));
  assert.ok(widgetSource.includes('["hideSuggestWidget", "editor.action.hideHover", "closeParameterHints"]'));
  assert.ok(widgetSource.includes("editor.blur && editor.blur()"));
  assert.ok(widgetSource.includes("if (input && input.blur) { input.blur(); }"));
  assert.ok(widgetSource.includes("function __dsoOwnedWidgetPortal(root, ownerToken)"));
});

test("overlay show restores widgets only after geometry and an active editor are ready", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const showStart = rendererSource.indexOf("window.__djangoShellOverlayShow = function");
  const showEnd = rendererSource.indexOf("window.__djangoShellOverlaySetGeometry", showStart);
  const showBody = rendererSource.slice(showStart, showEnd);
  const geometryGuard = showBody.indexOf("if (!__dsoApplyGeometry(root, geometry))");
  const editorReady = showBody.indexOf("const editor = __dsoEnsureEditor(root)");
  const editorVisibility = showBody.indexOf("const editorVisible = !!editor && !root.__dsoGeometryParked");
  const finalRestore = showBody.indexOf("__dsoSetOverlayWidgetVisibility(root, editorVisible && root.__dsoHasActiveConsoleGroup !== false, false)");
  const pendingBody = showBody.slice(geometryGuard, editorReady);

  assert.ok(geometryGuard >= 0 && editorReady > geometryGuard);
  assert.ok(pendingBody.includes("__dsoSetOverlayWidgetVisibility(root, false, true)"), "pending geometry dismisses and hides stale floating widgets");
  assert.ok(editorVisibility > editorReady && finalRestore > editorVisibility, "the portal is restored only after Monaco exists in the active console group");
  assert.equal(showBody.slice(0, editorReady).includes("__dsoSetOverlayWidgetVisibility(root, true"), false);
});

test("overlay model stays user-only instead of hiding generated prelude DOM", () => {
  const preludeViewSource = fs.readFileSync(new URL("../src/workbenchOverlayPreludeViewRenderer.ts", import.meta.url), "utf8");
  const syncSource = fs.readFileSync(new URL("../src/workbenchOverlaySyncRenderer.ts", import.meta.url), "utf8");

  assert.ok(preludeViewSource.includes("Applies shell prompt metadata without adding hidden prelude lines to the model"));
  assert.ok(preludeViewSource.includes("editor.setHiddenAreas([], \"django-shell-prelude\")"));
  assert.ok(syncSource.includes("model.setValue(userText)"));
  assert.ok(syncSource.includes("prelude.guard.strip"));
  assert.ok(overlaySource.includes("this.featureBridge.invalidateCompletions()"));
  assert.equal(syncSource.includes("overlayDiagnosticPrefixRendererSource"), false);
  assert.equal(syncSource.includes("__dsoDiagnosticPrefix"), false);
  const preludeUpdate = syncSource.slice(syncSource.indexOf("window.__djangoShellOverlaySetPrelude"), syncSource.indexOf("return \"ok\";", syncSource.indexOf("window.__djangoShellOverlaySetPrelude")));
  assert.equal(preludeUpdate.includes("root.style.visibility"), false, "analysis-prelude refreshes never flash-hide the live editor");
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
  assert.ok(frameRendererSource.includes("root.__dsoHasActiveConsoleGroup = entries.length > 0"));
  assert.ok(frameRendererSource.includes("const visibleCachedFrame = root.__dsoFrame"));
  assert.ok(frameRendererSource.includes("__dsoFrameArea(root.__dsoFrame) > 4000"), "only a still-visible owned frame survives transient tab metadata loss");
  assert.ok(frameRendererSource.includes("root.__dsoPortalHost && root.__dsoPortalHost.isConnected"));
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

test("orphan-window cleanup never blocks the owning renderer evaluation", () => {
  const orphanStart = workbenchWindowEvalSource.indexOf("const orphanCleanup");
  const orphanEnd = workbenchWindowEvalSource.indexOf("let timeoutHandle", orphanStart);
  const orphanBody = workbenchWindowEvalSource.slice(orphanStart, orphanEnd);

  assert.ok(orphanBody.includes("orphanCleanup"));
  assert.ok(orphanBody.includes("win.webContents.executeJavaScript(orphanCleanup"));
  assert.equal(orphanBody.includes("await"), false, "an unresponsive orphan window must not delay the target window");
  assert.ok(workbenchWindowEvalSource.includes("const outcome = await Promise.race"), "the owning renderer IPC call is bounded too");
  assert.ok(workbenchWindowEvalSource.includes("renderer-execute-timeout:"));
});

test("CDP evaluation timeouts retire the exact socket generation", () => {
  const sendStart = overlaySource.indexOf("private async send(method: string");
  const sendEnd = overlaySource.indexOf("private handleSocketMessage", sendStart);
  const sendBody = overlaySource.slice(sendStart, sendEnd);

  assert.ok(overlaySource.includes("const CDP_EVALUATE_TIMEOUT_MS"));
  assert.ok(overlaySource.includes("const RENDERER_EXECUTE_TIMEOUT_MS"));
  assert.ok(overlaySource.includes("const CAPTURE_EVALUATE_TIMEOUT_MS"));
  assert.ok(sendBody.includes("const socket = this.ws"));
  assert.ok(sendBody.includes("request.socket !== socket"), "a stale timeout cannot retire another socket's request");
  assert.ok(sendBody.includes("this.pending.set(id, { reply, socket })"));
  assert.ok(sendBody.includes('this.retireSocket(socket, `timeout:${method}`)'));
  assert.equal(sendBody.includes("this.closeSocket("), false, "request timeout cleanup stays generation-scoped");
});

test("late events from a retired CDP socket cannot close or resolve the new connection", () => {
  const connectStart = overlaySource.indexOf("private async connectCdpSocket()");
  const connectEnd = overlaySource.indexOf("private async evalInWorkbench", connectStart);
  const connectBody = overlaySource.slice(connectStart, connectEnd);
  const messageStart = overlaySource.indexOf("private handleSocketMessage");
  const messageEnd = overlaySource.indexOf("private closeServer", messageStart);
  const messageBody = overlaySource.slice(messageStart, messageEnd);
  const retireStart = overlaySource.indexOf("private retireSocket");
  const retireEnd = overlaySource.indexOf("private async openWarmupEditor", retireStart);
  const retireBody = overlaySource.slice(retireStart, retireEnd);

  assert.ok(overlaySource.includes("private cdpConnectPromise"), "concurrent reconnects share one socket generation");
  assert.ok(connectBody.includes('socket.on("message", (data) => this.handleSocketMessage(data, socket))'));
  assert.ok(connectBody.includes('socket.on("close", () => this.retireSocket(socket, "closed"))'));
  assert.ok(messageBody.includes("request.socket !== socket"), "old replies are ignored");
  assert.ok(retireBody.includes("request.socket !== socket"), "retirement only rejects requests owned by that socket");
  assert.ok(retireBody.includes("if (this.ws === socket) { this.ws = undefined; }"), "an old close event preserves the newer live socket");
});

test("renderer overlay root carries an owner token before reuse or disposal", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const cleanupSource = fs.readFileSync(new URL("../src/workbenchOverlayCleanupRenderer.ts", import.meta.url), "utf8");

  assert.ok(overlaySource.includes("__djangoShellOverlayOwnerToken"));
  assert.ok(rendererSource.includes("root.__dsoOwnerToken = requestedOwner"));
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
  assert.ok(preludeViewSource.includes("glyphMargin: !submitMode"));
  assert.ok(customConsoleSource.includes("sourceBreakpointLocations"));
  assert.equal(syncSource.includes("overlayBreakpointRendererSource"), false);
  assert.equal(overlaySource.includes('payload?.type === "toggleBreakpoint"'), false);
  assert.equal(customConsoleClientSource.includes('message.type === "overlayToggleBreakpoint"'), false);
  assert.equal(customConsoleSource.includes('typed.type === "overlayToggleBreakpoint"'), false);
  assert.equal(overlaySource.includes("toggleBreakpointFromVisibleLine"), false);
  assert.equal(overlaySource.includes("lastBreakpointToggleKey"), false);
});

test("warm overlay injection trusts live host state instead of probing and misclassifying timeouts", () => {
  const ensureStart = overlaySource.indexOf("private async ensureInjected()");
  const ensureEnd = overlaySource.indexOf("private async inject()", ensureStart);
  const ensureBody = overlaySource.slice(ensureStart, ensureEnd);

  assert.ok(ensureBody.includes("this.rendererInjected"));
  assert.ok(ensureBody.includes("return;"), "an already injected renderer takes the warm fast path");
  assert.equal(ensureBody.includes("rendererPatchState"), false, "warm shows must not add a health-probe Runtime.evaluate");
  assert.equal(overlaySource.includes("private async rendererPatchState()"), false, "transport failures cannot be converted into empty patch state");
  assert.ok(overlaySource.includes('report === "overlay-not-installed"'), "only a definitive renderer response triggers reinjection");
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

test("overlay prompt gutter keeps the glyph margin and reveals breakpoints there", () => {
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
  // Breakpoint reveal glyph is drawn in the same glyph margin.
  assert.ok(rendererSource.includes("dso-breakpoint"));
  assert.ok(syncSource.includes("dso-breakpoint"));
});

test("overlay renderer caches expensive widget layout work", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const syncSource = fs.readFileSync(new URL("../src/workbenchOverlaySyncRenderer.ts", import.meta.url), "utf8");
  const widgetSource = fs.readFileSync(new URL("../src/workbenchOverlayWidgetRenderer.ts", import.meta.url), "utf8");

  assert.ok(rendererSource.includes("window.__dsoWidgetCache"));
  assert.ok(rendererSource.includes("if (__dsoIsLiveWidget(cached))"));
  assert.ok(rendererSource.includes("cache && start && cache.set(start, widget)"));
  assert.ok(rendererSource.includes("root.__dsoLastEditorLayoutKey === layoutKey"));
  assert.ok(rendererSource.includes("style.__dsoPatchVersion === version"), "warm shows do not rewrite the overlay stylesheet");
  assert.ok(widgetSource.includes("node.__dsoThemeSyncKey === themeKey"), "unchanged themes skip the full VS Code variable copy");
  assert.ok(widgetSource.includes("style.__dsoPatchVersion === version"), "widget CSS is installed once per renderer patch");
  assert.ok(syncSource.includes("root.__dsoEnterEditor === editor && root.__dsoEnterCleanup"), "warm shows keep the existing key handlers and Monaco commands");
  assert.equal(rendererSource.includes("__dsoBreakpointLayer"), false);
});

test("overlay service capture keeps deep inspection outside its bounded temporary hooks", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const hooksStart = captureRendererSource.indexOf("wrappers.mapSet =");
  const hooksEnd = captureRendererSource.indexOf("window.__dsoCaptureOriginals = originals", hooksStart);
  const hooksBody = captureRendererSource.slice(hooksStart, hooksEnd);

  assert.ok(rendererSource.includes('import { overlayCaptureRendererSource } from "./workbenchOverlayCaptureRenderer"'));
  assert.ok(rendererSource.includes("${overlayCaptureRendererSource()}"));
  assert.ok(captureRendererSource.includes("const __dsoCaptureDeadlineMs = 1500"));
  assert.ok(captureRendererSource.includes("const __dsoForcedCaptureDeadlineMs = 3000"));
  assert.ok(captureRendererSource.includes("const __dsoBroadCaptureMs = 420"));
  assert.ok(captureRendererSource.includes("const __dsoCaptureQueueLimit = 384"));
  assert.ok(captureRendererSource.includes("function __dsoDrainCaptureQueue()"));
  assert.ok(captureRendererSource.includes("__dsoStartBroadCapture(generation)"));
  assert.ok(captureRendererSource.includes("generation !== window.__dsoCaptureGeneration"));
  assert.ok(rendererSource.includes("now - window.__dsoLastDomCaptureScanAt < 1200"), "DOM fallback scans are throttled");
  assert.ok(rendererSource.includes("window.__dsoDomCaptureFallbackAfter = Date.now() + 700"), "deep DOM discovery starts only after constructor capture gets a chance");
  assert.ok(rendererSource.includes("if (window.__dsoDomCaptureFallbackAfter && Date.now() >= window.__dsoDomCaptureFallbackAfter) { __dsoScanDom(); }"));
  assert.ok(rendererSource.includes("window.__dsoSniffedWidgets"), "captured widgets are deep-inspected only once");
  assert.equal(captureRendererSource.slice(captureRendererSource.indexOf("function __dsoCaptureTick"), captureRendererSource.indexOf("function __dsoStartCapture")).includes("__dsoScanDom"), false, "capture ticks never rescan editor DOM");
  assert.equal(hooksBody.includes("__dsoSniff"), false, "collection hot paths never deep-scan values");
  assert.equal(hooksBody.includes("Object.getOwnPropertyNames"), false, "property enumeration stays in the deferred queue drain");
});

test("capture probes existing editors before a file-backed fallback and never opens Untitled", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const showStart = overlaySource.indexOf("private async showNow()");
  const showEnd = overlaySource.indexOf("updateGeometry(geometry", showStart);
  const showBody = overlaySource.slice(showStart, showEnd);
  const fallbackStart = overlaySource.indexOf("private async openCaptureFallbackEditor()");
  const closeStart = overlaySource.indexOf("private async closeCaptureFallbackEditor", fallbackStart);
  const waitStart = overlaySource.indexOf("private async waitForOverlayCapture(");
  const waitEnd = overlaySource.indexOf("async function readRequestBody", waitStart);
  const fallbackBody = overlaySource.slice(fallbackStart, closeStart), closeBody = overlaySource.slice(closeStart, waitStart), waitBody = overlaySource.slice(waitStart, waitEnd);
  const armIndex = showBody.indexOf("await this.evalInWorkbench(captureArmExpression");
  const probeIndex = showBody.indexOf('executeCommand("vscode.getEditorLayout")', armIndex);
  const fallbackIndex = showBody.indexOf("openCaptureFallbackEditor()", probeIndex);
  const rearmIndex = showBody.indexOf("captureRearmExpression(this.token, generation)", fallbackIndex), secondProbe = showBody.indexOf('executeCommand("vscode.getEditorLayout")', probeIndex + 1), earlyClose = showBody.indexOf("await closeFallback()", secondProbe);
  const restoredPoll = showBody.indexOf("waitForOverlayCapture(CAPTURE_FALLBACK_TIMEOUT_MS, 75, true)", earlyClose);
  const stopIndex = showBody.indexOf("captureStopExpression(this.token, generation)", restoredPoll), finalClose = showBody.indexOf("await closeFallback()", stopIndex);
  assert.ok(armIndex >= 0 && probeIndex > armIndex && fallbackIndex > probeIndex, "exact service lookup runs before the fallback editor");
  assert.ok(rearmIndex > fallbackIndex && secondProbe > rearmIndex && earlyClose > secondProbe && restoredPoll > earlyClose, "fallback rearms exact lookup, settles, and closes before restored-host polling");
  assert.ok(stopIndex > restoredPoll && finalClose > stopIndex, "generation stop precedes bounded final tab cleanup");
  assert.equal(overlaySource.includes('openTextDocument({ content: ""'), false, "capture never creates an Untitled document");
  assert.ok(fallbackBody.includes("Promise.race") && fallbackBody.includes("void shown.then(close, close)") && fallbackBody.includes("scheduleGeneratedOverlayTabCleanup"));
  assert.ok(closeBody.includes("Promise.race") && closeBody.includes("CAPTURE_FALLBACK_CLOSE_TIMEOUT_MS") && closeBody.includes(".catch("));
  assert.ok(waitBody.includes("isEvaluationTimeoutMessage(message)") && waitBody.includes("retryMissingHost"));
  assert.equal(waitBody.includes("ctorMatch") || waitBody.includes('report.includes("factory=true")'), false);
  assert.ok(rendererSource.includes("window.__dsoArmOverlayCapture") && rendererSource.includes('return "capture-armed:"') && rendererSource.includes("window.__dsoStopOverlayCapture"));
});

test("overlay status reporting never performs another editor factory scan", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const statusStart = rendererSource.indexOf("function __dsoStatus()");
  const statusEnd = rendererSource.indexOf("function __dsoUri()", statusStart);
  const statusBody = rendererSource.slice(statusStart, statusEnd);

  assert.ok(statusBody.includes('" exactReady=" + __dsoCaptureReady()'));
  assert.ok(statusBody.includes('" factory=" + !!(root && root.__djangoShellEditor)'));
  assert.equal(statusBody.includes("__dsoFactory()"), false, "diagnostic status must stay a constant-time read");
});

test("transient owning-frame misses park the editor after a grace period instead of disposing Monaco", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const missStart = rendererSource.indexOf("function __dsoHandleGeometryMiss");
  const missEnd = rendererSource.indexOf("function __dsoEnsureStyle", missStart);
  const missBody = rendererSource.slice(missStart, missEnd);
  const timerStart = rendererSource.indexOf("root.__dsoGeometryTimer = window.setInterval");
  const timerEnd = rendererSource.indexOf("const editor = __dsoEnsureEditor", timerStart);
  const timerBody = rendererSource.slice(timerStart, timerEnd);
  const firstMissStart = missBody.indexOf("if (!root.__dsoGeometryMissingSince)");
  const graceStart = missBody.indexOf("if (now - root.__dsoGeometryMissingSince < 700)", firstMissStart);
  const firstMissBody = missBody.slice(firstMissStart, graceStart);

  assert.ok(missBody.includes("now - root.__dsoGeometryMissingSince < 700"));
  assert.ok(firstMissBody.includes("root.__dsoGeometryWidgetParked = true"));
  assert.ok(firstMissBody.includes("__dsoSetOverlayWidgetVisibility(root, false, true)"), "the first missing frame immediately hides body-level widgets");
  assert.ok(missBody.includes("root.__dsoGeometryParked = true"));
  assert.ok(missBody.includes('root.style.visibility = "hidden"'));
  assert.equal(missBody.includes("__dsoDisposeOverlay"), false, "a transient workbench layout gap never destroys the editor/model");
  assert.ok(timerBody.includes("__dsoHandleGeometryMiss(root)"));
  assert.equal(timerBody.includes("__dsoDisposeOverlay(root)"), false);
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
  assert.ok(customConsoleSource.includes("debug.shell.reuse"));
  assert.ok(customConsoleSource.includes("debug.shell.noBackend"));
  assert.ok(customConsoleSource.includes("debugAttachPromise"));
  assert.ok(customConsoleSource.includes("debug.shell.inFlight"));
  assert.ok(customConsoleSource.includes("startDebugpyWithTimeout"));
  assert.ok(customConsoleSource.includes("DEBUG_ATTACH_TIMEOUT_MS"));
  assert.ok(customConsoleSource.includes("debugpyEndpoint = undefined"));
});

test("console focus changes keep the overlay alive while visible or attaching a debugger", () => {
  const viewStart = customConsoleSource.indexOf("private handleViewState(visible: boolean, active: boolean)");
  const viewEnd = customConsoleSource.indexOf("private async updateOverlayPrelude", viewStart);
  const viewBody = customConsoleSource.slice(viewStart, viewEnd);
  const visibleBranch = viewBody.indexOf("if (visible)");
  const inactiveReturn = viewBody.indexOf("if (!active) { return; }", visibleBranch);
  const hide = viewBody.indexOf("this.overlay?.hide()", visibleBranch);

  assert.ok(viewBody.includes("Boolean(this.debugAttachPromise || this.debugSession || this.overlayDebugSession)"));
  assert.ok(visibleBranch >= 0 && inactiveReturn > visibleBranch, "visible-but-inactive panels return without hiding");
  assert.ok(hide > inactiveReturn, "hide remains exclusive to the non-visible branch");
  assert.ok(viewBody.includes("if (!keepForDebug) { this.overlay?.hide(); }"), "debug attachment keeps a hidden overlay warm");
  assert.ok(viewBody.includes("this.runtimeReady && this.overlayPrelude.length === 0"), "focus restoration does not refetch a large prelude already held in memory");
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
  assert.ok(customConsoleSource.includes('direct), { ...configuration, engine: requestedEngine })'));
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
  assert.ok(customConsoleSource.includes('keepForDebug = this.debugMode === "overlay"'));
  assert.ok(customConsoleSource.includes("if (wasActive) { return; }"));
  assert.ok(customConsoleSource.includes("if (!keepForDebug) { this.overlay?.hide(); }"));
  assert.ok(customConsoleSource.includes("if (!this.panel?.visible || !this.panel.active)"));
  assert.ok(customConsoleSource.includes("this.panel?.visible && this.panel.active && isOverlayGeometry"));
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
  assert.ok(customConsoleSource.includes('stepInto = this.lastDebugControlAction === "stepInto"'));
  assert.ok(customConsoleSource.includes("preferUserSource: stepInto"));
  assert.ok(customConsoleSource.includes("clearExternalDebugFrameDecoration"));
  assert.ok(customConsoleSource.includes('"djangoShell.externalDebugFrame", true'));
  assert.ok(customConsoleSource.includes('"djangoShell.externalDebugFrame", false'));
  assert.ok(customConsoleSource.includes("if (!this.panel?.visible || !this.panel.active)"));
  assert.ok(customConsoleSource.includes("if (!wasOverlayFrame) { this.panel?.reveal(vscode.ViewColumn.One); void this.showOverlay(); }"));
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
  assert.ok(customConsoleSource.includes("refreshExternalDebugFrameDecoration(info)"));
  assert.match(debugFrameNavigationSource, /export function refreshExternalDebugFrameDecoration\(info:/);
  assert.ok(debugFrameNavigationSource.includes("debugInlineValueText(latest.scopes)"));
  assert.ok(debugFrameNavigationSource.includes("debugInlineValueText(info.scopes)"));
  assert.ok(debugFrameNavigationSource.includes("contentText: `  ${inlineText}`"));
  assert.ok(debugFrameNavigationSource.includes('new vscode.ThemeColor("editor.inlineValuesForeground")'));
  assert.ok(debugFrameNavigationSource.includes('new vscode.ThemeColor("editor.inlineValuesBackground")'));
  assert.ok(debugFrameNavigationSource.includes("new vscode.Range(end, end)"), "native inline values attach at the source line end");
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
  assert.ok(debugAnalysisPanelSource.includes("variableNodes(id, scope.variables)"));
  assert.ok(debugAnalysisPanelSource.includes("variableNodes(node.id, children)"), "expanded children keep parent-scoped stable ids");
  assert.ok(debugAnalysisPanelSource.includes("item.id = node.id"), "tree items carry stable ids so expansion survives refreshes");
  assert.ok(debugAnalysisPanelSource.includes("this.refreshTimer = setTimeout("), "per-stop refresh bursts are coalesced");
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
  assert.ok(debugInspectorSource.includes('variablesForReference(session, variablesReference, 120, "children")'), "expanded nodes keep dunder members visible");
  assert.ok(debugInspectorSource.includes('level === "scope" && name.startsWith("__")'), "dunder filtering only applies at scope level");
  assert.ok(debugInspectorSource.includes("displayVariableValue(variable.value, variable.variablesReference)"));
  assert.ok(debugInspectorSource.includes("`${text}<${ref}>`"));
  assert.ok(customConsoleSource.includes("inspectDebugVariables(session"));
  assert.ok(customConsoleSource.includes("setDebugAnalysisInfo(info)"));
  assert.ok(customConsoleSource.includes("setDebugAnalysisVariableResolver"));
  assert.ok(debugInspectorSource.includes("export interface DebugStackFrameInfo"));
  assert.ok(debugInspectorSource.includes("frames: frames.slice(0, 8).map(stackFrameInfo)"));
});

test("overlay hover file links open beside the console or reveal inside the overlay", () => {
  const widgetRendererSource = fs.readFileSync(new URL("../src/workbenchOverlayWidgetRenderer.ts", import.meta.url), "utf8");
  // Renderer: capture-phase routing for file links inside portal popups (hover/suggest docs).
  assert.ok(widgetRendererSource.includes("__dsoInstallWidgetLinkRouter"));
  assert.ok(widgetRendererSource.includes('__dsoPost({ type: "openLink", href: href })'));
  // Extension: generated-file targets reveal inside the overlay editor instead of opening hidden tabs.
  assert.ok(overlaySource.includes('payload?.type === "openLink"'));
  assert.ok(overlaySource.includes("openHoverLink"));
  assert.ok(overlaySource.includes("parseHoverLinkTarget"));
  assert.ok(overlaySource.includes("target.line - this.memoryDocument.lineOffset()"));
  assert.ok(overlaySource.includes("revealOverlayLine"));
  // Real files open in a side group so the console webview and overlay stay intact.
  assert.ok(overlaySource.includes("viewColumn: vscode.ViewColumn.Beside"));
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

test("full debug teardown (stop/restart/close) interrupts the backend and disconnects", () => {
  assert.ok(customConsoleSource.includes("backend?.interrupt(\"debugWebview.stop\")"));
  assert.ok(customConsoleSource.includes("interruptExecution: (reason) => this.session?.backend?.interrupt(reason)"));
  assert.ok(debugControlsSource.includes("await interruptExecution?.();"));
  assert.ok(debugEventsSource.includes("onWillReceiveMessage(message)"));
  assert.ok(debugEventsSource.includes("debugAdapter.${request.command}"));
  assert.ok(debugEventsSource.includes("debugSessionTerminate"));
});

test("paused overlay debug keeps the executable console source tab out of cleanup", () => {
  assert.ok(customConsoleSource.includes("closeWorkspaceGeneratedOverlayTabs(false)"));
  assert.ok(generatedTabsSource.includes("includeExecutable = true"));
  assert.ok(generatedTabsSource.includes("if (includeExecutable)"));
  assert.ok(debugEventsSource.includes("debug.session.terminate"));
});

test("analysis-only overlay sync keeps the executable console-cell file dirty", () => {
  assert.ok(overlayMemorySource.includes("private editorDirty"));
  assert.ok(overlayMemorySource.includes("this.editorDirty = true"));
  assert.ok(overlayMemorySource.includes("changed || this.editorDirty"));
  assert.ok(overlayMemorySource.includes("this.editorDirty = this.editorText() !== text"));
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

test("a finished debug run ends warm and keeps the debugpy connection for reuse", () => {
  assert.ok(customConsoleSource.includes("if (this.debugRunActive) { await this.endDebugRun("));
  assert.ok(customConsoleSource.includes('this.lastDebugControlAction ? "completed" : "no breakpoint hit"'));
  assert.ok(customConsoleSource.includes("private async endDebugRun("));
  assert.ok(customConsoleSource.includes("this.debugRunActive = false; this.debugThreadId = undefined;"));
  assert.ok(customConsoleSource.includes("debugBreakpoints([])"), "endDebugRun clears breakpoint state so warm runs never pause");
  assert.ok(customConsoleSource.includes("debug.run.end"));
  // endDebugRun must NOT disconnect / stop the session (that is teardownDebug only)
  const endDebugRunBody = customConsoleSource.slice(customConsoleSource.indexOf("private async endDebugRun("), customConsoleSource.indexOf("private async stopDebugRun("));
  assert.ok(!endDebugRunBody.includes("disconnect(") && !endDebugRunBody.includes("stopDebugging("), "endDebugRun keeps the socket warm");
  assert.ok(customConsoleSource.includes('this.postDebugStatus("idle", detail)'));
  assert.ok(customConsoleSource.includes("clearExternalDebugFrameDecoration();"));
});

test("debug reuses a warm connection after natural completion; explicit stop/restart/close tears it down", () => {
  assert.ok(customConsoleSource.includes("return this.reuseWarmDebugRun(this.overlayDebugSession)"));
  assert.ok(customConsoleSource.includes("return this.reuseWarmDebugRun(this.debugSession)"));
  assert.ok(customConsoleSource.includes("private async reuseWarmDebugRun("));
  assert.ok(customConsoleSource.includes("this.debugRunActive = true;"));
  assert.ok(customConsoleSource.includes("private async teardownDebug("));
  assert.ok(customConsoleSource.includes("await this.teardownDebug();"), "restart tears the connection down fully");
  assert.ok(customConsoleSource.includes("await session.disconnect();"));
});

test("stop interrupts the active cell and tears down debugging without continuing user code", () => {
  assert.ok(customConsoleSource.includes('if (action === "stop") { await this.stopDebugRun(); return; }'));
  const stopStart = customConsoleSource.indexOf("private async stopDebugRun("), stopEnd = customConsoleSource.indexOf("private async teardownDebug(", stopStart), stopBody = customConsoleSource.slice(stopStart, stopEnd);
  assert.ok(stopBody.includes('this.lastDebugControlAction = "stop"'));
  assert.ok(stopBody.includes("await this.teardownDebug()"));
  assert.equal(stopBody.includes('runDebugControl("continue"'), false, "Stop must never resume the remaining user code");
  assert.ok(customConsoleSource.includes('backend?.interrupt("debugWebview.stop"); await session.disconnect()'), "direct debugging interrupts before disconnect");
  assert.ok(customConsoleSource.includes('backend?.interrupt("debugWebview.stop");\n    await vscode.debug.stopDebugging'), "file debugging interrupts before stopDebugging");
  assert.ok(debugEventsSource.includes('if (hooks.lastControlAction() === "stop")'), "a disconnect-time continued event cannot restore running UI state");
});

test("stepInto target resolution is time-boxed and bounds language-server calls", () => {
  const stepTargetsSource = fs.readFileSync(new URL("../src/debugStepTargets.ts", import.meta.url), "utf8");
  assert.ok(stepTargetsSource.includes("STEP_IN_TARGET_TIMEOUT_MS = 120"));
  assert.ok(stepTargetsSource.includes("Promise.race([preferredUserStepInTargetId"), "the target lookup races a timeout");
  assert.ok(stepTargetsSource.includes("pythonIdentifierSpans(line).slice(0, 8)"), "capped identifier probes");
  assert.ok(stepTargetsSource.includes("const staticCallNames = fallbackDirectCallNames(line, source.visibleText, [])"), "static call names are tried before language-server lookups");
  assert.ok(stepTargetsSource.includes("new vscode.Position(lineIndex, span.start)"), "one definition probe per identifier");
});

test("two-phase inspection: fast frame first, enriched (live/expandable previews) only on settle", () => {
  // Enrichment (candidates + previews) is split from the basic scope read and gated behind the enrich option.
  assert.ok(debugInspectorSource.includes("enrich?: boolean"), "inspect options carry an enrich flag");
  assert.ok(debugInspectorSource.includes("options.enrich !== false ? await enrichScopeVariables"), "basic scopes returned unless enrich requested");
  assert.ok(debugInspectorSource.includes("async function enrichScopeVariables"));
  assert.ok(debugInspectorSource.includes("globalsVariables"), "Globals variables are reused for local candidates (no per-name evaluate)");
  assert.ok(debugInspectorSource.includes("MAX_EVALUATED_LOCAL_CANDIDATES = 10"), "bounded fallback evaluates");
  // Previews evaluated live so the row keeps a current-pause variablesReference and stays expandable (user can drill into rows/fields).
  assert.ok(debugInspectorSource.includes("await evaluateQuerySetPreview(session, frameId, variable.name, expression)"));
  assert.ok(debugInspectorSource.includes("await evaluateDjangoModelPreview(session, frameId, variable.name, modelExpression)"));
  assert.ok(!debugInspectorSource.includes("cachedQuerySetPreview") && !debugInspectorSource.includes("cachedModelPreview"), "per-step preview caches removed in favour of settled live evaluation");
  // Stepping posts a fast (enrich:false) frame then a debounced enrich:true pass in both overlay and file paths.
  assert.ok(customConsoleSource.includes("enrich: false }).then(post)"), "overlay stop posts the fast frame first");
  assert.ok(customConsoleSource.includes("DEBUG_ENRICH_DELAY_MS"));
  assert.ok(debugEventsSource.includes("scheduleEnrich(current, () =>"), "file-mode stop/active-stack defer enrichment");
});

test("breakpoint lines are revealed with a whole-line marker (not a second gutter dot)", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  const syncSource = fs.readFileSync(new URL("../src/workbenchOverlaySyncRenderer.ts", import.meta.url), "utf8");
  // Extension mirrors breakpoint lines into the overlay whenever the breakpoint UI refreshes.
  assert.ok(customConsoleSource.includes("void this.overlay?.updateBreakpoints(lines);"));
  assert.ok(overlaySource.includes("async updateBreakpoints(lines: number[])"));
  assert.ok(overlaySource.includes("window.__dsoSetOverlayBreakpoints"));
  // Renderer marks the whole breakpoint LINE (className, isWholeLine) rather than adding a glyph-margin dot.
  assert.ok(syncSource.includes("window.__dsoApplyOverlayBreakpoints = function"));
  assert.ok(syncSource.includes('className: "dso-breakpoint-line", isWholeLine: true'));
  assert.ok(!syncSource.includes('glyphMarginClassName: "dso-breakpoint"'), "no extra breakpoint gutter dot");
  assert.ok(syncSource.includes("window.__dsoApplyOverlayBreakpoints && window.__dsoApplyOverlayBreakpoints(root, editor)"));
  assert.ok(rendererSource.includes(".dso-breakpoint-line{box-shadow:inset 3px 0 0 var(--vscode-debugIcon-breakpointForeground"));
});

test("stepping keeps the current-line marker stable (no per-step blink) and centers the arrow", () => {
  const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
  // Flicker: the transient running state must not clear the overlay debug line.
  assert.ok(overlaySource.includes('if (info.state === "running") {'), "updateDebugInfo keeps the paused line during the running state");
  assert.ok(overlaySource.includes('info.state === "paused" && info.frame && this.isOverlayFrame'));
  // Arrow centering: flex-center the triangle within Monaco's per-line glyph div instead of height:100% + top:50%.
  assert.ok(rendererSource.includes(".dso-debug-indicator{align-items:center;background:transparent;display:flex;justify-content:center;"), "arrow is flex-centered");
  assert.ok(!rendererSource.includes(".dso-debug-indicator{background:transparent;height:100%!important"), "no height:100% override that breaks centering");
});

test("overlay show and debug-line renderer traffic are single-flight and latest-value coalesced", () => {
  const showBody = overlaySource.slice(overlaySource.indexOf("async show(): Promise<boolean>"), overlaySource.indexOf("/** Updates the workbench overlay position"));
  const debugBody = overlaySource.slice(overlaySource.indexOf("async updateDebugInfo"), overlaySource.indexOf("/** Mirrors the one-based lines"));

  assert.ok(showBody.includes("if (this.showPromise)"));
  assert.ok(showBody.includes("const pending = this.showNow()"));
  assert.equal(showBody.includes("rendererPatchVersion"), false, "warm show must not perform a renderer health/version probe");
  assert.ok(showBody.includes("void this.queueDebugLineFlush()"), "debug decoration delivery must not delay a visible overlay");
  assert.equal(showBody.includes("await this.queueDebugLineFlush()"), false);
  assert.ok(showBody.includes("this.resumeHeldGeometry()"), "show completion releases the latest held geometry");
  assert.ok(debugBody.includes("this.debugLineTarget = visibleLine >= 1 ? visibleLine : 0"));
  assert.ok(debugBody.includes("this.inlineValueText = visibleLine > 0 ? debugInlineValueText(info.scopes) : \"\""));
  assert.ok(debugBody.includes("if (this.debugLineFlushPromise)"));
  assert.ok(debugBody.includes("while (this.ws?.readyState === WebSocket.OPEN && this.rendererInjected && this.debugLineApplied !== debugInlineRenderKey(this.debugLineTarget, this.inlineValueText))"));
  assert.ok(debugBody.includes("const target = this.debugLineTarget, inline = this.inlineValueText, key = debugInlineRenderKey(target, inline)"), "a queued update atomically snapshots the latest line and values before each CDP call");
});

test("paused-frame navigation is location-deduped while enriched inline values still refresh", () => {
  const body = customConsoleSource.slice(customConsoleSource.indexOf("private postDebugInfo(info"), customConsoleSource.indexOf("private async inspectDebugVariableChildren"));
  const duplicateGuard = body.indexOf("presentationKey === this.lastDebugPresentationKey");
  const markerUpdate = body.indexOf("this.overlay?.updateDebugInfo(info)");

  assert.ok(markerUpdate >= 0 && duplicateGuard > markerUpdate, "renderer values refresh before duplicate locations stop navigation");
  assert.equal((body.match(/this\.overlay\?\.updateDebugInfo\(info\)/g) ?? []).length, 1, "one renderer update site handles every frame state");
  assert.equal((body.match(/revealExternalDebugFrame\(/g) ?? []).length, 1, "one external navigation site");
  assert.equal((body.match(/closeWorkspaceGeneratedOverlayTabs\(false\)/g) ?? []).length, 1, "one overlay-mode external tab cleanup site");
  assert.ok(body.includes("if (!wasOverlayFrame) { this.panel?.reveal(vscode.ViewColumn.One); void this.showOverlay(); }"), "overlay-to-overlay steps only update the marker");
  assert.ok(body.includes("this.lastDebugPresentationKey === presentationKey"), "stale external reveals cannot park a newer frame");
  assert.ok(body.includes('if (info.state === "running") { return; } this.lastDebugPresentationKey = "";'), "terminal states reset presentation while transient running preserves it");
});

test("direct continued invalidates pending paused-frame inspection before posting running", () => {
  const continued = customConsoleSource.slice(customConsoleSource.indexOf("onContinued: (body)"), customConsoleSource.indexOf("onStopped: (body)"));
  const generation = continued.indexOf("this.debugStopGeneration += 1");
  const cancelEnrich = continued.indexOf("clearTimeout(this.debugEnrichTimer)");
  const postRunning = continued.indexOf('this.postDebugStatus("running", "continued")');

  assert.ok(generation >= 0 && generation < postRunning, "stale fast inspection is generation-guarded before running");
  assert.ok(cancelEnrich >= 0 && cancelEnrich < postRunning, "settled enrichment is cancelled before running");
});

test("backend only traces the request thread for debug runs so warm connections stay fast", () => {
  const backendSource = fs.readFileSync(new URL("../python/django_shell_backend.py", import.meta.url), "utf8");
  assert.ok(backendSource.includes("_debug_current_thread(breakpoint_lines is not None)"), "tracing is gated on a debug run");
  assert.ok(backendSource.includes("def _debug_current_thread(active):"));
  assert.ok(backendSource.includes("debugpy.trace_this_thread(False)"), "normal runs disable leftover tracing");
  // Progress emission is suppressed during a debug run so pause-time inspection reprs (QuerySet repr) don't flood.
  assert.ok(backendSource.includes("bool(_STATE.get(\"progress_emit\")) and breakpoint_lines is None"));
});

test("a warm run ignores and resumes a trailing stopped event after it has ended without re-activating debug", () => {
  assert.ok(customConsoleSource.includes("if (!this.debugRunActive) { this.logger?.log(\"debug.direct.stopped.stale\""));
  assert.ok(customConsoleSource.includes('runDebugControl("continue", session, threadId'));
  // The resume's continued event must NOT re-post "running" (which would re-enable the debug controls after the run ended).
  assert.ok(customConsoleSource.includes('debugRun: this.debugRunActive ? 1 : 0, threadId: body.threadId ?? 0 }); if (!this.debugRunActive) { return; } this.postDebugStatus("running", "continued")'));
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

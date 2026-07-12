// Workbench renderer overlay that hosts the Django shell Python editor.
import * as http from "http";
import WebSocket from "ws";
import * as vscode from "vscode";
import { debugInlineRenderKey, debugInlineValueText } from "./debugInlineValues";
import type { DebugFrameInfo } from "./debugInspector";
import { DiagnosticLogger } from "./diagnostics";
import { OverlayMemoryDocument } from "./overlayMemoryDocument";
import { parseHoverLinkTarget, registerOverlayHoverHandshake, samePath } from "./overlayHoverHandshake";
import { OverlayPythonFeatureBridge } from "./overlayPythonFeatureBridge";
import { closeGeneratedOverlayTabs, scheduleGeneratedOverlayTabCleanup } from "./generatedOverlayTabs";
import { OverlayShellCommandController, registerOverlayShellCommand } from "./overlayShellCommand";
import { overlayPreludeText } from "./overlayPrelude";
import { logOverlayRendererPayload } from "./overlayRendererLog";
import { findInspectorUrlForPid, findMainPid, waitForInspectorUrlForPid } from "./workbenchInspector";
import { overlayRendererSource } from "./workbenchOverlayRenderer";
import { mainProcessEvalExpression, parseFocusedWorkbenchCandidate } from "./workbenchWindowEval";
import { mainProcessMouseInputExpression, type WorkbenchMousePoint } from "./workbenchMouseInput";
interface CdpResponse { error?: { message?: string }; id?: number; result?: { exceptionDetails?: { exception?: { description?: string }; text?: string }; result?: { value?: unknown } }; }
type PendingReply = (response: CdpResponse) => void; type RunHandler = (code: string, lineOffset?: number) => Promise<boolean>;
/** Associates one CDP response callback with the socket generation that issued it. */
interface PendingRequest { reply: PendingReply; socket: WebSocket; }
/** Describes the Python cell editor anchor inside the custom webview viewport. */
export interface WorkbenchOverlayGeometry { height: number; left: number; top: number; width: number; }
/** Configures one independently-backed overlay surface and its owning webview panel. */
export interface WorkbenchOverlayProfile { analysisName?: string; contextKey?: string; editorName?: string; executionMode?: "shell" | "submit"; key?: string; panelTitle?: string; }
/** Configures command and extension-lifetime ownership when an overlay is activated. */
export interface WorkbenchOverlayActivationOptions { registerCommands?: boolean; registerWithContext?: boolean; }
const BRIDGE_PATH = "/django-shell-overlay";
const CORS_HEADERS = { "access-control-allow-headers": "content-type,x-django-shell-token", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-origin": "*", "access-control-allow-private-network": "true" };
const CAPTURE_EVALUATE_TIMEOUT_MS = 650;
const CAPTURE_FALLBACK_CLOSE_TIMEOUT_MS = 400;
const CAPTURE_FALLBACK_OPEN_TIMEOUT_MS = 1000;
const CAPTURE_FALLBACK_SETTLE_MS = 50;
const CAPTURE_FALLBACK_TIMEOUT_MS = 1700;
const CAPTURE_PROBE_TIMEOUT_MS = 450;
const CDP_EVALUATE_TIMEOUT_MS = 4500;
const CDP_REQUEST_TIMEOUT_MS = 10000;
const GEOMETRY_SETTLE_MS = 80;
const INITIAL_WINDOW_FOCUS_RETRY_MS = 100;
const RENDERER_EXECUTE_TIMEOUT_MS = 3200;
const RENDERER_RECOVERY_DELAY_MS = 400;
const RENDERER_PATCH_VERSION = 98;
/** Injects and coordinates the Django shell editor overlay in the VS Code workbench renderer. */
export class WorkbenchOverlay implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  private cdpConnectPromise: Promise<void> | undefined;
  private injectPromise: Promise<void> | undefined;
  private messageId = 1;
  private rendererInjected = false;
  private runHandler: RunHandler | undefined;
  private server: http.Server | undefined;
  private serverPort: number | undefined;
  private generatedCleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private readonly token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private workbenchFocusGeneration = 0;
  private workbenchWindowId: number | undefined;
  private ws: WebSocket | undefined;
  private geometry: WorkbenchOverlayGeometry | undefined;
  private geometryFlushInFlight = false;
  private geometryFlushPending = false;
  private geometrySettleTimer: ReturnType<typeof setTimeout> | undefined;
  private geometryTimer: ReturnType<typeof setTimeout> | undefined;
  private lastEvaluationTimeoutAt = 0;
  private debugLineApplied = "";
  private debugLineFlushPromise: Promise<void> | undefined;
  private debugLineTarget = 0;
  private inlineValueText = "";
  private readonly memoryDocument: OverlayMemoryDocument;
  private readonly featureBridge: OverlayPythonFeatureBridge;
  private readonly profile: Required<WorkbenchOverlayProfile>;
  private prelude = ""; private shellCommands: OverlayShellCommandController | undefined;
  private showPromise: Promise<boolean> | undefined;

  /** Stores diagnostics and resolves the backing files and owning panel for this overlay. */
  constructor(private readonly logger?: DiagnosticLogger, profile: WorkbenchOverlayProfile = {}) {
    this.profile = { analysisName: profile.analysisName ?? "analysis", contextKey: profile.contextKey ?? "djangoShell.overlayVisible", editorName: profile.editorName ?? "console-cell", executionMode: profile.executionMode ?? "shell", key: profile.key ?? "console", panelTitle: profile.panelTitle ?? "Django Shell" };
    this.memoryDocument = new OverlayMemoryDocument(logger, this.profile.editorName, this.profile.analysisName);
    this.featureBridge = new OverlayPythonFeatureBridge(this.memoryDocument, logger);
  }

  /** Registers the overlay lifecycle with VS Code. */
  activate(context: vscode.ExtensionContext, runHandler: RunHandler, options: WorkbenchOverlayActivationOptions = {}): void {
    this.runHandler = runHandler;
    this.memoryDocument.activate();
    this.featureBridge.activate();
    this.disposables.push(this.memoryDocument, this.featureBridge);
    this.disposables.push(registerOverlayHoverHandshake(context, { analysisUri: this.memoryDocument.analysisUri, editorUri: this.memoryDocument.editorUri, evaluate: (expression) => this.evalInWorkbench(expression), lineOffset: () => this.memoryDocument.lineOffset(), ownerToken: this.token }));
    this.disposables.push(vscode.window.onDidChangeWindowState(() => { this.workbenchFocusGeneration += 1; }));
    this.shellCommands = registerOverlayShellCommand(this.memoryDocument, runHandler, this.logger, { registerCommands: options.registerCommands !== false });
    this.disposables.push(this.shellCommands);
    if (options.registerCommands !== false) {
      this.disposables.push(vscode.commands.registerCommand("djangoShell.showOverlayEditor", () => this.show()));
      this.disposables.push(vscode.commands.registerCommand("djangoShell.overlayRunCurrentInput", () => this.runCurrentInput()));
    }
    if (options.registerWithContext !== false) { context.subscriptions.push(this); }
  }

  /** Shows the workbench overlay editor and creates it when needed. */
  async show(): Promise<boolean> {
    if (this.shutdownPromise) {
      throw new Error("Django Shell overlay has been disposed.");
    }
    if (this.showPromise) {
      return this.showPromise;
    }
    const pending = this.showNow();
    this.showPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.showPromise === pending) {
        this.showPromise = undefined;
      }
      this.resumeHeldGeometry();
    }
  }

  /** Performs one renderer show transaction; concurrent callers share it through show(). */
  private async showNow(): Promise<boolean> {
    const started = Date.now();
    await this.ensureInjected();
    let report = await this.evalInWorkbench(showExpression(this.geometry, this.token));
    if (report === "overlay-not-installed" || report === "owner-mismatch") { await this.inject(); report = await this.evalInWorkbench(showExpression(this.geometry, this.token)); }
    if (report.includes(":pending") && !report.includes("no-webview-host")) {
      const armReport = await this.evalInWorkbench(captureArmExpression(this.token), CAPTURE_EVALUATE_TIMEOUT_MS).catch((error: unknown) => {
        this.logger?.log("overlay.capture.arm.error", { error: error instanceof Error ? error.message : String(error) });
        return "capture-arm-error";
      });
      const generation = parseCaptureGeneration(armReport);
      if (generation === undefined) {
        this.logger?.log("overlay.capture.lease.error", { report: armReport });
      } else {
        let closeFallback = async (): Promise<void> => undefined;
        try {
          const layoutProbe = Promise.resolve(vscode.commands.executeCommand("vscode.getEditorLayout")).then(() => undefined).catch((error: unknown) => {
            this.logger?.log("overlay.capture.probe.error", { error: error instanceof Error ? error.message : String(error) });
          });
          await Promise.race([layoutProbe, delay(250)]);
          report = await this.waitForOverlayCapture(CAPTURE_PROBE_TIMEOUT_MS, 50);
          if (report.includes(":pending") && !report.includes("no-webview-host")) {
            closeFallback = await this.openCaptureFallbackEditor();
            await this.evalInWorkbench(captureRearmExpression(this.token, generation), CAPTURE_EVALUATE_TIMEOUT_MS).catch((error: unknown) => {
              this.logger?.log("overlay.capture.rearm.error", { error: error instanceof Error ? error.message : String(error), generation });
            });
            const fallbackProbe = Promise.resolve(vscode.commands.executeCommand("vscode.getEditorLayout")).then(() => undefined).catch((error: unknown) => {
              this.logger?.log("overlay.capture.probe.error", { error: error instanceof Error ? error.message : String(error) });
            });
            await Promise.race([fallbackProbe, delay(150)]);
            await delay(CAPTURE_FALLBACK_SETTLE_MS);
            await closeFallback();
            await delay(CAPTURE_FALLBACK_SETTLE_MS);
            report = await this.waitForOverlayCapture(CAPTURE_FALLBACK_TIMEOUT_MS, 75, true);
          }
        } finally {
          await this.evalInWorkbench(captureStopExpression(this.token, generation), CAPTURE_EVALUATE_TIMEOUT_MS).catch((error: unknown) => {
            this.logger?.log("overlay.capture.stop.error", { error: error instanceof Error ? error.message : String(error), generation });
          });
          await closeFallback();
        }
      }
    }
    this.logger?.log("overlay.show", { ms: Date.now() - started, report });
    await Promise.race([closeGeneratedOverlayTabs([this.memoryDocument.analysisUri]).catch(() => undefined), delay(CAPTURE_FALLBACK_CLOSE_TIMEOUT_MS)]);
    scheduleGeneratedOverlayTabCleanup([this.memoryDocument.analysisUri]);
    const visible = report.includes(":editor:");
    void vscode.commands.executeCommand("setContext", this.profile.contextKey, visible);
    void this.queueDebugLineFlush();
    return visible;
  }

  /** Updates the workbench overlay position from the webview cell anchor. */
  updateGeometry(geometry: WorkbenchOverlayGeometry): void {
    this.geometry = geometry;
    this.geometryFlushPending = true;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.rendererTransactionPending()) { return; }
    this.queueGeometryFlush(0);
    clearTimeout(this.geometrySettleTimer);
    this.geometrySettleTimer = setTimeout(() => { this.geometrySettleTimer = undefined; this.queueGeometryFlush(0); }, GEOMETRY_SETTLE_MS);
  }

  /** Queues a geometry update while coalescing rapid scroll measurements. */
  private queueGeometryFlush(delayMs: number): void {
    this.geometryFlushPending = true;
    if (this.geometryFlushInFlight || this.geometryTimer || this.rendererTransactionPending()) { return; }
    if (delayMs <= 0) {
      this.flushGeometry();
      return;
    }
    this.geometryTimer = setTimeout(() => {
      this.geometryTimer = undefined;
      this.flushGeometry();
    }, delayMs);
  }

  /** Applies the latest measured geometry to the renderer overlay. */
  private flushGeometry(): void {
    const geometry = this.geometry;
    if (!geometry || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.rendererTransactionPending()) { return; }
    this.geometryFlushPending = false;
    this.geometryFlushInFlight = true;
    this.logger?.log("overlay.geometry", { height: Math.round(geometry.height), left: Math.round(geometry.left), top: Math.round(geometry.top), width: Math.round(geometry.width) });
    void this.evalInWorkbench(geometryExpression(geometry, this.token)).catch((error: unknown) => { this.logger?.log("overlay.geometry.error", { error: error instanceof Error ? error.message : String(error) }); }).finally(() => {
      this.geometryFlushInFlight = false;
      this.resumeHeldGeometry();
    });
  }

  /** Returns whether a renderer show or patch transaction currently owns the CDP lane. */
  private rendererTransactionPending(): boolean {
    return Boolean(this.showPromise || this.injectPromise);
  }

  /** Resumes one coalesced geometry update after renderer work and timeout cooldowns settle. */
  private resumeHeldGeometry(): void {
    if (!this.geometryFlushPending || this.geometryFlushInFlight || this.geometryTimer || this.rendererTransactionPending() || this.ws?.readyState !== WebSocket.OPEN) { return; }
    const cooldown = Math.max(0, this.lastEvaluationTimeoutAt + RENDERER_RECOVERY_DELAY_MS - Date.now());
    this.queueGeometryFlush(cooldown);
  }

  /** Updates editor-only hidden imports without changing raw analysis text. */
  async updatePrelude(importLines: string[]): Promise<void> {
    const nextPrelude = overlayPreludeText(importLines);
    if (nextPrelude === this.prelude) {
      return;
    }
    this.prelude = nextPrelude; this.featureBridge.invalidateCompletions();
    await this.memoryDocument.updatePrelude(this.prelude); this.featureBridge.refreshSemanticTokens();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return; }
    const report = await this.evalInWorkbench(preludeExpression(this.prelude, this.token)).catch((error: unknown) => {
      this.logger?.log("overlay.prelude.error", { error: error instanceof Error ? error.message : String(error) });
      return "";
    });
    this.logger?.log("overlay.prelude.renderer", { report });
  }

  /** Updates the highlighted paused debugger line inside the overlay editor. */
  async updateDebugInfo(info: DebugFrameInfo): Promise<void> {
    // Keep the last paused line highlighted through the transient "running" state between steps: clearing it there and
    // re-adding it on the next stop makes the current-line marker blink on every step. It moves on the next "paused" and
    // clears only when the run ends (idle/error).
    if (info.state === "running") {
      return;
    }
    const visibleLine = info.state === "paused" && info.frame && this.isOverlayFrame(info.frame.path) ? info.frame.line : 0;
    this.debugLineTarget = visibleLine >= 1 ? visibleLine : 0;
    this.inlineValueText = visibleLine > 0 ? debugInlineValueText(info.scopes) : "";
    await this.queueDebugLineFlush();
  }

  /** Coalesces debug-line updates so rapid stepping sends only the latest renderer target. */
  private queueDebugLineFlush(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.rendererInjected || this.debugLineApplied === debugInlineRenderKey(this.debugLineTarget, this.inlineValueText)) {
      return Promise.resolve();
    }
    if (this.debugLineFlushPromise) {
      return this.debugLineFlushPromise;
    }
    let mayContinue = false;
    const pending = this.flushDebugLine().then((completed) => { mayContinue = completed; }).finally(() => {
      if (this.debugLineFlushPromise === pending) {
        this.debugLineFlushPromise = undefined;
      }
      if (mayContinue && this.ws?.readyState === WebSocket.OPEN && this.rendererInjected && this.debugLineApplied !== debugInlineRenderKey(this.debugLineTarget, this.inlineValueText)) {
        void this.queueDebugLineFlush();
      }
    });
    this.debugLineFlushPromise = pending;
    return pending;
  }

  /** Applies coalesced debug-line targets serially, skipping intermediate lines superseded during a CDP round trip. */
  private async flushDebugLine(): Promise<boolean> {
    while (this.ws?.readyState === WebSocket.OPEN && this.rendererInjected && this.debugLineApplied !== debugInlineRenderKey(this.debugLineTarget, this.inlineValueText)) {
      const target = this.debugLineTarget, inline = this.inlineValueText, key = debugInlineRenderKey(target, inline);
      try {
        const report = await this.evalInWorkbench(debugLineExpression(target, inline, this.token));
        if (report === "owner-mismatch" || report.includes("missing")) {
          return false;
        }
        this.debugLineApplied = key;
      } catch (error) {
        this.logger?.log("overlay.debug.info.error", { error: error instanceof Error ? error.message : String(error) });
        const superseded = key !== debugInlineRenderKey(this.debugLineTarget, this.inlineValueText);
        if (superseded && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) {
          await this.ensureCdpSocket().catch(() => undefined);
        }
        return superseded;
      }
    }
    return this.debugLineApplied === debugInlineRenderKey(this.debugLineTarget, this.inlineValueText);
  }

  /** Mirrors the one-based lines that have breakpoints into overlay glyph-margin dots so users can see where breakpoints are set. */
  async updateBreakpoints(lines: number[]): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.rendererInjected) {
      return;
    }
    await this.evalInWorkbench(breakpointsExpression(lines, this.token)).catch((error: unknown) => {
      this.logger?.log("overlay.breakpoints.error", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Reads the current user-visible overlay text from the renderer when possible. */
  async currentVisibleText(): Promise<string> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.rendererInjected) {
      return this.memoryDocument.visibleText();
    }
    const raw = await this.evalInWorkbench(visibleTextReadExpression(this.token)).catch(() => "");
    try {
      const payload = JSON.parse(raw) as { ok?: boolean; text?: string };
      if (payload.ok && typeof payload.text === "string") {
        await this.memoryDocument.sync(payload.text);
        return payload.text;
      }
    } catch {
      // Fall back to the host copy when the renderer response is not JSON.
    }
    const modelRaw = await this.evalInWorkbench(modelTextReadExpression(this.token)).catch(() => "");
    try {
      const payload = JSON.parse(modelRaw) as { ok?: boolean; text?: string };
      if (payload.ok && typeof payload.text === "string") {
        await this.memoryDocument.sync(payload.text);
        return this.memoryDocument.visibleText();
      }
    } catch {
      // Fall back to the host copy when the renderer response is not JSON.
    }
    return this.memoryDocument.visibleText();
  }

  /** Replaces the user-visible overlay text without exposing generated prelude lines. */
  async replaceVisibleText(text: string): Promise<void> {
    await this.memoryDocument.sync(text);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.rendererInjected) {
      return;
    }
    await this.evalInWorkbench(visibleTextWriteExpression(text, this.token)).catch((error: unknown) => {
      this.logger?.log("overlay.text.replace.error", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Synchronizes the full visible editor text into backing files without changing renderer contents. */
  async syncVisibleText(text: string, focusLine?: number): Promise<void> {
    await this.memoryDocument.sync(text, focusLine);
  }

  /** Returns the full generated source file text used by debugpy breakpoint binding. */
  async currentSourceText(): Promise<string> {
    await this.currentVisibleText().catch(() => undefined);
    return this.memoryDocument.fullText();
  }

  /** Posts a backend execution result to the overlay output area. */
  async postOutput(text: string, ok: boolean): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    await this.evalInWorkbench(outputExpression(text, ok, this.token)).catch((error: unknown) => {
      this.logger?.log("overlay.output.error", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Hides the renderer overlay while keeping editor and bridge state alive. */
  park(): void { void this.parkRendererOverlay(); }

  /** Hides the renderer overlay without destroying its reusable Monaco editor. */
  hide(): void { void this.parkRendererOverlay(); }

  /** Clears overlay text and generated prelude for a fresh backend session. */
  async reset(): Promise<void> { this.prelude = ""; this.debugLineTarget = 0; this.inlineValueText = ""; this.debugLineApplied = ""; await this.memoryDocument.reset(); void vscode.commands.executeCommand("setContext", this.profile.contextKey, false); if (this.ws?.readyState === WebSocket.OPEN) { await this.evalInWorkbench(resetExpression(this.memoryDocument.visibleText(), this.token)).catch((error: unknown) => { this.logger?.log("overlay.reset.error", { error: error instanceof Error ? error.message : String(error) }); }); } }

  /** Asks the renderer-owned overlay editor to run the current cursor execution unit. */
  async runCurrentInput(): Promise<string> { await this.ensureInjected(); const raw = await this.evalInWorkbench("(function(){const root=document.getElementById('django-shell-overlay');const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(!root||!editor||!model){return JSON.stringify({ok:false,reason:'missing-overlay'});}const payload=root.__dsoCurrentInputPayload?root.__dsoCurrentInputPayload():{code:''};const code=String(payload&&payload.code||'');const rawStart=payload&&payload.range?Number(payload.range.start)||1:1;const inputStart=Number(root.__dsoInputStartLine)||1;const start=Math.max(1,rawStart-inputStart+1);return JSON.stringify({code,ok:!!code.trim(),reason:code.trim()?undefined:'empty',start,text:String(model.getValue&&model.getValue()||'')});})()").catch((error: unknown) => JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : String(error) })); const payload = JSON.parse(raw) as { code?: string; ok?: boolean; start?: number; text?: string }; if (payload.ok && typeof payload.code === "string") { if (typeof payload.text === "string") { await this.memoryDocument.sync(payload.text, (payload.start ?? 1) - 1); } await this.runHandler?.(payload.code, this.relativeLineOffset(payload.start ?? 1)).catch((error: unknown) => { this.logger?.log("overlay.command.rerun.error", { error: error instanceof Error ? error.message : String(error) }); return false; }); this.logger?.log("overlay.command.rerun.host", { chars: payload.code.length, start: payload.start ?? 1 }); return "host-requested"; } const report = await this.evalInWorkbench("window.__dsoRunCurrentOverlayInput ? window.__dsoRunCurrentOverlayInput() : 'missing-runner'").catch((error: unknown) => `error:${error instanceof Error ? error.message : String(error)}`); this.logger?.log("overlay.command.rerun.eval", { report }); return report; }
  /** Asks the renderer-owned overlay editor to skip the current cursor execution unit. */
  async skipCurrentInput(): Promise<string> { await this.ensureInjected(); const raw = await this.evalInWorkbench("(function(){const root=document.getElementById('django-shell-overlay');const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(!root||!editor||!model){return JSON.stringify({ok:false,reason:'missing-overlay'});}const result=window.__dsoSkipCurrentOverlayInput?window.__dsoSkipCurrentOverlayInput():'missing-runner';return JSON.stringify({ok:result==='skipped',reason:result,text:String(model.getValue&&model.getValue()||'')});})()").catch((error: unknown) => JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : String(error) })); const payload = JSON.parse(raw) as { ok?: boolean; reason?: string; text?: string }; if (typeof payload.text === "string") { await this.memoryDocument.sync(payload.text); } if (!payload.ok) { await this.skipInput(); } this.logger?.log("overlay.command.skip.host", { ok: !!payload.ok, reason: payload.reason ?? "" }); return payload.reason ?? (payload.ok ? "skipped" : "empty"); }
  /** Runs the active file-backed overlay input command. */ async acceptInput(): Promise<void> { await this.shellCommands?.acceptInput(); }
  /** Inserts an indented continuation line in the file-backed overlay command. */ async insertNewline(): Promise<void> { await this.shellCommands?.insertNewline(); }
  /** Moves past the active file-backed overlay input command without running it. */ async skipInput(): Promise<void> { await this.shellCommands?.skipInput(); }
  /** Evaluates a renderer expression for extension host E2E tests. */
  async e2eEvaluate(expression: string): Promise<string> { await this.ensureInjected(); return this.evalInWorkbench(expression); }

  /** Moves the real workbench renderer mouse for extension-host hover E2E tests. */
  async e2eDispatchMouse(points: WorkbenchMousePoint[]): Promise<unknown> {
    await this.ensureInjected();
    if (!this.workbenchWindowId) { await this.evalInWorkbench("'mouse-input-target-ready'"); }
    if (!this.workbenchWindowId) { return { ok: false, reason: "missing-workbench-window-id" }; }
    await this.ensureCdpSocket();
    const response = await this.send("Runtime.evaluate", { awaitPromise: true, expression: mainProcessMouseInputExpression(this.workbenchWindowId, points), returnByValue: true }, CDP_REQUEST_TIMEOUT_MS);
    if (response.error?.message) { return { ok: false, reason: response.error.message }; }
    if (response.result?.exceptionDetails) { return { ok: false, reason: response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text || "mouse-input-exception" }; }
    return response.result?.result?.value;
  }

  /** Disposes the bridge and renderer overlay asynchronously. */
  dispose(): void { void this.shutdown(); }

  /** Tears down renderer and extension-host resources in dependency order. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shutdownPromise = this.shutdownNow();
    return this.shutdownPromise;
  }

  /** Runs the one-shot shutdown sequence for this overlay instance. */
  private async shutdownNow(): Promise<void> {
    await this.disposeRendererOverlay(true, "overlay.dispose.error");
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.closeServer();
    clearTimeout(this.generatedCleanupTimer); clearTimeout(this.geometrySettleTimer); clearTimeout(this.geometryTimer); this.closeSocket("dispose");
  }

  /** Requests renderer-owned overlay cleanup before local bridge resources vanish. */
  private async disposeRendererOverlay(reconnect: boolean, errorEvent: string): Promise<void> {
    void vscode.commands.executeCommand("setContext", this.profile.contextKey, false);
    if (!reconnect && this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    if (reconnect && this.ws?.readyState !== WebSocket.OPEN && !this.rendererInjected) {
      return;
    }
    try {
      if (reconnect && this.ws?.readyState !== WebSocket.OPEN) {
        await this.ensureCdpSocket();
      }
      const report = await this.evalInWorkbench(disposeExpression(this.token));
      this.logger?.log("overlay.dispose.renderer", { report });
    } catch (error) {
      this.logger?.log(errorEvent, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.debugLineApplied = "";
    }
  }

  /** Temporarily hides renderer-owned overlay DOM without disposing Monaco resources. */
  private async parkRendererOverlay(): Promise<void> {
    void vscode.commands.executeCommand("setContext", this.profile.contextKey, false);
    if (!this.rendererInjected) {
      return;
    }
    try {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        await this.ensureCdpSocket();
      }
      const report = await this.evalInWorkbench(parkExpression(this.token));
      this.logger?.log("overlay.park.renderer", { report });
    } catch (error) {
      this.logger?.log("overlay.park.error", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Ensures the local bridge and renderer patch are available. */
  private async ensureInjected(): Promise<void> {
    await this.ensureServer();
    await this.ensureCdpSocket();
    if (this.rendererInjected) { return; }
    await this.inject();
  }

  /** Runs one renderer patch transaction and shares it across concurrent callers. */
  private async inject(): Promise<void> {
    if (this.injectPromise) {
      return this.injectPromise;
    }
    const pending = this.injectNow();
    this.injectPromise = pending;
    try {
      await pending;
    } finally {
      if (this.injectPromise === pending) { this.injectPromise = undefined; }
      this.resumeHeldGeometry();
    }
  }

  /** Connects to the main-process inspector and injects the overlay patch. */
  private async injectNow(): Promise<void> {
    const bridge = await this.ensureServer();
    await this.ensureCdpSocket();
    const report = await this.evalInWorkbench(patchExpression(bridge.port, bridge.token, this.memoryDocument.editorUri.toString(), this.memoryDocument.visibleText(), this.geometry, this.prelude, this.profile.panelTitle, this.profile.executionMode));
    if (!report.includes("django-shell-overlay-shown")) {
      throw new Error(`overlay patch failed: ${report}`);
    }
    this.rendererInjected = true;
    this.debugLineApplied = "";
    this.logger?.log("overlay.inject", { key: this.profile.key, report });
  }
  /** Debounces generated tab cleanup after overlay input settles. */
  private scheduleGeneratedCleanup(): void { clearTimeout(this.generatedCleanupTimer); this.generatedCleanupTimer = setTimeout(() => { void closeGeneratedOverlayTabs([this.memoryDocument.analysisUri, this.memoryDocument.editorUri]).catch(() => undefined); }, 450); }
  /** Converts a one-based user-input line into the backing console-cell.py line offset. */
  private relativeLineOffset(relativeLine: unknown): number | undefined { return typeof relativeLine === "number" && Number.isFinite(relativeLine) ? Math.max(0, Math.floor(relativeLine) - 1) : undefined; }

  /** Opens one hover markdown link: generated-file targets reveal inside the overlay, real files open beside the console. */
  private async openHoverLink(href: string): Promise<void> {
    const target = parseHoverLinkTarget(href);
    if (!target) {
      return;
    }
    if (samePath(target.uri.fsPath, this.memoryDocument.analysisUri.fsPath)) {
      await this.revealOverlayLine(target.line - this.memoryDocument.lineOffset(), target.column);
      return;
    }
    if (samePath(target.uri.fsPath, this.memoryDocument.editorUri.fsPath)) {
      await this.revealOverlayLine(target.line, target.column);
      return;
    }
    const document = await vscode.workspace.openTextDocument(target.uri);
    const position = new vscode.Position(Math.max(0, target.line - 1), Math.max(0, target.column - 1));
    await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(position, position), viewColumn: vscode.ViewColumn.Beside });
  }

  /** Moves the overlay cursor to one visible line so generated-file link targets resolve in place. */
  private async revealOverlayLine(line: number, column: number): Promise<void> {
    const safeLine = Math.max(1, Math.floor(line) || 1);
    const safeColumn = Math.max(1, Math.floor(column) || 1);
    await this.ensureInjected();
    const report = await this.evalInWorkbench(`(function(){const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;if(!editor||!editor.setPosition){return "no-overlay";}const position={lineNumber:${safeLine},column:${safeColumn}};try{editor.setPosition(position);editor.revealPositionInCenterIfOutsideViewport&&editor.revealPositionInCenterIfOutsideViewport(position);editor.focus&&editor.focus();}catch(eReveal){return "reveal-error:"+String(eReveal&&eReveal.message||eReveal);}return "ok";})()`);
    this.logger?.log("overlay.openLink.reveal", { column: safeColumn, line: safeLine, report });
  }
  /** Returns whether a paused frame belongs to this overlay's generated source file. */
  private isOverlayFrame(pathOrUri: string | undefined): boolean { const normalized = normalizeFramePath(pathOrUri); return !!normalized && normalized === this.memoryDocument.editorUri.fsPath; }
  /** Starts the local HTTP bridge used by the renderer run button. */
  private async ensureServer(): Promise<{ port: number; token: string }> {
    if (this.server && this.serverPort !== undefined) {
      return { port: this.serverPort, token: this.token };
    }
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleBridgeRequest(req, res);
      });
      server.on("close", () => {
        if (this.server === server) {
          this.server = undefined;
          this.serverPort = undefined;
        }
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("overlay bridge did not receive a port"));
          return;
        }
        server.removeListener("error", reject);
        this.server = server;
        this.serverPort = address.port;
        resolve();
      });
    });
    return { port: this.serverPort!, token: this.token };
  }

  /** Handles one renderer-to-extension bridge request. */
  private async handleBridgeRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS).end();
        return;
      }
      const requestUrl = new URL(req.url ?? "", "http://127.0.0.1");
      const requestToken = req.headers["x-django-shell-token"] ?? requestUrl.searchParams.get("token");
      if (req.method !== "POST" || requestUrl.pathname !== BRIDGE_PATH || requestToken !== this.token) {
        res.writeHead(404, CORS_HEADERS).end();
        return;
      }
      const payload = JSON.parse(await readRequestBody(req));
      if (payload?.type === "log") {
        logOverlayRendererPayload(this.logger, payload);
      }
      if (payload?.type === "change" && typeof payload.code === "string") {
        this.logger?.log("overlay.bridge.change", textFields(payload.code));
        await this.memoryDocument.syncVolatile(payload.code);
      }
      if (payload?.type === "openLink" && typeof payload.href === "string") {
        this.logger?.log("overlay.bridge.openLink", { href: payload.href.slice(0, 300) });
        void this.openHoverLink(payload.href).catch((error: unknown) => this.logger?.log("overlay.openLink.error", { error: error instanceof Error ? error.message : String(error) }));
        res.writeHead(204, CORS_HEADERS).end();
        return;
      }
      if (payload?.type === "run" && typeof payload.code === "string") {
        this.logger?.log("overlay.bridge.run", { ...textFields(payload.code), fullText: typeof payload.text === "string" ? textFields(payload.text).lines : 0 });
        const range = payload.range as { start?: unknown } | undefined;
        await this.memoryDocument.sync(typeof payload.text === "string" ? payload.text : payload.code, this.relativeLineOffset(range?.start)); this.scheduleGeneratedCleanup();
        const lineOffset = this.relativeLineOffset(range?.start);
        const executed = await this.runHandler?.(payload.code, lineOffset).catch((error: unknown) => {
          this.logger?.log("overlay.bridge.run.error", { error: error instanceof Error ? error.message : String(error) });
          return false;
        });
        if (!res.destroyed) { res.writeHead(200, { ...CORS_HEADERS, "content-type": "application/json" }).end(JSON.stringify({ executed: Boolean(executed) })); }
        return;
      }
      res.writeHead(204, CORS_HEADERS).end();
    } catch (error) {
      this.logger?.log("overlay.bridge.error", { error: error instanceof Error ? error.message : String(error) });
      try {
        res.writeHead(500, CORS_HEADERS).end();
      } catch {
        // Response may already be closed by the renderer.
      }
    }
  }

  /** Ensures the CDP WebSocket for the Electron main process is open. */
  private async ensureCdpSocket(): Promise<void> {
    if (this.cdpConnectPromise) {
      return this.cdpConnectPromise;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    const pending = this.connectCdpSocket();
    this.cdpConnectPromise = pending;
    try {
      await pending;
    } finally {
      if (this.cdpConnectPromise === pending) { this.cdpConnectPromise = undefined; }
    }
  }

  /** Opens and enables one generation-bound CDP connection to the Electron main process. */
  private async connectCdpSocket(): Promise<void> {
    const pid = findMainPid();
    if (!pid) {
      throw new Error("Could not locate VS Code main process.");
    }
    let inspector = await findInspectorUrlForPid(pid, 1);
    let url = inspector.url;
    if (!url) {
      process.kill(pid, "SIGUSR1");
      inspector = await waitForInspectorUrlForPid(pid);
      url = inspector.url;
    }
    if (!url) {
      throw new Error(`VS Code main inspector did not open for pid ${pid}; attempts=${inspector.attempts}.`);
    }
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    this.ws = socket;
    socket.on("message", (data) => this.handleSocketMessage(data, socket));
    socket.on("close", () => this.retireSocket(socket, "closed"));
    socket.on("error", (error) => this.retireSocket(socket, `error:${error.message}`));
    const response = await this.send("Runtime.enable", {}, CDP_REQUEST_TIMEOUT_MS);
    if (response.error?.message) {
      this.retireSocket(socket, "enable-failed");
      throw new Error(response.error.message);
    }
  }

  /** Evaluates JavaScript inside the focused workbench renderer. */
  private async evalInWorkbench(expression: string, rendererTimeoutMs = RENDERER_EXECUTE_TIMEOUT_MS): Promise<string> {
    await this.ensureCdpSocket();
    const cdpTimeoutMs = Math.min(CDP_EVALUATE_TIMEOUT_MS, Math.max(1200, rendererTimeoutMs + 800));
    const focusGeneration = this.workbenchFocusGeneration;
    let focusedClaimId: number | undefined;
    let raw = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (focusedClaimId !== undefined && (!vscode.window.state.focused || focusGeneration !== this.workbenchFocusGeneration)) { return "stale-focused-workbench-candidate"; }
      const requestedWindowId = this.workbenchWindowId ?? focusedClaimId;
      const allowFocusedPanelClaim = requestedWindowId === undefined && vscode.window.state.focused && focusGeneration === this.workbenchFocusGeneration;
      const script = mainProcessEvalExpression(expression, requestedWindowId, rendererTimeoutMs, this.token, this.profile.panelTitle, vscode.workspace.name ?? "", allowFocusedPanelClaim);
      const response = await this.send("Runtime.evaluate", {
        awaitPromise: true,
        expression: script,
        includeCommandLineAPI: true,
        returnByValue: true
      }, cdpTimeoutMs);
      if (response.error?.message) {
        if (isEvaluationTimeoutMessage(response.error.message)) { this.lastEvaluationTimeoutAt = Date.now(); }
        throw new Error(response.error.message);
      }
      const exception = response.result?.exceptionDetails;
      if (exception) {
        throw new Error(exception.exception?.description || exception.text || "CDP Runtime.evaluate failed.");
      }
      const responseText = String(response.result?.result?.value ?? "");
      const focusedCandidate = parseFocusedWorkbenchCandidate(responseText);
      if (focusedCandidate !== undefined) {
        if (!allowFocusedPanelClaim || !vscode.window.state.focused || focusGeneration !== this.workbenchFocusGeneration) { return "stale-focused-workbench-candidate"; }
        focusedClaimId = focusedCandidate;
        continue;
      }
      raw = this.recordWorkbenchWindow(responseText);
      if (attempt === 0 && requestedWindowId === undefined && allowFocusedPanelClaim && /^(?:no-focused-workbench-window:|unclaimed-panel-workbench-window:|ambiguous-(?:panel|workspace)-workbench-window:)/.test(raw)) {
        await delay(INITIAL_WINDOW_FOCUS_RETRY_MS);
        continue;
      }
      if (raw.startsWith("renderer-execute-timeout:")) {
        this.lastEvaluationTimeoutAt = Date.now();
        throw new Error(`Renderer transport timed out after ${raw.slice("renderer-execute-timeout:".length)}ms.`);
      }
      return raw;
    }
    return raw;
  }

  /** Remembers the BrowserWindow id selected during the first successful overlay evaluation. */
  private recordWorkbenchWindow(raw: string): string {
    const match = /^__DSO_WINDOW_ID__:(\d+)\n([\s\S]*)$/.exec(raw);
    if (!match) {
      return raw;
    }
    this.workbenchWindowId = Number(match[1]);
    return match[2] ?? "";
  }

  /** Sends one CDP request and waits for its response. */
  private async send(method: string, params: Record<string, unknown>, timeoutMs = method === "Runtime.evaluate" ? CDP_EVALUATE_TIMEOUT_MS : CDP_REQUEST_TIMEOUT_MS): Promise<CdpResponse> {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("CDP WebSocket is not open.");
    }
    const id = this.messageId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<CdpResponse>((resolve) => {
      const timer = setTimeout(() => {
        const request = this.pending.get(id);
        if (!request || request.socket !== socket) { return; }
        this.pending.delete(id);
        resolve({ error: { message: `CDP request timed out: ${method}` }, id });
        this.retireSocket(socket, `timeout:${method}`);
      }, timeoutMs);
      const reply = (response: CdpResponse) => {
        clearTimeout(timer);
        resolve(response);
      };
      this.pending.set(id, { reply, socket });
      try {
        socket.send(payload);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ error: { message: error instanceof Error ? error.message : String(error) }, id });
        this.retireSocket(socket, `send-failed:${method}`);
      }
    });
  }

  /** Routes one CDP WebSocket message to the pending caller. */
  private handleSocketMessage(data: WebSocket.RawData, socket: WebSocket): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(String(data)) as CdpResponse;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const request = this.pending.get(message.id);
      if (!request || request.socket !== socket) { return; }
      this.pending.delete(message.id);
      request.reply(message);
    }
  }

  /** Closes the local renderer bridge. */
  private closeServer(): void {
    try {
      this.server?.close();
    } catch {
      // The server may already be closed during VS Code shutdown.
    }
    this.server = undefined;
    this.serverPort = undefined;
  }

  /** Closes the CDP socket and rejects pending requests. */
  private closeSocket(reason: string): void {
    const socket = this.ws;
    if (socket) { this.retireSocket(socket, reason); }
  }

  /** Retires one CDP socket generation without disturbing a newer live connection. */
  private retireSocket(socket: WebSocket, reason: string): void {
    for (const [id, request] of this.pending) {
      if (request.socket !== socket) { continue; }
      this.pending.delete(id);
      request.reply({ error: { message: `CDP socket closed: ${reason}` }, id });
    }
    if (this.ws === socket) { this.ws = undefined; }
    try {
      if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) { socket.close(); }
    } catch {
      // The socket may already be closed by the inspector.
    }
  }

  /** Opens the existing file-backed analysis document only when service-map probing cannot find an editor widget. */
  private async openCaptureFallbackEditor(): Promise<() => Promise<void>> {
    const preExisting = snapshotTabUris();
    const uri = this.memoryDocument.analysisUri;
    const document = await vscode.workspace.openTextDocument(uri);
    const close = async (): Promise<void> => this.closeCaptureFallbackEditor(uri, preExisting);
    const shown = Promise.resolve().then(() => vscode.window.showTextDocument(document, {
      preserveFocus: true,
      preview: true,
      viewColumn: vscode.ViewColumn.Active
    }));
    const outcome = await Promise.race([
      shown.then(() => ({ state: "shown" as const }), (error: unknown) => ({ error, state: "rejected" as const })),
      delay(CAPTURE_FALLBACK_OPEN_TIMEOUT_MS).then(() => ({ state: "timeout" as const }))
    ]);
    if (outcome.state === "shown") { return close; }
    scheduleGeneratedOverlayTabCleanup([uri]);
    void shown.then(close, close).catch((error: unknown) => this.logger?.log("overlay.capture.fallback.late-close.error", { error: error instanceof Error ? error.message : String(error) }));
    await close();
    if (outcome.state === "rejected") { throw outcome.error; }
    throw new Error(`Overlay capture fallback timed out after ${CAPTURE_FALLBACK_OPEN_TIMEOUT_MS}ms.`);
  }

  /** Closes only an introduced fallback tab within a deadline and schedules retries for late workbench changes. */
  private async closeCaptureFallbackEditor(uri: vscode.Uri, preExisting: Set<string>): Promise<void> {
    scheduleGeneratedOverlayTabCleanup([uri]);
    const closing = Promise.resolve().then(async () => {
      const tabs = introducedTabs(uri, preExisting);
      if (tabs.length) { await vscode.window.tabGroups.close(tabs, true); }
    }).catch((error: unknown) => this.logger?.log("overlay.capture.fallback.close.error", { error: error instanceof Error ? error.message : String(error) }));
    await Promise.race([closing, delay(CAPTURE_FALLBACK_CLOSE_TIMEOUT_MS)]);
  }

  /** Polls for a live overlay editor within one bounded capture phase. */
  private async waitForOverlayCapture(timeoutMs: number, pollMs: number, retryMissingHost = false): Promise<string> {
    const started = Date.now();
    let report = "";
    while (Date.now() - started < timeoutMs) {
      const remaining = Math.max(100, timeoutMs - (Date.now() - started));
      try {
        report = await this.evalInWorkbench(showExpression(this.geometry, this.token), Math.min(CAPTURE_EVALUATE_TIMEOUT_MS, remaining));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isRendererTransportTimeout(error) && !isEvaluationTimeoutMessage(message)) { throw error; }
      }
      if (report.includes(":editor:") || (!retryMissingHost && report.includes("no-webview-host"))) {
        return report;
      }
      const delayMs = Math.min(pollMs, Math.max(0, timeoutMs - (Date.now() - started)));
      if (delayMs > 0) { await delay(delayMs); }
    }
    return report || "django-shell-overlay-shown:pending:capture-timeout";
  }
}

/** Reads a bounded HTTP request body. */
async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 2_000_000) {
      throw new Error("overlay bridge request is too large");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Waits without blocking the extension host event loop. */
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Extracts a positive renderer generation from an acknowledged capture lease. */
function parseCaptureGeneration(report: string): number | undefined {
  const match = /^capture-(?:armed|ready):(\d+)$/.exec(report.trim());
  const generation = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(generation) && generation > 0 ? generation : undefined;
}

/** Returns whether a CDP or renderer transport diagnostic represents a deadline expiry. */
function isEvaluationTimeoutMessage(message: string): boolean { return /timed out/i.test(message); }

/** Returns whether a failed capture poll hit only its bounded renderer IPC deadline. */
function isRendererTransportTimeout(error: unknown): boolean { return error instanceof Error && error.message.startsWith("Renderer transport timed out after "); }

/** Returns compact size fields for text diagnostics. */
function textFields(text: string): { chars: number; lines: number } { return { chars: text.length, lines: text ? text.split(/\r?\n/).length : 0 }; }

/** Converts a DAP source path or file URI into a filesystem path for frame matching. */
function normalizeFramePath(pathOrUri: string | undefined): string {
  if (!pathOrUri) {
    return "";
  }
  if (/^file:\/\//i.test(pathOrUri)) {
    try {
      return vscode.Uri.parse(pathOrUri).fsPath;
    } catch {
      return pathOrUri;
    }
  }
  return pathOrUri;
}

/** Returns URI strings for tabs that already existed before warmup. */
function snapshotTabUris(): Set<string> {
  const uris = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const uri = tabUri(tab);
      if (uri) {
        uris.add(uri.toString());
      }
    }
  }
  return uris;
}

/** Returns tabs introduced for the warmup URI. */
function introducedTabs(uri: vscode.Uri, preExisting: Set<string>): vscode.Tab[] {
  const out: vscode.Tab[] = [];
  const target = uri.toString();
  if (preExisting.has(target)) {
    return out;
  }
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tabUri(tab)?.toString() === target) {
        out.push(tab);
      }
    }
  }
  return out;
}

/** Extracts a URI from a text-like tab input. */
function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input as { uri?: vscode.Uri };
  return input?.uri;
}

/** Returns the renderer patch expression with bridge settings baked in. */
function patchExpression(port: number, token: string, modelUri: string, initialText: string, geometry: WorkbenchOverlayGeometry | undefined, prelude: string, panelTitle: string, executionMode: "shell" | "submit"): string {
  return `
    (function () {
      try {
        var stale = document.getElementById("django-shell-overlay");
        if (stale && stale.__dsoOwnerToken !== ${JSON.stringify(token)}) {
          if (window.__dsoDisposeOverlay) { window.__dsoDisposeOverlay(stale, true); }
          else if (stale.parentElement) { stale.parentElement.removeChild(stale); }
        }
        var staleWidgets = document.getElementById("django-shell-overlay-widget-root");
        if (staleWidgets && String(staleWidgets.dataset && staleWidgets.dataset.djangoShellOverlayOwner || "") !== ${JSON.stringify(token)}) { staleWidgets.remove(); }
      } catch (eStaleOverlay) {}
      delete window.__dsoPendingOverlayVisibleText;
      delete window.__dsoPendingOverlayOwnerToken; window.__dsoOverlayDebugLine = 0; window.__dsoOverlayDebugInlineText = "";
      window.__djangoShellOverlayBridge = { port: ${JSON.stringify(port)}, token: ${JSON.stringify(token)} };
      window.__djangoShellOverlayModelUri = ${JSON.stringify(modelUri)};
      window.__djangoShellOverlayOwnerToken = ${JSON.stringify(token)};
      window.__djangoShellOverlayInitialText = ${JSON.stringify(initialText)};
      window.__djangoShellOverlayUseVisiblePrelude = false;
      window.__djangoShellOverlayGeometry = ${JSON.stringify(geometry ?? null)};
      window.__djangoShellOverlayPrelude = ${JSON.stringify(prelude)};
      window.__djangoShellOverlayPatched = true;
      window.__djangoShellOverlayPatchVersion = ${RENDERER_PATCH_VERSION};
      ${overlayRendererSource(modelUri, { executionMode, panelTitle })}
      return window.__djangoShellOverlayShow(window.__djangoShellOverlayGeometry, ${JSON.stringify(token)});
    })()
  `.trim();
}
/** Returns the expression that makes the overlay visible. */
function showExpression(geometry: WorkbenchOverlayGeometry | undefined, token: string): string { return `window.__djangoShellOverlayShow ? window.__djangoShellOverlayShow(${JSON.stringify(geometry ?? null)}, ${JSON.stringify(token)}) : 'overlay-not-installed'`; }
/** Returns the expression that freshly arms a generation-bound renderer capture lease. */
function captureArmExpression(token: string): string { return `window.__dsoArmOverlayCapture ? window.__dsoArmOverlayCapture(${JSON.stringify(token)}) : 'overlay-capture-missing'`; }
/** Returns the expression that rearms exact DI lookup for the file-backed fallback phase. */
function captureRearmExpression(token: string, generation: number): string { return `window.__dsoRearmOverlayServiceLookup ? window.__dsoRearmOverlayServiceLookup(${JSON.stringify(token)}, ${JSON.stringify(generation)}) : 'overlay-capture-missing'`; }
/** Returns the expression that stops only the renderer capture generation owned by this transaction. */
function captureStopExpression(token: string, generation: number): string { return `window.__dsoStopOverlayCapture ? window.__dsoStopOverlayCapture(${JSON.stringify(token)}, ${JSON.stringify(generation)}) : 'overlay-capture-missing'`; }
/** Returns the expression that moves the overlay to the latest webview anchor. */
function geometryExpression(geometry: WorkbenchOverlayGeometry, token: string): string { return `window.__djangoShellOverlaySetGeometry ? window.__djangoShellOverlaySetGeometry(${JSON.stringify(geometry)}, ${JSON.stringify(token)}) : 'overlay-not-installed'`; }

/** Returns the expression that updates hidden Python prelude imports. */
function preludeExpression(prelude: string, token: string): string { return `window.__djangoShellOverlaySetPrelude ? window.__djangoShellOverlaySetPrelude(${JSON.stringify(prelude)}, ${JSON.stringify(token)}) : 'overlay-not-installed'`; }

/** Returns the expression that renders the latest Python execution output. */
function outputExpression(text: string, ok: boolean, token: string): string { return `window.__djangoShellOverlaySetOutput ? window.__djangoShellOverlaySetOutput(${JSON.stringify(text)}, ${JSON.stringify(ok)}, ${JSON.stringify(token)}) : 'overlay-not-installed'`; }

/** Returns the expression that refreshes the paused debugger line marker. */
function debugLineExpression(visibleLine: number, inlineText: string, token: string): string { return `window.__dsoSetOverlayDebugLine ? window.__dsoSetOverlayDebugLine(${JSON.stringify(visibleLine)}, ${JSON.stringify(inlineText)}, ${JSON.stringify(token)}) : 'overlay-debug-line-missing'`; }
/** Builds the renderer call that renders overlay breakpoint glyphs for the given one-based lines. */
function breakpointsExpression(lines: number[], token: string): string { return `window.__dsoSetOverlayBreakpoints ? window.__dsoSetOverlayBreakpoints(${JSON.stringify(lines)}, ${JSON.stringify(token)}) : 'overlay-breakpoints-missing'`; }

/** Returns the expression that reads only user-visible overlay text. */
function visibleTextReadExpression(token: string): string { return `(function(){const root=document.getElementById("django-shell-overlay");if(!root||root.__dsoOwnerToken!==${JSON.stringify(token)}){return JSON.stringify({ok:false});}return window.__dsoGetOverlayVisibleText ? JSON.stringify({ok:true,text:window.__dsoGetOverlayVisibleText(${JSON.stringify(token)})}) : JSON.stringify({ok:false});})()`; }

/** Returns the expression that reads the raw overlay model text for compatibility fallback. */
function modelTextReadExpression(token: string): string { return `(function(){const root=document.getElementById("django-shell-overlay");if(!root||root.__dsoOwnerToken!==${JSON.stringify(token)}){return JSON.stringify({ok:false});}const editor=root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();return JSON.stringify({ok:!!(model&&model.getValue),text:model&&model.getValue?String(model.getValue()):""});})()`; }

/** Returns the expression that writes only user-visible overlay text. */
function visibleTextWriteExpression(text: string, token: string): string { return `window.__dsoSetOverlayVisibleText ? window.__dsoSetOverlayVisibleText(${JSON.stringify(text)}, ${JSON.stringify(token)}) : 'overlay-visible-text-missing'`; }

/** Returns the expression that removes renderer-owned overlay DOM and editor resources. */
function disposeExpression(token: string): string { return `(function(){const owner=${JSON.stringify(token)},root=document.getElementById("django-shell-overlay");try{if(window.__dsoStopOverlayCapture){window.__dsoStopOverlayCapture(owner);}}catch(eStopCapture){}if(!root){if(window.__dsoRemoveOverlayWidgetPortal){return window.__dsoRemoveOverlayWidgetPortal(null,owner)==="removed"?"orphan-widget-removed":"no-overlay";}const portal=document.getElementById("django-shell-overlay-widget-root");if(portal&&String(portal.dataset&&portal.dataset.djangoShellOverlayOwner||"")===owner){portal.remove();return "orphan-widget-removed";}return "no-overlay";}if(root.__dsoOwnerToken&&root.__dsoOwnerToken!==owner){return "owner-mismatch";}if(window.__dsoDisposeOverlay){return window.__dsoDisposeOverlay(root,true);}if(root.parentElement){root.parentElement.removeChild(root);return "removed";}return "no-overlay";})()`; }

/** Returns the expression that hides renderer-owned overlay DOM without disposing it. */
function parkExpression(token: string): string { return `(function(){const owner=${JSON.stringify(token)},root=document.getElementById("django-shell-overlay");if(!root){if(window.__dsoRemoveOverlayWidgetPortal){return window.__dsoRemoveOverlayWidgetPortal(null,owner)==="removed"?"orphan-widget-removed":"no-overlay";}const portal=document.getElementById("django-shell-overlay-widget-root");if(portal&&String(portal.dataset&&portal.dataset.djangoShellOverlayOwner||"")===owner){portal.remove();return "orphan-widget-removed";}return "no-overlay";}if(root.__dsoOwnerToken&&root.__dsoOwnerToken!==owner){return "owner-mismatch";}root.__dsoExplicitlyParked=true;root.style.setProperty("display","none","important");root.style.setProperty("visibility","hidden","important");try{if(window.__dsoSetOverlayWidgetVisibility){window.__dsoSetOverlayWidgetVisibility(root,false,true);}else if(root.__dsoWidgetRoot){root.__dsoWidgetRoot.style.setProperty("display","none","important");root.__dsoWidgetRoot.style.setProperty("visibility","hidden","important");}}catch(eWidgetPark){}return "parked";})()`; }

/** Returns the expression that clears stale renderer overlay state after backend restart. */
function resetExpression(initialText: string, token: string): string { return `(function(){const root=document.getElementById("django-shell-overlay");if(root?root.__dsoOwnerToken!==${JSON.stringify(token)}:window.__djangoShellOverlayOwnerToken!==${JSON.stringify(token)}){return "owner-mismatch";}window.__djangoShellOverlayInitialText=${JSON.stringify(initialText)};window.__djangoShellOverlayPrelude="";if(window.__djangoShellOverlayReset){return window.__djangoShellOverlayReset(window.__djangoShellOverlayInitialText,${JSON.stringify(token)});}try{const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(model&&model.setValue){model.setValue(window.__djangoShellOverlayInitialText);}}catch(eResetModel){}return window.__djangoShellOverlayHide?window.__djangoShellOverlayHide():'overlay-not-installed';})()`; }

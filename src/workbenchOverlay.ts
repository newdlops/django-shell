// Workbench renderer overlay that hosts the Django shell Python editor.
import * as http from "http";
import WebSocket from "ws";
import * as vscode from "vscode";
import type { DebugFrameInfo } from "./debugInspector";
import { DiagnosticLogger } from "./diagnostics";
import { OverlayMemoryDocument } from "./overlayMemoryDocument";
import { OverlayPythonFeatureBridge } from "./overlayPythonFeatureBridge";
import { closeGeneratedOverlayTabs, scheduleGeneratedOverlayTabCleanup } from "./generatedOverlayTabs";
import { OverlayShellCommandController, registerOverlayShellCommand } from "./overlayShellCommand";
import { overlayPreludeText } from "./overlayPrelude";
import { logOverlayRendererPayload } from "./overlayRendererLog";
import { findInspectorUrlForPid, findMainPid, waitForInspectorUrlForPid } from "./workbenchInspector";
import { overlayRendererSource } from "./workbenchOverlayRenderer";
interface CdpResponse { error?: { message?: string }; id?: number; result?: { exceptionDetails?: { exception?: { description?: string }; text?: string }; result?: { value?: unknown } }; }
type PendingReply = (response: CdpResponse) => void; type RunHandler = (code: string, lineOffset?: number) => Promise<boolean>;
/** Describes the Python cell editor anchor inside the custom webview viewport. */
export interface WorkbenchOverlayGeometry { height: number; left: number; top: number; width: number; }
/** Describes one one-based generated console-cell.py breakpoint location. */
interface OverlayBreakpointLocation { column?: number; line: number; }
const BRIDGE_PATH = "/django-shell-overlay";
const CORS_HEADERS = { "access-control-allow-headers": "content-type,x-django-shell-token", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-origin": "*", "access-control-allow-private-network": "true" };
const GEOMETRY_FRAME_MS = 16;
const GEOMETRY_SETTLE_MS = 80;
const RENDERER_PATCH_VERSION = 81;
/** Injects and coordinates the Django shell editor overlay in the VS Code workbench renderer. */
export class WorkbenchOverlay implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pending = new Map<number, PendingReply>();
  private injectPromise: Promise<void> | undefined;
  private messageId = 1;
  private rendererInjected = false;
  private runHandler: RunHandler | undefined;
  private server: http.Server | undefined;
  private serverPort: number | undefined;
  private generatedCleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private lastBreakpointToggleAt = 0;
  private lastBreakpointToggleKey = "";
  private shutdownPromise: Promise<void> | undefined;
  private readonly token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private workbenchWindowId: number | undefined;
  private ws: WebSocket | undefined;
  private geometry: WorkbenchOverlayGeometry | undefined;
  private geometryFlushInFlight = false;
  private geometryFlushPending = false;
  private geometrySettleTimer: ReturnType<typeof setTimeout> | undefined;
  private geometryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly memoryDocument: OverlayMemoryDocument;
  private readonly featureBridge: OverlayPythonFeatureBridge;
  private prelude = ""; private shellCommands: OverlayShellCommandController | undefined;

  /** Stores diagnostics used to report renderer overlay setup. */
  constructor(private readonly logger?: DiagnosticLogger) { this.memoryDocument = new OverlayMemoryDocument(logger); this.featureBridge = new OverlayPythonFeatureBridge(this.memoryDocument, logger); }

  /** Registers the overlay lifecycle with VS Code. */
  activate(context: vscode.ExtensionContext, runHandler: RunHandler, options: { registerCommands?: boolean } = {}): void {
    this.runHandler = runHandler;
    this.memoryDocument.activate(context);
    this.featureBridge.activate(context);
    this.shellCommands = registerOverlayShellCommand(this.memoryDocument, runHandler, this.logger, { registerCommands: options.registerCommands !== false });
    this.disposables.push(this.shellCommands);
    if (options.registerCommands !== false) {
      this.disposables.push(vscode.commands.registerCommand("djangoShell.showOverlayEditor", () => this.show()));
      this.disposables.push(vscode.commands.registerCommand("djangoShell.overlayRunCurrentInput", () => this.runCurrentInput()));
    }
    context.subscriptions.push(this);
  }

  /** Shows the workbench overlay editor and creates it when needed. */
  async show(): Promise<void> {
    if (this.shutdownPromise) {
      throw new Error("Django Shell overlay has been disposed.");
    }
    const started = Date.now();
    await this.ensureInjected();
    if (await this.rendererPatchVersion() !== String(RENDERER_PATCH_VERSION)) { await this.inject(); }
    let report = await this.evalInWorkbench(showExpression(this.geometry));
    if (report === "overlay-not-installed") { await this.inject(); report = await this.evalInWorkbench(showExpression(this.geometry)); }
    const ctorMatch = /\bctors=(\d+)/.exec(report);
    if (report.includes(":pending") && !report.includes("no-webview-host") && Number(ctorMatch?.[1] ?? 0) <= 0) {
      const closeWarmup = await this.openWarmupEditor();
      try {
        report = await this.waitForOverlayCapture();
      } finally {
        void closeWarmup().catch(() => undefined);
      }
    }
    this.logger?.log("overlay.show", { ms: Date.now() - started, report });
    await closeGeneratedOverlayTabs([this.memoryDocument.analysisUri]).catch(() => undefined);
    scheduleGeneratedOverlayTabCleanup([this.memoryDocument.analysisUri]);
    void vscode.commands.executeCommand("setContext", "djangoShell.overlayVisible", report.includes(":editor:"));
  }

  /** Updates the workbench overlay position from the webview cell anchor. */
  updateGeometry(geometry: WorkbenchOverlayGeometry): void {
    this.geometry = geometry;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return; }
    this.queueGeometryFlush(0);
    clearTimeout(this.geometrySettleTimer);
    this.geometrySettleTimer = setTimeout(() => { this.geometrySettleTimer = undefined; this.queueGeometryFlush(0); }, GEOMETRY_SETTLE_MS);
  }

  /** Queues a geometry update while coalescing rapid scroll measurements. */
  private queueGeometryFlush(delayMs: number): void {
    this.geometryFlushPending = true;
    if (this.geometryFlushInFlight || this.geometryTimer) { return; }
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
    this.geometryFlushPending = false;
    if (!geometry || !this.ws || this.ws.readyState !== WebSocket.OPEN) { return; }
    this.geometryFlushInFlight = true;
    this.logger?.log("overlay.geometry", { height: Math.round(geometry.height), left: Math.round(geometry.left), top: Math.round(geometry.top), width: Math.round(geometry.width) });
    void this.evalInWorkbench(geometryExpression(geometry)).catch((error: unknown) => { this.logger?.log("overlay.geometry.error", { error: error instanceof Error ? error.message : String(error) }); }).finally(() => {
      this.geometryFlushInFlight = false;
      if (this.geometryFlushPending) { this.queueGeometryFlush(GEOMETRY_FRAME_MS); }
    });
  }

  /** Updates editor-only hidden imports without changing raw analysis text. */
  async updatePrelude(importLines: string[]): Promise<void> {
    const nextPrelude = overlayPreludeText(importLines);
    if (nextPrelude === this.prelude) {
      return;
    }
    this.prelude = nextPrelude;
    await this.memoryDocument.updatePrelude(this.prelude);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return; }
    const report = await this.evalInWorkbench(preludeExpression(this.prelude)).catch((error: unknown) => {
      this.logger?.log("overlay.prelude.error", { error: error instanceof Error ? error.message : String(error) });
      return "";
    });
    this.logger?.log("overlay.prelude.renderer", { report });
    await this.updateBreakpoints(this.sourceBreakpointLocations());
  }

  /** Updates visible breakpoint markers for one-based console-cell.py source locations. */
  async updateBreakpoints(sourceBreakpoints: Array<number | OverlayBreakpointLocation>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.rendererInjected) {
      return;
    }
    await this.currentVisibleText().catch(() => undefined);
    const visibleLineCount = lineCount(this.memoryDocument.visibleText());
    const sourceLocations = sourceBreakpoints.map(sourceBreakpointLocation).filter((item): item is OverlayBreakpointLocation => !!item);
    const visibleLocations = sourceLocations.filter((item) => item.line >= 1 && item.line <= visibleLineCount);
    const report = await this.evalInWorkbench(breakpointExpression(visibleLocations)).catch((error: unknown) => {
      this.logger?.log("overlay.breakpoints.error", { error: error instanceof Error ? error.message : String(error) });
      return "";
    });
    this.logger?.log("overlay.breakpoints", { dropped: sourceLocations.length - visibleLocations.length, report, sourceLines: sourceLocations.length, visibleLineCount, visibleLines: visibleLocations.length });
  }

  /** Updates the highlighted paused debugger line inside the overlay editor. */
  async updateDebugInfo(info: DebugFrameInfo): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.rendererInjected) {
      return;
    }
    const visibleLine = info.frame && this.isOverlayFrame(info.frame.path) ? info.frame.line : 0;
    await this.evalInWorkbench(debugLineExpression(visibleLine >= 1 ? visibleLine : 0)).catch((error: unknown) => {
      this.logger?.log("overlay.debug.info.error", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Reads the current user-visible overlay text from the renderer when possible. */
  async currentVisibleText(): Promise<string> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.rendererInjected) {
      return this.memoryDocument.visibleText();
    }
    const raw = await this.evalInWorkbench(visibleTextReadExpression()).catch(() => "");
    try {
      const payload = JSON.parse(raw) as { ok?: boolean; text?: string };
      if (payload.ok && typeof payload.text === "string") {
        await this.memoryDocument.sync(payload.text);
        return payload.text;
      }
    } catch {
      // Fall back to the host copy when the renderer response is not JSON.
    }
    const modelRaw = await this.evalInWorkbench(modelTextReadExpression()).catch(() => "");
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
    const report = await this.evalInWorkbench(visibleTextWriteExpression(text)).catch((error: unknown) => {
      this.logger?.log("overlay.text.replace.error", { error: error instanceof Error ? error.message : String(error) });
      return "";
    });
    if (report.includes("missing")) {
      await this.inject();
      await this.evalInWorkbench(visibleTextWriteExpression(text)).catch((error: unknown) => {
        this.logger?.log("overlay.text.replace.retry.error", { error: error instanceof Error ? error.message : String(error) });
      });
    }
  }

  /** Synchronizes the full visible editor text into backing files without changing renderer contents. */
  async syncVisibleText(text: string): Promise<void> {
    await this.memoryDocument.sync(text);
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
    await this.evalInWorkbench(outputExpression(text, ok)).catch((error: unknown) => {
      this.logger?.log("overlay.output.error", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Tears down the renderer overlay without closing the reusable bridge. */
  hide(): void { void this.disposeRendererOverlay(false, "overlay.hide.error"); }

  /** Clears overlay text and generated prelude for a fresh backend session. */
  async reset(): Promise<void> { this.prelude = ""; await this.memoryDocument.reset(); void vscode.commands.executeCommand("setContext", "djangoShell.overlayVisible", false); if (this.ws?.readyState === WebSocket.OPEN) { await this.evalInWorkbench(resetExpression(this.memoryDocument.visibleText())).catch((error: unknown) => { this.logger?.log("overlay.reset.error", { error: error instanceof Error ? error.message : String(error) }); }); } }

  /** Asks the renderer-owned overlay editor to run the current cursor execution unit. */
  async runCurrentInput(): Promise<string> { await this.ensureInjected(); const raw = await this.evalInWorkbench("(function(){const root=document.getElementById('django-shell-overlay');const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(!root||!editor||!model){return JSON.stringify({ok:false,reason:'missing-overlay'});}const payload=root.__dsoCurrentInputPayload?root.__dsoCurrentInputPayload():{code:''};const code=String(payload&&payload.code||'');const rawStart=payload&&payload.range?Number(payload.range.start)||1:1;const inputStart=Number(root.__dsoInputStartLine)||1;const start=Math.max(1,rawStart-inputStart+1);return JSON.stringify({code,ok:!!code.trim(),reason:code.trim()?undefined:'empty',start,text:String(model.getValue&&model.getValue()||'')});})()").catch((error: unknown) => JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : String(error) })); const payload = JSON.parse(raw) as { code?: string; ok?: boolean; start?: number; text?: string }; if (payload.ok && typeof payload.code === "string") { if (typeof payload.text === "string") { await this.memoryDocument.sync(payload.text); } void this.runHandler?.(payload.code, this.relativeLineOffset(payload.start ?? 1)).catch((error: unknown) => this.logger?.log("overlay.command.rerun.error", { error: error instanceof Error ? error.message : String(error) })); this.logger?.log("overlay.command.rerun.host", { chars: payload.code.length, start: payload.start ?? 1 }); return "host-requested"; } const report = await this.evalInWorkbench("window.__dsoRunCurrentOverlayInput ? window.__dsoRunCurrentOverlayInput() : 'missing-runner'").catch((error: unknown) => `error:${error instanceof Error ? error.message : String(error)}`); this.logger?.log("overlay.command.rerun.eval", { report }); return report; }
  /** Asks the renderer-owned overlay editor to skip the current cursor execution unit. */
  async skipCurrentInput(): Promise<string> { await this.ensureInjected(); const raw = await this.evalInWorkbench("(function(){const root=document.getElementById('django-shell-overlay');const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(!root||!editor||!model){return JSON.stringify({ok:false,reason:'missing-overlay'});}const result=window.__dsoSkipCurrentOverlayInput?window.__dsoSkipCurrentOverlayInput():'missing-runner';return JSON.stringify({ok:result==='skipped',reason:result,text:String(model.getValue&&model.getValue()||'')});})()").catch((error: unknown) => JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : String(error) })); const payload = JSON.parse(raw) as { ok?: boolean; reason?: string; text?: string }; if (typeof payload.text === "string") { await this.memoryDocument.sync(payload.text); } if (!payload.ok) { await this.skipInput(); } this.logger?.log("overlay.command.skip.host", { ok: !!payload.ok, reason: payload.reason ?? "" }); return payload.reason ?? (payload.ok ? "skipped" : "empty"); }
  /** Runs the active file-backed overlay input command. */ async acceptInput(): Promise<void> { await this.shellCommands?.acceptInput(); }
  /** Inserts an indented continuation line in the file-backed overlay command. */ async insertNewline(): Promise<void> { await this.shellCommands?.insertNewline(); }
  /** Moves past the active file-backed overlay input command without running it. */ async skipInput(): Promise<void> { await this.shellCommands?.skipInput(); }
  /** Evaluates a renderer expression for extension host E2E tests. */
  async e2eEvaluate(expression: string): Promise<string> { await this.ensureInjected(); return this.evalInWorkbench(expression); }

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
    void vscode.commands.executeCommand("setContext", "djangoShell.overlayVisible", false);
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
    }
  }

  /** Ensures the local bridge and renderer patch are available. */
  private async ensureInjected(): Promise<void> {
    const bridge = await this.ensureServer();
    let needsInject = this.ws?.readyState !== WebSocket.OPEN || !this.rendererInjected;
    if (!needsInject) {
      const state = await this.rendererPatchState();
      needsInject = state.version !== String(RENDERER_PATCH_VERSION) || state.bridgePort !== String(bridge.port);
    }
    if (!needsInject) {
      return;
    }
    if (this.injectPromise) {
      return this.injectPromise;
    }
    this.injectPromise = this.inject().finally(() => {
      this.injectPromise = undefined;
    });
    return this.injectPromise;
  }

  /** Connects to the main-process inspector and injects the overlay patch. */
  private async inject(): Promise<void> {
    const bridge = await this.ensureServer();
    await this.ensureCdpSocket();
    const report = await this.evalInWorkbench(patchExpression(bridge.port, bridge.token, this.memoryDocument.editorUri.toString(), this.memoryDocument.visibleText(), this.geometry, this.prelude));
    if (!report.includes("django-shell-overlay-shown")) {
      throw new Error(`overlay patch failed: ${report}`);
    }
    this.rendererInjected = true;
    this.logger?.log("overlay.inject", { report });
    await this.updateBreakpoints(this.sourceBreakpointLocations());
  }
  /** Returns the renderer patch version currently installed in the workbench window. */
  private rendererPatchVersion(): Promise<string> {
    return this.evalInWorkbench("String(window.__djangoShellOverlayPatchVersion || '')").catch(() => "");
  }
  /** Returns the renderer patch and bridge state currently installed in the workbench window. */
  private async rendererPatchState(): Promise<{ bridgePort: string; version: string }> {
    const raw = await this.evalInWorkbench("JSON.stringify({bridgePort:String((window.__djangoShellOverlayBridge||{}).port||''),version:String(window.__djangoShellOverlayPatchVersion||'')})").catch(() => "");
    try {
      const parsed = JSON.parse(raw) as { bridgePort?: unknown; version?: unknown };
      return { bridgePort: String(parsed.bridgePort ?? ""), version: String(parsed.version ?? "") };
    } catch {
      return { bridgePort: "", version: "" };
    }
  }
  /** Debounces generated tab cleanup after overlay input settles. */
  private scheduleGeneratedCleanup(): void { clearTimeout(this.generatedCleanupTimer); this.generatedCleanupTimer = setTimeout(() => { void closeGeneratedOverlayTabs([this.memoryDocument.analysisUri, this.memoryDocument.editorUri]).catch(() => undefined); }, 450); }
  /** Converts a one-based user-input line into the backing console-cell.py line offset. */
  private relativeLineOffset(relativeLine: unknown): number | undefined { return typeof relativeLine === "number" && Number.isFinite(relativeLine) ? Math.max(0, Math.floor(relativeLine) - 1) : undefined; }
  /** Toggles a VS Code source breakpoint from a webview fallback payload. */
  async toggleBreakpointFromVisibleLine(relativeLine: unknown, relativeColumn: unknown, inline: boolean): Promise<boolean> { return this.toggleBreakpoint(relativeLine, relativeColumn, inline); }
  /** Toggles a VS Code source breakpoint from one user-input relative overlay location. */
  private async toggleBreakpoint(relativeLine: unknown, relativeColumn: unknown, inline: boolean): Promise<boolean> {
    if (typeof relativeLine !== "number" || !Number.isFinite(relativeLine)) {
      return false;
    }
    const sourceLine = this.relativeLineOffset(relativeLine);
    if (sourceLine === undefined) {
      return false;
    }
    const sourceColumn = inline && typeof relativeColumn === "number" && Number.isFinite(relativeColumn) ? Math.max(0, Math.floor(relativeColumn) - 1) : 0;
    const toggleKey = `${sourceLine}:${sourceColumn}`;
    const now = Date.now();
    if (this.lastBreakpointToggleKey === toggleKey && now - this.lastBreakpointToggleAt < 1000) { await this.updateBreakpoints(this.sourceBreakpointLocations()); return true; }
    this.lastBreakpointToggleKey = toggleKey; this.lastBreakpointToggleAt = now;
    const target = this.memoryDocument.editorUri.toString();
    const existing = vscode.debug.breakpoints.filter((breakpoint): breakpoint is vscode.SourceBreakpoint => breakpoint instanceof vscode.SourceBreakpoint && breakpoint.location.uri.toString() === target && breakpoint.location.range.start.line === sourceLine && breakpoint.location.range.start.character === sourceColumn);
    if (existing.length) {
      vscode.debug.removeBreakpoints(existing);
    } else {
      vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(this.memoryDocument.editorUri, new vscode.Position(sourceLine, sourceColumn)), true)]);
    }
    await this.updateBreakpoints(this.sourceBreakpointLocations());
    return true;
  }
  /** Returns one-based enabled breakpoint locations for the generated console source file. */
  private sourceBreakpointLocations(): OverlayBreakpointLocation[] { const target = this.memoryDocument.editorUri.toString(); return vscode.debug.breakpoints.filter((breakpoint): breakpoint is vscode.SourceBreakpoint => breakpoint instanceof vscode.SourceBreakpoint && breakpoint.enabled && breakpoint.location.uri.toString() === target).map((breakpoint) => ({ column: breakpoint.location.range.start.character > 0 ? breakpoint.location.range.start.character + 1 : 0, line: breakpoint.location.range.start.line + 1 })).sort((left, right) => left.line - right.line || (left.column ?? 0) - (right.column ?? 0)); }
  /** Returns one-based enabled breakpoint lines for the generated console source file. */
  private sourceBreakpointLines(): number[] { return [...new Set(this.sourceBreakpointLocations().map((item) => item.line))].sort((left, right) => left - right); }
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
      if (payload?.type === "toggleBreakpoint") {
        this.logger?.log("overlay.bridge.toggleBreakpoint", { column: Number(payload.column) || 0, inline: Boolean(payload.inline), inputStartLine: Number(payload.inputStartLine) || 0, line: Number(payload.line) || 0, rawColumn: Number(payload.rawColumn) || 0, rawLine: Number(payload.rawLine) || 0, source: String(payload.source || "") });
        const toggled = await this.toggleBreakpoint(payload.line, payload.column, Boolean(payload.inline));
        res.writeHead(200, { ...CORS_HEADERS, "content-type": "application/json" }).end(JSON.stringify({ toggled }));
        return;
      }
      if (payload?.type === "run" && typeof payload.code === "string") {
        this.logger?.log("overlay.bridge.run", { ...textFields(payload.code), fullText: typeof payload.text === "string" ? textFields(payload.text).lines : 0 });
        await this.memoryDocument.sync(typeof payload.text === "string" ? payload.text : payload.code); this.scheduleGeneratedCleanup();
        const range = payload.range as { start?: unknown } | undefined;
        const lineOffset = this.relativeLineOffset(range?.start);
        const work = this.runHandler?.(payload.code, lineOffset);
        void work?.catch((error: unknown) => {
          this.logger?.log("overlay.bridge.run.error", { error: error instanceof Error ? error.message : String(error) });
        });
        res.writeHead(200, { ...CORS_HEADERS, "content-type": "application/json" }).end(JSON.stringify({ executed: Boolean(work) }));
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
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
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
    socket.on("message", (data) => this.handleSocketMessage(data));
    socket.on("close", () => this.closeSocket("closed"));
    await this.send("Runtime.enable", {});
  }

  /** Evaluates JavaScript inside the focused workbench renderer. */
  private async evalInWorkbench(expression: string): Promise<string> {
    await this.ensureCdpSocket();
    const script = mainProcessEvalExpression(expression, this.workbenchWindowId);
    const response = await this.send("Runtime.evaluate", {
      awaitPromise: true,
      expression: script,
      includeCommandLineAPI: true,
      returnByValue: true
    });
    if (response.error?.message) {
      throw new Error(response.error.message);
    }
    const exception = response.result?.exceptionDetails;
    if (exception) {
      throw new Error(exception.exception?.description || exception.text || "CDP Runtime.evaluate failed.");
    }
    return this.recordWorkbenchWindow(String(response.result?.result?.value ?? ""));
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
  private async send(method: string, params: Record<string, unknown>): Promise<CdpResponse> {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("CDP WebSocket is not open.");
    }
    const id = this.messageId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<CdpResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: `CDP request timed out: ${method}` }, id });
      }, 15000);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      socket.send(payload);
    });
  }

  /** Routes one CDP WebSocket message to the pending caller. */
  private handleSocketMessage(data: WebSocket.RawData): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(String(data)) as CdpResponse;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const reply = this.pending.get(message.id);
      this.pending.delete(message.id);
      reply?.(message);
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
    for (const reply of this.pending.values()) {
      reply({ error: { message: `CDP socket closed: ${reason}` } });
    }
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      // The socket may already be closed by the inspector.
    }
    this.ws = undefined;
  }

  /** Opens a temporary Python editor briefly so VS Code creates an editor widget to capture. */
  private async openWarmupEditor(): Promise<() => Promise<void>> {
    const document = await vscode.workspace.openTextDocument({ content: "", language: "python" });
    const uri = document.uri;
    const preExisting = snapshotTabUris();
    await vscode.window.showTextDocument(document, {
      preserveFocus: true,
      preview: true,
      viewColumn: vscode.ViewColumn.Beside
    });
    return async () => {
      const tabs = introducedTabs(uri, preExisting);
      if (tabs.length) {
        await vscode.window.tabGroups.close(tabs, true);
      }
    };
  }

  /** Polls until renderer capture has a CodeEditorWidget constructor or the editor appears. */
  private async waitForOverlayCapture(): Promise<string> {
    const started = Date.now();
    let report = "";
    while (Date.now() - started < 2500) {
      await delay(100);
      report = await this.evalInWorkbench(showExpression(this.geometry));
      const ctorMatch = /\bctors=(\d+)/.exec(report);
      if (report.includes(":editor:") || report.includes("no-webview-host") || Number(ctorMatch?.[1] ?? 0) > 0) {
        return report;
      }
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

/** Returns compact size fields for text diagnostics. */
function textFields(text: string): { chars: number; lines: number } { return { chars: text.length, lines: text ? text.split(/\r?\n/).length : 0 }; }

/** Normalizes a source breakpoint line or location into one-based source coordinates. */
function sourceBreakpointLocation(value: number | OverlayBreakpointLocation): OverlayBreakpointLocation | undefined {
  const raw = typeof value === "number" ? { column: 0, line: value } : value;
  const line = Math.floor(Number(raw.line));
  const column = Math.max(0, Math.floor(Number(raw.column) || 0));
  return Number.isFinite(line) && line > 0 ? { column, line } : undefined;
}

/** Returns a compact one-based line count for user-visible text. */
function lineCount(text: string): number { return text ? text.split(/\r?\n/).length : 0; }

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

/** Wraps renderer JavaScript so it runs inside the owning workbench window. */
function mainProcessEvalExpression(rendererExpression: string, windowId?: number): string {
  const wrappedRendererExpression = `
    (async function () {
      try {
        return await (${rendererExpression});
      } catch (error) {
        return "renderer-throw:" + String(error && (error.stack || error.message) || error);
      }
    })()
  `.trim();
  return `
    (async function () {
      const req = typeof require === "function"
        ? require
        : (process && process.mainModule && typeof process.mainModule.require === "function" ? process.mainModule.require.bind(process.mainModule) : undefined);
      if (!req) { return "no-main-require"; }
      const BW = req("electron").BrowserWindow;
      const wins = BW.getAllWindows().filter((win) => /workbench\\.(?:esm\\.)?html/.test(win.webContents.getURL()));
      const requestedId = ${JSON.stringify(windowId ?? null)};
      const requested = requestedId ? BW.fromId(requestedId) : undefined;
      const focused = BW.getFocusedWindow();
      const target = requested && wins.includes(requested) ? requested : (requestedId ? undefined : (wins.includes(focused) ? focused : (wins.length === 1 ? wins[0] : undefined)));
      if (!target) { return requestedId ? "no-owned-workbench-window:" + requestedId : "no-focused-workbench-window:" + wins.length; }
      if (!requestedId) {
        const orphanCleanup = "try{const root=document.getElementById('django-shell-overlay');if(root&&!root.__dsoOwnerToken){if(window.__dsoDisposeOverlay){window.__dsoDisposeOverlay(root,true);}else{root.remove();}}}catch(e){}";
        await Promise.all(wins.filter(function (win) { return win !== target; }).map(function (win) { return win.webContents.executeJavaScript(orphanCleanup, true).catch(function () { return undefined; }); }));
      }
      var value;
      try {
        value = await target.webContents.executeJavaScript(${JSON.stringify(wrappedRendererExpression)}, true);
      } catch (error) {
        return "renderer-execute-error:" + String(error && (error.stack || error.message) || error);
      }
      return "__DSO_WINDOW_ID__:" + target.id + "\\n" + (value === undefined || value === null ? "" : String(value));
    })()
  `.trim();
}

/** Returns the renderer patch expression with bridge settings baked in. */
function patchExpression(port: number, token: string, modelUri: string, initialText: string, geometry: WorkbenchOverlayGeometry | undefined, prelude: string): string {
  return `
    (function () {
      window.__djangoShellOverlayBridge = { port: ${JSON.stringify(port)}, token: ${JSON.stringify(token)} };
      window.__djangoShellOverlayModelUri = ${JSON.stringify(modelUri)};
      window.__djangoShellOverlayOwnerToken = ${JSON.stringify(token)};
      window.__djangoShellOverlayInitialText = ${JSON.stringify(initialText)};
      window.__djangoShellOverlayUseVisiblePrelude = false;
      window.__djangoShellOverlayGeometry = ${JSON.stringify(geometry ?? null)};
      window.__djangoShellOverlayPrelude = ${JSON.stringify(prelude)};
      if (!window.__djangoShellOverlayPatched || window.__djangoShellOverlayPatchVersion !== ${RENDERER_PATCH_VERSION}) { try {
        var stale = document.getElementById("django-shell-overlay");
        if (stale && stale.__dsoOwnerToken !== window.__djangoShellOverlayOwnerToken) {
          if (window.__dsoDisposeOverlay) { window.__dsoDisposeOverlay(stale, true); }
          else if (stale.parentElement) { stale.parentElement.removeChild(stale); }
        }
      } catch (eStaleOverlay) {} }
      window.__djangoShellOverlayPatched = true;
      window.__djangoShellOverlayPatchVersion = ${RENDERER_PATCH_VERSION};
      ${overlayRendererSource(modelUri)}
      return window.__djangoShellOverlayShow(window.__djangoShellOverlayGeometry);
    })()
  `.trim();
}
/** Returns the expression that makes the overlay visible. */
function showExpression(geometry: WorkbenchOverlayGeometry | undefined): string { return `window.__djangoShellOverlayShow ? window.__djangoShellOverlayShow(${JSON.stringify(geometry ?? null)}) : 'overlay-not-installed'`; }
/** Returns the expression that moves the overlay to the latest webview anchor. */
function geometryExpression(geometry: WorkbenchOverlayGeometry): string { return `window.__djangoShellOverlaySetGeometry ? window.__djangoShellOverlaySetGeometry(${JSON.stringify(geometry)}) : 'overlay-not-installed'`; }

/** Returns the expression that updates hidden Python prelude imports. */
function preludeExpression(prelude: string): string { return `window.__djangoShellOverlaySetPrelude ? window.__djangoShellOverlaySetPrelude(${JSON.stringify(prelude)}) : 'overlay-not-installed'`; }

/** Returns the expression that renders the latest Python execution output. */
function outputExpression(text: string, ok: boolean): string { return `window.__djangoShellOverlaySetOutput ? window.__djangoShellOverlaySetOutput(${JSON.stringify(text)}, ${JSON.stringify(ok)}) : 'overlay-not-installed'`; }

/** Returns the expression that refreshes visible overlay breakpoint markers. */
function breakpointExpression(visibleLocations: OverlayBreakpointLocation[]): string { return `window.__dsoSetOverlayBreakpoints ? window.__dsoSetOverlayBreakpoints(${JSON.stringify(visibleLocations.map((item) => item.column ? item : item.line))}) : 'overlay-breakpoints-missing'`; }

/** Returns the expression that refreshes the paused debugger line marker. */
function debugLineExpression(visibleLine: number): string { return `window.__dsoSetOverlayDebugLine ? window.__dsoSetOverlayDebugLine(${JSON.stringify(visibleLine)}) : 'overlay-debug-line-missing'`; }

/** Returns the expression that reads only user-visible overlay text. */
function visibleTextReadExpression(): string { return `(function(){return window.__dsoGetOverlayVisibleText ? JSON.stringify({ok:true,text:window.__dsoGetOverlayVisibleText()}) : JSON.stringify({ok:false});})()`; }

/** Returns the expression that reads the raw overlay model text for compatibility fallback. */
function modelTextReadExpression(): string { return `(function(){const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();return JSON.stringify({ok:!!(model&&model.getValue),text:model&&model.getValue?String(model.getValue()):""});})()`; }

/** Returns the expression that writes only user-visible overlay text. */
function visibleTextWriteExpression(text: string): string { return `window.__dsoSetOverlayVisibleText ? window.__dsoSetOverlayVisibleText(${JSON.stringify(text)}) : 'overlay-visible-text-missing'`; }

/** Returns the expression that removes renderer-owned overlay DOM and editor resources. */
function disposeExpression(token: string): string { return `(function(){const root=document.getElementById("django-shell-overlay");if(root&&root.__dsoOwnerToken&&root.__dsoOwnerToken!==${JSON.stringify(token)}){return "owner-mismatch";}window.__djangoShellOverlayOwnerToken=${JSON.stringify(token)};if(window.__dsoDisposeOverlay){return window.__dsoDisposeOverlay(root);}if(root&&root.parentElement){root.parentElement.removeChild(root);return "removed";}return "no-overlay";})()`; }

/** Returns the expression that clears stale renderer overlay state after backend restart. */
function resetExpression(initialText: string): string { return `(function(){window.__djangoShellOverlayInitialText=${JSON.stringify(initialText)};window.__djangoShellOverlayPrelude="";if(window.__djangoShellOverlayReset){return window.__djangoShellOverlayReset(window.__djangoShellOverlayInitialText);}const root=document.getElementById("django-shell-overlay");try{const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(model&&model.setValue){model.setValue(window.__djangoShellOverlayInitialText);}}catch(eResetModel){}return window.__djangoShellOverlayHide?window.__djangoShellOverlayHide():'overlay-not-installed';})()`; }

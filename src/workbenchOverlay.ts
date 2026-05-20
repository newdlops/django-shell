// Workbench renderer overlay that hosts the Django shell Python editor.
import * as http from "http";
import WebSocket from "ws";
import * as vscode from "vscode";
import { DiagnosticLogger } from "./diagnostics";
import { OverlayMemoryDocument } from "./overlayMemoryDocument";
import { OverlayPythonFeatureBridge } from "./overlayPythonFeatureBridge";
import { registerOverlayShellCommand } from "./overlayShellCommand";
import { logOverlayRendererPayload } from "./overlayRendererLog";
import { findInspectorUrlForPid, findMainPid, waitForInspectorUrlForPid } from "./workbenchInspector";
import { overlayRendererSource } from "./workbenchOverlayRenderer";
interface CdpResponse { error?: { message?: string }; id?: number; result?: { exceptionDetails?: { exception?: { description?: string }; text?: string }; result?: { value?: unknown } }; }
type PendingReply = (response: CdpResponse) => void; type RunHandler = (code: string) => Promise<boolean>;
/** Describes the Python cell editor anchor inside the custom webview viewport. */
export interface WorkbenchOverlayGeometry { height: number; left: number; top: number; width: number; }

const BRIDGE_PATH = "/django-shell-overlay";
const CORS_HEADERS = { "access-control-allow-headers": "content-type,x-django-shell-token", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-origin": "*" };
const RENDERER_PATCH_VERSION = 26;

/** Injects and coordinates the Django shell editor overlay in the VS Code workbench renderer. */
export class WorkbenchOverlay implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pending = new Map<number, PendingReply>();
  private injectPromise: Promise<void> | undefined;
  private messageId = 1;
  private runHandler: RunHandler | undefined;
  private server: http.Server | undefined;
  private serverPort: number | undefined;
  private readonly token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private ws: WebSocket | undefined;
  private geometry: WorkbenchOverlayGeometry | undefined;
  private readonly memoryDocument: OverlayMemoryDocument;
  private readonly featureBridge: OverlayPythonFeatureBridge;
  private prelude = "";

  /** Stores diagnostics used to report renderer overlay setup. */
  constructor(private readonly logger?: DiagnosticLogger) { this.memoryDocument = new OverlayMemoryDocument(logger); this.featureBridge = new OverlayPythonFeatureBridge(this.memoryDocument, logger); }

  /** Registers the overlay lifecycle with VS Code. */
  activate(context: vscode.ExtensionContext, runHandler: RunHandler): void {
    this.runHandler = runHandler;
    this.memoryDocument.activate(context);
    this.featureBridge.activate(context);
    this.disposables.push(registerOverlayShellCommand(this.memoryDocument, runHandler, this.logger));
    this.disposables.push(vscode.commands.registerCommand("djangoShell.showOverlayEditor", () => this.show()));
    this.disposables.push(vscode.commands.registerCommand("djangoShell.overlayRunCurrentInput", () => this.runCurrentInput()));
    context.subscriptions.push(this);
  }

  /** Shows the workbench overlay editor and creates it when needed. */
  async show(): Promise<void> {
    const started = Date.now();
    await this.ensureInjected();
    let report = await this.evalInWorkbench(showExpression(this.geometry));
    if (report === "overlay-not-installed") { await this.inject(); report = await this.evalInWorkbench(showExpression(this.geometry)); }
    if (report.includes(":pending") && !report.includes("no-webview-host")) {
      const closeWarmup = await this.openWarmupEditor();
      try {
        report = await this.waitForOverlayCapture();
      } finally {
        await closeWarmup();
      }
    }
    this.logger?.log("overlay.show", { ms: Date.now() - started, report });
    this.logger?.log("overlay.probe", { report: await this.evalInWorkbench("(function(){const r=document.getElementById('django-shell-overlay');const e=r&&r.__djangoShellEditor;const m=e&&e.getModel&&e.getModel();return JSON.stringify({root:!!r,editor:!!e,sync:!!(r&&r.__dsoSyncEditor),enter:!!(r&&r.__dsoEnterEditor),sameEnter:!!(r&&r.__dsoEnterEditor===e),hasRunner:!!window.__dsoInstallEnterRunner,hasSync:!!window.__dsoInstallModelSync,uri:m&&String(m.uri),lines:m&&m.getLineCount&&m.getLineCount(),chars:m&&m.getValue&&m.getValue().length,active:String(document.activeElement&&document.activeElement.className||'').slice(0,80)});})()").catch((error: unknown) => `probe-error:${error instanceof Error ? error.message : String(error)}`) });
    await vscode.commands.executeCommand("setContext", "djangoShell.overlayVisible", report.includes(":editor:"));
  }

  /** Updates the workbench overlay position from the webview cell anchor. */
  updateGeometry(geometry: WorkbenchOverlayGeometry): void {
    this.geometry = geometry;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return; }
    void this.evalInWorkbench(geometryExpression(geometry)).catch((error: unknown) => {
      this.logger?.log("overlay.geometry.error", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Updates hidden imports used by Python language analysis. */
  updatePrelude(importLines: string[]): void {
    const nextPrelude = preludeText(importLines);
    if (nextPrelude === this.prelude) {
      return;
    }
    this.prelude = nextPrelude;
    this.memoryDocument.updatePrelude(this.prelude);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return; }
    void this.evalInWorkbench(preludeExpression(this.prelude)).catch((error: unknown) => {
      this.logger?.log("overlay.prelude.error", { error: error instanceof Error ? error.message : String(error) });
    });
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

  /** Hides the workbench overlay without tearing down the bridge. */
  hide(): void { void vscode.commands.executeCommand("setContext", "djangoShell.overlayVisible", false); if (this.ws?.readyState === WebSocket.OPEN) { void this.evalInWorkbench("window.__djangoShellOverlayHide ? window.__djangoShellOverlayHide() : 'overlay-not-installed'").catch(() => undefined); } }

  /** Clears overlay text and generated prelude for a fresh backend session. */
  async reset(): Promise<void> { this.prelude = ""; await this.memoryDocument.reset(); void vscode.commands.executeCommand("setContext", "djangoShell.overlayVisible", false); if (this.ws?.readyState === WebSocket.OPEN) { await this.evalInWorkbench(resetExpression(this.memoryDocument.fullText())).catch((error: unknown) => { this.logger?.log("overlay.reset.error", { error: error instanceof Error ? error.message : String(error) }); }); } }

  /** Asks the renderer-owned overlay editor to run the current cursor execution unit. */
  async runCurrentInput(): Promise<void> { await this.ensureInjected(); this.logger?.log("overlay.command.rerun.eval", { report: await this.evalInWorkbench("window.__dsoRunCurrentOverlayInput ? window.__dsoRunCurrentOverlayInput() : 'missing-runner'").catch((error: unknown) => `error:${error instanceof Error ? error.message : String(error)}`) }); }

  /** Disposes the bridge and hides the overlay if possible. */
  dispose(): void {
    this.hide();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.closeServer();
    this.closeSocket("dispose");
  }

  /** Ensures the local bridge and renderer patch are available. */
  private async ensureInjected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
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
    const report = await this.evalInWorkbench(patchExpression(bridge.port, bridge.token, this.memoryDocument.editorUri.toString(), this.memoryDocument.fullText(), this.geometry, this.prelude));
    if (!report.includes("django-shell-overlay-shown")) {
      throw new Error(`overlay patch failed: ${report}`);
    }
    this.logger?.log("overlay.inject", { report });
  }

  /** Starts the local HTTP bridge used by the renderer run button. */
  private async ensureServer(): Promise<{ port: number; token: string }> {
    if (this.server && this.serverPort !== undefined) {
      return { port: this.serverPort, token: this.token };
    }
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleBridgeRequest(req, res);
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
      if (req.method !== "POST" || req.url !== BRIDGE_PATH || req.headers["x-django-shell-token"] !== this.token) {
        res.writeHead(404, CORS_HEADERS).end();
        return;
      }
      const payload = JSON.parse(await readRequestBody(req));
      if (payload?.type === "log") {
        logOverlayRendererPayload(this.logger, payload);
      }
      if (payload?.type === "change" && typeof payload.code === "string") {
        this.logger?.log("overlay.bridge.change", textFields(payload.code));
        await this.memoryDocument.sync(payload.code);
      }
      if (payload?.type === "run" && typeof payload.code === "string") {
        this.logger?.log("overlay.bridge.run", textFields(payload.code));
        await this.memoryDocument.sync(payload.code);
        const executed = await this.runHandler?.(payload.code) ?? false;
        res.writeHead(200, { ...CORS_HEADERS, "content-type": "application/json" }).end(JSON.stringify({ executed }));
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
    const script = mainProcessEvalExpression(expression);
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
    return String(response.result?.result?.value ?? "");
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
      }, 5000);
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

  /** Opens an existing workspace file briefly so VS Code creates a real editor widget to capture. */
  private async openWarmupEditor(): Promise<() => Promise<void>> {
    const uri = this.memoryDocument.editorUri;
    const preExisting = snapshotTabUris();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
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
    return report || this.evalInWorkbench(showExpression(this.geometry));
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
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns compact size fields for text diagnostics. */
function textFields(text: string): { chars: number; lines: number } {
  return { chars: text.length, lines: text ? text.split(/\r?\n/).length : 0 };
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

/** Wraps renderer JavaScript so it runs inside the focused workbench window. */
function mainProcessEvalExpression(rendererExpression: string): string {
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
      const focused = BW.getFocusedWindow();
      const target = wins.includes(focused) ? focused : wins[0];
      if (!target) { return "no-workbench-window"; }
      var value;
      try {
        value = await target.webContents.executeJavaScript(${JSON.stringify(wrappedRendererExpression)}, true);
      } catch (error) {
        return "renderer-execute-error:" + String(error && (error.stack || error.message) || error);
      }
      return value === undefined || value === null ? "" : String(value);
    })()
  `.trim();
}

/** Returns the renderer patch expression with bridge settings baked in. */
function patchExpression(port: number, token: string, modelUri: string, initialText: string, geometry: WorkbenchOverlayGeometry | undefined, prelude: string): string {
  return `
    (function () {
      window.__djangoShellOverlayBridge = { port: ${JSON.stringify(port)}, token: ${JSON.stringify(token)} };
      window.__djangoShellOverlayModelUri = ${JSON.stringify(modelUri)};
      window.__djangoShellOverlayInitialText = ${JSON.stringify(initialText)};
      window.__djangoShellOverlayUseVisiblePrelude = true;
      window.__djangoShellOverlayGeometry = ${JSON.stringify(geometry ?? null)};
      window.__djangoShellOverlayPrelude = ${JSON.stringify(prelude)};
      if (!window.__djangoShellOverlayPatched || window.__djangoShellOverlayPatchVersion !== ${RENDERER_PATCH_VERSION}) { try {
        var stale = document.getElementById("django-shell-overlay");
        if (stale && stale.parentElement) { stale.parentElement.removeChild(stale); }
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

/** Returns the expression that clears stale renderer overlay state after backend restart. */
function resetExpression(initialText: string): string { return `(function(){window.__djangoShellOverlayInitialText=${JSON.stringify(initialText)};window.__djangoShellOverlayPrelude="";if(window.__djangoShellOverlayReset){return window.__djangoShellOverlayReset(window.__djangoShellOverlayInitialText);}const root=document.getElementById("django-shell-overlay");try{const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(model&&model.setValue){model.setValue(window.__djangoShellOverlayInitialText);}}catch(eResetModel){}return window.__djangoShellOverlayHide?window.__djangoShellOverlayHide():'overlay-not-installed';})()`; }

/** Builds hidden import text for Python analysis without touching disk. */
function preludeText(importLines: string[]): string {
  const seen = new Set<string>();
  const lines = importLines.filter((line) => line && !seen.has(line) && seen.add(line)).slice(0, 1000);
  return lines.length ? `# Django shell runtime imports for analysis.\n# ruff: noqa\n${lines.join("\n")}\n\n` : "";
}

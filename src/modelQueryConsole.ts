// Single reusable webview panel that runs user-written Django ORM code and renders the result in the grid.

import * as path from "path";
import * as vscode from "vscode";
import type { BackendTransportMode } from "./backendClient";
import type { BackendModelColumn, ModelCommitChange, ModelRelatedQuery } from "./modelBackend";
import type { ModelDataSource } from "./modelBrowser";
import { modelBrowserHtml } from "./modelBrowserHtml";
import { DiagnosticLogger } from "./diagnostics";
import type { WorkbenchOverlay, WorkbenchOverlayGeometry } from "./workbenchOverlay";

interface IncomingMessage {
  app?: string;
  changes?: ModelCommitChange[];
  code?: string;
  columns?: BackendModelColumn[];
  mode?: BackendTransportMode;
  model?: string;
  pageSize?: number;
  pk?: unknown;
  relation?: string;
  rect?: unknown;
  requestId?: number;
  single?: boolean;
  type: string;
  useOverlay?: boolean;
  value?: unknown;
}

const VIEW_TYPE = "djangoShell.modelQueryConsole";
const PAGE_SIZE = 50;

/** Opens and drives a single reusable query-console panel: evaluates ORM code and tabulates results. */
export class ModelQueryConsole implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly panelDisposables: vscode.Disposable[] = [];
  private activationContext: vscode.ExtensionContext | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private panelActive = false;
  private panelReady = false;
  private panelVisible = false;
  private viewGeneration = 0;
  private overlay: WorkbenchOverlay | undefined;
  private overlayPromise: Promise<WorkbenchOverlay> | undefined;
  private overlayShutdownPromise: Promise<void> | undefined;
  private preludeGeneration = 0;
  private inputAuthority: "fallback" | "overlay" = "fallback";
  private lastEditorGeometry: WorkbenchOverlayGeometry | undefined;
  private draftCode = "";
  private lastCode: string | undefined;
  private queryRequestId = 0;
  private nextOffset: number | null = null;
  private pageSize = PAGE_SIZE;
  private current: { app: string; model: string } | undefined;
  private columns: BackendModelColumn[] = [];

  /** Stores the extension path and the model data source. */
  constructor(private readonly extensionPath: string, private readonly source: ModelDataSource, private readonly logger?: DiagnosticLogger) {}

  /** Registers the run-query command and runtime change refresh. */
  activate(context: vscode.ExtensionContext): void {
    this.activationContext = context;
    this.disposables.push(
      vscode.commands.registerCommand("djangoShell.runModelQuery", () => this.open()),
      vscode.commands.registerCommand("djangoShell.runCurrentModelQuery", () => this.runCurrentQuery()),
      this.source.onDidChangeRuntime(() => this.handleRuntimeChange())
    );
    context.subscriptions.push(this);
  }

  /** Releases the panel and command registrations. */
  dispose(): void {
    const panel = this.panel;
    this.closePanel();
    panel?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Reveals the query console panel, creating it on first use. */
  open(): void {
    this.ensurePanel();
    this.panel?.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
  }

  /** Creates the webview panel once and wires its message and dispose handlers. */
  private ensurePanel(): void {
    if (this.panel) {
      return;
    }
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, "ORM Query", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.extensionPath, "media"))],
      retainContextWhenHidden: true
    });
    this.panelActive = this.panel.active;
    this.panelVisible = this.panel.visible;
    this.panel.webview.html = modelBrowserHtml(this.panel.webview, this.extensionPath);
    this.panelDisposables.push(
      this.panel.onDidDispose(() => this.closePanel()),
      this.panel.onDidChangeViewState((event) => this.handleViewState(event.webviewPanel.visible, event.webviewPanel.active)),
      this.panel.webview.onDidReceiveMessage((message: IncomingMessage) => void this.handleMessage(message))
    );
  }

  /** Clears panel state when the webview is closed. */
  private closePanel(): void {
    this.panel = undefined;
    this.panelActive = false;
    this.panelReady = false;
    this.panelVisible = false;
    this.viewGeneration += 1;
    this.queryRequestId += 1;
    this.lastEditorGeometry = undefined;
    for (const disposable of this.panelDisposables.splice(0)) { disposable.dispose(); }
    this.releaseOverlay();
  }

  /** Routes one message from the webview to its handler. */
  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (typeof message.pageSize === "number" && message.pageSize > 0) {
      this.pageSize = message.pageSize;
    }
    if (message.type === "ready") {
      const panel = this.panel;
      if (this.overlayShutdownPromise) { await this.overlayShutdownPromise; }
      if (panel !== this.panel) { return; }
      this.panelReady = true;
      this.post({ code: this.draftCode, type: "queryMode" });
      this.postTransport();
      if (this.lastCode) {
        await this.runQuery(this.lastCode, true);
      }
    } else if (message.type === "queryEditorGeometry" && isOverlayGeometry(message.rect)) {
      if (this.panelActive) { this.updateOverlayGeometry(message.rect); }
    } else if (message.type === "showQueryOverlay") {
      if (isOverlayGeometry(message.rect)) { this.updateOverlayGeometry(message.rect); }
      await this.showOverlay();
    } else if (message.type === "queryDraftChanged" && typeof message.code === "string") {
      await this.updateFallbackDraft(message.code);
    } else if (message.type === "runQuery" && typeof message.code === "string") {
      const code = message.useOverlay === false ? message.code : await this.currentQueryText(message.code);
      await this.runQuery(code, true, true);
    } else if (message.type === "loadMore") {
      if (this.lastCode && this.nextOffset !== null) {
        await this.runQuery(this.lastCode, false);
      }
    } else if (message.type === "reload") {
      if (this.lastCode) {
        await this.runQuery(this.lastCode, true);
      }
    } else if (message.type === "commitEdits") {
      await this.commitEdits(message);
    } else if (message.type === "commitRelated") {
      await this.commitRelated(message);
    } else if (message.type === "expandRelated") {
      await this.expandRelated(message);
    } else if (message.type === "openModel" && message.app && message.model) {
      void vscode.commands.executeCommand("djangoShell.openModelData", { app: message.app, model: message.model });
    } else if (message.type === "setTransport" && message.mode) {
      this.source.setModelTransport(message.mode);
      this.postTransport();
      if (this.lastCode) {
        await this.runQuery(this.lastCode, true);
      }
    }
  }

  /** Runs the user's ORM code and posts a synthesized schema (on reset) plus the tabulated rows. */
  private async runQuery(code: string, reset: boolean, recordExecution = false): Promise<void> {
    const panel = this.panel;
    if (!panel) {
      return;
    }
    const requestId = ++this.queryRequestId;
    if (recordExecution) { this.draftCode = code; this.lastCode = code; }
    this.post({ type: "queryStarted" });
    const offset = reset ? 0 : this.nextOffset ?? 0;
    this.nextOffset = null;
    const result = await this.source.modelQuery({ code, limit: this.pageSize, offset });
    if (panel !== this.panel || requestId !== this.queryRequestId) {
      return;
    }
    if (reset && this.overlay) { void this.updateOverlayPrelude(this.overlay); }
    this.logger?.log("model.query.run", { editable: result.editable, ok: result.ok, rows: result.rows.length });
    if (!result.ok) {
      this.nextOffset = null;
      this.current = undefined;
      this.post({ message: result.error ?? "Query failed.", type: "error" });
      return;
    }
    this.nextOffset = result.hasMore ? offset + this.pageSize : null;
    this.current = result.app && result.model ? { app: result.app, model: result.model } : undefined;
    this.columns = Array.isArray(result.columns) ? result.columns : [];
    if (reset) {
      this.post({ schema: { app: result.app ?? "", columns: result.columns, label: "ORM Query", model: result.model ?? "query", ok: true, pk: result.pk ?? "", relations: result.relations, table: "" }, type: "schema" });
    }
    this.post({ append: !reset, rows: result, type: "rows" });
  }

  /** Runs the complete query overlay document, preserving query-console whole-buffer semantics. */
  private async runCurrentQuery(): Promise<boolean> {
    if (!this.panel || !this.panelActive) { return false; }
    const code = await this.currentQueryText(this.draftCode);
    if (!code.trim()) { return false; }
    await this.runQuery(code, true, true);
    return true;
  }

  /** Accepts a whole-document submit sent directly by the live query overlay bridge. */
  private async runOverlaySubmission(code: string): Promise<boolean> {
    if (!this.panel || !this.panelActive || !code.trim()) { return false; }
    this.inputAuthority = "overlay";
    this.draftCode = code;
    await this.runQuery(code, true, true);
    return true;
  }

  /** Returns text from whichever query surface is currently authoritative. */
  private async currentQueryText(fallback: string): Promise<string> {
    if (this.inputAuthority === "fallback") {
      this.draftCode = fallback;
      try { await this.overlay?.replaceVisibleText(fallback); } catch (error) {
        this.logger?.log("model.query.fallback.sync.error", { error: error instanceof Error ? error.message : String(error) });
      }
      return fallback;
    }
    try {
      const overlay = this.overlay ?? await this.ensureOverlay();
      const text = await overlay.currentVisibleText();
      this.draftCode = text;
      return text;
    } catch (error) {
      this.logger?.log("model.query.overlay.text.error", { error: error instanceof Error ? error.message : String(error) });
      return fallback;
    }
  }

  /** Lazily creates a query-specific overlay with independent backing files and submit behavior. */
  private async ensureOverlay(): Promise<WorkbenchOverlay> {
    if (this.overlayShutdownPromise) { await this.overlayShutdownPromise; }
    if (this.overlay) { return this.overlay; }
    if (!this.activationContext) { throw new Error("ORM Query console has not been activated."); }
    if (!this.overlayPromise) {
      const panel = this.panel;
      this.overlayPromise = import("./workbenchOverlay").then(async ({ WorkbenchOverlay }) => {
        const overlay = new WorkbenchOverlay(this.logger, { analysisName: "query-analysis", contextKey: "djangoShell.queryOverlayVisible", editorName: "query-cell", executionMode: "submit", key: "query", panelTitle: "ORM Query" });
        overlay.activate(this.activationContext!, (code) => this.runOverlaySubmission(code), { registerCommands: false, registerWithContext: false });
        if (panel !== this.panel) { await overlay.shutdown(); throw new Error("ORM Query panel closed before overlay finished loading."); }
        if (this.lastEditorGeometry) { overlay.updateGeometry(this.lastEditorGeometry); }
        let syncedDraft: string;
        do {
          syncedDraft = this.draftCode;
          await overlay.replaceVisibleText(syncedDraft);
        } while (syncedDraft !== this.draftCode);
        if (panel !== this.panel) { await overlay.shutdown(); throw new Error("ORM Query panel closed before overlay finished loading."); }
        this.overlay = overlay;
        return overlay;
      }).finally(() => { this.overlayPromise = undefined; });
    }
    return this.overlayPromise;
  }

  /** Shows the query overlay only while its owning panel is the active editor. */
  private async showOverlay(): Promise<void> {
    const panel = this.panel;
    const generation = this.viewGeneration;
    if (!panel?.visible || !panel.active) { return; }
    try {
      const overlay = await this.ensureOverlay();
      if (panel !== this.panel || generation !== this.viewGeneration || !panel.active) {
        if (panel !== this.panel || !this.panel?.active) { this.hideOverlay(overlay); }
        return;
      }
      const rendered = await overlay.show();
      if (panel !== this.panel || generation !== this.viewGeneration || !panel.active) {
        if (panel !== this.panel || !this.panel?.active) { this.hideOverlay(overlay); }
        return;
      }
      if (!rendered) {
        await this.activateFallback(overlay, panel, generation);
        return;
      }
      this.inputAuthority = "overlay";
      void this.updateOverlayPrelude(overlay);
    } catch (error) {
      if (panel !== this.panel || generation !== this.viewGeneration) { return; }
      if (this.overlay) { await this.activateFallback(this.overlay, panel, generation); }
      this.logger?.log("model.query.overlay.show.error", { error: error instanceof Error ? error.message : String(error) });
      void vscode.window.showWarningMessage("ORM Query overlay editor could not be opened; the fallback query input remains available.");
    }
  }

  /** Makes the textarea authoritative after a failed overlay show, first mirroring the newest overlay draft into it. */
  private async activateFallback(overlay: WorkbenchOverlay, panel: vscode.WebviewPanel, generation: number): Promise<void> {
    let text = this.draftCode;
    try { text = await overlay.currentVisibleText(); } catch (error) {
      this.logger?.log("model.query.overlay.fallback.error", { error: error instanceof Error ? error.message : String(error) });
    }
    if (panel !== this.panel || generation !== this.viewGeneration || !panel.active) { return; }
    this.draftCode = text;
    await panel.webview.postMessage({ code: text, type: "queryDraft" });
    if (panel !== this.panel || generation !== this.viewGeneration || !panel.active) { return; }
    this.inputAuthority = "fallback";
    overlay.hide();
  }

  /** Records textarea edits while the fallback surface is active and mirrors them into the hidden backing document. */
  private async updateFallbackDraft(code: string): Promise<void> {
    if (this.inputAuthority !== "fallback") { return; }
    this.draftCode = code;
    try { await this.overlay?.replaceVisibleText(code); } catch (error) {
      this.logger?.log("model.query.fallback.sync.error", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Applies live-runtime imports to the query analysis document when inspection is available. */
  private async updateOverlayPrelude(overlay = this.overlay): Promise<void> {
    if (!overlay || !this.source.modelQueryPrelude) { return; }
    const generation = ++this.preludeGeneration;
    try {
      const lines = await this.source.modelQueryPrelude();
      if (overlay !== this.overlay || generation !== this.preludeGeneration) { return; }
      await overlay.updatePrelude(lines);
    } catch (error) {
      this.logger?.log("model.query.overlay.prelude.error", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Stores a validated query editor rectangle and forwards it to the live overlay. */
  private updateOverlayGeometry(geometry: WorkbenchOverlayGeometry): void {
    this.lastEditorGeometry = geometry;
    this.overlay?.updateGeometry(geometry);
  }

  /** Shows, remeasures, or hides the overlay as the query panel changes editor focus. */
  private handleViewState(visible: boolean, active: boolean): void {
    const becameActive = active && !this.panelActive;
    if (visible !== this.panelVisible || active !== this.panelActive) { this.viewGeneration += 1; }
    this.panelActive = active;
    this.panelVisible = visible;
    if (visible && active) {
      if (becameActive || !this.overlay) { this.post({ show: true, type: "measureQueryEditor" }); }
      return;
    }
    this.hideOverlay();
  }

  /** Copies live overlay text into the textarea fallback before hiding its renderer root. */
  private hideOverlay(overlay = this.overlay): void {
    if (!overlay) { return; }
    if (this.inputAuthority === "fallback") {
      if (!this.panel?.active) { overlay.hide(); }
      return;
    }
    void overlay.currentVisibleText().then((text) => {
      if (overlay !== this.overlay) { return; }
      this.draftCode = text;
      this.post({ code: text, type: "queryDraft" });
    }).catch((error: unknown) => this.logger?.log("model.query.overlay.draft.error", { error: error instanceof Error ? error.message : String(error) })).finally(() => {
      if (overlay !== this.overlay || !this.panel?.active) { overlay.hide(); }
    });
  }

  /** Releases a query overlay while retaining its latest draft for the next panel open. */
  private releaseOverlay(): void {
    const overlay = this.overlay;
    const pending = this.overlayPromise;
    const captureOverlayDraft = this.inputAuthority === "overlay";
    this.preludeGeneration += 1;
    this.overlay = undefined;
    this.overlayPromise = undefined;
    this.inputAuthority = "fallback";
    if (overlay) {
      const capture = captureOverlayDraft ? overlay.currentVisibleText().then((text) => { this.draftCode = text; }).catch(() => undefined) : Promise.resolve();
      this.trackOverlayShutdown(capture.then(() => overlay.shutdown()));
    } else if (pending) {
      this.trackOverlayShutdown(pending.then((loaded) => loaded.shutdown()));
    }
  }

  /** Tracks asynchronous query overlay shutdown without leaking rejected promises. */
  private trackOverlayShutdown(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => this.logger?.log("model.query.overlay.shutdown.error", { error: error instanceof Error ? error.message : String(error) })).finally(() => {
      if (this.overlayShutdownPromise === tracked) { this.overlayShutdownPromise = undefined; }
    });
    this.overlayShutdownPromise = tracked;
  }

  /** Commits staged edits against the last query's editable model (reuses the model-browser commit). */
  private async commitEdits(message: IncomingMessage): Promise<void> {
    if (!this.current || !Array.isArray(message.changes) || !message.changes.length) {
      return;
    }
    const result = await this.source.modelCommit({ app: this.current.app, changes: message.changes, columns: this.columns, model: this.current.model });
    this.logger?.log("model.query.commit", { model: `${this.current.app}.${this.current.model}`, ok: result.ok, saved: result.saved });
    this.post({ result, type: "commit" });
  }

  /** Commits staged edits made inside an expanded related table against that related model. */
  private async commitRelated(message: IncomingMessage): Promise<void> {
    if (!message.app || !message.model || !Array.isArray(message.changes) || !message.changes.length) {
      return;
    }
    const result = await this.source.modelCommit({ app: message.app, changes: message.changes, columns: Array.isArray(message.columns) ? message.columns : [], model: message.model });
    this.logger?.log("model.query.commit.related", { model: `${message.app}.${message.model}`, ok: result.ok, saved: result.saved });
    this.post({ result, type: "commit" });
  }

  /** Fetches related rows for one result row (forward FK or reverse FK / M2M) and returns them. */
  private async expandRelated(message: IncomingMessage): Promise<void> {
    if (!this.current || !message.relation || message.pk === undefined) {
      return;
    }
    const query: ModelRelatedQuery = { app: this.current.app, limit: this.pageSize, model: this.current.model, pk: message.pk, relation: message.relation, single: message.single, value: message.value };
    const result = await this.source.modelRelated(query);
    this.post({ requestId: message.requestId, result, type: "related" });
  }

  /** Re-runs the last query when the attached runtime changes. */
  private handleRuntimeChange(): void {
    if (this.overlay) { void this.updateOverlayPrelude(this.overlay); }
    if (this.panel && this.panelReady && this.lastCode) {
      void this.runQuery(this.lastCode, true);
    }
  }

  /** Posts the active transport and the user's transport preference to the webview. */
  private postTransport(): void {
    const transport = this.source.modelTransportInfo();
    this.post({ active: transport.active, mode: transport.mode, type: "transport" });
  }

  /** Posts one message to the webview when a panel is open. */
  private post(message: Record<string, unknown>): void {
    void this.panel?.webview.postMessage(message);
  }
}

/** Returns whether a webview payload contains a usable query overlay rectangle. */
function isOverlayGeometry(value: unknown): value is WorkbenchOverlayGeometry {
  const rect = value as WorkbenchOverlayGeometry | undefined;
  return !!rect && Number.isFinite(rect.left) && Number.isFinite(rect.top) && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 40 && rect.height > 40;
}

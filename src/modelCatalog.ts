// Activity Bar webview that searches and filters installed Django models in place.

import * as path from "path";
import * as vscode from "vscode";
import { type BackendModelList, MODEL_IDLE_MESSAGE } from "./modelBackend";
import type { ModelDataSource } from "./modelBrowser";
import { modelCatalogHtml } from "./modelCatalogHtml";
import { DiagnosticLogger } from "./diagnostics";

interface CatalogMessage {
  app?: string;
  model?: string;
  type: string;
}

const VIEW_ID = "djangoShell.modelCatalog";
const CATALOG_LOAD_RETRIES = 4;
const CATALOG_RETRY_BASE_MS = 500;
const CATALOG_REQUEST_TIMEOUT_MS = 8000;
const CATALOG_BUSY_MESSAGE = "Django shell is busy running or debugging Python. Try again after the current cell continues or finishes.";
const CATALOG_REQUEST_TIMEOUT = Symbol("catalogRequestTimeout");

/** Renders a searchable, filterable list of models that opens the data browser on selection. */
export class ModelCatalog implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private loadToken = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stale = true;

  /** Stores the extension path and the model data source. */
  constructor(private readonly extensionPath: string, private readonly source: ModelDataSource, private readonly logger?: DiagnosticLogger) {}

  /** Registers the webview view provider and its refresh command. */
  activate(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(VIEW_ID, this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.commands.registerCommand("djangoShell.refreshModelCatalog", () => this.refresh()),
      this.source.onDidChangeRuntime(() => this.handleRuntimeChange())
    );
    context.subscriptions.push(this);
  }

  /** Builds the webview, wires messaging, and loads the model list. */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(this.extensionPath, "media"))] };
    view.webview.html = modelCatalogHtml(view.webview, this.extensionPath);
    view.webview.onDidReceiveMessage((message: CatalogMessage) => void this.handleMessage(message), undefined, this.disposables);
    view.onDidChangeVisibility(() => this.handleVisibility(view.visible), undefined, this.disposables);
    view.onDidDispose(() => { this.view = undefined; }, undefined, this.disposables);
  }

  /** Marks the catalog stale on runtime changes and reloads only while it is on screen — a hidden catalog exchanges nothing until revealed. */
  private handleRuntimeChange(): void {
    this.stale = true;
    if (this.view?.visible) { this.refresh(); }
  }

  /** Reloads a stale catalog when the view is revealed and stops retry churn when it hides. */
  private handleVisibility(visible: boolean): void {
    if (!visible) { this.clearRetry(); return; }
    if (this.stale) { this.refresh(); }
  }

  /** Releases provider listeners and any pending retry. */
  dispose(): void {
    this.clearRetry();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Routes one message from the catalog webview. */
  private async handleMessage(message: CatalogMessage): Promise<void> {
    if (message.type === "ready") {
      this.refresh();
    } else if (message.type === "open" && message.app && message.model) {
      await vscode.commands.executeCommand("djangoShell.openModelData", { app: message.app, model: message.model });
    }
  }

  /** Reloads the catalog, superseding any in-flight load or pending retry. */
  private refresh(): void {
    this.loadToken += 1;
    this.clearRetry();
    void this.load(this.loadToken, 0);
  }

  /** Loads the catalog and posts it; a just-started shell may not serve the first introspection cleanly, so a failed load retries briefly until the runtime settles. */
  private async load(token: number, attempt: number): Promise<void> {
    if (!this.view || token !== this.loadToken) {
      return;
    }
    const started = Date.now();
    let list: BackendModelList;
    try {
      const pendingList = this.source.listModels();
      let result = await Promise.race([pendingList, new Promise<typeof CATALOG_REQUEST_TIMEOUT>((resolve) => setTimeout(() => resolve(CATALOG_REQUEST_TIMEOUT), CATALOG_REQUEST_TIMEOUT_MS))]);
      if (result === CATALOG_REQUEST_TIMEOUT) {
        this.logger?.log("model.catalog.timeout", { attempt, ms: CATALOG_REQUEST_TIMEOUT_MS });
        void this.view.webview.postMessage({ error: CATALOG_BUSY_MESSAGE, models: [], ok: false, type: "models" });
        // The slow read already queued backend work (possibly a typed PTY cell) — apply its result when it lands instead of discarding it.
        result = await pendingList;
      }
      list = result;
    } catch (error) {
      list = { error: error instanceof Error ? error.message : String(error), models: [], ok: false };
    }
    if (!this.view || token !== this.loadToken) {
      return;
    }
    this.logger?.log("model.catalog.load", { attempt, models: list.models.length, ms: Date.now() - started, ok: list.ok });
    void this.view.webview.postMessage({ error: list.error, models: list.models, ok: list.ok, type: "models" });
    if (list.ok) {
      this.stale = false;
      return;
    }
    this.stale = true;
    // No shell attached is a deterministic idle state: the next runtime change reloads it, so retrying now only logs noise.
    if (list.error !== MODEL_IDLE_MESSAGE && this.view.visible && attempt < CATALOG_LOAD_RETRIES) {
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.load(token, attempt + 1); }, CATALOG_RETRY_BASE_MS * (attempt + 1));
    }
  }

  /** Cancels any scheduled catalog reload. */
  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }
}

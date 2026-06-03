// Webview panel that browses Django model rows with lazy foreign-key expansion.

import * as path from "path";
import * as vscode from "vscode";
import type { BackendTransport, BackendTransportMode } from "./backendClient";
import type { BackendCommitResult, BackendModelCount, BackendModelFilter, BackendModelList, BackendModelOrder, BackendModelRelatedRows, BackendModelRows, BackendModelSchema, ModelCommitChange, ModelCommitQuery, ModelCountQuery, ModelRelatedQuery, ModelRowsQuery } from "./modelBackend";
import { modelBrowserHtml } from "./modelBrowserHtml";
import { DiagnosticLogger } from "./diagnostics";

/** Backend access used by the catalog tree and the data browser panel. */
export interface ModelDataSource {
  listModels(): Promise<BackendModelList>;
  modelCommit(query: ModelCommitQuery): Promise<BackendCommitResult>;
  modelCount(query: ModelCountQuery): Promise<BackendModelCount>;
  modelRelated(query: ModelRelatedQuery): Promise<BackendModelRelatedRows>;
  modelRows(query: ModelRowsQuery): Promise<BackendModelRows>;
  modelSchema(app: string, model: string): Promise<BackendModelSchema>;
  /** Returns the active transport and the user's selected transport preference. */
  modelTransportInfo(): { active: BackendTransport; mode: BackendTransportMode };
  readonly onDidChangeRuntime: vscode.Event<void>;
  setModelTransport(mode: BackendTransportMode): void;
}

interface ModelTarget {
  app: string;
  label?: string;
  model: string;
}

interface IncomingMessage {
  app?: string;
  changes?: ModelCommitChange[];
  filters?: BackendModelFilter[];
  mode?: BackendTransportMode;
  model?: string;
  order?: BackendModelOrder[];
  pk?: unknown;
  relation?: string;
  requestId?: number;
  type: string;
  value?: unknown;
}

const VIEW_TYPE = "djangoShell.modelBrowser";
const PAGE_SIZE = 50;

/** Opens and drives a single reusable webview panel for browsing model data. */
export class ModelBrowser implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private panel: vscode.WebviewPanel | undefined;
  private panelReady = false;
  private current: ModelTarget | undefined;
  private filters: BackendModelFilter[] = [];
  private order: BackendModelOrder[] = [];
  private nextCursor: unknown;
  private nextOffset: number | null = null;

  /** Stores the extension path and the model data source. */
  constructor(private readonly extensionPath: string, private readonly source: ModelDataSource, private readonly logger?: DiagnosticLogger) {}

  /** Registers the open-model command and runtime change refresh. */
  activate(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.commands.registerCommand("djangoShell.openModelData", (target?: ModelTarget) => this.openModel(target)),
      this.source.onDidChangeRuntime(() => this.handleRuntimeChange())
    );
    context.subscriptions.push(this);
  }

  /** Releases the panel and command registrations. */
  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Opens the browser for one model, prompting for a model when none was provided. */
  async openModel(target?: ModelTarget): Promise<void> {
    const resolved = target?.app && target?.model ? target : await this.pickModel();
    if (!resolved) {
      return;
    }
    this.current = resolved;
    this.filters = [];
    this.order = [];
    this.ensurePanel();
    this.panel?.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
    if (this.panelReady) {
      await this.loadModel();
    }
  }

  /** Prompts the user to pick a model when the command runs without arguments. */
  private async pickModel(): Promise<ModelTarget | undefined> {
    const list = await this.source.listModels();
    if (!list.ok) {
      void vscode.window.showWarningMessage(list.error ?? "Open the Django Shell console first.");
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      list.models.map((info) => ({ description: info.table, detail: info.label, info, label: `${info.app}.${info.model}` })),
      { placeHolder: `Search ${list.models.length} models by app, name, or table…`, matchOnDescription: true, matchOnDetail: true }
    );
    return picked ? { app: picked.info.app, label: picked.info.label, model: picked.info.model } : undefined;
  }

  /** Creates the webview panel once and wires its message and dispose handlers. */
  private ensurePanel(): void {
    if (this.panel) {
      return;
    }
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Model Data", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.extensionPath, "media"))],
      retainContextWhenHidden: true
    });
    this.panel.webview.html = modelBrowserHtml(this.panel.webview, this.extensionPath);
    this.panel.onDidDispose(() => this.closePanel(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage((message: IncomingMessage) => void this.handleMessage(message), undefined, this.disposables);
  }

  /** Clears panel state when the webview is closed. */
  private closePanel(): void {
    this.panel = undefined;
    this.panelReady = false;
  }

  /** Loads schema and the first row page for the current model. */
  private async loadModel(): Promise<void> {
    if (!this.current || !this.panel) {
      return;
    }
    const target = this.current;
    this.panel.title = `${target.model} — data`;
    this.post({ label: target.label, model: `${target.app}.${target.model}`, type: "loading" });
    const schema = await this.source.modelSchema(target.app, target.model);
    if (this.current !== target) {
      return;
    }
    if (!schema.ok) {
      this.post({ message: schema.error ?? "Could not load model schema.", type: "error" });
      return;
    }
    this.post({ schema, type: "schema" });
    await this.loadPage(true);
    const transport = this.source.modelTransportInfo();
    this.post({ active: transport.active, mode: transport.mode, type: "transport" });
  }

  /** Loads one page of rows, resetting the grid or appending to it. */
  private async loadPage(reset: boolean): Promise<void> {
    if (!this.current) {
      return;
    }
    const target = this.current;
    const query: ModelRowsQuery = { app: target.app, filters: this.filters, limit: PAGE_SIZE, model: target.model, order: this.order };
    if (!reset && this.nextCursor !== undefined && this.nextCursor !== null) {
      query.cursor = this.nextCursor;
    } else if (!reset && this.nextOffset !== null) {
      query.offset = this.nextOffset;
    }
    const rows = await this.source.modelRows(query);
    if (this.current !== target) {
      return;
    }
    this.nextCursor = rows.ok ? rows.nextCursor : undefined;
    this.nextOffset = rows.ok ? rows.nextOffset : null;
    this.logger?.log("model.browser.rows", { append: !reset, model: `${target.app}.${target.model}`, ok: rows.ok, rows: rows.rows.length });
    this.post({ append: !reset, rows, type: "rows" });
  }

  /** Routes one message from the webview to its handler. */
  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (message.type === "ready") {
      this.panelReady = true;
      if (this.current) {
        await this.loadModel();
      }
    } else if (message.type === "reload") {
      await this.loadModel();
    } else if (message.type === "loadMore") {
      await this.loadPage(false);
    } else if (message.type === "applyQuery") {
      this.filters = Array.isArray(message.filters) ? message.filters : [];
      this.order = Array.isArray(message.order) ? message.order : [];
      await this.loadPage(true);
    } else if (message.type === "requestCount") {
      await this.requestCount();
    } else if (message.type === "commitEdits") {
      await this.commitEdits(message);
    } else if (message.type === "setTransport" && message.mode) {
      this.source.setModelTransport(message.mode);
      await this.loadModel();
    } else if (message.type === "expandRelated") {
      await this.expandRelated(message);
    } else if (message.type === "openModel" && message.app && message.model) {
      await this.openModel({ app: message.app, model: message.model });
    }
  }

  /** Computes and returns the total row count for the current filter set. */
  private async requestCount(): Promise<void> {
    if (!this.current) {
      return;
    }
    const result = await this.source.modelCount({ app: this.current.app, filters: this.filters, model: this.current.model });
    this.post({ count: result.count, error: result.error, ok: result.ok, orm: result.orm, sql: result.sql, type: "count" });
  }

  /** Commits staged cell edits in one transaction and returns the result to the webview. */
  private async commitEdits(message: IncomingMessage): Promise<void> {
    if (!this.current || !Array.isArray(message.changes) || !message.changes.length) {
      return;
    }
    const result = await this.source.modelCommit({ app: this.current.app, changes: message.changes, model: this.current.model });
    this.logger?.log("model.browser.commit", { model: `${this.current.app}.${this.current.model}`, ok: result.ok, saved: result.saved });
    this.post({ result, type: "commit" });
  }

  /** Fetches related rows for one source row and returns them to the webview. */
  private async expandRelated(message: IncomingMessage): Promise<void> {
    if (!this.current || !message.relation || message.pk === undefined) {
      return;
    }
    const query: ModelRelatedQuery = { app: this.current.app, limit: PAGE_SIZE, model: this.current.model, pk: message.pk, relation: message.relation, value: message.value };
    const result = await this.source.modelRelated(query);
    this.post({ requestId: message.requestId, result, type: "related" });
  }

  /** Reloads the open panel when the attached runtime changes. */
  private handleRuntimeChange(): void {
    if (this.panel && this.current) {
      void this.loadModel();
    }
  }

  /** Posts one message to the webview when a panel is open. */
  private post(message: Record<string, unknown>): void {
    void this.panel?.webview.postMessage(message);
  }
}

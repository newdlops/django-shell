// Single reusable webview panel that runs user-written Django ORM code and renders the result in the grid.

import * as path from "path";
import * as vscode from "vscode";
import type { BackendTransportMode } from "./backendClient";
import type { BackendModelColumn, ModelCommitChange, ModelRelatedQuery } from "./modelBackend";
import type { ModelDataSource } from "./modelBrowser";
import { modelBrowserHtml } from "./modelBrowserHtml";
import { DiagnosticLogger } from "./diagnostics";

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
  requestId?: number;
  single?: boolean;
  type: string;
  value?: unknown;
}

const VIEW_TYPE = "djangoShell.modelQueryConsole";
const PAGE_SIZE = 50;

/** Opens and drives a single reusable query-console panel: evaluates ORM code and tabulates results. */
export class ModelQueryConsole implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private panel: vscode.WebviewPanel | undefined;
  private panelReady = false;
  private lastCode: string | undefined;
  private nextOffset: number | null = null;
  private pageSize = PAGE_SIZE;
  private current: { app: string; model: string } | undefined;
  private columns: BackendModelColumn[] = [];

  /** Stores the extension path and the model data source. */
  constructor(private readonly extensionPath: string, private readonly source: ModelDataSource, private readonly logger?: DiagnosticLogger) {}

  /** Registers the run-query command and runtime change refresh. */
  activate(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.commands.registerCommand("djangoShell.runModelQuery", () => this.open()),
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
    this.panel.webview.html = modelBrowserHtml(this.panel.webview, this.extensionPath);
    this.panel.onDidDispose(() => this.closePanel(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage((message: IncomingMessage) => void this.handleMessage(message), undefined, this.disposables);
  }

  /** Clears panel state when the webview is closed. */
  private closePanel(): void {
    this.panel = undefined;
    this.panelReady = false;
  }

  /** Routes one message from the webview to its handler. */
  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (typeof message.pageSize === "number" && message.pageSize > 0) {
      this.pageSize = message.pageSize;
    }
    if (message.type === "ready") {
      this.panelReady = true;
      this.post({ type: "queryMode" });
      this.postTransport();
      if (this.lastCode) {
        await this.runQuery(this.lastCode, true);
      }
    } else if (message.type === "runQuery" && typeof message.code === "string") {
      this.lastCode = message.code;
      await this.runQuery(message.code, true);
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
  private async runQuery(code: string, reset: boolean): Promise<void> {
    if (!this.panel) {
      return;
    }
    const offset = reset ? 0 : this.nextOffset ?? 0;
    const result = await this.source.modelQuery({ code, limit: this.pageSize, offset });
    if (!this.panel) {
      return;
    }
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

// Webview panels that browse Django model rows with lazy foreign-key expansion (one panel per tab).

import * as path from "path";
import * as vscode from "vscode";
import type { BackendTransport, BackendTransportMode } from "./backendClient";
import type { BackendCommitResult, BackendFilterFieldTree, BackendModelAggregate, BackendModelColumn, BackendModelComputed, BackendModelCount, BackendModelFilter, BackendModelList, BackendModelLookup, BackendModelOrder, BackendModelQuery, BackendModelRelatedRows, BackendModelRelation, BackendModelRows, BackendModelSchema, ModelAggregateQuery, ModelAggregateTerm, ModelAnnotationSpec, ModelCommitChange, ModelCommitQuery, ModelComputedQuery, ModelCountQuery, ModelLookupQuery, ModelQueryRequest, ModelRelatedQuery, ModelRowsQuery } from "./modelBackend";
import { modelBrowserHtml } from "./modelBrowserHtml";
import { DiagnosticLogger } from "./diagnostics";

/** Backend access used by the catalog tree and the data browser panels. */
export interface ModelDataSource {
  listModels(): Promise<BackendModelList>;
  modelAggregate(query: ModelAggregateQuery): Promise<BackendModelAggregate>;
  modelCommit(query: ModelCommitQuery): Promise<BackendCommitResult>;
  modelComputed(query: ModelComputedQuery): Promise<BackendModelComputed>;
  modelCount(query: ModelCountQuery): Promise<BackendModelCount>;
  modelFilterFields(app: string, model: string): Promise<BackendFilterFieldTree>;
  modelLookup(query: ModelLookupQuery): Promise<BackendModelLookup>;
  modelQuery(query: ModelQueryRequest): Promise<BackendModelQuery>;
  /** Returns hidden runtime imports used to analyze custom ORM query input. */
  modelQueryPrelude?(): Promise<string[]>;
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
  /** When set, the panel opens pre-filtered to this primary key (FK-link drill-in). */
  initialPk?: unknown;
  label?: string;
  model: string;
}

interface IncomingMessage {
  aggregates?: ModelAggregateTerm[];
  annotations?: ModelAnnotationSpec[];
  app?: string;
  changes?: ModelCommitChange[];
  columns?: BackendModelColumn[];
  field?: string;
  filterPk?: unknown;
  filters?: BackendModelFilter[];
  groupBy?: string[];
  mode?: BackendTransportMode;
  model?: string;
  order?: BackendModelOrder[];
  pageSize?: number;
  pk?: unknown;
  q?: string;
  relation?: string;
  requestId?: number | string;
  single?: boolean;
  target?: string;
  type: string;
  value?: unknown;
}

const VIEW_TYPE = "djangoShell.modelBrowser";
const PAGE_SIZE = 50;
const MODEL_REQUEST_TIMEOUT_MS = 8000;
const MODEL_BUSY_MESSAGE = "Django shell is busy running or debugging Python. Try again after the current cell continues or finishes.";
const MODEL_REQUEST_TIMEOUT = Symbol("modelRequestTimeout");

/** Opens model-data browser tabs; each open creates an independent panel with its own state. */
export class ModelBrowser implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly panels = new Set<ModelBrowserPanel>();

  /** Stores the extension path and the model data source. */
  constructor(private readonly extensionPath: string, private readonly source: ModelDataSource, private readonly logger?: DiagnosticLogger) {}

  /** Registers the open-model command and runtime change refresh. */
  activate(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.commands.registerCommand("djangoShell.openModelData", (target?: ModelTarget) => this.openModel(target)),
      this.source.onDidChangeRuntime(() => this.refreshPanels())
    );
    context.subscriptions.push(this);
  }

  /** Releases every open panel and the command registrations. */
  dispose(): void {
    for (const panel of [...this.panels]) {
      panel.dispose();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Opens a new browser tab for one model, prompting for a model when none was provided. */
  async openModel(target?: ModelTarget): Promise<void> {
    const resolved = target?.app && target?.model ? target : await this.pickModel();
    if (!resolved) {
      return;
    }
    const panel = new ModelBrowserPanel(this.extensionPath, this.source, resolved, (next) => void this.openModel(next), this.logger);
    this.panels.add(panel);
    panel.onDidDispose(() => this.panels.delete(panel));
  }

  /** Reloads every open panel after the attached runtime changes. */
  private refreshPanels(): void {
    for (const panel of this.panels) {
      panel.refresh();
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
}

/** Drives one model-data browser webview panel and its own filter/sort/pagination/edit state. */
class ModelBrowserPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly disposeHandlers: Array<() => void> = [];
  private panelReady = false;
  private disposed = false;
  private filters: BackendModelFilter[] = [];
  private annotations: ModelAnnotationSpec[] = [];
  private order: BackendModelOrder[] = [];
  private nextCursor: unknown;
  private nextOffset: number | null = null;
  private pageSize = PAGE_SIZE;
  private columns: BackendModelColumn[] = [];
  private relations: BackendModelRelation[] = [];
  private loadedRowCount = 0;
  private loadGeneration = 0;

  /** Creates the webview panel for one model target and wires its message and dispose handlers. */
  constructor(
    extensionPath: string,
    private readonly source: ModelDataSource,
    private readonly target: ModelTarget,
    private readonly openAnother: (target: ModelTarget) => void,
    private readonly logger?: DiagnosticLogger
  ) {
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, `${target.model} — data`, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(extensionPath, "media"))],
      retainContextWhenHidden: true
    });
    this.panel.webview.html = modelBrowserHtml(this.panel.webview, extensionPath);
    if (target.initialPk !== undefined && target.initialPk !== null) {
      // Opened by following a foreign-key link: pre-filter to that row's primary key. `pk` is allowlisted backend-side and resolves to the model's real primary key in every transport.
      this.filters = [{ field: "pk", lookup: "exact", value: target.initialPk }];
    }
    this.panel.onDidDispose(() => this.handleDispose(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage((message: IncomingMessage) => void this.handleMessage(message), undefined, this.disposables);
  }

  /** Registers a callback fired when this panel is closed. */
  onDidDispose(handler: () => void): void {
    this.disposeHandlers.push(handler);
  }

  /** Closes the underlying panel. */
  dispose(): void {
    this.panel.dispose();
  }

  /** Reloads the panel when the attached runtime changes. */
  refresh(): void {
    if (this.panelReady) {
      void this.loadModel();
    }
  }

  /** Releases listeners and notifies the owner when the panel is closed. */
  private handleDispose(): void {
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    for (const handler of this.disposeHandlers) {
      handler();
    }
  }

  /** Returns whether the active transport reconstructs reads as readable ORM cells (no schema RPC): ORM or Terminal mode. */
  private reconstructsViaOrmCell(): boolean {
    const mode = this.source.modelTransportInfo().mode;
    return mode === "orm" || mode === "pty";
  }

  /** Loads schema and the first row page for this panel's model. */
  private async loadModel(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const generation = this.nextLoadGeneration();
    this.panel.title = `${this.target.model} — data`;
    this.post({ label: this.target.label, model: `${this.target.app}.${this.target.model}`, type: "loading" });
    if (this.reconstructsViaOrmCell()) {
      // ORM and Terminal modes type the read as a literal cell (no schema RPC); the head is synthesized from the first page.
      await this.loadPage(true, generation);
    } else {
      const schema = await this.withRequestTimeout("schema", this.source.modelSchema(this.target.app, this.target.model), generation);
      if (!schema || !this.isCurrentLoad(generation)) {
        return;
      }
      if (!schema.ok) {
        this.post({ message: schema.error ?? "Could not load model schema.", type: "error" });
        return;
      }
      this.columns = schema.columns;
      this.relations = schema.relations;
      this.post({ schema, type: "schema" });
      await this.loadPage(true, generation);
    }
    if (!this.isCurrentLoad(generation)) { return; }
    const transport = this.source.modelTransportInfo();
    this.post({ active: transport.active, mode: transport.mode, type: "transport" });
  }

  /** Loads one page of rows, resetting the grid or appending to it. */
  private async loadPage(reset: boolean, generation = this.nextLoadGeneration()): Promise<void> {
    const query: ModelRowsQuery = { annotations: this.annotations, app: this.target.app, columns: this.columns, filters: this.filters, limit: this.pageSize, model: this.target.model, order: this.order, relations: this.relations };
    if (!reset && this.nextCursor !== undefined && this.nextCursor !== null) {
      query.cursor = this.nextCursor;
    } else if (!reset && this.nextOffset !== null) {
      query.offset = this.nextOffset;
    }
    const rows = await this.withRequestTimeout("rows", this.source.modelRows(query), generation);
    if (!rows || !this.isCurrentLoad(generation)) {
      return;
    }
    this.nextCursor = rows.ok ? rows.nextCursor : undefined;
    this.nextOffset = rows.ok ? rows.nextOffset : null;
    this.loadedRowCount = (reset ? 0 : this.loadedRowCount) + (rows.ok ? rows.rows.length : 0);
    if (rows.ok && rows.columns.length) {
      this.columns = rows.columns;
    }
    if (rows.ok && rows.relations) {
      this.relations = rows.relations;
    }
    if (reset && rows.ok && this.reconstructsViaOrmCell()) {
      // ORM and Terminal modes have no schema RPC: build the grid head from the page's own columns/relations.
      this.post({ schema: { app: this.target.app, columns: rows.columns, label: this.target.label ?? "", model: this.target.model, ok: true, pk: rows.pk ?? "id", relations: rows.relations ?? [], table: "" }, type: "schema" });
    }
    this.logger?.log("model.browser.rows", { append: !reset, model: `${this.target.app}.${this.target.model}`, ok: rows.ok, rows: rows.rows.length });
    this.post({ append: !reset, filters: this.filters, order: this.order, rows, type: "rows" });
  }

  /** Returns the next generation id for model loads so late responses cannot update this panel. */
  private nextLoadGeneration(): number { this.loadGeneration += 1; return this.loadGeneration; }

  /** Returns whether a model load response still belongs to the current panel request. */
  private isCurrentLoad(generation: number): boolean { return !this.disposed && generation === this.loadGeneration; }

  /** Awaits one backend model request with a UI timeout so debug pauses and long cells do not leave the grid loading forever. */
  private async withRequestTimeout<T>(kind: string, request: Promise<T>, generation: number): Promise<T | undefined> {
    try {
      const result = await Promise.race([request, new Promise<typeof MODEL_REQUEST_TIMEOUT>((resolve) => setTimeout(() => resolve(MODEL_REQUEST_TIMEOUT), MODEL_REQUEST_TIMEOUT_MS))]);
      if (result !== MODEL_REQUEST_TIMEOUT) { return result; }
      if (this.isCurrentLoad(generation)) { this.logger?.log("model.browser.timeout", { kind, model: `${this.target.app}.${this.target.model}`, ms: MODEL_REQUEST_TIMEOUT_MS }); this.post({ message: MODEL_BUSY_MESSAGE, type: "busy" }); }
    } catch (error) {
      if (this.isCurrentLoad(generation)) { this.post({ message: error instanceof Error ? error.message : String(error), type: "error" }); }
    }
    return undefined;
  }

  /** Routes one message from the webview to its handler. */
  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (typeof message.pageSize === "number" && message.pageSize > 0) {
      this.pageSize = message.pageSize;
    }
    if (message.type === "ready") {
      this.panelReady = true;
      await this.loadModel();
    } else if (message.type === "reload") {
      await this.loadModel();
    } else if (message.type === "loadMore") {
      await this.loadPage(false);
    } else if (message.type === "applyQuery") {
      this.filters = Array.isArray(message.filters) ? message.filters : [];
      this.order = Array.isArray(message.order) ? message.order : [];
      this.annotations = Array.isArray(message.annotations) ? message.annotations : [];
      await this.loadPage(true);
    } else if (message.type === "requestCount") {
      await this.requestCount();
    } else if (message.type === "aggregate") {
      await this.requestAggregate(message);
    } else if (message.type === "loadComputed" && typeof message.field === "string") {
      await this.loadComputed(message.field);
    } else if (message.type === "commitEdits") {
      await this.commitEdits(message);
    } else if (message.type === "commitRelated") {
      await this.commitRelated(message);
    } else if (message.type === "setTransport" && message.mode) {
      this.source.setModelTransport(message.mode);
      await this.loadModel();
    } else if (message.type === "expandRelated") {
      await this.expandRelated(message);
    } else if (message.type === "lookupRelated") {
      await this.lookupRelated(message);
    } else if (message.type === "filterFields" && message.app && message.model) {
      await this.sendFilterFields(message);
    } else if (message.type === "modelList") {
      await this.sendModelList(message);
    } else if (message.type === "openModel" && message.app && message.model) {
      this.openAnother({ app: message.app, initialPk: message.filterPk, model: message.model });
    }
  }

  /** Fetches one model's filter field/relation tree (root model or a relation target) for the cascading filter dropdowns. */
  private async sendFilterFields(message: IncomingMessage): Promise<void> {
    const result = await this.source.modelFilterFields(message.app as string, message.model as string);
    if (this.disposed) {
      return;
    }
    this.post({ requestId: message.requestId, result, target: `${message.app}.${message.model}`, type: "filterFields" });
  }

  /** Sends the installed-model list to the webview for free-form Subquery target selection. */
  private async sendModelList(message: IncomingMessage): Promise<void> {
    const result = await this.source.listModels();
    if (this.disposed) {
      return;
    }
    this.post({ requestId: message.requestId, result, type: "modelList" });
  }

  /** Lazily fetches one @property column's values for the currently-loaded rows (user activated the column). */
  private async loadComputed(field: string): Promise<void> {
    const result = await this.source.modelComputed({ annotations: this.annotations, app: this.target.app, columns: this.columns, field, filters: this.filters, limit: Math.max(this.loadedRowCount, 1), model: this.target.model, order: this.order, relations: this.relations });
    if (this.disposed) {
      return;
    }
    this.logger?.log("model.browser.computed", { field, model: `${this.target.app}.${this.target.model}`, ok: result.ok, queries: result.queryCount, rows: result.rowCount });
    this.post({ error: result.error, field, ok: result.ok, queryCount: result.queryCount, rowCount: result.rowCount, type: "computed", values: result.values });
  }

  /** Computes and returns the total row count for the current filter set. */
  private async requestCount(): Promise<void> {
    const result = await this.source.modelCount({ app: this.target.app, columns: this.columns, filters: this.filters, model: this.target.model, relations: this.relations });
    this.post({ count: result.count, error: result.error, ok: result.ok, orm: result.orm, sql: result.sql, type: "count" });
  }

  /** Computes grouped/global aggregates for the current filter set and returns the result grid to the webview. */
  private async requestAggregate(message: IncomingMessage): Promise<void> {
    const filters = Array.isArray(message.filters) ? message.filters : this.filters;
    this.filters = filters;
    const result = await this.source.modelAggregate({
      aggregates: Array.isArray(message.aggregates) ? message.aggregates : [],
      app: this.target.app,
      columns: this.columns,
      filters,
      groupBy: Array.isArray(message.groupBy) ? message.groupBy : [],
      model: this.target.model,
      relations: this.relations
    });
    if (this.disposed) {
      return;
    }
    this.logger?.log("model.browser.aggregate", { groups: result.rows.length, model: `${this.target.app}.${this.target.model}`, ok: result.ok });
    this.post({ result, type: "aggregate" });
  }

  /** Commits staged cell edits in one transaction and returns the result to the webview. */
  private async commitEdits(message: IncomingMessage): Promise<void> {
    if (!Array.isArray(message.changes) || !message.changes.length) {
      return;
    }
    const result = await this.source.modelCommit({ app: this.target.app, changes: message.changes, columns: this.columns, model: this.target.model });
    this.logger?.log("model.browser.commit", { model: `${this.target.app}.${this.target.model}`, ok: result.ok, saved: result.saved });
    this.post({ result, type: "commit" });
  }

  /** Commits staged edits made inside an expanded related table against that related model. */
  private async commitRelated(message: IncomingMessage): Promise<void> {
    if (!message.app || !message.model || !Array.isArray(message.changes) || !message.changes.length) {
      return;
    }
    const result = await this.source.modelCommit({ app: message.app, changes: message.changes, columns: Array.isArray(message.columns) ? message.columns : [], model: message.model });
    this.logger?.log("model.browser.commit.related", { model: `${message.app}.${message.model}`, ok: result.ok, saved: result.saved });
    this.post({ result, type: "commit" });
  }

  /** Fetches related rows for one source row and returns them to the webview. */
  private async expandRelated(message: IncomingMessage): Promise<void> {
    if (!message.relation || message.pk === undefined) {
      return;
    }
    const query: ModelRelatedQuery = { app: this.target.app, limit: PAGE_SIZE, model: this.target.model, pk: message.pk, relation: message.relation, single: message.single, value: message.value };
    const result = await this.source.modelRelated(query);
    this.post({ requestId: message.requestId, result, type: "related" });
  }

  /** Searches the target model for foreign-key picker candidates and returns them to the webview. */
  private async lookupRelated(message: IncomingMessage): Promise<void> {
    const target = message.target;
    if (!target) {
      return;
    }
    const split = target.lastIndexOf(".");
    if (split < 0) {
      return;
    }
    const configured = vscode.workspace.getConfiguration("djangoShell").get<string[]>("modelBrowser.lookupExcludeFields", []);
    const exclude = Array.isArray(configured) ? configured.filter((item) => typeof item === "string" && item.trim()) : [];
    const result = await this.source.modelLookup({ app: target.slice(0, split), exclude, model: target.slice(split + 1), q: typeof message.q === "string" ? message.q : "" });
    this.post({ requestId: message.requestId, result, type: "lookup" });
  }

  /** Posts one message to the webview unless the panel has been closed. */
  private post(message: Record<string, unknown>): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }
}

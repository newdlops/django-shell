// Webview panels that browse Django model rows with lazy foreign-key expansion (one panel per tab).

import * as path from "path";
import * as vscode from "vscode";
import type { BackendInterruptResult, BackendTransport, BackendTransportMode } from "./backendClient";
import type { BackendCommitResult, BackendFilterFieldTree, BackendModelAggregate, BackendModelColumn, BackendModelComputed, BackendModelCount, BackendModelFilter, BackendModelList, BackendModelLookup, BackendModelOrder, BackendModelQuery, BackendModelRelatedRows, BackendModelRelation, BackendModelRows, BackendModelSchema, ModelAggregateQuery, ModelAggregateTerm, ModelAnnotationSpec, ModelCommitChange, ModelCommitQuery, ModelComputedQuery, ModelCountQuery, ModelLookupQuery, ModelQueryRequest, ModelRelatedQuery, ModelRowsQuery } from "./modelBackend";
import { modelBrowserHtml } from "./modelBrowserHtml";
import { DiagnosticLogger } from "./diagnostics";
import { buildRecipeCountOrm, buildRecipeRowsOrm, buildRecipeSummaryOrm } from "./modelQueryRecipeOrm";
import { cloneModelQueryRecipe, createEmptyModelQueryRecipe, isModelQueryRecipeV2, type ModelQueryRecipeV2, type QueryModelRef } from "./modelQueryRecipe";
import { createInitialPkModelQueryRecipe, isRecipeInitialPk } from "./modelQueryRecipeInitialPk";
import { loadModelQueryMetadata, ModelQueryMetadataIndex } from "./modelQueryRecipeMetadata";
import type { ModelQueryIssue, ModelQueryValidation } from "./modelQueryRecipeValidation";

/** Backend access used by the catalog tree and the data browser panels. */
export interface ModelDataSource {
  listModels(refresh?: boolean): Promise<BackendModelList>;
  modelAggregate(query: ModelAggregateQuery): Promise<BackendModelAggregate>;
  modelCommit(query: ModelCommitQuery): Promise<BackendCommitResult>;
  modelComputed(query: ModelComputedQuery): Promise<BackendModelComputed>;
  modelCount(query: ModelCountQuery): Promise<BackendModelCount>;
  modelFilterFields(app: string, model: string): Promise<BackendFilterFieldTree>;
  modelLookup(query: ModelLookupQuery): Promise<BackendModelLookup>;
  modelQuery(query: ModelQueryRequest): Promise<BackendModelQuery>;
  /** Interrupts an active custom ORM query without queueing another shell request. */
  interruptModelQuery(reason: string): Promise<BackendInterruptResult>;
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
  grid?: { logicalColumns: number; logicalRows: number; ms: number; renderedCells: number; renderedColumns: number; renderedRows: number };
  mode?: BackendTransportMode;
  model?: string;
  order?: BackendModelOrder[];
  pageSize?: number;
  pk?: unknown;
  q?: string;
  relation?: string;
  requestId?: number | string;
  recipe?: ModelQueryRecipeV2;
  revision?: number;
  single?: boolean;
  target?: string;
  type: string;
  value?: unknown;
}

const VIEW_TYPE = "djangoShell.modelBrowser";
const PAGE_SIZE = 50;
const MODEL_REQUEST_TIMEOUT_MS = 8000;
const MODEL_BUSY_MESSAGE = "Django shell is busy. Retry when the current execution finishes.";
const MODEL_REQUEST_TIMEOUT = Symbol("modelRequestTimeout");

/** Creates a user-actionable Recipe protocol issue before full semantic validation is available. */
function recipeIssue(code: "FIELD_METADATA_UNAVAILABLE" | "RECIPE_SHAPE_INVALID" | "RECIPE_SOURCE_MISMATCH", fix: string): ModelQueryIssue {
  return { code, fix, message: code.split("_").map((part) => part.toLowerCase()).join(" "), path: "", severity: "error" };
}

/** Normalizes unknown rejection values into one concise metadata error message. */
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Creates a compact query-log summary without putting Recipe JSON into a user-visible log. */
function compactRecipeSummary(recipe: ModelQueryRecipeV2): string {
  const filters = recipe.where.children.length;
  const computed = recipe.computed.filter((item) => item.enabled).length;
  const mode = recipe.mode === "summary" ? recipe.groupBy.length ? `Summary grouped by ${recipe.groupBy.length} field${recipe.groupBy.length === 1 ? "" : "s"}` : "Global summary" : "Rows";
  const order = recipe.orderBy.length ? `${recipe.orderBy.length} explicit order term${recipe.orderBy.length === 1 ? "" : "s"}` : "primary-key ascending";
  return `${mode}; ${filters ? `${filters} filter${filters === 1 ? "" : "s"}` : "all rows"}; ${computed ? `${computed} computed column${computed === 1 ? "" : "s"}` : "no computed columns"}; ${order}`;
}

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
  private appliedRecipe: ModelQueryRecipeV2;
  private appliedRecipeRevision = 0;
  private appliedRecipeSummary = "All rows · no computed columns · Rows ordered by primary key ascending";
  private initialRecipeHydrated = false;
  private latestRecipeRevision = 0;
  private recipeMetadata: ModelQueryMetadataIndex | undefined;
  private readonly recipeTreeCache = new Map<string, BackendFilterFieldTree>();
  private readonly recipeTreeRequests = new Map<string, Promise<BackendFilterFieldTree>>();
  private recipeModelCatalog: QueryModelRef[] | undefined;
  private recipeModelCatalogRequest: Promise<QueryModelRef[]> | undefined;

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
    this.panel.webview.html = modelBrowserHtml(this.panel.webview, extensionPath, { mode: "model" });
    const recipeSource = { app: target.app, model: target.model };
    this.appliedRecipe = createEmptyModelQueryRecipe(recipeSource);
    if (target.initialPk !== undefined && target.initialPk !== null && isRecipeInitialPk(target.initialPk)) {
      // Opened by following a foreign-key link: pre-filter to that row's primary key. `pk` is allowlisted backend-side and resolves to the model's real primary key in every transport.
      this.filters = [{ field: "pk", lookup: "exact", value: target.initialPk }];
      this.appliedRecipe = createInitialPkModelQueryRecipe(recipeSource, target.initialPk);
      this.appliedRecipeSummary = compactRecipeSummary(this.appliedRecipe);
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
      void this.refreshAppliedRecipe();
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
    this.post({ label: this.target.label, model: `${this.target.app}.${this.target.model}`, phase: "schema", type: "loading" });
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
      this.hydrateInitialRecipe();
      await this.loadPage(true, generation);
    }
    if (!this.isCurrentLoad(generation)) { return; }
    const transport = this.source.modelTransportInfo();
    this.hydrateInitialRecipe();
    this.post({ active: transport.active, mode: transport.mode, type: "transport" });
  }

  /** Loads one page of rows, resetting the grid or appending to it. */
  private async loadPage(reset: boolean, generation = this.nextLoadGeneration()): Promise<void> {
    this.post({ phase: reset ? "rows" : "more", type: "loading" });
    const query: ModelRowsQuery = { annotations: this.annotations, app: this.target.app, columns: this.columns, filters: this.filters, limit: this.pageSize, model: this.target.model, order: this.order, relations: this.relations };
    const revision = this.appliedRecipeRevision;
    if (this.recipeMetadata) {
      query.recipe = this.appliedRecipe;
      query.recipeMetadata = this.recipeMetadata.toBundle();
    }
    if (!reset && this.nextCursor !== undefined && this.nextCursor !== null) {
      query.cursor = this.nextCursor;
    } else if (!reset && this.nextOffset !== null) {
      query.offset = this.nextOffset;
    }
    const rows = await this.withRequestTimeout("rows", this.source.modelRows(query), generation);
    if (!rows || !this.isCurrentRecipeLoad(generation, revision)) {
      return;
    }
    if (!rows.ok && this.recipeMetadata && rows.issues?.length) {
      this.post({ issues: rows.issues, revision, type: "queryRecipeRejected" });
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
    this.post({ append: !reset, filters: this.filters, order: this.order, queryLog: this.recipeLogMeta("rows"), recipeVersion: rows.recipeVersion, revision, rows, type: "rows" });
  }

  /** Hydrates a linked-row initial Recipe once the webview has received its source schema. */
  private hydrateInitialRecipe(): void {
    if (this.initialRecipeHydrated || this.target.initialPk === undefined || this.target.initialPk === null || !isRecipeInitialPk(this.target.initialPk)) { return; }
    this.initialRecipeHydrated = true;
    this.post({ recipe: this.appliedRecipe, revision: this.appliedRecipeRevision, type: "queryRecipeApplied" });
  }

  /** Returns compact Recipe provenance for a query-log entry without serializing Recipe JSON. */
  private recipeLogMeta(action: "count" | "rows" | "summary"): { action: "count" | "rows" | "summary"; revision: number; summary: string } | undefined {
    if (!this.recipeMetadata) { return undefined; }
    return { action, revision: this.appliedRecipeRevision, summary: this.appliedRecipeSummary };
  }

  /** Returns the next generation id for model loads so late responses cannot update this panel. */
  private nextLoadGeneration(): number { this.loadGeneration += 1; return this.loadGeneration; }

  /** Returns whether a model load response still belongs to the current panel request. */
  private isCurrentLoad(generation: number): boolean { return !this.disposed && generation === this.loadGeneration; }

  /** Returns whether a data response still belongs to both the current load and applied Recipe revision. */
  private isCurrentRecipeLoad(generation: number, revision: number): boolean { return this.isCurrentLoad(generation) && revision === this.appliedRecipeRevision; }

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

  /** Prepares all live metadata referenced by one Recipe, sharing catalog and tree requests across preview and apply. */
  private async prepareRecipeMetadata(recipe: ModelQueryRecipeV2): Promise<ModelQueryMetadataIndex> {
    const catalog = await this.loadRecipeModelCatalog();
    return loadModelQueryMetadata(recipe, (model) => this.loadRecipeTree(model), catalog, this.columns);
  }

  /** Loads and memoizes the installed-model catalog used to resolve explicit subquery sources. */
  private loadRecipeModelCatalog(): Promise<QueryModelRef[]> {
    if (this.recipeModelCatalog) { return Promise.resolve(this.recipeModelCatalog); }
    if (!this.recipeModelCatalogRequest) {
      this.recipeModelCatalogRequest = this.source.listModels().then((result) => {
        if (!result.ok) { throw new Error(result.error ?? "Could not load model metadata."); }
        const models = result.models.map((model) => ({ app: model.app, model: model.model }));
        this.recipeModelCatalog = models;
        return models;
      }).finally(() => { this.recipeModelCatalogRequest = undefined; });
    }
    return this.recipeModelCatalogRequest;
  }

  /** Loads one live filter tree once so concurrent Recipe preview and apply never duplicate metadata requests. */
  private loadRecipeTree(model: QueryModelRef): Promise<BackendFilterFieldTree> {
    const key = `${model.app}.${model.model}`;
    const cached = this.recipeTreeCache.get(key);
    if (cached) { return Promise.resolve(cached); }
    const inFlight = this.recipeTreeRequests.get(key);
    if (inFlight) { return inFlight; }
    const request = this.source.modelFilterFields(model.app, model.model).then((tree) => {
      if (!tree.ok) { throw new Error(tree.error ?? `Could not load ${key} field metadata.`); }
      this.recipeTreeCache.set(key, tree);
      return tree;
    }).finally(() => this.recipeTreeRequests.delete(key));
    this.recipeTreeRequests.set(key, request);
    return request;
  }

  /** Builds a validation-only Recipe compiler result without evaluating any Django QuerySet. */
  private compileRecipe(recipe: ModelQueryRecipeV2, metadata: ModelQueryMetadataIndex): ModelQueryValidation {
    const transport: BackendTransport | "orm" = this.reconstructsViaOrmCell() ? "orm" : this.source.modelTransportInfo().active;
    const context = { columns: this.columns, limit: this.pageSize, metadata, relations: this.relations, source: { app: this.target.app, model: this.target.model }, transport };
    return (recipe.mode === "summary" ? buildRecipeSummaryOrm(recipe, context) : buildRecipeRowsOrm(recipe, context)).validation;
  }

  /** Rejects malformed or source-mismatched Recipe input before any metadata or backend request. */
  private recipeInputIssues(recipe: unknown): ModelQueryIssue[] {
    if (!isModelQueryRecipeV2(recipe)) { return [recipeIssue("RECIPE_SHAPE_INVALID", "Restore the required Recipe v2 objects and arrays.")]; }
    if (recipe.source.app !== this.target.app || recipe.source.model !== this.target.model) { return [recipeIssue("RECIPE_SOURCE_MISMATCH", "Apply this Recipe only to its source model.")]; }
    return [];
  }

  /** Advances the monotonic Recipe revision unless this message is stale. */
  private acceptRecipeRevision(revision: unknown): revision is number {
    if (!Number.isSafeInteger(revision) || (revision as number) < 0 || (revision as number) < this.latestRecipeRevision) { return false; }
    this.latestRecipeRevision = revision as number;
    return true;
  }

  /** Previews a draft Recipe through the extension-host compiler without executing a database query. */
  private async previewQueryRecipe(message: IncomingMessage): Promise<void> {
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    if (!requestId || !this.acceptRecipeRevision(message.revision)) { return; }
    const issues = this.recipeInputIssues(message.recipe);
    if (issues.length) { this.post({ issues, revision: message.revision, type: "queryRecipeRejected" }); return; }
    const recipe = message.recipe as ModelQueryRecipeV2;
    try {
      const metadata = await this.prepareRecipeMetadata(recipe);
      if (this.disposed || message.revision !== this.latestRecipeRevision) { return; }
      const validation = this.compileRecipe(recipe, metadata);
      this.post({ requestId, revision: message.revision, type: "queryRecipePreview", validation });
    } catch (error) {
      if (message.revision === this.latestRecipeRevision) { this.post({ issues: [recipeIssue("FIELD_METADATA_UNAVAILABLE", errorMessage(error))], revision: message.revision, type: "queryRecipeRejected" }); }
    }
  }

  /** Validates, applies, and executes one new authoritative Recipe revision. */
  private async applyQueryRecipe(message: IncomingMessage): Promise<void> {
    if (!this.acceptRecipeRevision(message.revision)) { return; }
    const issues = this.recipeInputIssues(message.recipe);
    if (issues.length) { this.post({ issues, revision: message.revision, type: "queryRecipeRejected" }); return; }
    const recipe = message.recipe as ModelQueryRecipeV2;
    try {
      const metadata = await this.prepareRecipeMetadata(recipe);
      if (this.disposed || message.revision !== this.latestRecipeRevision) { return; }
      const validation = this.compileRecipe(recipe, metadata);
      if (!validation.ok) { this.post({ issues: validation.issues, revision: message.revision, type: "queryRecipeRejected" }); return; }
      this.appliedRecipe = cloneModelQueryRecipe(validation.normalized ?? recipe);
      this.appliedRecipeRevision = message.revision;
      this.appliedRecipeSummary = compactRecipeSummary(this.appliedRecipe);
      this.recipeMetadata = metadata;
      this.post({ recipe: this.appliedRecipe, revision: this.appliedRecipeRevision, type: "queryRecipeApplied" });
      if (this.appliedRecipe.mode === "summary") { await this.loadRecipeSummary(this.appliedRecipeRevision); }
      else { await this.loadPage(true); }
    } catch (error) {
      if (message.revision === this.latestRecipeRevision) { this.post({ issues: [recipeIssue("FIELD_METADATA_UNAVAILABLE", errorMessage(error))], revision: message.revision, type: "queryRecipeRejected" }); }
    }
  }

  /** Runs one applied summary Recipe and suppresses rows from an old Recipe revision. */
  private async loadRecipeSummary(revision: number, generation = this.nextLoadGeneration()): Promise<void> {
    if (!this.recipeMetadata) { return; }
    this.post({ phase: "aggregate", type: "loading" });
    const result = await this.source.modelAggregate({ aggregates: [], app: this.target.app, columns: this.columns, model: this.target.model, recipe: this.appliedRecipe, recipeMetadata: this.recipeMetadata.toBundle(), relations: this.relations });
    if (!this.isCurrentRecipeLoad(generation, revision)) { return; }
    this.logger?.log("model.browser.recipe.summary", { model: `${this.target.app}.${this.target.model}`, ok: result.ok, revision });
    if (!result.ok && result.issues?.length) {
      this.post({ issues: result.issues, revision, type: "queryRecipeRejected" });
      return;
    }
    this.post({ queryLog: this.recipeLogMeta("summary"), result, revision, type: "aggregate" });
  }

  /** Revalidates the applied Recipe after runtime reload and preserves the current grid on failure. */
  private async refreshAppliedRecipe(): Promise<void> {
    if (!this.recipeMetadata) { await this.loadModel(); return; }
    const revision = this.appliedRecipeRevision;
    try {
      const metadata = await this.prepareRecipeMetadata(this.appliedRecipe);
      if (this.disposed || revision !== this.appliedRecipeRevision) { return; }
      const validation = this.compileRecipe(this.appliedRecipe, metadata);
      if (!validation.ok) { this.post({ issues: validation.issues, revision, type: "queryRecipeRejected" }); return; }
      this.recipeMetadata = metadata;
      await this.loadModel();
    } catch (error) {
      if (revision === this.appliedRecipeRevision) { this.post({ issues: [recipeIssue("FIELD_METADATA_UNAVAILABLE", errorMessage(error))], revision, type: "queryRecipeRejected" }); }
    }
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
      if (!this.isRequestedRecipeRevisionCurrent(message)) { return; }
      await this.loadModel();
    } else if (message.type === "loadMore") {
      if (!this.isRequestedRecipeRevisionCurrent(message)) { return; }
      await this.loadPage(false);
    } else if (message.type === "applyQuery") {
      this.filters = Array.isArray(message.filters) ? message.filters : [];
      this.order = Array.isArray(message.order) ? message.order : [];
      this.annotations = Array.isArray(message.annotations) ? message.annotations : [];
      // Preserve the legacy bridge until P4-09 replaces this message with Recipe conversion.
      this.recipeMetadata = undefined;
      this.appliedRecipe = createEmptyModelQueryRecipe({ app: this.target.app, model: this.target.model });
      this.appliedRecipeRevision += 1;
      this.latestRecipeRevision = Math.max(this.latestRecipeRevision, this.appliedRecipeRevision);
      this.post({ phase: "filters", type: "loading" });
      await this.loadPage(true);
    } else if (message.type === "applyQueryRecipe") {
      await this.applyQueryRecipe(message);
    } else if (message.type === "previewQueryRecipe") {
      await this.previewQueryRecipe(message);
    } else if (message.type === "requestCount") {
      if (!this.isRequestedRecipeRevisionCurrent(message)) { return; }
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
    } else if (message.type === "gridRendered" && message.grid) {
      this.logger?.log("model.grid.render", message.grid);
    } else if (message.type === "openConsole") {
      await vscode.commands.executeCommand("djangoShell.openConsole");
    } else if (message.type === "openModel" && message.app && message.model) {
      this.openAnother({ app: message.app, initialPk: message.filterPk, model: message.model });
    }
  }

  /** Rejects a stale webview pagination or count action without changing the applied Recipe. */
  private isRequestedRecipeRevisionCurrent(message: IncomingMessage): boolean {
    return message.revision === undefined || message.revision === this.appliedRecipeRevision;
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
    const revision = this.appliedRecipeRevision;
    const query: ModelComputedQuery = { annotations: this.annotations, app: this.target.app, columns: this.columns, field, filters: this.filters, limit: Math.max(this.loadedRowCount, 1), model: this.target.model, order: this.order, relations: this.relations };
    if (this.recipeMetadata) { query.recipe = this.appliedRecipe; query.recipeMetadata = this.recipeMetadata.toBundle(); }
    const result = await this.source.modelComputed(query);
    if (this.disposed || revision !== this.appliedRecipeRevision) {
      return;
    }
    this.logger?.log("model.browser.computed", { field, model: `${this.target.app}.${this.target.model}`, ok: result.ok, queries: result.queryCount, rows: result.rowCount });
    this.post({ error: result.error, field, ok: result.ok, queryCount: result.queryCount, revision, rowCount: result.rowCount, type: "computed", values: result.values });
  }

  /** Computes and returns the total row count for the current filter set. */
  private async requestCount(): Promise<void> {
    const revision = this.appliedRecipeRevision;
    const query: ModelCountQuery = { app: this.target.app, columns: this.columns, filters: this.filters, model: this.target.model, relations: this.relations };
    if (this.recipeMetadata) { query.recipe = this.appliedRecipe; query.recipeMetadata = this.recipeMetadata.toBundle(); }
    const result = await this.source.modelCount(query);
    if (this.disposed || revision !== this.appliedRecipeRevision) { return; }
    if (!result.ok && result.issues?.length) { this.post({ issues: result.issues, revision, type: "queryRecipeRejected" }); }
    this.post({ count: result.count, error: result.error, ok: result.ok, orm: result.orm, queryLog: this.recipeLogMeta("count"), recipeVersion: result.recipeVersion, revision, sql: result.sql, type: "count" });
  }

  /** Computes grouped/global aggregates for the current filter set and returns the result grid to the webview. */
  private async requestAggregate(message: IncomingMessage): Promise<void> {
    const filters = Array.isArray(message.filters) ? message.filters : this.filters;
    this.filters = filters;
    this.post({ phase: "aggregate", type: "loading" });
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

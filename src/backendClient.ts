// Socket client for executing Python code through the in-process Django shell backend.

import * as net from "net";
import { BackendEndpoint } from "./backendBootstrap";
import { hotReloadTransportError, parseHotReloadResponse, type BackendHotReloadResult } from "./backendHotReloadProtocol";
import { recipeAggregateValidationFailure, recipeCountValidationFailure, recipeRowsValidationFailure, withRecipeResult } from "./backendClientRecipeResults";
import { DiagnosticLogger } from "./diagnostics";
import type { ModelQueryRecipeV2 } from "./modelQueryRecipe";
import { ModelQueryMetadataIndex } from "./modelQueryRecipeMetadata";
import { buildRecipeCountOrm, buildRecipeRowsOrm, buildRecipeSummaryOrm } from "./modelQueryRecipeOrm";
import {
  BackendCommitResult, BackendFilterFieldTree, BackendModelAggregate, BackendModelColumn, BackendModelComputed, BackendModelCount, BackendModelFilter, BackendModelList, BackendModelLookup, BackendModelOrder,
  BackendModelQuery, BackendModelRelatedRows, BackendModelRelation, BackendModelRows, BackendModelSchema, ModelAggregateQuery, ModelAggregateTerm, ModelAnnotationSpec, ModelCommitChange, ModelCommitQuery,
  ModelComputedQuery, ModelCountQuery, ModelLookupQuery, ModelQueryRequest, ModelRelatedQuery, ModelRowsQuery,
  parseFilterFieldsResponse, parseModelAggregateResponse, parseModelCommitResponse, parseModelComputedResponse, parseModelCountResponse, parseModelListResponse, parseModelLookupResponse, parseModelQueryResponse,
  parseModelRelatedResponse, parseModelRowsResponse, parseModelSchemaResponse, parseOrmAggregateResponse, parseOrmCommitResponse, parseOrmComputedResponse, parseOrmCountResponse,
  parseOrmGridResponse, parseOrmLookupResponse, parseOrmModelsResponse, parseOrmRelatedResponse
} from "./modelBackend";
import { aggregatesNeedPython, buildAggregateOrm, buildCommitOrm, buildComputedOrm, buildCountOrm, buildInspectOrm, buildLookupOrm, buildModelsOrm, buildRelatedOrm, buildRowsOrm } from "./modelOrm";
import {
  connectHost, hasDebugExecutionPayload, isPtyFallbackKind, kindErrorResponse, nativeDebuggerTransportError,
  ORM_NO_PTY, ORM_PTY_SUPPRESSED, PARALLEL_MODEL_READ_KINDS, PARALLEL_MODEL_READ_UNAVAILABLE,
  parseBackendResponse, parseChildrenResponse, parseCompletenessResponse, parseDebugBreakpointsResponse,
  parseEnvironmentResponse, parseInspectionResponse, parseInterruptResponse, parseLoadFeatureResponse,
  parseNativeDebuggerResponse, parseOrmInspectChildren, parseOrmInspectResponse, parseProgressResponse,
  parseStageDebugpyResponse, ptyFallbackPayload, unsupportedPtyFallbackResponse, buildInspectChildrenOrm
} from "./backendClientResponses";

export { parseLoadFeatureResponse } from "./backendClientResponses";

const TCP_CONNECT_TIMEOUT_MS = 1500;
const TCP_RETRY_COOLDOWN_MS = 15000;
const PARALLEL_READ_RESPONSE_TIMEOUT_MS = 6000;
const HOT_RELOAD_RESPONSE_TIMEOUT_MS = 15000;
// Max length of a reconstructed ORM cell we'll TYPE into the shell. A literal cell is written as one line, and a tty
// input queue (MAX_INPUT, ~1KB on macOS) silently drops bytes past it → the cell arrives truncated, IPython sits at a
// continuation prompt, and the serialized PTY queue hangs. Reads whose cell exceeds this fall back to the socket/`_djs_rpc`
// request path (bounded, id-matched) instead. The introspection cells (inspect/children) are the long ones.
const PTY_CELL_LIMIT = 900;
// Max rows one ORM read cell returns over the PTY: the result grid rides the PTY marker (~1 MB), so an unbounded page
// ("all" = 1e9) overruns it and the table can't tabulate. "all" therefore loads this many at a time (+ Load more); the
// socket transport (Auto/Socket) has no marker limit and can fetch more at once.
const ORM_PTY_ROW_CAP = 2000;

export interface BackendExecutionResult {
  error?: string;
  ok: boolean;
  result?: string;
  stderr: string;
  stdout: string;
  traceback?: string;
}

export interface BackendProgressSnapshot {
  active: boolean;
  current?: number;
  detail?: string;
  done?: boolean;
  elapsed?: number;
  kind?: string;
  label?: string;
  line?: number;
  ok?: boolean;
  output?: string;
  percent?: number;
  rate?: number;
  stream?: string;
  total?: number | null;
}

export interface BackendInterruptResult {
  error?: string;
  interrupted: boolean;
  message?: string;
  ok: boolean;
  reason?: string;
}

export interface BackendDebugBreakpointsResult {
  breakpointLines?: number[];
  error?: string;
  ok: boolean;
}

export interface BackendCompletenessResult {
  complete: boolean;
  ok: boolean;
  stderr: string;
  traceback?: string;
}

export interface BackendStageDebugpyResult {
  error?: string;
  ok: boolean;
  path?: string | null;
  reused?: boolean;
}

export interface NativeDebuggerStartOptions {
  expectedVersion: string;
  host: string;
  port: number;
  tracerPath: string;
}

export interface BackendNativeDebuggerResult {
  apiVersion: number;
  engine: "experimental";
  error?: string;
  host: string;
  ok: boolean;
  port: number;
  reused: boolean;
  version: string;
}

export type { BackendHotReloadFileResult, BackendHotReloadResult } from "./backendHotReloadProtocol";

export interface BackendLoadFeatureResult {
  error?: string;
  ok: boolean;
  reused?: boolean;
}

export interface BackendRuntimeInspection {
  error?: string;
  loadedModuleCount?: number;
  modules: BackendRuntimeModule[];
  ok: boolean;
  variables: BackendRuntimeVariable[];
}

export interface BackendRuntimeEnvironment {
  basePrefix?: string;
  cwd?: string;
  django?: BackendDjangoRuntime;
  error?: string;
  executable?: string;
  ok: boolean;
  path: string[];
  prefix?: string;
  settingsModule?: string;
  version?: string;
  virtualEnv?: string;
}

export interface BackendDjangoRuntime {
  appsReady?: boolean;
  available?: boolean;
  configured?: boolean;
  error?: string;
  installedApps: string[];
  settingsModule?: string;
  version?: string;
}

export interface BackendRuntimeChildren {
  children: BackendRuntimeVariable[];
  error?: string;
  ok: boolean;
}

export interface BackendRuntimeModule {
  file: string;
  name: string;
  package: string;
}

export interface BackendRuntimeVariable {
  childCount?: number;
  childrenTruncated?: boolean;
  djangoModel?: BackendRuntimeDjangoModel;
  dynamicAttributes?: boolean;
  hasChildren?: boolean;
  importLine?: string;
  kind?: string;
  length?: number;
  name: string;
  origin?: string;
  path?: BackendRuntimePathSegment[];
  preview: string;
  type: string;
  typeImportLine?: string;
}

export interface BackendRuntimeDjangoModel {
  app?: string;
  model?: string;
  pk?: string;
  pkValue?: unknown;
  table?: string;
}

export interface BackendRuntimePathSegment {
  index?: number;
  name?: string;
  op: string;
}

export interface BackendRequestPayload {
  aggregates?: ModelAggregateTerm[];
  annotations?: ModelAnnotationSpec[];
  app?: string;
  breakpointLines?: number[];
  changes?: ModelCommitChange[];
  code?: string;
  cursor?: unknown;
  data?: string;
  digest?: string;
  expectedVersion?: string;
  exclude?: string[];
  filename?: string;
  filters?: BackendModelFilter[];
  groupBy?: string[];
  host?: string;
  kind: string;
  lineOffset?: number;
  lightweight?: boolean;
  limit?: number;
  model?: string;
  offset?: number;
  order?: BackendModelOrder[];
  partsKey?: string;
  path?: BackendRuntimePathSegment[];
  paths?: string[];
  pk?: unknown;
  port?: number;
  q?: string;
  relation?: string;
  reason?: string;
  /** Versioned query recipe sent to the Python backend; in-process metadata is never serialised. */
  recipe?: ModelQueryRecipeV2;
  sourceText?: string;
  tracerPath?: string;
  value?: unknown;
}

export type BackendFallbackTransport = (payload: BackendRequestPayload) => Promise<string>;
export type BackendTransport = "none" | "pty" | "tcp";
// "orm": model-browser reads run as the user's literal ORM cells (audit-friendly); other kinds behave like "auto".
// "pty": forces the terminal and likewise reconstructs reads as ORM cells (no `_djs_rpc`); metadata kinds suppressed.
export type BackendTransportMode = "auto" | "orm" | "pty" | "tcp";

/** Sends execution requests to the backend running inside the Django shell process. */
export class BackendClient {
  private activeTransport: BackendTransport = "none";
  private featureLoader: (() => Promise<void>) | undefined;
  private featureReady: Promise<void> | undefined;
  private forwardedEndpoint: { host: string; port: number } | undefined;
  private modelList: BackendModelList | undefined; private modelListInFlight: Promise<BackendModelList> | undefined;
  private modelListInFlightRefresh = false; private modelRefreshInFlight: Promise<BackendModelList> | undefined;
  private parallelModelReads = false;
  private remoteSocketUnavailable = false;
  private tcpFailedAt = 0;
  private mode: BackendTransportMode = "orm";

  /** Stores the socket endpoint and shared authentication token. */
  constructor(
    private readonly endpoint: BackendEndpoint,
    private readonly logger?: DiagnosticLogger,
    private readonly fallback?: BackendFallbackTransport
  ) {}

  /** Returns the PID of the Python process hosting this backend when reported by the current protocol. */
  get processId(): number | undefined {
    return Number.isInteger(this.endpoint.pid) && Number(this.endpoint.pid) > 0 ? Number(this.endpoint.pid) : undefined;
  }

  /** Returns the transport that most recently completed a backend request. */
  get transport(): BackendTransport {
    return this.activeTransport;
  }

  /** Returns the user-selected transport preference. */
  get transportMode(): BackendTransportMode {
    return this.mode;
  }

  /** Sets the transport preference; re-enables TCP probing unless terminal is forced. */
  setTransportMode(mode: BackendTransportMode): void {
    this.mode = mode;
    if (this.mode !== "pty") {
      this.tcpFailedAt = 0;
    }
  }

  /** Runs model-browser reads through the socket while a Python cell owns the terminal stream. */
  async withParallelModelReads<T>(enabled: boolean, task: () => Promise<T>): Promise<T> {
    const previous = this.parallelModelReads;
    this.parallelModelReads = enabled || previous;
    try {
      return await task();
    } finally {
      this.parallelModelReads = previous;
    }
  }

  /** Marks the loopback socket unreachable so requests skip it and use the PTY — e.g. a remote SSH/kubectl shell whose 127.0.0.1 is the pod's, not ours. */
  markSocketUnavailable(): void {
    this.remoteSocketUnavailable = true;
  }

  /** Routes socket requests through a locally forwarded tunnel endpoint, restoring parallel reads for remote SSH/kubectl shells. */
  useForwardedEndpoint(host: string, port: number): void {
    this.forwardedEndpoint = { host, port };
    this.remoteSocketUnavailable = false;
    this.tcpFailedAt = 0;
  }

  /** Returns whether socket requests should be skipped: remote shells permanently, transient failures only during a short cooldown so one busy/paused moment cannot disable parallel reads for the rest of the session. */
  private get socketUnavailable(): boolean {
    return this.remoteSocketUnavailable || (this.tcpFailedAt !== 0 && Date.now() - this.tcpFailedAt < TCP_RETRY_COOLDOWN_MS);
  }

  /** Returns whether reads reconstruct as readable ORM cells (ORM + Terminal modes) instead of `_djs_rpc` plumbing. */
  private get reconstructsViaOrmCell(): boolean { return this.mode === "pty" || (this.mode === "orm" && !this.parallelModelReads); }

  /** Returns whether runtime-tree metadata truly needs the interactive shell because no local socket path is available or Terminal mode was explicitly selected. */
  private get reconstructsRuntimeInspectionViaOrmCell(): boolean { return this.mode === "pty" || (this.mode === "orm" && this.socketUnavailable); }
  /** Returns whether expensive runtime tree requests are safe for the active transport. */
  supportsRuntimeInspection(): boolean {
    // Local inspection uses the parallel socket; remote/Terminal fallback uses pure Python probe cells whose capture hook attaches metadata.
    if (this.reconstructsRuntimeInspectionViaOrmCell) { return Boolean(this.fallback); }
    return !this.socketUnavailable || Boolean(this.fallback);
  }

  /** Returns whether the hidden overlay prelude can be fetched at all: ORM/Terminal modes suppress the metadata request over the PTY, so without a socket path the fetch deterministically fails and callers should skip it instead of retrying. */
  supportsHiddenPrelude(): boolean {
    return !this.socketUnavailable || (!this.reconstructsViaOrmCell && Boolean(this.fallback));
  }

  /** Executes Python code in the backend namespace and returns captured output. */
  execute(code: string, filename?: string, lineOffset?: number, sourceText?: string, breakpointLines?: number[]): Promise<BackendExecutionResult> {
    return this.request({ breakpointLines, code, filename, kind: "execute", lineOffset, sourceText }, parseBackendResponse);
  }

  /** Starts debugpy through a backend path that leaves process stderr untouched. */
  debugpy(code: string): Promise<BackendExecutionResult> {
    return this.request({ code, kind: "debugpy" }, parseBackendResponse);
  }

  /** Starts or reuses Django Shell's embedded experimental tracer over the authenticated local backend socket. */
  async startNativeDebugger(options: NativeDebuggerStartOptions): Promise<BackendNativeDebuggerResult> {
    const payload: BackendRequestPayload = { ...options, kind: "nativeDebugger" };
    if (this.remoteSocketUnavailable) {
      return nativeDebuggerTransportError("The built-in experimental debugger requires a backend socket on the current VS Code host.");
    }
    const started = Date.now();
    try {
      const buffer = await this.socketRequest(payload);
      const parsed = parseNativeDebuggerResponse(buffer);
      this.activeTransport = "tcp";
      this.tcpFailedAt = 0;
      this.logRequest(payload.kind, started, parsed, buffer.length, undefined, "tcp");
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logRequest(payload.kind, started, undefined, 0, message, "tcp");
      return nativeDebuggerTransportError(`The built-in experimental debugger could not reach the local backend socket: ${message}`);
    }
  }

  /** Reloads loaded modules through the embedded engine over the backend socket; never types reload plumbing into the shell. */
  async hotReload(paths: string[]): Promise<BackendHotReloadResult> {
    const payload: BackendRequestPayload = { kind: "hotReload", paths };
    if (this.remoteSocketUnavailable) {
      return hotReloadTransportError("Built-in hot reload requires a backend socket on the current VS Code host.");
    }
    const started = Date.now();
    try {
      const buffer = await this.socketRequest(payload, HOT_RELOAD_RESPONSE_TIMEOUT_MS);
      const parsed = parseHotReloadResponse(buffer);
      this.activeTransport = "tcp";
      this.tcpFailedAt = 0;
      this.logRequest(payload.kind, started, parsed, buffer.length, undefined, "tcp");
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logRequest(payload.kind, started, undefined, 0, message, "tcp");
      return hotReloadTransportError(`Built-in hot reload could not reach the backend socket: ${message}`);
    }
  }

  /** Probes for an already-staged debugpy bundle by digest; the tiny request may cross the socket or the one-line PTY RPC. */
  stageDebugpyProbe(digest: string): Promise<BackendStageDebugpyResult> {
    return this.request({ digest, kind: "stagedebugpy" }, parseStageDebugpyResponse);
  }

  /** Uploads the compressed debugpy bundle in one socket request; rejects when the socket is unreachable so the caller can fall back to typed PTY staging. */
  stageDebugpyUpload(digest: string, data: string): Promise<BackendStageDebugpyResult> {
    if (this.socketUnavailable) {
      return Promise.reject(new Error("Backend socket is unavailable for the debugpy bundle upload."));
    }
    const started = Date.now();
    const payload: BackendRequestPayload = { data, digest, kind: "stagedebugpy" };
    return this.socketRequest(payload).then((buffer) => {
      const parsed = parseStageDebugpyResponse(buffer);
      this.activeTransport = "tcp";
      this.logRequest(payload.kind, started, parsed, buffer.length, undefined, "tcp");
      return parsed;
    }, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logRequest(payload.kind, started, undefined, 0, message, "tcp");
      throw error instanceof Error ? error : new Error(message);
    });
  }

  /** Loads the deferred model-browser feature over the socket in one request; rejects when the socket is unreachable so the caller can fall back to typed PTY delivery. */
  loadFeature(data: string): Promise<BackendLoadFeatureResult> {
    if (this.socketUnavailable) {
      return Promise.reject(new Error("Backend socket is unavailable for the model browser feature load."));
    }
    const started = Date.now();
    const payload: BackendRequestPayload = { data, kind: "loadfeature" };
    return this.socketRequest(payload).then((buffer) => {
      const parsed = parseLoadFeatureResponse(buffer);
      this.activeTransport = "tcp";
      this.logRequest(payload.kind, started, parsed, buffer.length, undefined, "tcp");
      return parsed;
    }, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logRequest(payload.kind, started, undefined, 0, message, "tcp");
      throw error instanceof Error ? error : new Error(message);
    });
  }

  /** Registers the lazy deferred-feature loader; browse requests await it once on first use instead of loading at attach. */
  setModelBrowserFeatureLoader(loader: () => Promise<void>): void {
    this.featureLoader = loader;
  }

  /** Loads the deferred model-browser feature once before the first browse request. A failed delivery clears the memo so a later browse retries, and the request proceeds into the backend's still-loading guard instead of failing here. */
  private ensureModelBrowserFeature(): Promise<void> {
    if (!this.featureLoader) { return Promise.resolve(); }
    if (!this.featureReady) {
      const attempt: Promise<void> = this.featureLoader().catch((error: unknown) => {
        if (this.featureReady === attempt) { this.featureReady = undefined; }
        this.logger?.log("backend.feature.deferred", { error: error instanceof Error ? error.message : String(error) });
      });
      this.featureReady = attempt;
    }
    return this.featureReady;
  }

  /** Returns the latest running Python progress snapshot when the socket can be polled. */
  progress(): Promise<BackendProgressSnapshot> {
    return this.request({ kind: "progress" }, parseProgressResponse, false);
  }

  /** Interrupts the current user execution over TCP without queueing behind the terminal fallback. */
  interrupt(reason?: string): Promise<BackendInterruptResult> {
    const started = Date.now();
    const payload = { kind: "interrupt", reason };
    return this.socketRequest(payload).then(
      (buffer) => {
        const parsed = parseInterruptResponse(buffer);
        this.activeTransport = "tcp";
        this.logRequest(payload.kind, started, parsed, buffer.length, undefined, "tcp");
        return parsed;
      },
      (error: unknown) => {
        const parsed = { error: error instanceof Error ? error.message : String(error), interrupted: false, ok: false, reason };
        this.logRequest(payload.kind, started, parsed, 0, parsed.error, "tcp");
        return parsed;
      }
    );
  }

  /** Updates active debug breakpoint guards over TCP without queueing behind running user code. */
  debugBreakpoints(breakpointLines: number[]): Promise<BackendDebugBreakpointsResult> {
    const started = Date.now();
    const payload = { breakpointLines, kind: "debugBreakpoints" };
    return this.socketRequest(payload).then(
      (buffer) => {
        const parsed = parseDebugBreakpointsResponse(buffer);
        this.activeTransport = "tcp";
        this.logRequest(payload.kind, started, parsed, buffer.length, undefined, "tcp");
        return parsed;
      },
      (error: unknown) => {
        const parsed = { error: error instanceof Error ? error.message : String(error), ok: false };
        this.logRequest(payload.kind, started, parsed, 0, parsed.error, "tcp");
        return parsed;
      }
    );
  }

  /** Returns whether progress polling can run without queuing behind the interactive PTY cell. */
  canPollProgress(): boolean {
    return this.mode !== "pty" && !this.socketUnavailable;
  }

  /** Checks whether Python source is complete without executing it. */
  isComplete(code: string): Promise<BackendCompletenessResult> {
    return this.request({ code, kind: "complete" }, parseCompletenessResponse);
  }

  /** Returns safe summaries for variables and modules in the attached runtime. */
  inspect(): Promise<BackendRuntimeInspection> {
    if (this.reconstructsRuntimeInspectionViaOrmCell) { return this.ormCell(buildInspectOrm(), parseOrmInspectResponse); }
    return this.request({ kind: "inspect" }, parseInspectionResponse);
  }

  /** Returns namespace summaries intended only for hidden editor preludes. */
  prelude(): Promise<BackendRuntimeInspection> {
    return this.request({ kind: "prelude" }, parseInspectionResponse);
  }

  /** Returns lightweight Python and Django environment details from the runtime. */
  environment(): Promise<BackendRuntimeEnvironment> {
    return this.request({ kind: "environment" }, parseEnvironmentResponse);
  }

  /** Returns safe child summaries for one inspected runtime value path using pure Python probe cells in ORM/terminal mode. */
  children(path: BackendRuntimePathSegment[], kind?: string): Promise<BackendRuntimeChildren> {
    if (this.reconstructsRuntimeInspectionViaOrmCell) {
      const expression = buildInspectChildrenOrm(path, kind);
      if (expression) { return this.ormCell(expression, (buffer) => parseOrmInspectChildren(buffer, path)); }
    }
    return this.request({ kind: "children", path }, parseChildrenResponse);
  }

  /** Returns the catalog once per attached backend, coalescing concurrent loads; an explicit refresh bypasses a completed cache. */
  async models(refresh = false): Promise<BackendModelList> {
    await this.ensureModelBrowserFeature();
    if (this.modelListInFlight) {
      if (!refresh || this.modelListInFlightRefresh) { return this.modelListInFlight; }
      if (!this.modelRefreshInFlight) { const active = this.modelListInFlight; const queued = active.catch(() => undefined).then(() => this.loadModels(true)).finally(() => { if (this.modelRefreshInFlight === queued) { this.modelRefreshInFlight = undefined; } }); this.modelRefreshInFlight = queued; }
      return this.modelRefreshInFlight;
    }
    if (!refresh && this.modelList) { return this.modelList; }
    return this.loadModels(refresh);
  }

  /** Starts one model enumeration and records whether it already satisfies a forced refresh. */
  private loadModels(refresh: boolean): Promise<BackendModelList> {
    const pending = this.reconstructsViaOrmCell ? this.ormCell(buildModelsOrm(), parseOrmModelsResponse) : this.request({ kind: "models" }, parseModelListResponse);
    this.modelListInFlightRefresh = refresh;
    const result = pending.then((list) => { if (list.ok) { this.modelList = list; } return list; }).finally(() => { if (this.modelListInFlight === result) { this.modelListInFlight = undefined; this.modelListInFlightRefresh = false; } }); this.modelListInFlight = result;
    return result;
  }

  /** Returns column and relation metadata for one model without querying rows. */
  async modelSchema(app: string, model: string): Promise<BackendModelSchema> {
    await this.ensureModelBrowserFeature();
    return this.request({ app, kind: "schema", model }, parseModelSchemaResponse);
  }

  /** Returns the filterable field/relation tree for one model so the filter UI can drill across relations (metadata RPC; suppressed in ORM/Terminal mode like schema). */
  async modelFilterFields(app: string, model: string): Promise<BackendFilterFieldTree> {
    await this.ensureModelBrowserFeature();
    return this.request({ app, kind: "filterfields", model }, parseFilterFieldsResponse);
  }

  /** Returns one bounded page of model rows with foreign keys kept as raw ids. */
  async modelRows(query: ModelRowsQuery): Promise<BackendModelRows> {
    await this.ensureModelBrowserFeature();
    if (this.reconstructsViaOrmCell) {
      const requested = typeof query.limit === "number" && query.limit > 0 ? query.limit : 50;
      const limit = Math.min(requested, ORM_PTY_ROW_CAP); // the PTY marker can't carry an unbounded "all" page
      const offset = typeof query.offset === "number" && query.offset > 0 ? query.offset : 0;
      if (query.recipe) {
        const keyset = !query.recipe.orderBy.length && !query.recipe.computed.some((item) => item.enabled);
        const compiled = buildRecipeRowsOrm(query.recipe, this.recipeOrmContext(query, limit, offset, query.cursor));
        if (!compiled.validation.ok || !compiled.cell) { return recipeRowsValidationFailure(query.recipe, compiled.validation); }
        return this.ormCell(compiled.cell, (buffer) => parseOrmGridResponse(buffer, limit, offset, keyset)).then((result) => withRecipeResult(result, query.recipe as ModelQueryRecipeV2, compiled.validation));
      }
      return this.ormCell(buildRowsOrm({ annotations: query.annotations, app: query.app, columns: query.columns, filters: query.filters, limit, model: query.model, offset, order: query.order, relations: query.relations }), (buffer) => parseOrmGridResponse(buffer, limit, offset));
    }
    const { recipeMetadata: _recipeMetadata, ...wireQuery } = query;
    return this.request({ ...wireQuery, kind: "rows" }, parseModelRowsResponse);
  }

  /** Runs a reconstructed ORM expression as the user's literal shell cell and parses the capture hook's marker. */
  private ormCell<T>(code: string, parse: (buffer: string) => T): Promise<T> {
    if (!this.fallback) { return Promise.resolve(parse(`${JSON.stringify({ ok: false, stderr: "ORM mode requires the interactive shell." })}\n`)); }
    return this.fallback({ code, kind: "ormcell" }).then((buffer) => { this.activeTransport = "pty"; const parsed = parse(buffer); if (parsed && typeof parsed === "object" && "orm" in parsed) { (parsed as Record<string, unknown>).orm = code; } return parsed; });
  }

  /** Returns related rows for one source row, fetched lazily on explicit expansion. */
  async modelRelated(query: ModelRelatedQuery): Promise<BackendModelRelatedRows> {
    await this.ensureModelBrowserFeature();
    if (this.reconstructsViaOrmCell) {
      const single = typeof query.single === "boolean" ? query.single : query.value !== undefined && query.value !== null;
      const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : 50;
      return this.ormCell(buildRelatedOrm(query.app, query.model, query.pk, query.relation, limit), (buffer) => parseOrmRelatedResponse(buffer, limit, single));
    }
    return this.request({ ...query, kind: "related" }, parseModelRelatedResponse);
  }

  /** Searches a target model for foreign-key picker candidates matching a query string. */
  async modelLookup(query: ModelLookupQuery): Promise<BackendModelLookup> {
    await this.ensureModelBrowserFeature();
    if (this.reconstructsViaOrmCell) {
      const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : 20;
      return this.ormCell(buildLookupOrm(query.app, query.model, query.q, query.exclude ?? [], limit), (buffer) => parseOrmLookupResponse(buffer, limit));
    }
    return this.request({ ...query, kind: "lookup" }, parseModelLookupResponse);
  }

  /** Lazily computes ONE @property over the current filter/order page (user-activated column), returning {pk: cell}. */
  async modelComputed(query: ModelComputedQuery): Promise<BackendModelComputed> {
    await this.ensureModelBrowserFeature();
    const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : 50;
    if (query.recipe) {
      // Phase 2 has rows/count/summary ORM facades; a property fetch needs the Recipe-aware Python implementation.
      // `request` uses the healthy socket in ORM mode and otherwise returns the normal bounded transport error, never a legacy broad query.
      const { recipeMetadata: _recipeMetadata, ...wireQuery } = query;
      return this.request({ ...wireQuery, kind: "computed", limit }, parseModelComputedResponse);
    }
    if (this.reconstructsViaOrmCell) {
      return this.ormCell(buildComputedOrm(query.app, query.model, query.field, query.filters, query.order, limit, query.columns, query.relations, query.annotations), parseOrmComputedResponse);
    }
    const { recipeMetadata: _recipeMetadata, ...wireQuery } = query;
    return this.request({ ...wireQuery, kind: "computed", limit }, parseModelComputedResponse);
  }

  /** Evaluates user-written ORM code and returns its tabulated result for the grid. */
  async modelQuery(query: ModelQueryRequest): Promise<BackendModelQuery> {
    await this.ensureModelBrowserFeature();
    // Unlike model reads, a user query must always use the backend request channel. A literal terminal cell depends on
    // an IPython post-execute marker and cannot be interrupted by the backend while that marker is missing; routing it
    // through `query` keeps Run/Interrupt/timeout lifecycle ownership in one observable execution thread.
    return this.request({ ...query, kind: "query" }, parseModelQueryResponse);
  }

  /** Returns the row count for the current filter set, computed on demand. */
  async modelCount(query: ModelCountQuery): Promise<BackendModelCount> {
    await this.ensureModelBrowserFeature();
    if (this.reconstructsViaOrmCell) {
      if (query.recipe) {
        const compiled = buildRecipeCountOrm(query.recipe, this.recipeOrmContext(query, 50));
        if (!compiled.validation.ok || !compiled.cell) { return Promise.resolve(recipeCountValidationFailure(query.recipe, compiled.validation)); }
        return this.ormCell(compiled.cell, parseOrmCountResponse).then((result) => withRecipeResult(result, query.recipe as ModelQueryRecipeV2, compiled.validation));
      }
      return this.ormCell(buildCountOrm(query.app, query.model, query.filters, query.columns, query.relations), parseOrmCountResponse);
    }
    const { recipeMetadata: _recipeMetadata, ...wireQuery } = query;
    return this.request({ ...wireQuery, kind: "count" }, parseModelCountResponse);
  }

  /** Computes grouped or global aggregates (Count/Sum/Avg/Min/Max/Exists) for the current filter set. */
  async modelAggregate(query: ModelAggregateQuery): Promise<BackendModelAggregate> {
    await this.ensureModelBrowserFeature();
    if (this.reconstructsViaOrmCell) {
      if (query.recipe) {
        const limit = ORM_PTY_ROW_CAP;
        const compiled = buildRecipeSummaryOrm(query.recipe, this.recipeOrmContext(query, limit));
        if (!compiled.validation.ok || !compiled.cell) { return Promise.resolve(recipeAggregateValidationFailure(query.recipe, compiled.validation)); }
        return this.ormCell(compiled.cell, (buffer) => parseOrmAggregateResponse(buffer, limit)).then((result) => withRecipeResult(result, query.recipe as ModelQueryRecipeV2, compiled.validation));
      }
      if (aggregatesNeedPython(query.aggregates, query.columns)) {
        // A computed @property aggregate needs a full Python scan, which can't be a clean ORM cell — direct to the socket.
        return Promise.resolve({ columns: [], error: "Computed-@property aggregates aren't available over the terminal — switch the Link selector to Socket or Auto.", groupBy: [], hasMore: false, ok: false, orm: "", rows: [], sql: [] });
      }
      const limit = ORM_PTY_ROW_CAP;
      return this.ormCell(buildAggregateOrm({ aggregates: query.aggregates, app: query.app, columns: query.columns, filters: query.filters, groupBy: query.groupBy, limit, model: query.model, relations: query.relations }), (buffer) => parseOrmAggregateResponse(buffer, limit));
    }
    const { recipeMetadata: _recipeMetadata, ...wireQuery } = query;
    return this.request({ ...wireQuery, kind: "aggregate" }, parseModelAggregateResponse);
  }

  /** Applies staged cell edits in one atomic transaction and returns per-row results. */
  async modelCommit(query: ModelCommitQuery): Promise<BackendCommitResult> {
    await this.ensureModelBrowserFeature();
    if (this.reconstructsViaOrmCell && Array.isArray(query.changes) && query.changes.length) { return this.ormCell(buildCommitOrm(query.app, query.model, query.changes, query.columns), (buffer) => parseOrmCommitResponse(buffer, query.changes.length)); }
    return this.request({ ...query, kind: "commit" }, parseModelCommitResponse);
  }

  /** Sends one JSON request to the backend and parses the single-line response. */
  private request<T>(
    payload: BackendRequestPayload,
    parse: (buffer: string) => T,
    log = true
  ): Promise<T> {
    const started = Date.now();
    // The extracted PTY payload helper preserves `hasDebugExecutionPayload(payload) ? payload` and
    // `payload.kind === "execute" && Array.isArray(payload.breakpointLines)` so breakpoint metadata stays intact.
    // Debug cell runs stay on the interactive main thread (stable pydevd thread id, traced since attach): route them
    // through the PTY even when the socket/tunnel is healthy — the socket keeps serving parallel reads beside them.
    if (this.fallback && hasDebugExecutionPayload(payload)) {
      return this.requestFallback(payload, parse, started, undefined, log, false);
    }
    // Skip the socket whenever it is known unreachable (remote shell, or a recent failure cooldown) and a terminal fallback exists — covers auto AND forced Socket, so a doomed loopback connect is never retried.
    if (this.mode === "pty" || (this.socketUnavailable && this.fallback)) {
      return this.requestFallback(payload, parse, started, undefined, log, false);
    }
    return this.socketRequest(payload, this.parallelReadResponseTimeout(payload)).then(
      (buffer) => {
        const parsed = parse(buffer);
        this.activeTransport = "tcp";
        this.tcpFailedAt = 0;
        if (log) { this.logRequest(payload.kind, started, parsed, buffer.length, undefined, "tcp"); }
        return parsed;
      },
      (error: unknown) => {
        if (this.mode === "tcp" && !this.fallback) {
          // Socket forced but unreachable and no terminal fallback exists: report the failure.
          this.activeTransport = "none";
          const message = error instanceof Error ? error.message : String(error);
          if (log) { this.logRequest(payload.kind, started, undefined, 0, message, "tcp"); }
          return parse(kindErrorResponse(payload.kind, `Socket transport failed: ${message}`));
        }
        // Socket unreachable (e.g. a remote shell whose 127.0.0.1 isn't ours): fall back to the terminal so the request still completes. requestFallback starts the retry cooldown.
        return this.requestFallback(payload, parse, started, error, log);
      }
    );
  }

  /** Returns a bounded response wait for busy-time parallel reads, so a paused/suspended backend rejects instead of hanging the read forever. */
  private parallelReadResponseTimeout(payload: BackendRequestPayload): number | undefined {
    return this.parallelModelReads && PARALLEL_MODEL_READ_KINDS.has(payload.kind) ? PARALLEL_READ_RESPONSE_TIMEOUT_MS : undefined;
  }

  /** Builds the strictly metadata-backed context required by Recipe v2 ORM reconstruction. */
  private recipeOrmContext(query: { app: string; columns?: BackendModelColumn[]; model: string; recipeMetadata?: import("./modelQueryRecipeMetadata").ModelQueryMetadataBundle; relations?: BackendModelRelation[] }, limit: number, offset?: number, cursor?: unknown): { columns: BackendModelColumn[]; cursor?: unknown; limit: number; metadata: ModelQueryMetadataIndex; offset?: number; relations: BackendModelRelation[]; source: { app: string; model: string }; transport: "orm" } {
    return { columns: query.columns ?? [], cursor, limit, metadata: query.recipeMetadata ? ModelQueryMetadataIndex.fromBundle(query.recipeMetadata) : new ModelQueryMetadataIndex(), offset, relations: query.relations ?? [], source: { app: query.app, model: query.model }, transport: "orm" };
  }

  /** Sends one request through the direct TCP socket transport. */
  private socketRequest(payload: BackendRequestPayload, responseTimeoutMs?: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const host = this.forwardedEndpoint?.host ?? connectHost(this.endpoint.host);
      const socket = net.createConnection({ host, port: this.forwardedEndpoint?.port ?? this.endpoint.port });
      let buffer = "";
      let settled = false;
      let responseTimer: ReturnType<typeof setTimeout> | undefined;
      const connectTimer = setTimeout(() => {
        fail(new Error(`Timed out connecting to Django shell backend after ${TCP_CONNECT_TIMEOUT_MS}ms.`));
      }, TCP_CONNECT_TIMEOUT_MS);

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        clearTimeout(connectTimer);
        if (responseTimeoutMs) {
          responseTimer = setTimeout(() => {
            fail(new Error(`Django shell backend did not answer within ${responseTimeoutMs}ms while handling ${payload.kind}.`));
          }, responseTimeoutMs);
        }
        socket.write(`${JSON.stringify({ ...payload, token: this.endpoint.token })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.includes("\n")) {
          succeed(buffer);
        }
      });
      socket.on("error", (error) => {
        fail(new Error(`${error.message}; host=${host}; endpointHost=${this.endpoint.host}`));
      });
      socket.on("close", () => {
        if (!settled) {
          fail(new Error("Django shell backend socket closed before a response was received."));
        }
      });

      /** Rejects the socket request once and closes the socket. */
      function fail(error: Error): void {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(responseTimer);
        socket.destroy();
        reject(error);
      }

      /** Resolves the socket request once and closes the socket. */
      function succeed(value: string): void {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(responseTimer);
        socket.end();
        resolve(value);
      }
    });
  }

  /** Falls back to PTY request transport when direct TCP is unreachable. */
  private async requestFallback<T>(
    payload: BackendRequestPayload,
    parse: (buffer: string) => T,
    started: number,
    error: unknown,
    log: boolean,
    logTcpFailure = true
  ): Promise<T> {
    if (log && logTcpFailure) {
      this.logRequest(payload.kind, started, undefined, 0, error instanceof Error ? error.message : String(error), "tcp");
    }
    if (!this.fallback) {
      return parse(kindErrorResponse(payload.kind, error instanceof Error ? error.message : "Terminal transport is unavailable."));
    }
    if (error !== undefined) {
      // Start the retry cooldown only for real socket failures; deliberate fallbacks (forced PTY, cooldown skips,
      // debug runs pinned to the main thread) must not keep pushing the next socket probe further out.
      this.tcpFailedAt = Date.now();
    }
    if (this.parallelModelReads && PARALLEL_MODEL_READ_KINDS.has(payload.kind)) {
      const buffer = kindErrorResponse(payload.kind, PARALLEL_MODEL_READ_UNAVAILABLE);
      const parsed = parse(buffer);
      if (log) { this.logRequest(payload.kind, Date.now(), parsed, buffer.length, "parallel socket unavailable; not queued behind active cell", "none"); }
      return parsed;
    }
    // ORM/Terminal modes never type metadata plumbing into the shell (no command equivalent): suppress, don't emit `_djs_rpc`.
    const metadataSuppressed = this.reconstructsViaOrmCell && ORM_NO_PTY.has(payload.kind);
    if (metadataSuppressed || !isPtyFallbackKind(payload.kind)) {
      const buffer = metadataSuppressed ? kindErrorResponse(payload.kind, ORM_PTY_SUPPRESSED) : unsupportedPtyFallbackResponse(payload.kind);
      const parsed = parse(buffer);
      if (log) { this.logRequest(payload.kind, Date.now(), parsed, buffer.length, metadataSuppressed ? "suppressed (not typed into terminal)" : "unsupported over PTY fallback", "pty"); }
      return parsed;
    }
    const fallbackStarted = Date.now();
    const buffer = await this.fallback(ptyFallbackPayload(payload));
    const parsed = parse(buffer);
    this.activeTransport = "pty";
    if (log) {
      this.logRequest(payload.kind, fallbackStarted, parsed, buffer.length, undefined, "pty");
    }
    return parsed;
  }

  /** Writes one backend request timing diagnostic. */
  private logRequest(kind: string, started: number, parsed: unknown, bytes: number, error?: string, transport?: string): void {
    const ok = typeof parsed === "object" && parsed !== null && "ok" in parsed ? Boolean(parsed.ok) : undefined;
    this.logger?.log("backend.request", {
      bytes,
      error,
      kind,
      ms: Date.now() - started,
      ok,
      port: this.endpoint.port,
      transport
    });
  }
}

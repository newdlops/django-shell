// Socket client for executing Python code through the in-process Django shell backend.

import * as net from "net";
import { BackendEndpoint } from "./backendBootstrap";
import { DiagnosticLogger } from "./diagnostics";
import {
  BackendCommitResult, BackendFilterFieldTree, BackendModelAggregate, BackendModelComputed, BackendModelCount, BackendModelFilter, BackendModelList, BackendModelLookup, BackendModelOrder,
  BackendModelQuery, BackendModelRelatedRows, BackendModelRows, BackendModelSchema, ModelAggregateQuery, ModelAggregateTerm, ModelAnnotationSpec, ModelCommitChange, ModelCommitQuery,
  ModelComputedQuery, ModelCountQuery, ModelLookupQuery, ModelQueryRequest, ModelRelatedQuery, ModelRowsQuery, modelUnsupportedFallback,
  parseFilterFieldsResponse, parseModelAggregateResponse, parseModelCommitResponse, parseModelComputedResponse, parseModelCountResponse, parseModelListResponse, parseModelLookupResponse, parseModelQueryResponse,
  parseModelRelatedResponse, parseModelRowsResponse, parseModelSchemaResponse, parseOrmAggregateResponse, parseOrmCommitResponse, parseOrmComputedResponse, parseOrmCountResponse,
  parseOrmGridResponse, parseOrmLookupResponse, parseOrmModelsResponse, parseOrmQueryResponse, parseOrmRelatedResponse
} from "./modelBackend";
import { aggregatesNeedPython, buildAggregateOrm, buildCommitOrm, buildComputedOrm, buildCountOrm, buildInspectOrm, buildLookupOrm, buildModelsOrm, buildRelatedOrm, buildRowsOrm } from "./modelOrm";

const TCP_CONNECT_TIMEOUT_MS = 1500;
// Max length of a reconstructed ORM cell we'll TYPE into the shell. A literal cell is written as one line, and a tty
// input queue (MAX_INPUT, ~1KB on macOS) silently drops bytes past it → the cell arrives truncated, IPython sits at a
// continuation prompt, and the serialized PTY queue hangs. Reads whose cell exceeds this fall back to the socket/`_djs_rpc`
// request path (bounded, id-matched) instead. The introspection cells (inspect/children) are the long ones.
const PTY_CELL_LIMIT = 900;
// Max rows one ORM read cell returns over the PTY: the result grid rides the PTY marker (~1 MB), so an unbounded page
// ("all" = 1e9) overruns it and the table can't tabulate. "all" therefore loads this many at a time (+ Load more); the
// socket transport (Auto/Socket) has no marker limit and can fetch more at once.
const ORM_PTY_ROW_CAP = 2000;
const INSPECT_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface BackendExecutionResult {
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
  label?: string;
  line?: number;
  ok?: boolean;
  percent?: number;
  rate?: number;
  total?: number | null;
}

export interface BackendCompletenessResult {
  complete: boolean;
  ok: boolean;
  stderr: string;
  traceback?: string;
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
  exclude?: string[];
  filename?: string;
  filters?: BackendModelFilter[];
  groupBy?: string[];
  kind: string;
  lineOffset?: number;
  lightweight?: boolean;
  limit?: number;
  model?: string;
  offset?: number;
  order?: BackendModelOrder[];
  path?: BackendRuntimePathSegment[];
  pk?: unknown;
  q?: string;
  relation?: string;
  sourceText?: string;
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
  private tcpUnavailable = false;
  private mode: BackendTransportMode = "orm";

  /** Stores the socket endpoint and shared authentication token. */
  constructor(
    private readonly endpoint: BackendEndpoint,
    private readonly logger?: DiagnosticLogger,
    private readonly fallback?: BackendFallbackTransport
  ) {}

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
    this.tcpUnavailable = this.mode === "pty" && this.tcpUnavailable;
  }

  /** Marks the loopback socket unreachable so requests skip it and use the PTY — e.g. a remote SSH/kubectl shell whose 127.0.0.1 is the pod's, not ours. */
  markSocketUnavailable(): void {
    this.tcpUnavailable = true;
  }

  /** Returns whether reads reconstruct as readable ORM cells (ORM + Terminal modes) instead of `_djs_rpc` plumbing. */
  private get reconstructsViaOrmCell(): boolean { return this.mode === "orm" || this.mode === "pty"; }

  /** Returns whether expensive runtime tree requests are safe for the active transport. */
  supportsRuntimeInspection(): boolean {
    // Runtime inspection uses pure Python probe cells; the capture hook attaches metadata without logging helper calls.
    if (this.reconstructsViaOrmCell) { return Boolean(this.fallback); }
    return !this.tcpUnavailable || Boolean(this.fallback);
  }

  /** Executes Python code in the backend namespace and returns captured output. */
  execute(code: string, filename?: string, lineOffset?: number, sourceText?: string, breakpointLines?: number[]): Promise<BackendExecutionResult> {
    return this.request({ breakpointLines, code, filename, kind: "execute", lineOffset, sourceText }, parseBackendResponse);
  }

  /** Returns the latest running Python progress snapshot when the socket can be polled. */
  progress(): Promise<BackendProgressSnapshot> {
    return this.request({ kind: "progress" }, parseProgressResponse, false);
  }

  /** Returns whether progress polling can run without queuing behind the interactive PTY cell. */
  canPollProgress(): boolean {
    return this.mode !== "pty" && !this.tcpUnavailable;
  }

  /** Checks whether Python source is complete without executing it. */
  isComplete(code: string): Promise<BackendCompletenessResult> {
    return this.request({ code, kind: "complete" }, parseCompletenessResponse);
  }

  /** Returns safe summaries for variables and modules in the attached runtime. */
  inspect(): Promise<BackendRuntimeInspection> {
    if (this.reconstructsViaOrmCell) { return this.ormCell(buildInspectOrm(), parseOrmInspectResponse); }
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
    if (this.reconstructsViaOrmCell) {
      const expression = buildInspectChildrenOrm(path, kind);
      if (expression) { return this.ormCell(expression, (buffer) => parseOrmInspectChildren(buffer, path)); }
    }
    return this.request({ kind: "children", path }, parseChildrenResponse);
  }

  /** Returns the catalog of browsable Django models from the attached runtime. */
  models(): Promise<BackendModelList> {
    if (this.reconstructsViaOrmCell) { return this.ormCell(buildModelsOrm(), parseOrmModelsResponse); }
    return this.request({ kind: "models" }, parseModelListResponse);
  }

  /** Returns column and relation metadata for one model without querying rows. */
  modelSchema(app: string, model: string): Promise<BackendModelSchema> {
    return this.request({ app, kind: "schema", model }, parseModelSchemaResponse);
  }

  /** Returns the filterable field/relation tree for one model so the filter UI can drill across relations (metadata RPC; suppressed in ORM/Terminal mode like schema). */
  modelFilterFields(app: string, model: string): Promise<BackendFilterFieldTree> {
    return this.request({ app, kind: "filterfields", model }, parseFilterFieldsResponse);
  }

  /** Returns one bounded page of model rows with foreign keys kept as raw ids. */
  modelRows(query: ModelRowsQuery): Promise<BackendModelRows> {
    if (this.reconstructsViaOrmCell) {
      const requested = typeof query.limit === "number" && query.limit > 0 ? query.limit : 50;
      const limit = Math.min(requested, ORM_PTY_ROW_CAP); // the PTY marker can't carry an unbounded "all" page
      const offset = typeof query.offset === "number" && query.offset > 0 ? query.offset : 0;
      return this.ormCell(buildRowsOrm({ annotations: query.annotations, app: query.app, columns: query.columns, filters: query.filters, limit, model: query.model, offset, order: query.order, relations: query.relations }), (buffer) => parseOrmGridResponse(buffer, limit, offset));
    }
    return this.request({ ...query, kind: "rows" }, parseModelRowsResponse);
  }

  /** Runs a reconstructed ORM expression as the user's literal shell cell and parses the capture hook's marker. */
  private ormCell<T>(code: string, parse: (buffer: string) => T): Promise<T> {
    if (!this.fallback) { return Promise.resolve(parse(`${JSON.stringify({ ok: false, stderr: "ORM mode requires the interactive shell." })}\n`)); }
    return this.fallback({ code, kind: "ormcell" }).then((buffer) => { this.activeTransport = "pty"; const parsed = parse(buffer); if (parsed && typeof parsed === "object" && "orm" in parsed) { (parsed as Record<string, unknown>).orm = code; } return parsed; });
  }

  /** Returns related rows for one source row, fetched lazily on explicit expansion. */
  modelRelated(query: ModelRelatedQuery): Promise<BackendModelRelatedRows> {
    if (this.reconstructsViaOrmCell) {
      const single = typeof query.single === "boolean" ? query.single : query.value !== undefined && query.value !== null;
      const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : 50;
      return this.ormCell(buildRelatedOrm(query.app, query.model, query.pk, query.relation, limit), (buffer) => parseOrmRelatedResponse(buffer, limit, single));
    }
    return this.request({ ...query, kind: "related" }, parseModelRelatedResponse);
  }

  /** Searches a target model for foreign-key picker candidates matching a query string. */
  modelLookup(query: ModelLookupQuery): Promise<BackendModelLookup> {
    if (this.reconstructsViaOrmCell) {
      const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : 20;
      return this.ormCell(buildLookupOrm(query.app, query.model, query.q, query.exclude ?? [], limit), (buffer) => parseOrmLookupResponse(buffer, limit));
    }
    return this.request({ ...query, kind: "lookup" }, parseModelLookupResponse);
  }

  /** Lazily computes ONE @property over the current filter/order page (user-activated column), returning {pk: cell}. */
  modelComputed(query: ModelComputedQuery): Promise<BackendModelComputed> {
    const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : 50;
    if (this.reconstructsViaOrmCell) {
      return this.ormCell(buildComputedOrm(query.app, query.model, query.field, query.filters, query.order, limit, query.columns, query.relations, query.annotations), parseOrmComputedResponse);
    }
    return this.request({ ...query, kind: "computed", limit }, parseModelComputedResponse);
  }

  /** Evaluates user-written ORM code and returns its tabulated result for the grid. */
  modelQuery(query: ModelQueryRequest): Promise<BackendModelQuery> {
    if (this.reconstructsViaOrmCell) {
      // Terminal/ORM mode types the user's ORM as a literal cell (no `_djs_rpc`); the capture hook tabulates it and we window the grid client-side to the requested page.
      const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : 50;
      const offset = typeof query.offset === "number" && query.offset > 0 ? query.offset : 0;
      return this.ormCell(query.code, (buffer) => parseOrmQueryResponse(buffer, limit, offset));
    }
    return this.request({ ...query, kind: "query" }, parseModelQueryResponse);
  }

  /** Returns the row count for the current filter set, computed on demand. */
  modelCount(query: ModelCountQuery): Promise<BackendModelCount> {
    if (this.reconstructsViaOrmCell) { return this.ormCell(buildCountOrm(query.app, query.model, query.filters, query.columns, query.relations), parseOrmCountResponse); }
    return this.request({ ...query, kind: "count" }, parseModelCountResponse);
  }

  /** Computes grouped or global aggregates (Count/Sum/Avg/Min/Max/Exists) for the current filter set. */
  modelAggregate(query: ModelAggregateQuery): Promise<BackendModelAggregate> {
    if (this.reconstructsViaOrmCell) {
      if (aggregatesNeedPython(query.aggregates, query.columns)) {
        // A computed @property aggregate needs a full Python scan, which can't be a clean ORM cell — direct to the socket.
        return Promise.resolve({ columns: [], error: "Computed-@property aggregates aren't available over the terminal — switch the Link selector to Socket or Auto.", groupBy: [], hasMore: false, ok: false, orm: "", rows: [], sql: [] });
      }
      const limit = ORM_PTY_ROW_CAP;
      return this.ormCell(buildAggregateOrm({ aggregates: query.aggregates, app: query.app, columns: query.columns, filters: query.filters, groupBy: query.groupBy, limit, model: query.model, relations: query.relations }), (buffer) => parseOrmAggregateResponse(buffer, limit));
    }
    return this.request({ ...query, kind: "aggregate" }, parseModelAggregateResponse);
  }

  /** Applies staged cell edits in one atomic transaction and returns per-row results. */
  modelCommit(query: ModelCommitQuery): Promise<BackendCommitResult> {
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
    // Skip the socket whenever it is known unreachable (remote shell, or a prior failure) and a terminal fallback exists — covers auto AND forced Socket, so a doomed loopback connect is never retried.
    if (this.mode === "pty" || (this.tcpUnavailable && this.fallback)) {
      return this.requestFallback(payload, parse, started, undefined, log, false);
    }
    return this.socketRequest(payload).then(
      (buffer) => {
        const parsed = parse(buffer);
        this.activeTransport = "tcp";
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
        // Socket unreachable (e.g. a remote shell whose 127.0.0.1 isn't ours): fall back to the terminal so the request still completes. requestFallback sets tcpUnavailable so we stop retrying.
        return this.requestFallback(payload, parse, started, error, log);
      }
    );
  }

  /** Sends one request through the direct TCP socket transport. */
  private socketRequest(payload: BackendRequestPayload): Promise<string> {
    return new Promise((resolve, reject) => {
      const host = connectHost(this.endpoint.host);
      const socket = net.createConnection({ host, port: this.endpoint.port });
      let buffer = "";
      let settled = false;
      const connectTimer = setTimeout(() => {
        fail(new Error(`Timed out connecting to Django shell backend after ${TCP_CONNECT_TIMEOUT_MS}ms.`));
      }, TCP_CONNECT_TIMEOUT_MS);

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        clearTimeout(connectTimer);
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
    this.tcpUnavailable = true;
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

/** Returns a connectable loopback host for wildcard backend bind addresses. */
function connectHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

const PTY_FALLBACK_KINDS = new Set(["children", "complete", "environment", "execute", "inspect", "prelude", "models", "schema", "filterfields", "rows", "related", "count", "aggregate", "commit", "lookup", "query"]); // helpers: scrubbed _djs_rpc; execute: literal cell.
// Kinds ORM/Terminal modes never type over the terminal; schema is synthesized from the first row page, and the filter tree falls back to flat fields (see modelBrowser).
const ORM_NO_PTY = new Set(["children", "environment", "inspect", "models", "prelude", "schema", "filterfields"]);
const ORM_PTY_SUPPRESSED = "Kept out of the shell: this metadata is not typed into the terminal — switch the Link selector to Socket/Auto to fetch it.";
const PTY_PAGE_LIMIT = 25;

/** Returns whether one request kind can be serviced over the interactive PTY fallback. */
function isPtyFallbackKind(kind: string): boolean {
  return PTY_FALLBACK_KINDS.has(kind);
}

/** Returns a smaller payload variant for the slower terminal fallback transport. */
function ptyFallbackPayload(payload: BackendRequestPayload): BackendRequestPayload {
  const next = payload.sourceText === undefined && payload.breakpointLines === undefined ? payload : { ...payload, breakpointLines: undefined, sourceText: undefined };
  if ((payload.kind === "rows" || payload.kind === "related" || payload.kind === "query") && (payload.limit === undefined || payload.limit > PTY_PAGE_LIMIT)) {
    return { ...next, limit: PTY_PAGE_LIMIT };
  }
  return next;
}

/** Returns a safe error response when a request cannot cross the active transport. */
function unsupportedPtyFallbackResponse(kind: string): string {
  return kindErrorResponse(kind, "Remote runtime inspection is disabled because the backend is only reachable through the interactive terminal.");
}

/** Returns a kind-shaped error response carrying one message. */
function kindErrorResponse(kind: string, error: string): string {
  const model = modelUnsupportedFallback(kind, error);
  if (model) {
    return model;
  }
  if (kind === "children") {
    return `${JSON.stringify({ children: [], error, ok: false })}\n`;
  }
  if (kind === "inspect") {
    return `${JSON.stringify({ error, loadedModuleCount: 0, modules: [], ok: false, variables: [] })}\n`;
  }
  return `${JSON.stringify({ error, ok: false })}\n`;
}

/** Parses the single-line JSON response returned by the Python backend. */
function parseBackendResponse(buffer: string): BackendExecutionResult {
  const line = buffer.split(/\r?\n/, 1)[0] ?? "";
  const parsed = JSON.parse(line) as Partial<BackendExecutionResult>;
  return { ok: Boolean(parsed.ok), result: parsed.result, stderr: parsed.stderr ?? "", stdout: parsed.stdout ?? "", traceback: parsed.traceback };
}

/** Parses the latest backend execution progress snapshot. */
function parseProgressResponse(buffer: string): BackendProgressSnapshot {
  const parsed = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "{}") as Partial<BackendProgressSnapshot>;
  return {
    active: Boolean(parsed.active),
    current: typeof parsed.current === "number" ? parsed.current : undefined,
    detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
    done: Boolean(parsed.done),
    elapsed: typeof parsed.elapsed === "number" ? parsed.elapsed : undefined,
    label: typeof parsed.label === "string" ? parsed.label : undefined,
    line: typeof parsed.line === "number" ? parsed.line : undefined,
    ok: typeof parsed.ok === "boolean" ? parsed.ok : undefined,
    percent: typeof parsed.percent === "number" ? parsed.percent : undefined,
    rate: typeof parsed.rate === "number" ? parsed.rate : undefined,
    total: typeof parsed.total === "number" || parsed.total === null ? parsed.total : undefined
  };
}

/** Parses a backend completeness check response. */
function parseCompletenessResponse(buffer: string): BackendCompletenessResult {
  const line = buffer.split(/\r?\n/, 1)[0] ?? "";
  const parsed = JSON.parse(line) as Partial<BackendCompletenessResult>;
  return { complete: Boolean(parsed.complete), ok: Boolean(parsed.ok), stderr: parsed.stderr ?? "", traceback: parsed.traceback };
}

/** Parses a backend runtime inspection response. */
function parseInspectionResponse(buffer: string): BackendRuntimeInspection {
  const parsed = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "") as Partial<BackendRuntimeInspection>;
  return { error: parsed.error, loadedModuleCount: parsed.loadedModuleCount, modules: Array.isArray(parsed.modules) ? parsed.modules : [], ok: Boolean(parsed.ok), variables: Array.isArray(parsed.variables) ? parsed.variables : [] };
}

/** Parses a pure `len(globals())` probe marker into runtime inspection data attached by the capture hook. */
function parseOrmInspectResponse(buffer: string): BackendRuntimeInspection {
  const marker = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "{}") as { ok?: boolean; runtime?: Partial<BackendRuntimeInspection>; stderr?: string; traceback?: string };
  const runtime = marker.runtime;
  if (marker.ok === false || !runtime || !Array.isArray(runtime.variables)) {
    const error = (marker.traceback || marker.stderr || "Runtime inspection failed in ORM mode.").trim().split(/\r?\n/).filter(Boolean).pop();
    return { error, loadedModuleCount: 0, modules: [], ok: false, variables: [] };
  }
  return { loadedModuleCount: runtime.loadedModuleCount ?? 0, modules: [], ok: true, variables: runtime.variables };
}

/** Builds a pure Python inspection probe for one safe runtime path. */
function buildInspectChildrenOrm(path: BackendRuntimePathSegment[], kind?: string): string | null {
  const expression = reconstructInspectExpression(path);
  if (!expression) { return null; }
  return kind === "collection" ? `len(${expression})` : `dir(${expression})`;
}

/** Reconstructs a pure Python expression for an inspector path (`a.b`, `list(a)[0]`, `list(a.all())[0]`, `list(d.items())[0][1]`) without helper calls. */
function reconstructInspectExpression(path: BackendRuntimePathSegment[]): string | null {
  const root = path[0];
  if (!root || root.op !== "name" || !INSPECT_IDENTIFIER.test(root.name ?? "")) { return null; }
  let expression = root.name as string;
  for (let i = 1; i < path.length; i += 1) {
    const segment = path[i];
    if (segment.op === "attr" && INSPECT_IDENTIFIER.test(segment.name ?? "")) {
      expression += `.${segment.name}`;
    } else if (segment.op === "index" && Number.isInteger(segment.index) && (segment.index as number) >= 0) {
      expression = `list((${expression}))[${segment.index}]`;
    } else if (segment.op === "all_index" && Number.isInteger(segment.index) && (segment.index as number) >= 0) {
      expression = `list((${expression}).all())[${segment.index}]`;
    } else if (segment.op === "dict" && Number.isInteger(segment.index) && (segment.index as number) >= 0) {
      expression = `list((${expression}).items())[${segment.index}][1]`;
    } else {
      return null;
    }
  }
  return expression;
}

/** Parses an inspection drill-down marker with paths RELATIVE to the result object, so the requested path is prepended to make them absolute. */
function parseOrmInspectChildren(buffer: string, path: BackendRuntimePathSegment[]): BackendRuntimeChildren {
  const marker = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "{}") as { inspect?: { children?: BackendRuntimeVariable[]; error?: string }; ok?: boolean; stderr?: string; traceback?: string };
  if (marker.ok === false || marker.inspect?.error || !marker.inspect || !Array.isArray(marker.inspect.children)) {
    const error = (marker.inspect?.error || marker.traceback || marker.stderr || "").trim().split(/\r?\n/).filter(Boolean).pop();
    return { children: [], error: error || "Children unavailable in ORM mode.", ok: false };
  }
  const children = marker.inspect.children.map((child) => ({ ...child, path: [...path, ...(Array.isArray(child.path) ? child.path : [])] }));
  return { children, ok: true };
}

/** Parses a backend runtime environment response. */
function parseEnvironmentResponse(buffer: string): BackendRuntimeEnvironment {
  const parsed = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "") as Partial<BackendRuntimeEnvironment>;
  return { basePrefix: parsed.basePrefix, cwd: parsed.cwd, django: parseDjangoRuntime(parsed.django), error: parsed.error, executable: parsed.executable, ok: Boolean(parsed.ok), path: Array.isArray(parsed.path) ? parsed.path : [], prefix: parsed.prefix, settingsModule: parsed.settingsModule, version: parsed.version, virtualEnv: parsed.virtualEnv };
}

/** Parses nested Django runtime metadata from an environment response. */
function parseDjangoRuntime(value: BackendRuntimeEnvironment["django"]): BackendDjangoRuntime | undefined {
  if (!value) { return undefined; }
  return { appsReady: Boolean(value.appsReady), available: Boolean(value.available), configured: Boolean(value.configured), error: value.error, installedApps: Array.isArray(value.installedApps) ? value.installedApps : [], settingsModule: value.settingsModule, version: value.version };
}

/** Parses a backend runtime child inspection response. */
function parseChildrenResponse(buffer: string): BackendRuntimeChildren {
  const parsed = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "") as Partial<BackendRuntimeChildren>;
  return { children: Array.isArray(parsed.children) ? parsed.children : [], error: parsed.error, ok: Boolean(parsed.ok) };
}

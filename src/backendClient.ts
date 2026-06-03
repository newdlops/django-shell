// Socket client for executing Python code through the in-process Django shell backend.

import * as net from "net";
import { BackendEndpoint } from "./backendBootstrap";
import { DiagnosticLogger } from "./diagnostics";
import {
  BackendCommitResult,
  BackendModelCount,
  BackendModelFilter,
  BackendModelList,
  BackendModelOrder,
  BackendModelRelatedRows,
  BackendModelRows,
  BackendModelSchema,
  ModelCommitChange,
  ModelCommitQuery,
  ModelCountQuery,
  ModelRelatedQuery,
  ModelRowsQuery,
  modelUnsupportedFallback,
  parseModelCommitResponse,
  parseModelCountResponse,
  parseModelListResponse,
  parseModelRelatedResponse,
  parseModelRowsResponse,
  parseModelSchemaResponse
} from "./modelBackend";

const TCP_CONNECT_TIMEOUT_MS = 1500;
const TCP_RESPONSE_TIMEOUT_MS = 30000;

export interface BackendExecutionResult {
  ok: boolean;
  result?: string;
  stderr: string;
  stdout: string;
  traceback?: string;
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
  hasChildren?: boolean;
  importLine?: string;
  kind?: string;
  name: string;
  origin?: string;
  path?: BackendRuntimePathSegment[];
  preview: string;
  type: string;
  typeImportLine?: string;
}

export interface BackendRuntimePathSegment {
  index?: number;
  name?: string;
  op: string;
}

export interface BackendRequestPayload {
  app?: string;
  changes?: ModelCommitChange[];
  code?: string;
  cursor?: unknown;
  filters?: BackendModelFilter[];
  kind: string;
  lightweight?: boolean;
  limit?: number;
  model?: string;
  offset?: number;
  order?: BackendModelOrder[];
  path?: BackendRuntimePathSegment[];
  pk?: unknown;
  relation?: string;
  value?: unknown;
}

export type BackendFallbackTransport = (payload: BackendRequestPayload) => Promise<string>;
export type BackendTransport = "none" | "pty" | "tcp";
export type BackendTransportMode = "auto" | "pty" | "tcp";

/** Sends execution requests to the backend running inside the Django shell process. */
export class BackendClient {
  private activeTransport: BackendTransport = "none";
  private tcpUnavailable = false;
  private mode: BackendTransportMode = "auto";

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
    this.tcpUnavailable = mode === "pty" && this.tcpUnavailable;
  }

  /** Returns whether expensive runtime tree requests are safe for the active transport. */
  supportsRuntimeInspection(): boolean {
    return !this.tcpUnavailable || Boolean(this.fallback);
  }

  /** Executes Python code in the backend namespace and returns captured output. */
  execute(code: string): Promise<BackendExecutionResult> {
    return this.request({ code, kind: "execute" }, parseBackendResponse);
  }

  /** Checks whether Python source is complete without executing it. */
  isComplete(code: string): Promise<BackendCompletenessResult> {
    return this.request({ code, kind: "complete" }, parseCompletenessResponse);
  }

  /** Returns safe summaries for variables and modules in the attached runtime. */
  inspect(): Promise<BackendRuntimeInspection> {
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

  /** Returns safe child summaries for one inspected runtime value path. */
  children(path: BackendRuntimePathSegment[]): Promise<BackendRuntimeChildren> {
    return this.request({ kind: "children", path }, parseChildrenResponse);
  }

  /** Returns the catalog of browsable Django models from the attached runtime. */
  models(): Promise<BackendModelList> {
    return this.request({ kind: "models" }, parseModelListResponse);
  }

  /** Returns column and relation metadata for one model without querying rows. */
  modelSchema(app: string, model: string): Promise<BackendModelSchema> {
    return this.request({ app, kind: "schema", model }, parseModelSchemaResponse);
  }

  /** Returns one bounded page of model rows with foreign keys kept as raw ids. */
  modelRows(query: ModelRowsQuery): Promise<BackendModelRows> {
    return this.request({ ...query, kind: "rows" }, parseModelRowsResponse);
  }

  /** Returns related rows for one source row, fetched lazily on explicit expansion. */
  modelRelated(query: ModelRelatedQuery): Promise<BackendModelRelatedRows> {
    return this.request({ ...query, kind: "related" }, parseModelRelatedResponse);
  }

  /** Returns the row count for the current filter set, computed on demand. */
  modelCount(query: ModelCountQuery): Promise<BackendModelCount> {
    return this.request({ ...query, kind: "count" }, parseModelCountResponse);
  }

  /** Applies staged cell edits in one atomic transaction and returns per-row results. */
  modelCommit(query: ModelCommitQuery): Promise<BackendCommitResult> {
    return this.request({ ...query, kind: "commit" }, parseModelCommitResponse);
  }

  /** Sends one JSON request to the backend and parses the single-line response. */
  private request<T>(
    payload: BackendRequestPayload,
    parse: (buffer: string) => T,
    log = true
  ): Promise<T> {
    const started = Date.now();
    if (this.mode === "pty" || (this.mode === "auto" && this.tcpUnavailable && this.fallback)) {
      return this.requestFallback(payload, parse, started, undefined, log, false);
    }
    return this.socketRequest(payload).then(
      (buffer) => {
        const parsed = parse(buffer);
        this.activeTransport = "tcp";
        if (log) {
          this.logRequest(payload.kind, started, parsed, buffer.length, undefined, "tcp");
        }
        return parsed;
      },
      (error: unknown) => {
        if (this.mode === "tcp") {
          this.activeTransport = "none";
          const message = error instanceof Error ? error.message : String(error);
          if (log) {
            this.logRequest(payload.kind, started, undefined, 0, message, "tcp");
          }
          return parse(kindErrorResponse(payload.kind, `Socket transport failed: ${message}`));
        }
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
      let responseTimer: NodeJS.Timeout | undefined;
      let settled = false;
      const connectTimer = setTimeout(() => {
        fail(new Error(`Timed out connecting to Django shell backend after ${TCP_CONNECT_TIMEOUT_MS}ms.`));
      }, TCP_CONNECT_TIMEOUT_MS);

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        clearTimeout(connectTimer);
        responseTimer = setTimeout(() => {
          fail(new Error(`Timed out waiting for Django shell backend response after ${TCP_RESPONSE_TIMEOUT_MS}ms.`));
        }, TCP_RESPONSE_TIMEOUT_MS);
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
        if (responseTimer) {
          clearTimeout(responseTimer);
        }
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
        if (responseTimer) {
          clearTimeout(responseTimer);
        }
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
    if (!isPtyFallbackKind(payload.kind)) {
      const buffer = unsupportedPtyFallbackResponse(payload.kind);
      const parsed = parse(buffer);
      if (log) {
        this.logRequest(payload.kind, Date.now(), parsed, buffer.length, "unsupported over PTY fallback", "pty");
      }
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

const PTY_FALLBACK_KINDS = new Set(["children", "complete", "environment", "execute", "inspect", "prelude", "models", "schema", "rows", "related", "count", "commit"]);
const PTY_PAGE_LIMIT = 25;

/** Returns whether one request kind can be serviced over the interactive PTY fallback. */
function isPtyFallbackKind(kind: string): boolean {
  return PTY_FALLBACK_KINDS.has(kind);
}

/** Returns a smaller payload variant for the slower terminal fallback transport. */
function ptyFallbackPayload(payload: BackendRequestPayload): BackendRequestPayload {
  if (payload.kind === "inspect") {
    return { ...payload, lightweight: true };
  }
  if ((payload.kind === "rows" || payload.kind === "related") && (payload.limit === undefined || payload.limit > PTY_PAGE_LIMIT)) {
    return { ...payload, limit: PTY_PAGE_LIMIT };
  }
  return payload;
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
  return {
    ok: Boolean(parsed.ok),
    result: parsed.result,
    stderr: parsed.stderr ?? "",
    stdout: parsed.stdout ?? "",
    traceback: parsed.traceback
  };
}

/** Parses a backend completeness check response. */
function parseCompletenessResponse(buffer: string): BackendCompletenessResult {
  const line = buffer.split(/\r?\n/, 1)[0] ?? "";
  const parsed = JSON.parse(line) as Partial<BackendCompletenessResult>;
  return {
    complete: Boolean(parsed.complete),
    ok: Boolean(parsed.ok),
    stderr: parsed.stderr ?? "",
    traceback: parsed.traceback
  };
}

/** Parses a backend runtime inspection response. */
function parseInspectionResponse(buffer: string): BackendRuntimeInspection {
  const line = buffer.split(/\r?\n/, 1)[0] ?? "";
  const parsed = JSON.parse(line) as Partial<BackendRuntimeInspection>;
  return {
    error: parsed.error,
    loadedModuleCount: parsed.loadedModuleCount,
    modules: Array.isArray(parsed.modules) ? parsed.modules : [],
    ok: Boolean(parsed.ok),
    variables: Array.isArray(parsed.variables) ? parsed.variables : []
  };
}

/** Parses a backend runtime environment response. */
function parseEnvironmentResponse(buffer: string): BackendRuntimeEnvironment {
  const line = buffer.split(/\r?\n/, 1)[0] ?? "";
  const parsed = JSON.parse(line) as Partial<BackendRuntimeEnvironment>;
  return {
    basePrefix: parsed.basePrefix,
    cwd: parsed.cwd,
    django: parseDjangoRuntime(parsed.django),
    error: parsed.error,
    executable: parsed.executable,
    ok: Boolean(parsed.ok),
    path: Array.isArray(parsed.path) ? parsed.path : [],
    prefix: parsed.prefix,
    settingsModule: parsed.settingsModule,
    version: parsed.version,
    virtualEnv: parsed.virtualEnv
  };
}

/** Parses nested Django runtime metadata from an environment response. */
function parseDjangoRuntime(value: BackendRuntimeEnvironment["django"]): BackendDjangoRuntime | undefined {
  if (!value) {
    return undefined;
  }
  return {
    appsReady: Boolean(value.appsReady),
    available: Boolean(value.available),
    configured: Boolean(value.configured),
    error: value.error,
    installedApps: Array.isArray(value.installedApps) ? value.installedApps : [],
    settingsModule: value.settingsModule,
    version: value.version
  };
}

/** Parses a backend runtime child inspection response. */
function parseChildrenResponse(buffer: string): BackendRuntimeChildren {
  const line = buffer.split(/\r?\n/, 1)[0] ?? "";
  const parsed = JSON.parse(line) as Partial<BackendRuntimeChildren>;
  return {
    children: Array.isArray(parsed.children) ? parsed.children : [],
    error: parsed.error,
    ok: Boolean(parsed.ok)
  };
}

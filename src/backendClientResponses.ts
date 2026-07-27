// Response parsing and transport helpers shared by the Django shell backend client.

import { modelUnsupportedFallback } from "./modelBackend";
import type {
  BackendCompletenessResult, BackendDebugBreakpointsResult, BackendDjangoRuntime, BackendExecutionResult,
  BackendInterruptResult, BackendLoadFeatureResult, BackendNativeDebuggerResult, BackendProgressSnapshot,
  BackendRequestPayload, BackendRuntimeChildren, BackendRuntimeEnvironment, BackendRuntimeInspection,
  BackendRuntimePathSegment, BackendRuntimeVariable, BackendStageDebugpyResult
} from "./backendClient";

const INSPECT_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PTY_FALLBACK_KINDS = new Set(["children", "complete", "debugpy", "environment", "execute", "inspect", "prelude", "models", "schema", "filterfields", "rows", "related", "count", "aggregate", "commit", "lookup", "query", "stagedebugpy"]); // helpers: scrubbed _djs_rpc; execute: literal cell; stagedebugpy: probe-sized only (uploads are socket-only).
/** Marks model reads that require a parallel backend connection while Python is busy. */
export const PARALLEL_MODEL_READ_KINDS = new Set(["models", "schema", "filterfields", "rows", "related", "computed", "lookup", "count", "aggregate"]);
/** Marks metadata requests that ORM and terminal modes must never type into the shell. */
export const ORM_NO_PTY = new Set(["children", "environment", "inspect", "models", "prelude", "schema", "filterfields"]);
/** Explains why ORM and terminal modes suppress a metadata request. */
export const ORM_PTY_SUPPRESSED = "Kept out of the shell: this metadata is not typed into the terminal — switch the Link selector to Socket/Auto to fetch it.";
/** Explains why a model read cannot fall back while another cell owns the only terminal stream. */
export const PARALLEL_MODEL_READ_UNAVAILABLE = "Model table reads need a second backend connection while Python is running; this shell only has the terminal stream.";
const PTY_PAGE_LIMIT = 25;

/** Returns a connectable loopback host for wildcard backend bind addresses. */
export function connectHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

/** Returns whether one request kind can be serviced over the interactive PTY fallback. */
export function isPtyFallbackKind(kind: string): boolean {
  return PTY_FALLBACK_KINDS.has(kind);
}

/** Returns a smaller payload variant for the slower terminal fallback transport. */
export function ptyFallbackPayload(payload: BackendRequestPayload): BackendRequestPayload {
  const next = payload.sourceText === undefined && payload.breakpointLines === undefined || hasDebugExecutionPayload(payload) ? payload : { ...payload, breakpointLines: undefined, sourceText: undefined };
  if ((payload.kind === "rows" || payload.kind === "related" || payload.kind === "query") && (payload.limit === undefined || payload.limit > PTY_PAGE_LIMIT)) {
    return { ...next, limit: PTY_PAGE_LIMIT };
  }
  return next;
}

/** Returns whether a PTY fallback execute request must preserve debug filename and breakpoint metadata. */
export function hasDebugExecutionPayload(payload: BackendRequestPayload): boolean {
  return payload.kind === "execute" && Array.isArray(payload.breakpointLines);
}

/** Returns a safe error response when a request cannot cross the active transport. */
export function unsupportedPtyFallbackResponse(kind: string): string {
  return kindErrorResponse(kind, "Remote runtime inspection is disabled because the backend is only reachable through the interactive terminal.");
}

/** Parses a backend execution-interrupt response. */
export function parseInterruptResponse(buffer: string): BackendInterruptResult {
  const line = buffer.split(/\r?\n/, 1)[0] ?? "";
  const parsed = JSON.parse(line) as Partial<BackendInterruptResult>;
  return { error: parsed.error, interrupted: Boolean(parsed.interrupted), message: parsed.message, ok: Boolean(parsed.ok), reason: parsed.reason };
}

/** Parses a live debug breakpoint guard update response. */
export function parseDebugBreakpointsResponse(buffer: string): BackendDebugBreakpointsResult {
  const parsed = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "{}") as Partial<BackendDebugBreakpointsResult>;
  return { breakpointLines: Array.isArray(parsed.breakpointLines) ? parsed.breakpointLines.filter((line): line is number => typeof line === "number") : undefined, error: parsed.error, ok: Boolean(parsed.ok) };
}

/** Returns a kind-shaped error response carrying one message. */
export function kindErrorResponse(kind: string, error: string): string {
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
export function parseBackendResponse(buffer: string): BackendExecutionResult {
  const line = buffer.split(/\r?\n/, 1)[0] ?? "";
  const parsed = JSON.parse(line) as Partial<BackendExecutionResult>;
  return { error: parsed.error, ok: Boolean(parsed.ok), result: parsed.result, stderr: parsed.stderr ?? "", stdout: parsed.stdout ?? "", traceback: parsed.traceback };
}

/** Parses the latest backend execution progress snapshot. */
export function parseProgressResponse(buffer: string): BackendProgressSnapshot {
  const parsed = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "{}") as Partial<BackendProgressSnapshot>;
  return {
    active: Boolean(parsed.active),
    current: typeof parsed.current === "number" ? parsed.current : undefined,
    detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
    done: Boolean(parsed.done),
    elapsed: typeof parsed.elapsed === "number" ? parsed.elapsed : undefined,
    kind: typeof parsed.kind === "string" ? parsed.kind : undefined,
    label: typeof parsed.label === "string" ? parsed.label : undefined,
    line: typeof parsed.line === "number" ? parsed.line : undefined,
    ok: typeof parsed.ok === "boolean" ? parsed.ok : undefined,
    output: typeof parsed.output === "string" ? parsed.output : undefined,
    percent: typeof parsed.percent === "number" ? parsed.percent : undefined,
    rate: typeof parsed.rate === "number" ? parsed.rate : undefined,
    stream: typeof parsed.stream === "string" ? parsed.stream : undefined,
    total: typeof parsed.total === "number" || parsed.total === null ? parsed.total : undefined
  };
}

/** Parses a staged-debugpy probe or upload response. */
export function parseStageDebugpyResponse(buffer: string): BackendStageDebugpyResult {
  const parsed = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "{}") as Partial<BackendStageDebugpyResult>;
  return { error: parsed.error, ok: Boolean(parsed.ok), path: typeof parsed.path === "string" && parsed.path ? parsed.path : null, reused: Boolean(parsed.reused) };
}

/** Parses the stable endpoint contract returned by the embedded experimental tracer bootstrap. */
export function parseNativeDebuggerResponse(buffer: string): BackendNativeDebuggerResult {
  const parsed = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "{}") as Partial<BackendNativeDebuggerResult>;
  return {
    apiVersion: typeof parsed.apiVersion === "number" ? parsed.apiVersion : 0,
    engine: "experimental",
    error: typeof parsed.error === "string" ? parsed.error : undefined,
    host: typeof parsed.host === "string" ? parsed.host : "",
    ok: Boolean(parsed.ok),
    port: typeof parsed.port === "number" ? parsed.port : 0,
    reused: Boolean(parsed.reused),
    version: typeof parsed.version === "string" ? parsed.version : ""
  };
}

/** Returns the stable native-engine result shape for a socket-only transport failure. */
export function nativeDebuggerTransportError(error: string): BackendNativeDebuggerResult {
  return { apiVersion: 0, engine: "experimental", error, host: "", ok: false, port: 0, reused: false, version: "" };
}

/** Parses the JSON result of a "loadfeature" request (socket buffer or typed PTY response marker). */
export function parseLoadFeatureResponse(buffer: string): BackendLoadFeatureResult {
  const parsed = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "{}") as Partial<BackendLoadFeatureResult>;
  return { error: parsed.error, ok: Boolean(parsed.ok), reused: Boolean(parsed.reused) };
}

/** Parses a backend completeness check response. */
export function parseCompletenessResponse(buffer: string): BackendCompletenessResult {
  const line = buffer.split(/\r?\n/, 1)[0] ?? "";
  const parsed = JSON.parse(line) as Partial<BackendCompletenessResult>;
  return { complete: Boolean(parsed.complete), ok: Boolean(parsed.ok), stderr: parsed.stderr ?? "", traceback: parsed.traceback };
}

/** Parses a backend runtime inspection response. */
export function parseInspectionResponse(buffer: string): BackendRuntimeInspection {
  const parsed = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "") as Partial<BackendRuntimeInspection>;
  return { error: parsed.error, loadedModuleCount: parsed.loadedModuleCount, modules: Array.isArray(parsed.modules) ? parsed.modules : [], ok: Boolean(parsed.ok), variables: Array.isArray(parsed.variables) ? parsed.variables : [] };
}

/** Parses a pure `len(globals())` probe marker into runtime inspection data attached by the capture hook. */
export function parseOrmInspectResponse(buffer: string): BackendRuntimeInspection {
  const marker = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "{}") as { ok?: boolean; runtime?: Partial<BackendRuntimeInspection>; stderr?: string; traceback?: string };
  const runtime = marker.runtime;
  if (marker.ok === false || !runtime || !Array.isArray(runtime.variables)) {
    const error = (marker.traceback || marker.stderr || "Runtime inspection failed in ORM mode.").trim().split(/\r?\n/).filter(Boolean).pop();
    return { error, loadedModuleCount: 0, modules: [], ok: false, variables: [] };
  }
  return { loadedModuleCount: runtime.loadedModuleCount ?? 0, modules: [], ok: true, variables: runtime.variables };
}

/** Builds a pure Python inspection probe for one safe runtime path. */
export function buildInspectChildrenOrm(path: BackendRuntimePathSegment[], kind?: string): string | null {
  const expression = reconstructInspectExpression(path);
  if (!expression) { return null; }
  return kind === "collection" ? `len(${expression})` : `dir(${expression})`;
}

/** Reconstructs a pure Python expression for an inspector path without helper calls. */
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

/** Parses an inspection drill-down marker and prepends the requested path to relative child paths. */
export function parseOrmInspectChildren(buffer: string, path: BackendRuntimePathSegment[]): BackendRuntimeChildren {
  const marker = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "{}") as { inspect?: { children?: BackendRuntimeVariable[]; error?: string }; ok?: boolean; stderr?: string; traceback?: string };
  if (marker.ok === false || marker.inspect?.error || !marker.inspect || !Array.isArray(marker.inspect.children)) {
    const error = (marker.inspect?.error || marker.traceback || marker.stderr || "").trim().split(/\r?\n/).filter(Boolean).pop();
    return { children: [], error: error || "Children unavailable in ORM mode.", ok: false };
  }
  const children = marker.inspect.children.map((child) => ({ ...child, path: [...path, ...(Array.isArray(child.path) ? child.path : [])] }));
  return { children, ok: true };
}

/** Parses a backend runtime environment response. */
export function parseEnvironmentResponse(buffer: string): BackendRuntimeEnvironment {
  const parsed = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "") as Partial<BackendRuntimeEnvironment>;
  return { basePrefix: parsed.basePrefix, cwd: parsed.cwd, django: parseDjangoRuntime(parsed.django), error: parsed.error, executable: parsed.executable, ok: Boolean(parsed.ok), path: Array.isArray(parsed.path) ? parsed.path : [], prefix: parsed.prefix, settingsModule: parsed.settingsModule, version: parsed.version, virtualEnv: parsed.virtualEnv };
}

/** Parses nested Django runtime metadata from an environment response. */
function parseDjangoRuntime(value: BackendRuntimeEnvironment["django"]): BackendDjangoRuntime | undefined {
  if (!value) { return undefined; }
  return { appsReady: Boolean(value.appsReady), available: Boolean(value.available), configured: Boolean(value.configured), error: value.error, installedApps: Array.isArray(value.installedApps) ? value.installedApps : [], settingsModule: value.settingsModule, version: value.version };
}

/** Parses a backend runtime child inspection response. */
export function parseChildrenResponse(buffer: string): BackendRuntimeChildren {
  const parsed = JSON.parse(buffer.split(/\r?\n/, 1)[0] ?? "") as Partial<BackendRuntimeChildren>;
  return { children: Array.isArray(parsed.children) ? parsed.children : [], error: parsed.error, ok: Boolean(parsed.ok) };
}

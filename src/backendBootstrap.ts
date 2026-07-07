// Backend bootstrap command builder and marker parser for in-process Django shell attachment.
import * as fs from "fs";
import { deflateSync } from "zlib";

export const BACKEND_READY_PREFIX = "__DJANGO_SHELL_BACKEND_READY__";
export const BACKEND_FAILED_PREFIX = "__DJANGO_SHELL_BACKEND_FAILED__";
export const BACKEND_RESPONSE_PREFIX = "__DJANGO_SHELL_BACKEND_RESPONSE__";
export const BACKEND_PROGRESS_PREFIX = "__DJANGO_SHELL_BACKEND_PROGRESS__";
// Printed by the env/disk bootstrap when it can load NEITHER the spawn-env payload NOR a local runtime file — i.e. a remote
// shell (SSH, kubectl/docker exec). A CLEAN signal (no FileNotFoundError traceback in the server pre_run_cell audit) that
// tells the extension to retry with the inline bootstrap that embeds the source.
export const BACKEND_NEEDS_INLINE_PREFIX = "__DJANGO_SHELL_BACKEND_NEEDS_INLINE__";

export interface BackendEndpoint {
  autoImported?: number;
  cellCapture?: boolean;
  host: string;
  ipython?: boolean;
  port: number;
  token: string;
}

export interface BackendPtyResponse {
  chunk?: BackendPtyResponseChunk;
  id: string;
  response?: unknown;
}

export interface BackendPtyResponseChunk {
  count: number;
  data: string;
  index: number;
}

export interface BackendPtyResponseParseResult {
  markers: BackendPtyResponse[];
  rest: string;
}

export interface BackendProgressParseResult {
  markers: unknown[];
  rest: string;
}

export interface BackendBootstrapCommand {
  bytes: number;
  command: string;
  mode: "env" | "inline";
}

const INLINE_BOOTSTRAP_CHUNK_SIZE = 900;

/** Env var carrying the compressed backend source to the spawned shell out-of-band (never typed, so the shell-audit log stays clean). */
export const BACKEND_PAYLOAD_ENV = "DJANGO_SHELL_BACKEND_B64";

/** Env var ("1"/"0") telling the backend whether to bind workspace models into the live shell namespace at startup. */
export const BACKEND_AUTOIMPORT_ENV = "DJANGO_SHELL_AUTOIMPORT_MODELS";

// Section marker splitting the backend into a small always-needed CORE and the larger model-browser FEATURE. On remote
// shells the core is typed inline and the feature is delivered out-of-band (socket, else typed) so the fragile typed
// bootstrap carries ~half the bytes. Local (env/disk) delivery still ships the whole source, so nothing splits there.
export const BACKEND_FEATURE_MARKER = "# --- Model data browser";

/** Reads the backend source file, returning undefined when unreadable. */
function readBackendSource(runtimePath: string): string | undefined {
  try {
    return fs.readFileSync(runtimePath, "utf8");
  } catch {
    return undefined;
  }
}

/** Returns the core backend source (everything before the deferred model-browser feature section). */
function backendCoreSource(source: string): string {
  const index = source.indexOf(BACKEND_FEATURE_MARKER);
  return index >= 0 ? source.slice(0, index) : source;
}

/** Returns the deferred model-browser feature source (from its section marker to EOF), or "" when the marker is absent. */
function backendFeatureSource(source: string): string {
  const index = source.indexOf(BACKEND_FEATURE_MARKER);
  return index >= 0 ? source.slice(index) : "";
}

/** Returns the deflate+base64 whole backend source for the spawn env payload (local delivery ships everything), or undefined when unreadable. */
export function backendBootstrapPayload(runtimePath: string): string | undefined {
  const source = readBackendSource(runtimePath);
  return source ? deflateSync(Buffer.from(source, "utf8")).toString("base64") : undefined;
}

/** Returns the deflate+base64 of the deferred model-browser feature source for a socket "loadfeature" request, or undefined when absent/unreadable. */
export function backendFeaturePayload(runtimePath: string): string | undefined {
  const source = readBackendSource(runtimePath);
  if (!source) {
    return undefined;
  }
  const feature = backendFeatureSource(source);
  return feature ? deflateSync(Buffer.from(feature, "utf8")).toString("base64") : undefined;
}

/** Builds the one-line Python command injected into the interactive Django shell. */
export function buildBackendBootstrap(runtimePath: string, token: string): string {
  return buildBackendBootstrapCommand(runtimePath, token).command;
}

/** Builds the short bootstrap command: loads backend source from the spawn env payload (else the on-disk runtime file), so the typed cell carries no large blob into the shell-audit log. On a remote shell (no env payload AND no local file) it prints a clean NEEDS_INLINE signal instead of raising FileNotFoundError, so the audit stays clean and the inline retry is armed. */
export function buildBackendBootstrapCommand(runtimePath: string, token: string): BackendBootstrapCommand {
  const load = backendLoadStatements(token);
  const python = [
    "import os as _djs_o,types as _djs_t,base64 as _djs_b,zlib as _djs_z",
    `_djs_e=_djs_o.environ.get(${pythonString(BACKEND_PAYLOAD_ENV)}); _djs_p=${pythonString(runtimePath)}`,
    `_djs_src=_djs_z.decompress(_djs_b.b64decode(_djs_e)).decode("utf-8") if _djs_e else (open(_djs_p,encoding="utf-8").read() if _djs_o.path.exists(_djs_p) else None)`,
    `if _djs_src is None: print(${pythonString(BACKEND_NEEDS_INLINE_PREFIX)})`,
    `else: ${load}`
  ].join("\n");
  const command = `exec(${pythonString(python)})\r`;
  return { bytes: command.length, command, mode: "env" };
}

/** Builds a file-independent bootstrap that embeds the compressed backend source in the typed command, as a fallback for remote shells (SSH, kubectl/docker exec) where the spawn env payload is not forwarded and the local runtime path is absent on the remote. Returns undefined when the local source cannot be read. */
export function buildInlineBackendBootstrapCommand(runtimePath: string, token: string): BackendBootstrapCommand | undefined {
  const source = readBackendSource(runtimePath);
  if (!source) {
    return undefined;
  }
  // Type only the CORE half inline; the model-browser feature follows over the socket (or typed fallback) after ready.
  const payload = deflateSync(Buffer.from(backendCoreSource(source), "utf8")).toString("base64");
  const partsKey = `_djs_inline_parts_${token}`;
  const partsLiteral = pythonString(partsKey);
  const python = [
    "import types as _djs_t,base64 as _djs_b,zlib as _djs_z",
    `_djs_payload="".join(globals().pop(${partsLiteral},[]))`,
    `_djs_src=_djs_z.decompress(_djs_b.b64decode(_djs_payload)).decode("utf-8")`,
    backendLoadStatements(token)
  ].join("; ");
  const initLine = `globals()[${partsLiteral}]=[]`;
  const chunkLines = payloadChunks(payload).map((chunk) => `globals().setdefault(${partsLiteral},[]).append(${pythonString(chunk)})`);
  const command = `${initLine}\r${chunkLines.join("\r")}\rexec(${pythonString(python)})\r`;
  return { bytes: command.length, command, mode: "inline" };
}

/** Shell-namespace key staging the typed feature chunks that a `loadfeature` PTY request consumes via `partsKey`. */
export const BACKEND_FEATURE_PARTS_KEY = "_djs_feature_parts";

/** Builds the typed PTY fallback that stages the deferred feature source in short append lines and finishes with the given `_djs_rpc` loadfeature line — used only when the socket "loadfeature" is unavailable (a pure-PTY remote with no tunnel). The rpc tail is capture-skipped by the backend hook, so its id-correlated response marker prints straight to the terminal. Returns undefined when there is no feature section. */
export function buildFeatureLoadPtyCommand(runtimePath: string, rpcTailLine: string): string | undefined {
  const payload = backendFeaturePayload(runtimePath);
  if (!payload) {
    return undefined;
  }
  const partsLiteral = pythonString(BACKEND_FEATURE_PARTS_KEY);
  const initLine = `globals()[${partsLiteral}]=[]`;
  const chunkLines = payloadChunks(payload).map((chunk) => `globals().setdefault(${partsLiteral},[]).append(${pythonString(chunk)})`);
  return `${initLine}\r${chunkLines.join("\r")}\r${rpcTailLine.replace(/\r$/, "")}\r`;
}

/** Splits the inline backend payload into short terminal input lines so remote IPython/kubectl PTYs do not choke on one huge line. */
function payloadChunks(payload: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < payload.length; index += INLINE_BOOTSTRAP_CHUNK_SIZE) {
    chunks.push(payload.slice(index, index + INLINE_BOOTSTRAP_CHUNK_SIZE));
  }
  return chunks;
}

/** The shared `_djs_src`-loading tail: build the module, run start() (which wires `_djs_rpc`/initial names into the namespace), expose the module, and scrub the bootstrap line from history (kept LAST so IPython does not re-record it). */
function backendLoadStatements(token: string): string {
  return [
    '_djs_m=_djs_t.ModuleType("django_shell_backend")',
    'exec(compile(_djs_src,"<django-shell-backend>","exec"),_djs_m.__dict__)',
    `_djs_m.start(globals(), ${pythonString(token)})`,
    'globals()["_djs_backend_module"]=_djs_m',
    "_djs_m._pty_history_scrub(None)"
  ].join("; ");
}

/** Parses a backend-ready marker from terminal output. */
export function parseBackendReadyMarker(output: string): BackendEndpoint | undefined {
  return parseMarkerJson<BackendEndpoint>(output, BACKEND_READY_PREFIX);
}

/** Parses a backend-failed marker from terminal output. */
export function parseBackendFailedMarker(output: string): string | undefined {
  const payload = parseMarkerJson<{ error?: string }>(output, BACKEND_FAILED_PREFIX);
  return payload?.error;
}

/** Returns whether the env/disk bootstrap signalled it needs the inline (source-embedded) bootstrap — a remote shell. */
export function parseBackendNeedsInline(output: string): boolean {
  return output.lastIndexOf(BACKEND_NEEDS_INLINE_PREFIX) >= 0;
}

/** Parses a PTY backend response marker from terminal output. */
export function parseBackendResponseMarker(output: string): BackendPtyResponse | undefined {
  return parseBackendResponseMarkers(output).markers.at(-1);
}

/** Parses every complete PTY backend response marker from terminal output and keeps an incomplete tail. */
export function parseBackendResponseMarkers(output: string): BackendPtyResponseParseResult {
  const parsed = parsePrefixedJsonLines<BackendPtyResponse>(output, BACKEND_RESPONSE_PREFIX);
  return { markers: parsed.markers, rest: parsed.rest };
}

/** Parses every complete progress marker from terminal output and keeps an incomplete tail. */
export function parseBackendProgressMarkers(output: string): BackendProgressParseResult {
  return parsePrefixedJsonLines<unknown>(output, BACKEND_PROGRESS_PREFIX);
}

/** Parses complete JSON marker lines with the given prefix. */
function parsePrefixedJsonLines<T>(output: string, prefix: string): { markers: T[]; rest: string } {
  const markers: T[] = [];
  let searchFrom = 0;
  let consumed = 0;
  for (;;) {
    const index = output.indexOf(prefix, searchFrom);
    if (index < 0) {
      break;
    }
    const start = index + prefix.length;
    const end = lineEndIndex(output, start);
    if (end < 0) {
      break;
    }
    const raw = output.slice(start, end).trim();
    try {
      markers.push(JSON.parse(raw) as T);
    } catch {
      // Ignore malformed marker-looking output; later complete markers can still resolve the request.
    }
    consumed = output[end] === "\r" && output[end + 1] === "\n" ? end + 2 : end + 1;
    searchFrom = consumed;
  }
  return { markers, rest: output.slice(consumed) };
}

/** Encodes a JavaScript string as a Python string literal. */
function pythonString(value: string): string {
  return JSON.stringify(value);
}

/** Extracts a JSON object printed after a backend marker prefix. */
function parseMarkerJson<T>(output: string, prefix: string): T | undefined {
  const index = output.lastIndexOf(prefix);
  if (index < 0) {
    return undefined;
  }
  const rest = output.slice(index + prefix.length);
  const match = rest.match(/(\{[^\r\n]*\})/);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    return undefined;
  }
}

/** Returns the index of the next line ending, or -1 when the marker line is incomplete. */
function lineEndIndex(output: string, start: number): number {
  const cr = output.indexOf("\r", start);
  const lf = output.indexOf("\n", start);
  if (cr < 0) {
    return lf;
  }
  if (lf < 0) {
    return cr;
  }
  return Math.min(cr, lf);
}

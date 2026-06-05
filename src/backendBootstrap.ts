// Backend bootstrap command builder and marker parser for in-process Django shell attachment.
import * as fs from "fs";
import { deflateSync } from "zlib";

export const BACKEND_READY_PREFIX = "__DJANGO_SHELL_BACKEND_READY__";
export const BACKEND_FAILED_PREFIX = "__DJANGO_SHELL_BACKEND_FAILED__";
export const BACKEND_RESPONSE_PREFIX = "__DJANGO_SHELL_BACKEND_RESPONSE__";

export interface BackendEndpoint {
  autoImported?: number;
  cellCapture?: boolean;
  host: string;
  ipython?: boolean;
  port: number;
  token: string;
}

export interface BackendPtyResponse {
  id: string;
  response: unknown;
}

export interface BackendBootstrapCommand {
  bytes: number;
  command: string;
  mode: "env" | "inline";
}

/** Env var carrying the compressed backend source to the spawned shell out-of-band (never typed, so the shell-audit log stays clean). */
export const BACKEND_PAYLOAD_ENV = "DJANGO_SHELL_BACKEND_B64";

/** Env var ("1"/"0") telling the backend whether to bind workspace models into the live shell namespace at startup. */
export const BACKEND_AUTOIMPORT_ENV = "DJANGO_SHELL_AUTOIMPORT_MODELS";

/** Returns the deflate+base64 backend source to set as the spawn env payload, or undefined when unreadable. */
export function backendBootstrapPayload(runtimePath: string): string | undefined {
  try {
    return deflateSync(Buffer.from(fs.readFileSync(runtimePath, "utf8"), "utf8")).toString("base64");
  } catch {
    return undefined;
  }
}

/** Builds the one-line Python command injected into the interactive Django shell. */
export function buildBackendBootstrap(runtimePath: string, token: string): string {
  return buildBackendBootstrapCommand(runtimePath, token).command;
}

/** Builds the short bootstrap command: loads backend source from the spawn env payload (else the on-disk runtime file), so the typed cell carries no large blob into the shell-audit log. */
export function buildBackendBootstrapCommand(runtimePath: string, token: string): BackendBootstrapCommand {
  const python = [
    "import os as _djs_o,types as _djs_t,base64 as _djs_b,zlib as _djs_z",
    '_djs_m=_djs_t.ModuleType("django_shell_backend")',
    `_djs_e=_djs_o.environ.get(${pythonString(BACKEND_PAYLOAD_ENV)})`,
    `_djs_src=(_djs_z.decompress(_djs_b.b64decode(_djs_e)).decode("utf-8") if _djs_e else open(${pythonString(runtimePath)},encoding="utf-8").read())`,
    'exec(compile(_djs_src,"<django-shell-backend>","exec"),_djs_m.__dict__)',
    `_djs_m.start(globals(), ${pythonString(token)})`,
    'globals()["_djs_backend_module"]=_djs_m',
    'globals()["_djs_backend_initial_names"]=_djs_m._STATE["server"].initial_names',
    rpcDefinition(token)
  ].join("; ");
  const command = `exec(${pythonString(python)})\r`;
  return { bytes: command.length, command, mode: "env" };
}

/** Builds a file-independent bootstrap that embeds the compressed backend source in the typed command, as a fallback for remote shells (SSH, kubectl/docker exec) where the spawn env payload is not forwarded and the local runtime path is absent on the remote. Returns undefined when the local source cannot be read. */
export function buildInlineBackendBootstrapCommand(runtimePath: string, token: string): BackendBootstrapCommand | undefined {
  const payload = backendBootstrapPayload(runtimePath);
  if (!payload) {
    return undefined;
  }
  const python = [
    "import types as _djs_t,base64 as _djs_b,zlib as _djs_z",
    '_djs_m=_djs_t.ModuleType("django_shell_backend")',
    `_djs_src=_djs_z.decompress(_djs_b.b64decode(${pythonString(payload)})).decode("utf-8")`,
    'exec(compile(_djs_src,"<django-shell-backend>","exec"),_djs_m.__dict__)',
    `_djs_m.start(globals(), ${pythonString(token)})`,
    'globals()["_djs_backend_module"]=_djs_m',
    'globals()["_djs_backend_initial_names"]=_djs_m._STATE["server"].initial_names',
    rpcDefinition(token)
  ].join("; ");
  const command = `exec(${pythonString(python)})\r`;
  return { bytes: command.length, command, mode: "inline" };
}

/** Defines the short `_djs_rpc(request, id)` PTY helper and scrubs the bootstrap line from shell history. */
function rpcDefinition(token: string): string {
  return [
    `globals()["_djs_rpc"]=(lambda _djs_r,_djs_i: _djs_m._pty_serve(globals(), ${pythonString(token)}, _djs_r, _djs_i, globals().get("_djs_backend_initial_names", set())))`,
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

/** Parses a PTY backend response marker from terminal output. */
export function parseBackendResponseMarker(output: string): BackendPtyResponse | undefined {
  return parseMarkerJson<BackendPtyResponse>(output, BACKEND_RESPONSE_PREFIX);
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

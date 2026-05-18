// Backend bootstrap command builder and marker parser for in-process Django shell attachment.
import * as fs from "fs";
import { deflateSync } from "zlib";

export const BACKEND_READY_PREFIX = "__DJANGO_SHELL_BACKEND_READY__";
export const BACKEND_FAILED_PREFIX = "__DJANGO_SHELL_BACKEND_FAILED__";
export const BACKEND_RESPONSE_PREFIX = "__DJANGO_SHELL_BACKEND_RESPONSE__";

export interface BackendEndpoint {
  host: string;
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
  mode: "inline" | "path";
}

/** Builds the one-line Python command injected into the interactive Django shell. */
export function buildBackendBootstrap(runtimePath: string, token: string): string {
  return buildBackendBootstrapCommand(runtimePath, token).command;
}

/** Builds a backend bootstrap command and describes how it will load backend code. */
export function buildBackendBootstrapCommand(runtimePath: string, token: string): BackendBootstrapCommand {
  const inline = inlineBackendBootstrap(runtimePath, token);
  if (inline) {
    return { bytes: inline.length, command: inline, mode: "inline" };
  }
  const command = pathBackendBootstrap(runtimePath, token);
  return { bytes: command.length, command, mode: "path" };
}

/** Builds a file-independent bootstrap command for remote Python processes. */
function inlineBackendBootstrap(runtimePath: string, token: string): string | undefined {
  let source: string;
  try {
    source = fs.readFileSync(runtimePath, "utf8");
  } catch {
    return undefined;
  }
  const payload = deflateSync(Buffer.from(source, "utf8")).toString("base64");
  const python = [
    "import base64 as _djs_b,zlib as _djs_z,types as _djs_t",
    '_djs_m=_djs_t.ModuleType("django_shell_backend")',
    `_djs_src=_djs_z.decompress(_djs_b.b64decode(${pythonString(payload)})).decode("utf-8")`,
    'exec(compile(_djs_src,"<django-shell-backend>","exec"),_djs_m.__dict__)',
    `_djs_m.start(globals(), ${pythonString(token)})`,
    'globals()["_djs_backend_module"]=_djs_m',
    'globals()["_djs_backend_initial_names"]=_djs_m._STATE["server"].initial_names'
  ].join("; ");
  return `exec(${pythonString(python)})\r`;
}

/** Builds the legacy path-based bootstrap command when source cannot be embedded. */
function pathBackendBootstrap(runtimePath: string, token: string): string {
  const python = [
    "import importlib.util as _djs_u",
    `_djs_s=_djs_u.spec_from_file_location("django_shell_backend", ${pythonString(runtimePath)})`,
    "_djs_m=_djs_u.module_from_spec(_djs_s)",
    "_djs_s.loader.exec_module(_djs_m)",
    `_djs_m.start(globals(), ${pythonString(token)})`,
    'globals()["_djs_backend_module"]=_djs_m',
    'globals()["_djs_backend_initial_names"]=_djs_m._STATE["server"].initial_names'
  ].join("; ");
  return `exec(${pythonString(python)})\r`;
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

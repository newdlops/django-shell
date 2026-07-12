// Native tracer startup and endpoint normalization for Django Shell debug sessions.

import * as path from "path";
import type { BackendClient, BackendNativeDebuggerResult } from "./backendClient";

export const NATIVE_TRACER_API_VERSION = 1;
export const NATIVE_TRACER_VERSION = "2026.07.11.4";

/** Connectable endpoint returned by the in-process native tracer. */
export interface NativeDebugEndpoint {
  host: string;
  inProcess: true;
  port: number;
  reused: boolean;
}

/** Bootstrap-style result shared with the existing debugpy startup path. */
export interface NativeDebugSessionResult {
  endpoint?: NativeDebugEndpoint;
  error?: string;
  ok: boolean;
}

/** Options needed to load the vendored tracer through the live shell backend. */
export interface StartNativeDebugSessionOptions {
  backend: BackendClient;
  extensionPath: string;
  host?: string;
  port?: number;
}

/** Loads or reuses the vendored tracer and returns a direct DAP endpoint. */
export async function startDjangoShellNativeDebugSession(options: StartNativeDebugSessionOptions): Promise<NativeDebugSessionResult> {
  try {
    const host = normalizeRequestedHost(options.host);
    const port = normalizeRequestedPort(options.port);
    if (typeof options.extensionPath !== "string" || !options.extensionPath.trim()) {
      return { error: "Django Shell could not locate its bundled native tracer.", ok: false };
    }
    const result = await options.backend.startNativeDebugger({
      expectedVersion: NATIVE_TRACER_VERSION,
      host,
      port,
      tracerPath: path.join(options.extensionPath, "python", "django_shell_native_tracer.py")
    });
    return normalizeNativeDebuggerResult(result);
  } catch (error) {
    return { error: normalizeError(error, "Django Shell could not start the native tracer."), ok: false };
  }
}

/** Strictly validates the backend's native tracer response and makes its endpoint connectable. */
export function normalizeNativeDebuggerResult(result: BackendNativeDebuggerResult): NativeDebugSessionResult {
  if (!result || result.ok !== true) {
    return { error: normalizeError(result?.error, "The Django Shell backend could not start the native tracer."), ok: false };
  }
  if (result.apiVersion !== NATIVE_TRACER_API_VERSION) {
    return { error: `The native tracer API is incompatible (expected ${NATIVE_TRACER_API_VERSION}, received ${String(result.apiVersion ?? "unknown")}). Restart the Django shell after updating the extension.`, ok: false };
  }
  if (result.version !== NATIVE_TRACER_VERSION) {
    return { error: `The active native tracer version is incompatible (expected ${NATIVE_TRACER_VERSION}, received ${String(result.version ?? "unknown")}). Restart the Django shell to load the bundled tracer.`, ok: false };
  }
  if (result.engine !== "experimental") {
    return { error: "The Django Shell backend returned the wrong debugger engine.", ok: false };
  }
  const host = connectableNativeHost(result.host);
  const port = result.port;
  if (!host || typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return { error: "The native tracer returned an invalid loopback endpoint.", ok: false };
  }
  return { endpoint: { host, inProcess: true, port, reused: Boolean(result.reused) }, ok: true };
}

/** Normalizes a requested native listener host while keeping it loopback-only. */
function normalizeRequestedHost(value: unknown): string {
  const host = connectableNativeHost(value ?? "127.0.0.1");
  if (!host) {
    throw new Error("Django Shell native debugging requires a loopback listen host.");
  }
  return host;
}

/** Normalizes a requested native listener port, allowing zero for automatic selection. */
function normalizeRequestedPort(value: unknown): number {
  const port = value === undefined ? 0 : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Django Shell native debugging received an invalid listen port.");
  }
  return port;
}

/** Converts wildcard listeners to loopback and rejects non-loopback hosts. */
function connectableNativeHost(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const host = raw === "0.0.0.0" || raw === "::" ? "127.0.0.1" : raw;
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return host;
  }
  const octets = host.split(".");
  if (octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) {
    return host;
  }
  return undefined;
}

/** Returns a useful one-line backend error with a stable fallback. */
function normalizeError(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim()) { return value.message.trim(); }
  if (typeof value === "string" && value.trim()) { return value.trim(); }
  return fallback;
}

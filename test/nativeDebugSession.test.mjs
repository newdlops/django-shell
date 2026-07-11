// Unit tests for bundled native tracer startup and backend result validation.

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { NATIVE_TRACER_VERSION, normalizeNativeDebuggerResult, startDjangoShellNativeDebugSession } = require("../out/nativeDebugSession.js");

test("starts the bundled tracer and normalizes its loopback endpoint", async () => {
  let request;
  const backend = {
    async startNativeDebugger(value) {
      request = value;
      return { apiVersion: 1, engine: "experimental", host: "0.0.0.0", ok: true, port: 43123, reused: true, version: NATIVE_TRACER_VERSION };
    }
  };
  const result = await startDjangoShellNativeDebugSession({ backend, extensionPath: "/extension", host: "0.0.0.0", port: 0 });
  assert.deepEqual(request, {
    expectedVersion: NATIVE_TRACER_VERSION,
    host: "127.0.0.1",
    port: 0,
    tracerPath: path.join("/extension", "python", "django_shell_native_tracer.py")
  });
  assert.deepEqual(result, { endpoint: { host: "127.0.0.1", inProcess: true, port: 43123, reused: true }, ok: true });
});

test("normalizes backend failures and thrown startup errors", async () => {
  assert.deepEqual(normalizeNativeDebuggerResult({ error: "load failed", ok: false }), { error: "load failed", ok: false });
  const result = await startDjangoShellNativeDebugSession({ backend: { async startNativeDebugger() { throw new Error("socket closed"); } }, extensionPath: "/extension" });
  assert.deepEqual(result, { error: "socket closed", ok: false });
});

test("preserves a Port Manager rewritten 127/8 tracer host", () => {
  const result = normalizeNativeDebuggerResult({
    apiVersion: 1,
    engine: "experimental",
    host: "127.96.137.83",
    ok: true,
    port: 43124,
    reused: true,
    version: NATIVE_TRACER_VERSION
  });

  assert.deepEqual(result, { endpoint: { host: "127.96.137.83", inProcess: true, port: 43124, reused: true }, ok: true });
});

test("rejects stale tracers and malformed success endpoints", () => {
  const success = { apiVersion: 1, engine: "experimental", host: "127.0.0.1", ok: true, port: 43123, version: NATIVE_TRACER_VERSION };
  assert.match(normalizeNativeDebuggerResult({ ...success, apiVersion: 0 }).error, /API is incompatible/);
  assert.match(normalizeNativeDebuggerResult({ ...success, version: "stale" }).error, /version is incompatible/);
  assert.match(normalizeNativeDebuggerResult({ ...success, engine: undefined }).error, /wrong debugger engine/);
  assert.match(normalizeNativeDebuggerResult({ ...success, host: "203.0.113.10" }).error, /invalid loopback endpoint/);
  assert.match(normalizeNativeDebuggerResult({ ...success, port: 0 }).error, /invalid loopback endpoint/);
  assert.match(normalizeNativeDebuggerResult({ ...success, port: "43123" }).error, /invalid loopback endpoint/);
});

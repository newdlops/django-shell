// Unit tests for Django Shell's internal debug-engine and native adapter contract.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  buildDjangoShellNativeDebugConfiguration,
  debugEngineForSession,
  DJANGO_SHELL_NATIVE_DEBUG_TYPE,
  normalizeDjangoShellDebugEngine,
  parseDjangoShellNativeDebugConfiguration
} = require("../out/debugEngine.js");

test("keeps debugpy as default and accepts explicit experimental opt-in", () => {
  assert.equal(normalizeDjangoShellDebugEngine(undefined), "debugpy");
  assert.equal(normalizeDjangoShellDebugEngine("debugpy"), "debugpy");
  assert.equal(normalizeDjangoShellDebugEngine("experimental"), "experimental");
  assert.equal(normalizeDjangoShellDebugEngine("unknown"), "debugpy");
});

test("builds and recognizes an internal native attach session", () => {
  const configuration = buildDjangoShellNativeDebugConfiguration({ host: "127.0.0.1", port: 43123 }, "/workspace");
  assert.deepEqual(configuration, {
    __djangoShellSession: true,
    cwd: "/workspace",
    engine: "experimental",
    host: "127.0.0.1",
    name: "Django Shell",
    port: 43123,
    request: "attach",
    type: DJANGO_SHELL_NATIVE_DEBUG_TYPE
  });
  assert.deepEqual(parseDjangoShellNativeDebugConfiguration(configuration), configuration);
  assert.equal(debugEngineForSession(DJANGO_SHELL_NATIVE_DEBUG_TYPE, configuration), "experimental");
  assert.equal(debugEngineForSession("python", configuration), "debugpy");
});

test("rejects forged, remote, and malformed native adapter configurations", () => {
  const valid = buildDjangoShellNativeDebugConfiguration({ host: "localhost", port: 43123 }, "/workspace");
  assert.throws(() => parseDjangoShellNativeDebugConfiguration({ ...valid, __djangoShellSession: false }), /not owned/);
  assert.throws(() => parseDjangoShellNativeDebugConfiguration({ ...valid, type: "python" }), /internal attach/);
  assert.throws(() => parseDjangoShellNativeDebugConfiguration({ ...valid, host: "192.0.2.10" }), /loopback/);
  assert.throws(() => parseDjangoShellNativeDebugConfiguration({ ...valid, host: "127.999.1.1" }), /loopback/);
  assert.throws(() => parseDjangoShellNativeDebugConfiguration({ ...valid, port: 0 }), /adapter port/);
  assert.throws(() => parseDjangoShellNativeDebugConfiguration({ ...valid, port: "43123" }), /adapter port/);
  assert.throws(() => parseDjangoShellNativeDebugConfiguration(undefined), /invalid/);
  assert.throws(() => buildDjangoShellNativeDebugConfiguration({ host: "127.0.0.1", port: 43123 }, ""), /workspace path/);
});

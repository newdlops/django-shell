// Unit tests for Django shell debugger bootstrap helpers.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildDebugpySteppingRules } = require("../out/debugSteppingRules.js");
const {
  DEBUGPY_MARKER_PREFIX,
  buildDebugpyBootstrapCode,
  buildDjangoShellDebugConfiguration,
  effectiveDebugpyListenHost,
  parseDebugpyBootstrapResult,
  readDjangoShellDebugOptions
} = require("../out/debugShell.js");

test("builds a reusable debugpy bootstrap that emits a marker", () => {
  const code = buildDebugpyBootstrapCode("127.0.0.1", 56789, DEBUGPY_MARKER_PREFIX, ["/vscode/debugpy/bundled/libs"]);

  assert.match(code, /import debugpy as _djs_debugpy/);
  assert.match(code, /_djs_debugpy\.listen\(_djs_debug_requested\)/);
  assert.match(code, /in_process_debug_adapter=True/);
  assert.match(code, /timed out waiting for adapter to connect/);
  assert.match(code, /_djs_debug_socket\.socket/);
  assert.match(code, /_djs_debug_endpoint = \(_djs_debug_listen_result\[0\] or _djs_debug_host, int\(_djs_debug_listen_result\[1\]\)\)/);
  assert.match(code, /_django_shell_debugpy_endpoint/);
  assert.match(code, new RegExp(DEBUGPY_MARKER_PREFIX));
  assert.match(code, /\/vscode\/debugpy\/bundled\/libs/);
  assert.match(code, /_djs_debug_sys\.path\.insert/);
  assert.match(code, /PYDEVD_DISABLE_FILE_VALIDATION/);
  assert.match(code, /PYTHONBREAKPOINT/);
  assert.match(code, /_djs_debug_sys\.breakpointhook = _djs_debugpy\.breakpoint/);
  assert.match(code, /56789/);
});

test("parses debugpy endpoint markers and failures", () => {
  const ok = parseDebugpyBootstrapResult(`noise\n${DEBUGPY_MARKER_PREFIX}{"ok":true,"host":"127.0.0.1","port":56789,"reused":false}\n`);
  const failed = parseDebugpyBootstrapResult(`${DEBUGPY_MARKER_PREFIX}{"ok":false,"error":"ImportError('debugpy')"}\n`);
  const inProcess = parseDebugpyBootstrapResult(`${DEBUGPY_MARKER_PREFIX}{"ok":true,"host":"127.0.0.1","inProcess":true,"port":56790,"reused":false}\n`);

  assert.deepEqual(ok, { endpoint: { host: "127.0.0.1", port: 56789, reused: false }, ok: true });
  assert.deepEqual(inProcess, { endpoint: { host: "127.0.0.1", inProcess: true, port: 56790, reused: false }, ok: true });
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? "", /debugpy/);
});

test("builds a Python attach configuration for the live shell endpoint", () => {
  const configuration = buildDjangoShellDebugConfiguration({ host: "127.0.0.1", port: 56789, reused: true }, "/workspace/app");
  const rules = buildDebugpySteppingRules();

  assert.deepEqual(configuration, {
    connect: { host: "127.0.0.1", port: 56789 },
    cwd: "/workspace/app",
    django: true,
    justMyCode: false,
    name: "Django Shell",
    pathMappings: [{ localRoot: "/workspace/app", remoteRoot: "/workspace/app" }],
    request: "attach",
    rules,
    type: "python"
  });
});

test("debug stepping skips third-party packages while keeping project source debuggable", () => {
  const rules = buildDebugpySteppingRules();
  const configuration = buildDjangoShellDebugConfiguration({ host: "127.0.0.1", port: 56789, reused: true }, "/workspace/app");
  const paths = rules.map((rule) => rule.path);

  assert.equal(configuration.justMyCode, false);
  assert.deepEqual(configuration.rules, rules);
  assert.ok(paths.includes("*/site-packages/*"));
  assert.ok(paths.includes("*\\site-packages\\*"));
  assert.ok(paths.includes("*/dist-packages/*"));
  assert.ok(paths.includes("*\\dist-packages\\*"));
});

test("builds remote-friendly Python attach configuration from debug settings", () => {
  const options = readDjangoShellDebugOptions({
    get(key, fallback) {
      return { connectHost: "127.0.0.1", connectPort: 45678, listenHost: "0.0.0.0", listenPort: 5678, remoteRoot: "/app" }[key] ?? fallback;
    }
  });
  const configuration = buildDjangoShellDebugConfiguration({ host: "0.0.0.0", port: 5678, reused: false }, "/workspace/app", options);

  assert.equal(options.listenHost, "0.0.0.0");
  assert.equal(options.listenPort, 5678);
  assert.deepEqual(configuration.connect, { host: "127.0.0.1", port: 45678 });
  assert.deepEqual(configuration.pathMappings, [{ localRoot: "/workspace/app", remoteRoot: "/app" }]);
});

test("widens debugpy listen host for an explicit remote attach host", () => {
  const remoteDefault = readDjangoShellDebugOptions({
    get(key, fallback) {
      return { connectHost: "10.0.2.15" }[key] ?? fallback;
    }
  });
  const remoteExplicit = readDjangoShellDebugOptions({
    get(key, fallback) {
      return { connectHost: "10.0.2.15", listenHost: "127.0.0.1" }[key] ?? fallback;
    },
    inspect(key) {
      return key === "listenHost" ? { workspaceValue: "127.0.0.1" } : undefined;
    }
  });

  assert.equal(effectiveDebugpyListenHost(remoteDefault), "0.0.0.0");
  assert.equal(effectiveDebugpyListenHost(remoteExplicit), "127.0.0.1");
});

// Unit tests for backend bootstrap command generation and marker parsing.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  BACKEND_FAILED_PREFIX,
  BACKEND_READY_PREFIX,
  buildBackendBootstrap,
  buildBackendBootstrapCommand,
  parseBackendFailedMarker,
  parseBackendReadyMarker
} = require("../out/backendBootstrap.js");

test("builds a path bootstrap command when backend source is unavailable", () => {
  const command = buildBackendBootstrap("/tmp/backend.py", "abc123");

  assert.match(command, /^exec\(/);
  assert.match(command, /backend\.py/);
  assert.match(command, /abc123/);
  assert.match(command, /\r$/);
});

test("builds an inline Python bootstrap command when backend source is available", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-backend-"));
  const runtimePath = path.join(dir, "backend.py");
  fs.writeFileSync(runtimePath, "def start(namespace, token):\\n    namespace['attached_token'] = token\\n");

  const bootstrap = buildBackendBootstrapCommand(runtimePath, "remote-token");

  assert.equal(bootstrap.mode, "inline");
  assert.match(bootstrap.command, /^exec\(/);
  assert.match(bootstrap.command, /b64decode/);
  assert.match(bootstrap.command, /remote-token/);
  assert.doesNotMatch(bootstrap.command, /backend\.py/);
  assert.match(bootstrap.command, /\r$/);
});

test("parses backend ready and failed markers from terminal output", () => {
  const ready = parseBackendReadyMarker(
    `noise\r\n${BACKEND_READY_PREFIX}{"host":"127.0.0.1","port":49152,"token":"abc"}\r\n>>> `
  );
  const failed = parseBackendFailedMarker(`${BACKEND_FAILED_PREFIX}{"error":"boom"}\n`);

  assert.deepEqual(ready, { host: "127.0.0.1", port: 49152, token: "abc" });
  assert.equal(failed, "boom");
});

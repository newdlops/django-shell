// Unit tests for backend bootstrap command generation and marker parsing.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const {
  BACKEND_FAILED_PREFIX,
  BACKEND_READY_PREFIX,
  BACKEND_RESPONSE_PREFIX,
  buildBackendBootstrap,
  buildBackendBootstrapCommand,
  buildInlineBackendBootstrapCommand,
  parseBackendFailedMarker,
  parseBackendReadyMarker,
  parseBackendResponseMarkers
} = require("../out/backendBootstrap.js");

test("builds a path bootstrap command when backend source is unavailable", () => {
  const command = buildBackendBootstrap("/tmp/backend.py", "abc123");

  assert.match(command, /^exec\(/);
  assert.match(command, /backend\.py/);
  assert.match(command, /abc123/);
  assert.match(command, /\r$/);
});

test("builds a short env-payload bootstrap (no inline blob) so the shell-audit log stays clean", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-backend-"));
  const runtimePath = path.join(dir, "backend.py");
  fs.writeFileSync(runtimePath, "def start(namespace, token):\n    namespace['attached_token'] = token\n");

  const bootstrap = buildBackendBootstrapCommand(runtimePath, "remote-token");

  assert.equal(bootstrap.mode, "env");
  assert.match(bootstrap.command, /^exec\(/);
  assert.match(bootstrap.command, /DJANGO_SHELL_BACKEND_B64/);
  assert.match(bootstrap.command, /remote-token/);
  assert.ok(bootstrap.command.length < 2000, `typed bootstrap must be short (no inline blob), got ${bootstrap.command.length}`);
  assert.match(bootstrap.command, /\r$/);
});

test("builds a file-independent inline bootstrap that embeds the source for remote shells (SSH, kubectl)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-backend-"));
  const runtimePath = path.join(dir, "backend.py");
  const source = "def start(namespace, token):\n    namespace['attached_token'] = token\n";
  fs.writeFileSync(runtimePath, source);

  const bootstrap = buildInlineBackendBootstrapCommand(runtimePath, "remote-token");

  assert.equal(bootstrap.mode, "inline");
  assert.match(bootstrap.command, /^exec\(/);
  assert.match(bootstrap.command, /remote-token/);
  assert.match(bootstrap.command, /\r$/);
  // Must not depend on the spawn env payload or the local on-disk path, which a remote shell cannot reach.
  assert.doesNotMatch(bootstrap.command, /DJANGO_SHELL_BACKEND_B64/);
  assert.ok(!bootstrap.command.includes(runtimePath), "inline bootstrap must not reference the local runtime path");
  // The embedded blob must decompress back to the exact backend source (inner quotes are JSON-escaped in the command).
  const embedded = bootstrap.command.match(/b64decode\(\\"([A-Za-z0-9+/=]+)\\"\)/);
  assert.ok(embedded, "inline bootstrap must embed a base64 blob");
  assert.equal(zlib.inflateSync(Buffer.from(embedded[1], "base64")).toString("utf8"), source);
});

test("returns no inline bootstrap when the local runtime source cannot be read", () => {
  assert.equal(buildInlineBackendBootstrapCommand(path.join(os.tmpdir(), "does-not-exist-xyz.py"), "t"), undefined);
});

test("parses backend ready and failed markers from terminal output", () => {
  const ready = parseBackendReadyMarker(
    `noise\r\n${BACKEND_READY_PREFIX}{"host":"127.0.0.1","port":49152,"token":"abc"}\r\n>>> `
  );
  const failed = parseBackendFailedMarker(`${BACKEND_FAILED_PREFIX}{"error":"boom"}\n`);

  assert.deepEqual(ready, { host: "127.0.0.1", port: 49152, token: "abc" });
  assert.equal(failed, "boom");
});

test("parses multiple complete PTY response markers and preserves an incomplete tail", () => {
  const first = `${BACKEND_RESPONSE_PREFIX}${JSON.stringify({ chunk: { count: 2, data: '{"ok":', index: 0 }, id: "cell" })}\r\n`;
  const second = `${BACKEND_RESPONSE_PREFIX}${JSON.stringify({ chunk: { count: 2, data: "true}", index: 1 }, id: "cell" })}\n`;
  const partial = `${BACKEND_RESPONSE_PREFIX}{"id":"later"`;

  const parsed = parseBackendResponseMarkers(`noise\n${first}${second}${partial}`);

  assert.equal(parsed.markers.length, 2);
  assert.deepEqual(parsed.markers.map((marker) => marker.chunk?.index), [0, 1]);
  assert.equal(parsed.rest, partial);
});

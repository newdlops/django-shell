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
  BACKEND_PROGRESS_PREFIX,
  BACKEND_READY_PREFIX,
  BACKEND_RESPONSE_PREFIX,
  BACKEND_FEATURE_PARTS_KEY,
  backendBootstrapPayload,
  backendFeaturePayload,
  buildBackendBootstrap,
  buildBackendBootstrapCommand,
  buildFeatureLoadPtyCommand,
  buildInlineBackendBootstrapCommand,
  parseBackendFailedMarker,
  parseBackendProgressMarkers,
  parseBackendReadyMarker,
  parseBackendResponseMarkers
} = require("../out/backendBootstrap.js");

test("remote inline bootstrap types only the core half; the model browser ships separately", () => {
  const realPath = path.resolve("python/django_shell_backend.py");
  const marker = "# --- Model data browser";
  const whole = zlib.inflateSync(Buffer.from(backendBootstrapPayload(realPath), "base64")).toString("utf8");
  const feature = zlib.inflateSync(Buffer.from(backendFeaturePayload(realPath), "base64")).toString("utf8");
  const core = whole.slice(0, whole.indexOf(marker));

  // Whole (local env/disk delivery) has everything; the feature half carries the browser defs but not start().
  assert.ok(whole.includes(marker) && whole.includes("def _browse_models") && whole.includes("def start(namespace"));
  assert.ok(feature.startsWith(marker) && feature.includes("def _browse_models"));
  assert.ok(!feature.includes("def start(namespace"), "start() stays in the core half");
  // Core keeps the loader + dispatch guard (and the still-loading degrade helper) but not the browser definitions.
  assert.ok(core.includes("def start(namespace") && core.includes("def _load_feature") && core.includes("_BROWSE_REQUEST_KINDS"));
  assert.ok(core.includes("def _browse_models_or_loading("), "the capture-hook degrade guard stays in the typed core");
  assert.ok(!core.includes("def _browse_models("), "browser definitions are deferred out of the typed core");

  // The inline command's embedded payload reconstructs to exactly the core half (no browser defs typed on remote).
  const command = buildInlineBackendBootstrapCommand(realPath, "tok").command;
  const chunks = [...command.matchAll(/\.append\("([^"]*)"\)/g)].map((match) => match[1]);
  const inlineSource = zlib.inflateSync(Buffer.from(chunks.join(""), "base64")).toString("utf8");
  assert.equal(inlineSource, core);
  assert.ok(Buffer.from(backendFeaturePayload(realPath), "base64").length < Buffer.from(backendBootstrapPayload(realPath), "base64").length);

  // Typed fallback stages chunks under the shared parts key and finishes with the caller's `_djs_rpc` loadfeature line,
  // whose id-correlated marker resolves the paced request (append-cell markers are ignored by the id map).
  const rpcTail = `_djs_rpc("{\\"kind\\":\\"loadfeature\\"}", "feature-1")\r`;
  const fallback = buildFeatureLoadPtyCommand(realPath, rpcTail);
  assert.ok(fallback.includes(`globals()["${BACKEND_FEATURE_PARTS_KEY}"]=[]`));
  const featureChunks = [...fallback.matchAll(/\.append\("([^"]*)"\)/g)].map((match) => match[1]);
  assert.equal(zlib.inflateSync(Buffer.from(featureChunks.join(""), "base64")).toString("utf8"), feature);
  assert.ok(fallback.trimEnd().endsWith(rpcTail.trimEnd()), "the rpc tail is the final typed line");
});

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
  assert.match(bootstrap.command, /^globals\(\)\["/);
  assert.match(bootstrap.command, /remote-token/);
  assert.match(bootstrap.command, /\r$/);
  // Must not depend on the spawn env payload or the local on-disk path, which a remote shell cannot reach.
  assert.doesNotMatch(bootstrap.command, /DJANGO_SHELL_BACKEND_B64/);
  assert.ok(!bootstrap.command.includes(runtimePath), "inline bootstrap must not reference the local runtime path");
  // The streamed blob must decompress back to the exact backend source.
  const lines = bootstrap.command.trimEnd().split("\r");
  const payload = lines
    .slice(1, -1)
    .map((line) => {
      const match = line.match(/^globals\(\)\.setdefault\("[^"]+",\[\]\)\.append\("([A-Za-z0-9+/=]+)"\)$/);
      assert.ok(match, `inline chunk must be a standalone Python append statement: ${line}`);
      return match[1];
    })
    .join("");
  assert.match(lines[0], /^globals\(\)\["/);
  assert.match(lines.at(-1), /^exec\(/);
  assert.doesNotMatch(bootstrap.command, /\binput\(/);
  assert.ok(lines.every((line) => line.length < 1200), "inline bootstrap must avoid one giant terminal input line");
  assert.equal(zlib.inflateSync(Buffer.from(payload, "base64")).toString("utf8"), source);
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

test("parses progress markers independently from normal terminal output", () => {
  const first = `${BACKEND_PROGRESS_PREFIX}${JSON.stringify({ active: true, current: 3, total: 10 })}\r\n`;
  const second = `${BACKEND_PROGRESS_PREFIX}${JSON.stringify({ active: false, done: true, ok: true })}\n`;
  const partial = `${BACKEND_PROGRESS_PREFIX}{"active":true`;

  const parsed = parseBackendProgressMarkers(`noise\n${first}>>> ${second}${partial}`);

  assert.equal(parsed.markers.length, 2);
  assert.deepEqual(parsed.markers.map((marker) => marker.active), [true, false]);
  assert.equal(parsed.markers[0].current, 3);
  assert.equal(parsed.rest, partial);
});

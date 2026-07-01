// Unit tests for bundled debugpy packaging used by remote debugger attach.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildDebugpyBundleInstallCommand,
  createDebugpyBundlePayload,
  parseDebugpyBundleInstallResult
} = require("../out/debugpyBundle.js");

test("packages portable debugpy files without native extension binaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-debugpy-libs-"));
  fs.mkdirSync(path.join(root, "debugpy", "server"), { recursive: true });
  fs.mkdirSync(path.join(root, "debugpy", "_vendored"), { recursive: true });
  fs.mkdirSync(path.join(root, "packaging"), { recursive: true });
  fs.writeFileSync(path.join(root, "debugpy", "__init__.py"), "__version__ = 'x'\n");
  fs.writeFileSync(path.join(root, "debugpy", "server", "api.py"), "def listen(): pass\n");
  fs.writeFileSync(path.join(root, "debugpy", "_vendored", "native.so"), "binary");
  fs.writeFileSync(path.join(root, "packaging", "__init__.py"), "");
  fs.writeFileSync(path.join(root, "debugpy", "py.typed"), "");

  const payload = createDebugpyBundlePayload([path.join(root, "missing"), root]);
  assert.ok(payload);
  const files = JSON.parse(zlib.inflateSync(Buffer.from(payload.data, "base64")).toString("utf8"));
  const names = files.map((file) => file[0]);

  assert.equal(payload.fileCount, 4);
  assert.ok(payload.digest.length >= 16);
  assert.ok(names.includes("debugpy/__init__.py"));
  assert.ok(names.includes("debugpy/server/api.py"));
  assert.ok(names.includes("debugpy/py.typed"));
  assert.ok(names.includes("packaging/__init__.py"));
  assert.ok(!names.includes("debugpy/_vendored/native.so"));
});

test("builds a chunked remote debugpy installer command", () => {
  const payload = { data: "a".repeat(2500), digest: "0123456789abcdef0123456789abcdef", fileCount: 2 };
  const command = buildDebugpyBundleInstallCommand(payload, "debugpy-request-1", "__RESPONSE__");
  const lines = command.command.trimEnd().split("\r");

  assert.equal(command.chunks, 3);
  assert.match(lines[0], /^globals\(\)\["/);
  assert.match(lines.at(-1), /^exec\(/);
  assert.ok(lines.every((line) => line.length < 1200), "installer must avoid giant terminal input lines");
  assert.match(command.command, /__RESPONSE__/);
  assert.match(command.command, /debugpy-request-1/);
});

test("parses remote debugpy installer responses", () => {
  assert.deepEqual(parseDebugpyBundleInstallResult('{"ok":true,"path":"/tmp/debugpy"}\n'), { ok: true, path: "/tmp/debugpy" });
  assert.deepEqual(parseDebugpyBundleInstallResult('{"ok":false,"error":"boom"}\n'), { error: "boom", ok: false });
});

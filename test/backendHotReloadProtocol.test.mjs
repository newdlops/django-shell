// Defensive parsing tests for the built-in hot-reload wire contract.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseHotReloadResponse } = require("../out/backendHotReloadProtocol.js");

test("rejects a response from the wrong engine", () => {
  assert.throws(() => parseHotReloadResponse('{"engine":"debugpy","ok":true,"results":[]}\n'), /response engine/i);
});

test("discards malformed rows and preserves structured partial results", () => {
  const parsed = parseHotReloadResponse(`${JSON.stringify({ engine: "experimental", ok: false, results: [null, 7, { message: "closure changed", module: "app.views", patched: ["kept", 3], path: "/app/views.py", status: "partial" }] })}\n`);
  assert.deepEqual(parsed, {
    engine: "experimental",
    error: undefined,
    ok: false,
    results: [{ message: "closure changed", module: "app.views", patched: ["kept"], path: "/app/views.py", status: "partial" }]
  });
});

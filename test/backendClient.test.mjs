// Unit tests for backend client transport error handling.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { BackendClient } = require("../out/backendClient.js");

test("preserves debugpy transport errors in execution results", async () => {
  const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "t" });
  client.setTransportMode("pty");

  const result = await client.debugpy("print('debugpy')");

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Terminal transport is unavailable/);
});

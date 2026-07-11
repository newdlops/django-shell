// Unit tests for engine-specific direct DAP initialize and attach arguments.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildDirectDebugAdapterAttachArguments, buildDirectDebugAdapterInitializeArguments } = require("../out/directDebugAdapterSession.js");

test("retains debugpy attach behavior by default", () => {
  const initialize = buildDirectDebugAdapterInitializeArguments({});
  const attach = buildDirectDebugAdapterAttachArguments({ cwd: "/workspace", pathMappings: [{ localRoot: "/workspace", remoteRoot: "/app" }] });
  assert.equal(initialize.adapterID, "python");
  assert.equal(attach.type, "python");
  assert.equal(attach.django, true);
  assert.equal(attach.justMyCode, false);
  assert.ok(Array.isArray(attach.rules));
  assert.equal(attach.showReturnValue, true);
  assert.equal(attach.cwd, "/workspace");
  assert.deepEqual(attach.pathMappings, [{ localRoot: "/workspace", remoteRoot: "/app" }]);
});

test("uses the native adapter identity without debugpy-only attach options", () => {
  const initialize = buildDirectDebugAdapterInitializeArguments({ engine: "experimental" });
  const attach = buildDirectDebugAdapterAttachArguments({ cwd: "/workspace", engine: "experimental", name: "Native Django Shell" });
  assert.equal(initialize.adapterID, "django-shell-native");
  assert.deepEqual(attach, { cwd: "/workspace", name: "Native Django Shell", request: "attach" });
  for (const key of ["django", "justMyCode", "rules", "showReturnValue", "steppingResumesAllThreads", "subProcess", "type"]) {
    assert.equal(key in attach, false, `${key} must not leak into the native tracer attach request`);
  }
});

// Regression tests for a debug click made while the Django shell backend is attaching.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const NodeModule = require("node:module");
const originalLoad = NodeModule._load;
const information = [];
const warnings = [];
let DeferredDebugStart;

try {
  NodeModule._load = function loadWithVscodeMock(request, parent, isMain) {
    return request === "vscode" ? { window: { showInformationMessage: (message) => { information.push(message); }, showWarningMessage: (message) => { warnings.push(message); } } } : originalLoad.call(this, request, parent, isMain);
  };
  ({ DeferredDebugStart } = require("../out/deferredDebugStart.js"));
} finally {
  NodeModule._load = originalLoad;
}

test("replays one coalesced debug request only after READY", async () => {
  information.length = 0;
  let generation = 4;
  let ready = false;
  let runs = 0;
  const gate = new DeferredDebugStart({ current: (candidate) => ready && candidate === generation, generation: () => generation, onCancelled() {}, async run() { runs += 1; } });

  gate.request();
  gate.request();
  gate.drain();
  await settle();
  assert.equal(runs, 0, "attaching debug cannot cross the readiness gate");

  ready = true;
  gate.drain();
  await settle();
  assert.equal(runs, 1);
  assert.equal(information.length, 1, "repeated clicks produce one request and one feedback message");
});

test("cancels queued debug when the attaching backend fails", () => {
  warnings.length = 0;
  const cancelled = [];
  const gate = new DeferredDebugStart({ current: () => false, generation: () => 1, onCancelled: (reason) => cancelled.push(reason), async run() {} });
  gate.request();

  gate.cancel("failed", true);

  assert.deepEqual(cancelled, ["failed"]);
  assert.match(warnings[0], /debugging was cancelled/);
});

/** Lets resolved async replay callbacks and their finalizer complete. */
function settle() { return new Promise((resolve) => setImmediate(resolve)); }

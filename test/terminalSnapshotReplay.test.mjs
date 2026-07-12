// Unit tests for lossless setup-terminal snapshot and live-data ordering.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { applyTerminalSnapshot, consumeTerminalData, createTerminalReplayState } = require("../out/terminalSnapshotReplay.js");

test("replays output produced before the panel exactly once when live data wins the race", () => {
  const state = createTerminalReplayState();
  assert.deepEqual(applyTerminalSnapshot(state, { state: "starting", text: "" }), { clear: true, write: "" });
  assert.deepEqual(consumeTerminalData(state, "B"), { clear: false, write: "" });
  assert.deepEqual(applyTerminalSnapshot(state, { state: "starting", text: "AB" }), { clear: false, write: "AB" });
  assert.deepEqual(consumeTerminalData(state, "C"), { clear: false, write: "C" });
});

test("appends buffered live data when an older snapshot does not contain it", () => {
  const state = createTerminalReplayState();
  consumeTerminalData(state, "B");
  assert.deepEqual(applyTerminalSnapshot(state, { state: "starting", text: "A" }), { clear: false, write: "AB" });
});

test("deduplicates the longest partial overlap between snapshot and buffered output", () => {
  const state = createTerminalReplayState();
  consumeTerminalData(state, "BC");
  assert.deepEqual(applyTerminalSnapshot(state, { state: "starting", text: "AB" }), { clear: false, write: "ABC" });
});

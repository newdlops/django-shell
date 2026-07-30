// Deterministic performance and lifecycle tests for the overlay geometry scheduler.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { OverlayGeometryScheduler, geometryKey } = require("../out/overlayGeometryScheduler.js");

/** Resolves queued microtasks after one scheduler transition. */
function settle() { return new Promise((resolve) => setImmediate(resolve)); }

test("geometry scheduler dispatches leading and newest trailing rectangles only", async () => {
  const calls = [];
  let release;
  const scheduler = new OverlayGeometryScheduler(async (geometry) => { calls.push(geometry.left); await new Promise((resolve) => { release = resolve; }); }, () => true);
  scheduler.update({ height: 10, left: 1, top: 2, width: 3 });
  scheduler.update({ height: 10, left: 2, top: 2, width: 3 });
  scheduler.update({ height: 10, left: 3, top: 2, width: 3 });
  assert.deepEqual(calls, [1]);
  release(); await settle();
  assert.deepEqual(calls, [1, 3]);
  scheduler.dispose();
});

test("geometry scheduler suppresses duplicate keys and parks cleanly", async () => {
  const calls = [];
  const scheduler = new OverlayGeometryScheduler(async (geometry) => { calls.push(geometryKey(geometry)); }, () => true);
  const geometry = { height: 10, left: 1.2, top: 2, width: 3 };
  scheduler.update(geometry); await settle();
  scheduler.update({ ...geometry, left: 1.49 }); await settle();
  scheduler.pause(); scheduler.update({ ...geometry, left: 8 }); await settle();
  assert.deepEqual(calls, ["1:2:3:10"]);
  scheduler.dispose();
});

test("geometry scheduler retries once after cooldown and lets newer geometry win", async () => {
  const calls = [];
  let attempts = 0;
  const scheduler = new OverlayGeometryScheduler(async (geometry) => {
    calls.push(geometry.left);
    attempts += 1;
    if (attempts === 1) { throw new Error("transient"); }
  }, () => true);
  scheduler.update({ height: 10, left: 1, top: 2, width: 3 });
  await settle();
  assert.deepEqual(calls, [1], "failure must not immediately retry");
  await new Promise((resolve) => setTimeout(resolve, 425));
  assert.deepEqual(calls, [1, 1], "one cooldown retry is allowed");
  scheduler.dispose();

  const newestCalls = [];
  const newest = new OverlayGeometryScheduler(async (geometry) => {
    newestCalls.push(geometry.left);
    if (geometry.left === 1) { throw new Error("transient"); }
  }, () => true);
  newest.update({ height: 10, left: 1, top: 2, width: 3 });
  await settle();
  newest.update({ height: 10, left: 9, top: 2, width: 3 });
  await settle(); await new Promise((resolve) => setTimeout(resolve, 425));
  assert.deepEqual(newestCalls, [1, 9], "a newer rectangle cancels an armed stale retry");
  newest.dispose();
});

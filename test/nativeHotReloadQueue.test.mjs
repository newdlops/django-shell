// Behavioral tests for hot-reload debounce, execution gating, chunking, and disposal.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { NativeHotReloadQueue } = require("../out/nativeHotReloadQueue.js");

test("sorts, deduplicates, and chunks bulk saves without exceeding the backend limit", async () => {
  const calls = [];
  let observed;
  const backend = { hotReload: async (paths) => {
    calls.push(paths);
    return { engine: "experimental", ok: true, results: paths.map((path) => ({ message: "ok", patched: [], path, status: "ok" })) };
  } };
  const queue = new NativeHotReloadQueue(backend, { debounceMs: 2, maxBatchSize: 2, onResult: (result) => { observed = result; } });
  for (const path of ["/z.py", "/b.py", "/a.py", "/d.py", "/c.py", "/a.py"]) { queue.enqueue(path); }

  await waitFor(() => observed);
  assert.deepEqual(calls, [["/a.py", "/b.py"], ["/c.py", "/d.py"], ["/z.py"]]);
  assert.equal(observed.results.length, 5);
  queue.dispose();
});

test("defers changes while user code runs and flushes them when execution becomes safe", async () => {
  let safe = false;
  const calls = [];
  const queue = new NativeHotReloadQueue({ hotReload: async (paths) => {
    calls.push(paths);
    return { engine: "experimental", ok: true, results: [] };
  } }, { canFlush: () => safe, debounceMs: 2, retryDelayMs: 3 });
  queue.enqueue("/held.py");

  await delay(15);
  assert.deepEqual(calls, []);
  safe = true;
  await waitFor(() => calls.length === 1);
  assert.deepEqual(calls, [["/held.py"]]);
  queue.dispose();
});

test("serializes a change that arrives during an in-flight reload", async () => {
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  const calls = [];
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const queue = new NativeHotReloadQueue({ hotReload: async (paths) => {
    calls.push(paths);
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (calls.length === 1) { await firstGate; }
    active -= 1;
    return { engine: "experimental", ok: true, results: [] };
  } }, { debounceMs: 2 });
  queue.enqueue("/first.py");
  await waitFor(() => calls.length === 1);
  queue.enqueue("/second.py");
  await delay(10);
  assert.equal(calls.length, 1);
  releaseFirst();
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls, [["/first.py"], ["/second.py"]]);
  assert.equal(maxActive, 1);
  queue.dispose();
});

test("dispose drops pending paths and suppresses in-flight result callbacks", async () => {
  let release;
  let results = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = new NativeHotReloadQueue({ hotReload: async () => {
    await gate;
    return { engine: "experimental", ok: true, results: [] };
  } }, { debounceMs: 2, onResult: () => { results += 1; } });
  queue.enqueue("/pending.py");
  await delay(5);
  queue.dispose();
  release();
  await delay(5);
  assert.equal(results, 0);
});

test("retries a busy chunk with untouched paths while reporting earlier successes exactly once", async () => {
  const calls = [];
  const reports = [];
  let busy = true;
  const queue = new NativeHotReloadQueue({ hotReload: async (paths) => {
    calls.push(paths);
    if (paths[0] === "/b.py" && busy) {
      busy = false;
      return { engine: "experimental", error: "busy", ok: false, retryable: true, results: [] };
    }
    return { engine: "experimental", ok: true, retryable: false, results: paths.map((path) => ({ message: "ok", patched: [], path, status: "ok" })) };
  } }, { debounceMs: 2, maxBatchSize: 1, onResult: (result, paths) => reports.push({ paths, result }), retryDelayMs: 3 });
  for (const path of ["/c.py", "/a.py", "/b.py"]) { queue.enqueue(path); }

  await waitFor(() => reports.length === 2);
  assert.deepEqual(calls, [["/a.py"], ["/b.py"], ["/b.py"], ["/c.py"]]);
  assert.deepEqual(reports.map((report) => report.paths), [["/a.py"], ["/b.py", "/c.py"]]);
  assert.deepEqual(reports.flatMap((report) => report.result.results.map((row) => row.path)), ["/a.py", "/b.py", "/c.py"]);
  assert.equal(reports.some((report) => report.result.error === "busy"), false);
  queue.dispose();
});

test("serializes repeated busy retries without reporting transient failures", async () => {
  let active = 0;
  let attempts = 0;
  let maxActive = 0;
  const calls = [];
  const reports = [];
  const queue = new NativeHotReloadQueue({ hotReload: async (paths) => {
    calls.push(paths);
    attempts += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(3);
    active -= 1;
    if (attempts < 3) { return { engine: "experimental", error: "busy", ok: false, retryable: true, results: [] }; }
    return { engine: "experimental", ok: true, retryable: false, results: [{ message: "ok", patched: [], path: paths[0], status: "ok" }] };
  } }, { debounceMs: 2, onResult: (result) => reports.push(result), retryDelayMs: 2 });
  queue.enqueue("/busy.py");

  await waitFor(() => reports.length === 1);
  assert.deepEqual(calls, [["/busy.py"], ["/busy.py"], ["/busy.py"]]);
  assert.equal(maxActive, 1);
  assert.equal(reports[0].ok, true);
  assert.equal(reports[0].retryable, false);
  queue.dispose();
});

test("recovers after one non-retryable timeout result and flushes the next enqueue", async () => {
  const calls = [];
  const reports = [];
  const reloading = [];
  const queue = new NativeHotReloadQueue({ hotReload: async (paths) => {
    calls.push(paths);
    if (calls.length === 1) { return { engine: "experimental", error: "socket timed out", ok: false, retryable: false, results: [] }; }
    return { engine: "experimental", ok: true, retryable: false, results: [{ message: "ok", patched: [], path: paths[0], status: "ok" }] };
  } }, { debounceMs: 2, onReloading: (active) => reloading.push(active), onResult: (result) => reports.push(result) });
  queue.enqueue("/timeout.py");
  await waitFor(() => reports.length === 1 && reloading.length === 2);

  queue.enqueue("/recovered.py");
  await waitFor(() => reports.length === 2 && reloading.length === 4);
  assert.deepEqual(calls, [["/timeout.py"], ["/recovered.py"]]);
  assert.deepEqual(reports.map((result) => [result.ok, result.error]), [[false, "socket timed out"], [true, undefined]]);
  assert.deepEqual(reloading, [true, false, true, false]);
  queue.dispose();
});

/** Waits for an asynchronous condition with a short bounded timeout. */
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) { throw new Error("Timed out waiting for hot-reload queue state."); }
    await delay(2);
  }
}

/** Delays one event-loop turn range for deterministic debounce tests. */
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

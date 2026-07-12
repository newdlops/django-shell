// Unit tests for completion-first analysis scheduling around state-mutation barriers.

import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PriorityBarrierQueue } = require("../out/priorityBarrierQueue.js");

test("runs completion work before queued background analysis", async () => {
  const queue = new PriorityBarrierQueue();
  const order = [];

  const background = queue.enqueue(0, async () => { order.push("background"); });
  const completion = queue.enqueue(2, async () => { order.push("completion"); });

  await Promise.all([background, completion]);
  assert.deepEqual(order, ["completion", "background"]);
});

test("promotes completion after the active lease releases", async () => {
  const queue = new PriorityBarrierQueue();
  const started = deferred();
  const release = deferred();
  const order = [];

  const active = queue.enqueue(1, async () => {
    order.push("active");
    started.resolve();
    await release.promise;
  });
  await started.promise;
  const background = queue.enqueue(0, async () => { order.push("background"); });
  const completion = queue.enqueue(2, async () => { order.push("completion"); });
  release.resolve();

  await Promise.all([active, background, completion]);
  assert.deepEqual(order, ["active", "completion", "background"]);
});

test("never promotes analysis across a queued mutation barrier", async () => {
  const queue = new PriorityBarrierQueue();
  const started = deferred();
  const release = deferred();
  const order = [];

  const active = queue.enqueue(1, async () => {
    order.push("active");
    started.resolve();
    await release.promise;
  });
  await started.promise;
  const before = queue.enqueue(0, async () => { order.push("background-before"); });
  const mutation = queue.enqueueBarrier(async () => { order.push("mutation"); });
  const after = queue.enqueue(2, async () => { order.push("completion-after"); });
  release.resolve();

  await Promise.all([active, before, mutation, after]);
  assert.deepEqual(order, ["active", "background-before", "mutation", "completion-after"]);
});

test("continues draining after one queued action fails", async () => {
  const queue = new PriorityBarrierQueue();
  const order = [];
  const failed = queue.enqueue(2, async () => { order.push("failed"); throw new Error("expected"); });
  const next = queue.enqueue(1, async () => { order.push("next"); return 42; });

  await assert.rejects(failed, /expected/);
  assert.equal(await next, 42);
  assert.deepEqual(order, ["failed", "next"]);
});

/** Creates a manually resolved promise for deterministic queue ordering. */
function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

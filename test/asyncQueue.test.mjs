// Unit tests for keyed asynchronous queue priority and failure behavior.

import assert from "node:assert/strict";
import test from "node:test";

import { SerializedAsyncQueue } from "../out/asyncQueue.js";

test("high-priority user execution passes queued background metadata", async () => {
  const queue = new SerializedAsyncQueue();
  const blocker = deferred();
  const order = [];
  const active = queue.run("backend", async () => { order.push("active"); await blocker.promise; });
  const metadata = queue.run("backend", async () => { order.push("metadata"); });
  const execute = queue.run("backend", async () => { order.push("execute"); }, "high");

  await Promise.resolve();
  assert.deepEqual(order, ["active"]);
  blocker.resolve();
  await Promise.all([active, metadata, execute]);
  assert.deepEqual(order, ["active", "execute", "metadata"]);
});

test("a rejected task releases its key while unrelated keys run independently", async () => {
  const queue = new SerializedAsyncQueue();
  const order = [];
  const failure = queue.run("backend", async () => { order.push("failure"); throw new Error("expected"); });
  const recovery = queue.run("backend", async () => { order.push("recovery"); return 2; });
  const parallel = queue.run("other", async () => { order.push("parallel"); return 3; });

  await assert.rejects(failure, /expected/);
  assert.deepEqual(await Promise.all([recovery, parallel]), [2, 3]);
  assert.ok(order.indexOf("recovery") > order.indexOf("failure"));
});

/** Creates a manually settled promise for deterministic queue tests. */
function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

// Verifies custom ORM query timeout, interrupt, and late-result lifecycle handling.

import assert from "node:assert/strict";
import test from "node:test";

import { ModelQueryRunController } from "../out/modelQueryRunController.js";

test("settles immediate success and backend failure without leaving an active query", async () => {
  const success = controller();
  assert.deepEqual(await success.controller.run(async () => 42), { kind: "succeeded", value: 42 });
  assert.equal(success.controller.active, false);
  assert.deepEqual(success.states.map((snapshot) => snapshot.state), ["running", "succeeded"]);

  const failureTimers = fakeTimers();
  const failure = controller({ timers: failureTimers });
  assert.deepEqual(await failure.controller.run(async () => { throw new Error("database unavailable"); }), { error: "database unavailable", kind: "failed" });
  assert.equal(failure.controller.active, false);
  assert.deepEqual(failure.states.map((snapshot) => snapshot.state), ["running", "failed"]);
  assert.equal(failureTimers.count(), 0);
});

test("marks a long query slow after eight seconds before it completes", async () => {
  const timers = fakeTimers();
  const run = controller({ timers });
  const pending = deferred();
  const outcome = run.controller.run(() => pending.promise);

  timers.advance(8000);
  assert.equal(run.controller.snapshot.state, "slow");
  pending.resolve("done");

  assert.deepEqual(await outcome, { kind: "succeeded", value: "done" });
  assert.deepEqual(run.states.map((snapshot) => snapshot.state), ["running", "slow", "succeeded"]);
  assert.equal(timers.count(), 0);
});

test("times out after the configured limit, interrupts once, and ignores a late success", async () => {
  const timers = fakeTimers();
  const interrupts = [];
  const run = controller({ interrupts, timers, timeoutMs: () => 30000 });
  const pending = deferred();
  const outcome = run.controller.run(() => pending.promise);

  timers.advance(30000);
  assert.deepEqual(await outcome, { interruptConfirmed: undefined, kind: "timedOut" });
  assert.deepEqual(interrupts, ["modelQuery.timeout"]);
  assert.equal(run.controller.snapshot.timeoutMs, 30000);
  pending.resolve("late rows");
  await Promise.resolve();

  assert.equal(run.controller.snapshot.state, "timedOut");
  assert.equal(run.states.some((snapshot) => snapshot.state === "succeeded"), false);
  assert.equal(timers.count(), 0);
});

test("manual cancellation reports successful and failed interrupt acknowledgements", async () => {
  const successful = controller();
  const successfulPending = deferred();
  const successfulOutcome = successful.controller.run(() => successfulPending.promise);
  await successful.controller.cancel("modelQuery.cancel");
  assert.deepEqual(await successfulOutcome, { interruptConfirmed: true, kind: "cancelled" });
  assert.deepEqual(successful.interrupts, ["modelQuery.cancel"]);
  assert.equal(successful.controller.active, false);

  const failed = controller({ interruptResult: { error: "socket unavailable", interrupted: false, ok: false } });
  const failedPending = deferred();
  const failedOutcome = failed.controller.run(() => failedPending.promise);
  await failed.controller.cancel("modelQuery.cancel");
  assert.deepEqual(await failedOutcome, { error: "socket unavailable", interruptConfirmed: false, kind: "cancelled" });
  assert.equal(failed.controller.snapshot.error, "socket unavailable");
});

test("does not execute a second query while one is active", async () => {
  const run = controller();
  const pending = deferred();
  let calls = 0;
  const first = run.controller.run(async () => { calls += 1; return pending.promise; });
  const second = await run.controller.run(async () => { calls += 1; return "second"; });

  await Promise.resolve();
  assert.equal(calls, 1);
  assert.deepEqual(second, { kind: "busy" });
  pending.resolve("first");
  assert.deepEqual(await first, { kind: "succeeded", value: "first" });
});

test("dispose requests an interrupt and timeoutMs zero does not arm an automatic timeout", async () => {
  const timers = fakeTimers();
  const disposed = controller({ timers });
  const disposePending = deferred();
  const disposeOutcome = disposed.controller.run(() => disposePending.promise);
  disposed.controller.dispose();
  await Promise.resolve();
  assert.deepEqual(disposed.interrupts, ["modelQuery.dispose"]);
  assert.deepEqual(await disposeOutcome, { interruptConfirmed: true, kind: "cancelled" });
  assert.equal(timers.count(), 0);

  const noTimeoutTimers = fakeTimers();
  const noTimeout = controller({ timers: noTimeoutTimers, timeoutMs: () => 0 });
  const pending = deferred();
  const outcome = noTimeout.controller.run(() => pending.promise);
  noTimeoutTimers.advance(60000);
  assert.equal(noTimeout.controller.active, true);
  assert.deepEqual(noTimeout.interrupts, []);
  pending.resolve("still allowed");
  assert.deepEqual(await outcome, { kind: "succeeded", value: "still allowed" });
  assert.equal(noTimeoutTimers.count(), 0);
});

/** Builds a controller with a deterministic interrupt result and optional virtual timers. */
function controller({ interruptResult = { interrupted: true, ok: true }, interrupts = [], timeoutMs = () => 30000, timers } = {}) {
  const states = [];
  const options = {
    interrupt: async (reason) => {
      interrupts.push(reason);
      return interruptResult;
    },
    onChange: (snapshot) => states.push(snapshot),
    timeoutMs
  };
  if (timers) {
    options.now = timers.now;
    options.setTimer = timers.setTimer;
    options.clearTimer = timers.clearTimer;
  }
  return { controller: new ModelQueryRunController(options), interrupts, states };
}

/** Creates a promise whose resolution is controlled directly by the test. */
function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

/** Provides deterministic timers so timeout and cleanup paths are tested without wall-clock waits. */
function fakeTimers() {
  let now = 0;
  let nextId = 0;
  const pending = new Map();
  return {
    clearTimer(id) { pending.delete(id); },
    count() { return pending.size; },
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...pending.entries()].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) { break; }
        const [id, timer] = next;
        pending.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = target;
    },
    now: () => now,
    setTimer(callback, milliseconds) {
      const id = ++nextId;
      pending.set(id, { at: now + milliseconds, callback });
      return id;
    }
  };
}

// Ensures an interrupt without an acknowledgement cannot hold the ORM query controller indefinitely.

import assert from "node:assert/strict";
import test from "node:test";
import { ModelQueryRunController } from "../out/modelQueryRunController.js";
import { deferred, fakeClock, flush } from "./stabilityHostHarness.mjs";

test("Cancel retires an unacknowledged interrupt and ignores late query/interrupt results", async () => {
  const clock = fakeClock(), interruption = deferred(), execution = deferred();
  const controller = new ModelQueryRunController({ interrupt: () => interruption.promise, onChange() {}, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, timeoutMs: () => 1000 });
  const first = controller.run(() => execution.promise);
  const cancel = controller.cancel("modelQuery.cancel");
  execution.resolve("old rows"); await flush();
  clock.advance(5999); assert.equal(controller.snapshot.state, "cancelling");
  clock.advance(1); await cancel;
  const outcome = await first;
  assert.equal(outcome.kind, "cancelled"); assert.equal(outcome.interruptConfirmed, false);
  assert.match(outcome.error, /may still be running/); assert.equal(clock.count(), 0);
  assert.deepEqual(await controller.run(async () => "new rows"), { kind: "succeeded", value: "new rows" });
  interruption.resolve({ ok: true, interrupted: true }); await flush();
  assert.equal(controller.snapshot.requestId, 2); assert.equal(controller.snapshot.state, "succeeded");
  controller.dispose();
});

test("Cancel before the submission microtask prevents execution entirely", async () => {
  let executions = 0;
  const interrupted = [];
  const controller = new ModelQueryRunController({ interrupt: async (reason, requestId) => { interrupted.push([reason, requestId]); return { ok: true, interrupted: true }; }, onChange() {}, timeoutMs: () => 0 });
  const run = controller.run(async () => { executions += 1; return "must not execute"; });
  await controller.cancel("modelQuery.cancel"); await run;
  assert.equal(executions, 0); assert.deepEqual(interrupted, [["modelQuery.cancel", 1]]); controller.dispose();
});

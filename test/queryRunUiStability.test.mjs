// Checks repeated query lifecycle notifications and truthful cancellation recovery in the rendered controls contract.
import assert from "node:assert/strict";
import test from "node:test";
import { createQueryRunUi } from "../media/queryRunUi.js";
import { domFixture } from "./stabilityDomHarness.mjs";

/** Installs the bounded document controls used by query lifecycle rendering. */
function fixture(t) {
  const dom = domFixture(), previous = globalThis.document;
  const nodes = Object.fromEntries(["runQuery", "interruptQuery", "openQueryConsole", "transport", "reload", "more", "status"].map((id) => [id, dom.el("button", { disabled: id === "more" })]));
  globalThis.document = { getElementById: (id) => nodes[id], querySelector: () => null };
  const ui = createQueryRunUi({ post() {}, status: nodes.status });
  t.after(() => { ui.render({ state: "idle" }); globalThis.document = previous; });
  return { nodes, ui };
}

test("running, duplicate started, slow, and cancelling notifications preserve the original enabled state", (t) => {
  const { nodes, ui } = fixture(t);
  for (const state of ["running", "running", "slow", "cancelling"]) {
    ui.render({ startedAt: Date.now(), state }); assert.equal(nodes.reload.disabled, true); assert.equal(nodes.transport.disabled, true);
  }
  ui.render({ state: "succeeded" });
  assert.equal(nodes.reload.disabled, false); assert.equal(nodes.transport.disabled, false); assert.equal(nodes.more.disabled, true);
  assert.equal(nodes.more.dataset.queryRunDisabled, undefined);
});

test("timeout shows interruption only when acknowledged and offers recovery after an unconfirmed cancel", (t) => {
  const { nodes, ui } = fixture(t);
  ui.render({ state: "timedOut", timeoutMs: 30000 }); assert.match(nodes.status.textContent, /timed out/); assert.doesNotMatch(nodes.status.textContent, /Query interrupted/);
  ui.render({ error: "Cancellation requested; execution has not yet stopped.", interruptConfirmed: false, state: "timedOut", timeoutMs: 30000 });
  assert.match(nodes.status.textContent, /not yet stopped/); assert.equal(nodes.openQueryConsole.hidden, false);
  ui.render({ interruptConfirmed: true, state: "timedOut", timeoutMs: 30000 }); assert.match(nodes.status.textContent, /Query interrupted/);
});

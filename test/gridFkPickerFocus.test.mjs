// Verifies foreign-key searches survive window focus changes without staging search text as a relation key.
import assert from "node:assert/strict";
import test from "node:test";
import { openFkPicker } from "../media/gridFkPicker.js";
import { domFixture } from "./stabilityDomHarness.mjs";

/** Opens the production picker with controllable document focus and observable edits. */
function fixture(t) {
  const dom = domFixture(), original = globalThis.document;
  globalThis.document = dom.document;
  let focused = true, sequence = 0;
  dom.document.hasFocus = () => focused;
  const staged = [], requests = [], cell = dom.el("td");
  const picker = openFkPicker(cell, { attname: "company_id", relation: { target: "fixture.Company" } }, "1", {
    allocId: () => ++sequence, post: (request) => requests.push(request), stage: (value) => staged.push(value), done() {}
  });
  t.after(() => { picker.cancel(); globalThis.document = original; });
  return { ...dom, cell, input: cell.querySelector("input"), picker, requests, staged, setFocused: (value) => { focused = value; } };
}

test("losing webview focus preserves the search and accepts a later exact candidate", async (t) => {
  const f = fixture(t);
  f.input.value = "Beta";
  f.setFocused(false); f.document.activeElement = undefined; f.input.dispatch("blur");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(f.staged, [], "application focus changes must not stage the search label as a key");
  f.picker.fill({ requestId: f.requests.at(-1).requestId, result: { ok: true, rows: [{ pk: 2, value: "001", label: "#2 · Beta" }] } });
  assert.match(f.cell.textContent, /#2 · Beta/);
  f.setFocused(true); f.input.focus(); f.input.dispatch("keydown", { key: "Enter" });
  assert.deepEqual(f.staged, ["001"]);
});

test("moving to another control in the same webview still stages direct key input", async (t) => {
  const f = fixture(t);
  f.input.value = "007"; f.document.activeElement = f.el("button"); f.input.dispatch("blur");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(f.staged, ["007"]);
});

test("a stale blur callback cannot close a picker that regained focus", async (t) => {
  const f = fixture(t);
  f.input.value = "Beta"; f.input.dispatch("blur"); f.input.focus();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(f.staged, []);
});

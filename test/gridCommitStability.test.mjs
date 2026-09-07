// Covers save snapshots, related editor isolation, failure recovery, and offset-preserving cell edits.

import assert from "node:assert/strict";
import test from "node:test";
import { createEditor } from "../media/gridEdit.js";
import { buildEditableRelatedTable } from "../media/gridRelated.js";
import { temporalEditorValue, temporalStoredValue } from "../media/gridTemporalEdit.js";
import { domFixture } from "./stabilityDomHarness.mjs";

/** Creates a main-table editor with observable changes and real scalar edit handlers. */
function fixture(t) {
  const dom = domFixture(), original = globalThis.document;
  globalThis.document = dom.document; t.after(() => { globalThis.document = original; });
  const messages = [], notices = [], row = dom.el("tr", { dataset: { pk: "1" }, _pk: 1 });
  let reloads = 0, ended = 0;
  const editor = createEditor({ post: (message) => messages.push(structuredClone(message)), paintCell: (td) => { td.textContent = td.dataset.staged ?? td._editval; }, onChange() {}, onCommitEnd: () => { ended += 1; }, reload: () => { reloads += 1; }, notify: (text) => notices.push(text) });
  /** Edits a scalar cell through its actual input and blur handlers. */
  function edit(field, value, type = "CharField", initial = "old", blur = true) {
    let cell = row.children.find((td) => td.dataset.attname === field);
    if (!cell) { cell = dom.el("td", { dataset: { attname: field }, _column: { type }, _editval: initial }); row.appendChild(cell); }
    editor.editCell(cell);
    const input = cell.querySelector("input, select"); input.value = value;
    if (blur) { input.dispatch("blur"); }
    return cell;
  }
  return { ...dom, edit, editor, messages, notices, ended: () => ended, reloads: () => reloads };
}

/** Delivers a response with the exact editor and commit identity sent to the host. */
function reply(editor, request, result = { ok: true, saved: 1 }) { return editor.handleResult({ ...request, result, type: "commit" }); }

test("commit clears only the sent versions, retaining later edits to the same and different fields", (t) => {
  const f = fixture(t);
  f.edit("name", "sent"); f.editor.commitEdits(); const first = f.messages[0];
  f.editor.commitEdits(); assert.equal(f.messages.length, 1);
  f.edit("name", "later"); f.edit("notes", "unsent");
  assert.equal(reply(f.editor, first), true);
  assert.equal(f.editor.pendingCount(), 2);
  assert.deepEqual(first.changes, [{ fields: { name: "sent" }, pk: 1 }]);
  f.editor.commitEdits(); const second = f.messages[1];
  assert.deepEqual(second.changes[0].fields, { name: "later", notes: "unsent" });
  assert.equal(reply(f.editor, first), false, "duplicate old success cannot settle the next commit");
  reply(f.editor, second); assert.equal(f.editor.pendingCount(), 0);
});

test("an unfinished input is staged before a successful response reloads the grid", (t) => {
  const f = fixture(t);
  f.edit("name", "sent"); f.editor.commitEdits();
  f.edit("notes", "still typing", "CharField", "old", false);
  reply(f.editor, f.messages[0]);
  assert.equal(f.editor.pendingCount(), 1);
  f.editor.commitEdits(); assert.deepEqual(f.messages[1].changes[0].fields, { notes: "still typing" });
});

test("failed commits retain edits, release busy state, and use fresh identities when retried", (t) => {
  const f = fixture(t);
  f.edit("name", "changed"); f.editor.commitEdits(); const first = f.messages[0];
  reply(f.editor, first, { error: "Save could not be confirmed.", ok: false });
  assert.equal(f.editor.pendingCount(), 1); assert.equal(f.editor.isCommitting(), false);
  assert.equal(f.ended(), 1); assert.equal(f.reloads(), 0);
  f.editor.commitEdits(); assert.notEqual(f.messages[1].commitId, first.commitId);
  f.editor.reset(); f.edit("name", "new model draft");
  assert.equal(reply(f.editor, f.messages[1]), false); assert.equal(f.editor.pendingCount(), 1);
});

test("related saves route to their own editor, preserve parent drafts, and refresh newer child edits", (t) => {
  const f = fixture(t), relatedMessages = [];
  f.edit("parent", "unsaved parent");
  const table = buildEditableRelatedTable({ app: "fixture", model: "Child", pk: "id", columns: [{ attname: "name", editable: true, type: "CharField" }], rows: [{ id: 2, name: "old" }] }, { el: f.el, renderValue: (value) => f.el("span", {}, String(value)), post: (message) => relatedMessages.push(structuredClone(message)), reload() {} });
  const cell = table.querySelector("td"), grid = table.querySelector("table"), commit = table.querySelector("button");
  grid.dispatch("dblclick", { target: cell }); cell.querySelector("input").value = "saved child"; cell.querySelector("input").dispatch("blur");
  commit.dispatch("click"); assert.equal(commit.disabled, true);
  const request = relatedMessages[0]; assert.equal(request.type, "commitRelated");
  grid.dispatch("dblclick", { target: cell }); cell.querySelector("input").value = "new child draft"; cell.querySelector("input").dispatch("blur");
  assert.equal(reply(f.editor, request), false); assert.equal(f.editor.pendingCount(), 1);
  assert.equal(table.handleCommit({ ...request, result: { ok: true, saved: 1 }, type: "commit" }), true);
  table.refreshRows({ ok: true, rows: [{ id: 2, name: "saved child" }] });
  assert.equal(table.querySelector("td").dataset.staged, "new child draft");
  assert.equal(commit.disabled, false); assert.equal(f.reloads(), 0);
});

test("datetime picker saves the original offset and precision without altering an untouched value", (t) => {
  const f = fixture(t), original = "2026-09-07T12:00:00.123456+00:00";
  f.edit("untouched", "2026-09-07T12:00:00", "DateTimeField", original);
  assert.equal(f.editor.pendingCount(), 0);
  f.edit("at", "2026-09-07T12:01", "DateTimeField", original);
  f.editor.commitEdits(); assert.equal(f.messages[0].changes[0].fields.at, "2026-09-07T12:01:00.123456+00:00");
  assert.equal(temporalEditorValue("DateTimeField", original), "2026-09-07T12:00:00");
  for (const offset of ["Z", "+09:00", "+01:00", "+02:00", "-05:00"]) {
    assert.equal(temporalStoredValue("DateTimeField", `2026-03-29T01:00:00.123${offset}`, "2026-03-29T02:01"), `2026-03-29T02:01:00.123${offset}`);
  }
  assert.equal(temporalStoredValue("TimeField", "12:00:00.123456", "12:01"), "12:01:00.123456");
  assert.equal(temporalStoredValue("DateTimeField", original, ""), "");
});

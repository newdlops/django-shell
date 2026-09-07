// Verifies lazy model-property load, reload, retry, and stale-response behavior across grid changes.

import assert from "node:assert/strict";
import test from "node:test";
import { createPropertyValues, propertyLoadAction } from "../media/gridPropertyValues.js";

/** Creates a property grid with an observable host boundary and repaint callbacks. */
function fixture() {
  const state = { columns: [{ attname: "display_name", computed: true }], computed: {}, computedActive: new Set(), rowCount: 2 };
  const posted = []; const errors = []; const successes = [];
  const loader = createPropertyValues({ onChange() {}, onError: (message) => errors.push(message), onSuccess: (message) => successes.push(message), post: (message) => posted.push(message), state });
  loader.rowsChanged({ revision: 0 });
  return { errors, loader, posted, state, successes };
}

/** Completes a property request through the same correlated message shape as the host. */
function complete(fixture, request = fixture.posted.at(-1), changes = {}) {
  fixture.loader.accept({ ...request, ok: true, type: "computed", values: { "007": "Acme", "008": "Other" }, ...changes });
}

test("property values stay lazy, then Load and Reload both fetch and display values", () => {
  const f = fixture();
  assert.equal(f.posted.length, 0);
  assert.equal(propertyLoadAction(f.state, "display_name"), "Load");
  f.loader.load("display_name");
  assert.equal(propertyLoadAction(f.state, "display_name"), "Loading");
  f.loader.load("display_name");
  assert.equal(f.posted.length, 1, "duplicate loading clicks cannot queue property reads");
  complete(f);
  assert.equal(f.state.computed.display_name["007"], "Acme");
  assert.equal(propertyLoadAction(f.state, "display_name"), "Reload");
  f.loader.load("display_name");
  assert.equal(f.posted.length, 2, "Reload fetches instead of hiding the column");
  assert.equal(f.state.computedActive.has("display_name"), true);
  complete(f, undefined, { values: { "007": "Updated" } });
  assert.equal(f.state.computed.display_name["007"], "Updated");
});

test("replacement, sorting, filtering, and appended rows refresh active properties", () => {
  const f = fixture();
  f.loader.load("display_name"); complete(f);
  for (const message of [{ revision: 0 }, { revision: 1 }, { revision: 2 }, { append: true, revision: 2 }]) {
    const before = f.posted.length;
    f.loader.rowsChanged(message);
    assert.equal(f.posted.length, before + 1);
    assert.equal(f.state.computed.display_name, undefined, "a changed page cannot reuse stale property values");
    assert.equal(f.posted.at(-1).revision, message.revision);
    complete(f);
  }
});

test("superseded replies cannot overwrite the new page even within the same revision", () => {
  const f = fixture();
  f.loader.load("display_name"); const old = f.posted.at(-1);
  f.loader.rowsChanged({ revision: 0 }); const current = f.posted.at(-1);
  complete(f, old, { values: { "007": "Stale" } });
  assert.equal(f.state.computed.display_name, undefined);
  assert.equal(f.state.computedPending.has("display_name"), true);
  complete(f, current, { revision: 99 });
  assert.equal(f.state.computed.display_name, undefined);
  complete(f, current);
  assert.equal(f.state.computed.display_name["007"], "Acme");
});

test("failed property reads exit loading and retry successfully", () => {
  const f = fixture();
  f.loader.load("display_name");
  complete(f, undefined, { error: "Traceback\nRuntimeError: disconnected\n", ok: false });
  assert.equal(propertyLoadAction(f.state, "display_name"), "Retry");
  assert.equal(f.state.computedPending.has("display_name"), false);
  assert.match(f.errors[0], /RuntimeError: disconnected/);
  f.loader.load("display_name"); complete(f);
  assert.equal(propertyLoadAction(f.state, "display_name"), "Reload");
  assert.equal(f.state.computedErrors.display_name, undefined);
});

test("false, zero, empty text, null, and string primary keys survive property responses", () => {
  const f = fixture();
  const values = { "007": false, "008": 0, "009": "", "010": null };
  f.loader.load("display_name"); complete(f, undefined, { values });
  assert.deepEqual(f.state.computed.display_name, values);
  assert.equal(f.successes.length, 1);
});

test("empty pages avoid reads and reload active properties when rows return", () => {
  const f = fixture(); f.state.rowCount = 0;
  f.loader.load("display_name");
  assert.equal(f.posted.length, 0);
  assert.equal(f.state.computedPending.size, 0);
  f.state.rowCount = 1; f.loader.rowsChanged({ revision: 1 });
  assert.equal(f.posted.length, 1);
});

test("model and column changes invalidate pending property responses", () => {
  const f = fixture();
  f.loader.load("display_name"); const old = f.posted.at(-1);
  f.loader.reset(); complete(f, old);
  assert.equal(f.state.computedActive.size, 0);
  assert.deepEqual(f.state.computed, {});
  f.loader.load("display_name"); f.state.columns = []; f.loader.rowsChanged({ revision: 1 });
  complete(f);
  assert.equal(f.state.computedActive.size, 0);
  assert.equal(f.state.computedPending.size, 0);
  assert.deepEqual(f.state.computed, {});
});

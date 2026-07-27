// Verifies Query Builder focus, caret, and structural-intent preservation helpers.
import assert from "node:assert/strict";
import test from "node:test";

import { captureQueryFocus, createQueryFocusIntent, restoreQueryFocus } from "../media/gridQueryFocus.js";

/** Builds the smallest focusable control fixture needed by the pure focus helpers. */
function control(key, { inBuilder = true } = {}) {
  const calls = { focus: [], scroll: [], selection: [] };
  return {
    calls,
    closest: () => inBuilder ? {} : undefined,
    dataset: { queryControlKey: key },
    focus: (options) => calls.focus.push(options),
    scrollIntoView: (options) => calls.scroll.push(options),
    selectionDirection: "backward",
    selectionEnd: 5,
    selectionStart: 3,
    setSelectionRange: (...args) => calls.selection.push(args)
  };
}

/** Builds a query-root fixture that resolves controls by their stable control key. */
function root(active, controls) {
  return {
    activeElement: active,
    querySelector: (selector) => controls.find((item) => selector.replaceAll("\\", "").includes(item.dataset.queryControlKey))
  };
}

test("focus outside the Query Builder is not captured", () => {
  const outside = control("other", { inBuilder: false });
  assert.equal(captureQueryFocus(root(outside, [outside])), undefined);
});

test("text selection is restored without scrolling by default", () => {
  const field = control("computed.alias");
  const snapshot = captureQueryFocus(root(field, [field]));
  assert.deepEqual(snapshot, { direction: "backward", end: 5, key: "computed.alias", start: 3 });
  assert.equal(restoreQueryFocus(root(undefined, [field]), snapshot), true);
  assert.deepEqual(field.calls.focus, [{ preventScroll: true }]);
  assert.deepEqual(field.calls.selection, [[3, 5, "backward"]]);
  assert.deepEqual(field.calls.scroll, []);
});

test("explicit structural intent wins over captured focus and is consumed once", () => {
  const intent = createQueryFocusIntent();
  intent.set({ controlKey: "new-condition" });
  assert.deepEqual(intent.consume(), { controlKey: "new-condition" });
  assert.equal(intent.consume(), undefined);
});

test("missing structural target fails safely and reveal mode scrolls the target into view", () => {
  const field = control("result.order");
  assert.equal(restoreQueryFocus(root(undefined, []), { controlKey: "missing" }), false);
  assert.equal(restoreQueryFocus(root(undefined, [field]), { controlKey: "result.order" }, { reveal: true }), true);
  assert.deepEqual(field.calls.focus, [{ preventScroll: false }]);
  assert.deepEqual(field.calls.scroll, [{ block: "nearest" }]);
});

// Unit tests for pure strict execution-unit range detection.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { overlayExecutionUnitRange } = require("../out/overlayExecutionUnit.js");

test("finds upper and lower units separated by two blank lines", () => {
  const source = "upper = 1\n\n\nlower = 2\nprint(lower)";

  assert.deepEqual(overlayExecutionUnitRange(source, 0), { end: 0, start: 0 });
  assert.deepEqual(overlayExecutionUnitRange(source, 4), { end: 4, start: 3 });
});

test("preserves a single blank line inside one execution unit", () => {
  const source = "value = 1\n\nprint(value)";

  assert.deepEqual(overlayExecutionUnitRange(source, 2), { end: 2, start: 0 });
});

test("honors a marker floor and CRLF separators", () => {
  const source = "hidden = 1\r\n# --- django shell input ---\r\nupper = 1\r\n\r\n\r\nlower = 2";

  assert.deepEqual(overlayExecutionUnitRange(source, 5, 2), { end: 5, start: 5 });
});

test("does not assign separator lines to either execution unit", () => {
  const source = "upper = 1\n\n\nlower = 2";

  assert.equal(overlayExecutionUnitRange(source, 1), undefined);
  assert.equal(overlayExecutionUnitRange(source, 2), undefined);
});

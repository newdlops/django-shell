// Unit tests for pure strict execution-unit range detection.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { overlayExecutionUnitRange, overlayExecutionUnitSeparatorBlankLines } = require("../out/overlayExecutionUnit.js");

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

test("keeps the conventional two blank lines after an import in one unit", () => {
  const source = "import os\n\n\nprint(os.name)";

  assert.deepEqual(overlayExecutionUnitRange(source, 0), { end: 3, start: 0 });
  assert.deepEqual(overlayExecutionUnitRange(source, 3), { end: 3, start: 0 });
  assert.deepEqual(overlayExecutionUnitRange(source, 1), { end: 3, start: 0 });
  assert.deepEqual(overlayExecutionUnitRange(source, 2), { end: 3, start: 0 });
  assert.equal(overlayExecutionUnitSeparatorBlankLines(source, 0), 3);
});

test("separates a from-import only after three blank lines", () => {
  const source = "from pathlib import Path\n\n\n\nprint(Path.cwd())";

  assert.deepEqual(overlayExecutionUnitRange(source, 0), { end: 0, start: 0 });
  assert.deepEqual(overlayExecutionUnitRange(source, 4), { end: 4, start: 4 });
  for (const line of [1, 2, 3]) { assert.equal(overlayExecutionUnitRange(source, line), undefined); }
});

test("recognizes parenthesized and backslash-continued import endings", () => {
  const parenthesized = "from pathlib import (\n    Path,\n)\n\n\nPath.cwd()";
  const backslash = "from package import First, \\\n    Second\n\n\nuse(First, Second)";

  assert.deepEqual(overlayExecutionUnitRange(parenthesized, 5), { end: 5, start: 0 });
  assert.deepEqual(overlayExecutionUnitRange(backslash, 4), { end: 4, start: 0 });
});

test("uses the ordinary separator after later non-import code in an import-led unit", () => {
  const source = "import os\n\n\nvalue = os.name\n\n\nprint(value)";

  assert.deepEqual(overlayExecutionUnitRange(source, 3), { end: 3, start: 0 });
  assert.deepEqual(overlayExecutionUnitRange(source, 6), { end: 6, start: 6 });
});

test("does not treat an import followed by another semicolon statement as an import ending", () => {
  const source = "import os; value = 1\n\n\nprint(value)";

  assert.deepEqual(overlayExecutionUnitRange(source, 0), { end: 0, start: 0 });
  assert.deepEqual(overlayExecutionUnitRange(source, 3), { end: 3, start: 3 });
  assert.equal(overlayExecutionUnitSeparatorBlankLines(source, 0), 2);
});

test("keeps top-level import comments with the conventional two-blank gap", () => {
  const source = "import os\n# Used by the expression below.\n\n\nprint(os.name)";

  assert.deepEqual(overlayExecutionUnitRange(source, 4), { end: 4, start: 0 });
  assert.equal(overlayExecutionUnitSeparatorBlankLines(source, 1), 3);
});

test("uses the ordinary separator after an indented import", () => {
  const source = "if enabled:\n    import os\n\n\nprint(os.name)";

  assert.deepEqual(overlayExecutionUnitRange(source, 1), { end: 1, start: 0 });
  assert.deepEqual(overlayExecutionUnitRange(source, 4), { end: 4, start: 4 });
  assert.equal(overlayExecutionUnitSeparatorBlankLines(source, 1), 2);
});

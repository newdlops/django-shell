// Unit tests for shell-order-independent Python analysis projection.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { overlayExecutionUnitRange, projectOverlayAnalysisText } = require("../out/overlayAnalysisProjection.js");

test("projects only the focused unit across a strict import boundary", () => {
  const source = "import unexecuted_upper\n\n\nlower_value = 2\nlower_value\n";

  assert.deepEqual(overlayExecutionUnitRange(source, 4), { end: 4, start: 3 });
  assert.equal(projectOverlayAnalysisText(source, 4), "\n\n\nlower_value = 2\nlower_value\n");
  assert.deepEqual(overlayExecutionUnitRange(source, 0), { end: 0, start: 0 });
  assert.equal(projectOverlayAnalysisText(source, 0), "import unexecuted_upper\n\n\n\n\n");
});

test("preserves line endings and single internal blank lines without projecting sibling units", () => {
  const source = "def build():\r\n    value = 1\r\n\r\n    return value\r\n\r\n\r\nother = 2\r\n";
  const projected = projectOverlayAnalysisText(source, 3);

  assert.equal(projected, "def build():\r\n    value = 1\r\n\r\n    return value\r\n\r\n\r\n\r\n");
  assert.equal(projected.split("\r\n").length, source.split("\r\n").length);
});

test("treats every line in a multi-blank separator as non-executable analysis space", () => {
  const source = "upper = 1\n\n\nlower = 2";

  assert.equal(overlayExecutionUnitRange(source, 1), undefined);
  assert.equal(overlayExecutionUnitRange(source, 2), undefined);
  assert.equal(projectOverlayAnalysisText(source, 1), "\n\n\n");
});

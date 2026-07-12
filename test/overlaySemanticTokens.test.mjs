// Unit tests for hidden-analysis semantic-token coordinate mapping.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { mapOverlaySemanticTokenData } = require("../out/overlaySemanticTokens.js");

test("drops hidden prelude tokens and rebases the first visible token", () => {
  const data = Uint32Array.from([
    0, 0, 4, 1, 0,
    2, 3, 7, 2, 1,
    1, 1, 5, 3, 4
  ]);

  assert.deepEqual([...mapOverlaySemanticTokenData(data, 2, 0, 4)], [
    0, 3, 7, 2, 1,
    1, 1, 5, 3, 4
  ]);
});

test("recomputes same-line character deltas after filtered tokens", () => {
  const data = Uint32Array.from([
    1, 2, 3, 1, 0,
    0, 5, 4, 2, 8,
    1, 1, 2, 3, 16
  ]);

  assert.deepEqual([...mapOverlaySemanticTokenData(data, 1, 3, 5)], [
    3, 2, 3, 1, 0,
    0, 5, 4, 2, 8,
    1, 1, 2, 3, 16
  ]);
});

test("maps legacy visible prefixes and drops tokens beyond the visible document", () => {
  const data = Uint32Array.from([
    4, 2, 6, 7, 1,
    2, 1, 3, 8, 2,
    3, 0, 2, 9, 4
  ]);

  assert.deepEqual([...mapOverlaySemanticTokenData(data, 4, 7, 10)], [
    7, 2, 6, 7, 1,
    2, 1, 3, 8, 2
  ]);
});

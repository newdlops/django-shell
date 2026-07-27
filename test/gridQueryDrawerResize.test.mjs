// Tests for bounded, keyboard-accessible Query Builder drawer resizing.
import assert from "node:assert/strict";
import test from "node:test";
import { __test } from "../media/gridQueryDrawerResize.js";

test("drawer resize clamps each height to the available inclusive range", () => {
  assert.equal(__test.clampHeight(50, 220, 620), 220);
  assert.equal(__test.clampHeight(700, 220, 620), 620);
  assert.equal(__test.clampHeight(411.6, 220, 620), 412);
});

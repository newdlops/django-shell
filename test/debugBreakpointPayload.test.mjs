// Unit tests for lossless DAP breakpoint metadata conversion.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { debugBreakpointKey, debugBreakpointPayload } = require("../out/debugBreakpointPayload.js");

test("preserves conditional, hit-count, logpoint, and column fields", () => {
  const breakpoint = { column: 7, condition: "user.is_staff", hitCondition: "% 3", line: 12, logMessage: "user={user!r}" };
  assert.deepEqual(debugBreakpointPayload(breakpoint), breakpoint);
  assert.notEqual(debugBreakpointKey(breakpoint), debugBreakpointKey({ ...breakpoint, condition: "user.is_superuser" }));
});

test("omits empty optional DAP fields", () => {
  assert.deepEqual(debugBreakpointPayload({ line: 4 }), { line: 4 });
});

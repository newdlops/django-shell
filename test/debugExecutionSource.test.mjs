// Unit tests for independent execution-unit debugger source projection.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { debugExecutionBreakpoints, debugExecutionScope } = require("../out/debugExecutionSource.js");

test("projects only the selected unit while preserving its original source lines", () => {
  const code = "selected = []\n\nselected.append('ran')\nselected";
  const scope = debugExecutionScope(code, 6);

  assert.equal(scope.startLine, 7);
  assert.equal(scope.endLine, 10);
  assert.equal(scope.sourceText, `${"\n".repeat(6)}${code}\n`);
  assert.doesNotThrow(() => new Function(scope.sourceText));
});

test("filters breakpoints outside the selected execution unit", () => {
  const scope = debugExecutionScope("selected = 1\nselected += 1", 4);
  const breakpoints = [{ line: 1 }, { condition: "selected == 1", line: 5 }, { line: 6 }, { line: 9 }];

  assert.deepEqual(debugExecutionBreakpoints(breakpoints, scope), [
    { condition: "selected == 1", line: 5 },
    { line: 6 }
  ]);
  assert.equal(debugExecutionBreakpoints(breakpoints, undefined), breakpoints);
});

test("normalizes invalid offsets without changing source contents", () => {
  assert.deepEqual(debugExecutionScope("value = 1", Number.NaN), {
    endLine: 1,
    sourceText: "value = 1\n",
    startLine: 1
  });
});

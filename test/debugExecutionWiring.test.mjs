// Regression checks for selected-unit breakpoint projection through the extension host.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const consoleSource = fs.readFileSync(new URL("../src/customConsole.ts", import.meta.url), "utf8");
const breakpointSource = fs.readFileSync(new URL("../src/debugBreakpoints.ts", import.meta.url), "utf8");

test("filters both adapter and backend breakpoints to the active debug unit", () => {
  assert.ok(consoleSource.includes("debugExecutionScope(code, lineOffset)"));
  assert.ok(consoleSource.includes("debugExecutionBreakpoints(this.debugBreakpointSourceLocations(filename), debugScope)"));
  assert.ok(consoleSource.includes("debugExecutionBreakpoints(sourceBreakpointLocations(activeUri, this.defaultExecutionLineOffset()), scope)"));
});

test("sends the line-stable execution projection to the debug adapter", () => {
  assert.ok(consoleSource.includes('syncActiveDebugBreakpoints("execute", debugScope?.sourceText'));
  assert.ok(breakpointSource.includes("{ sourceText: request.sourceText }"));
});

test("does not compile the full overlay before the scoped execute synchronization", () => {
  assert.ok(consoleSource.includes("direct.attach(attachEndpoint, async () => undefined"));
  assert.equal(consoleSource.includes('syncActiveDebugBreakpoints("reuse"'), false);
});

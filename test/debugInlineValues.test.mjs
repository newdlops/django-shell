// Regression contracts for VS Code-style paused inline values in the shell overlay.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const overlaySource = readSource("../src/workbenchOverlay.ts");
const rendererSource = readSource("../src/workbenchOverlayRenderer.ts");
const syncRendererSource = readSource("../src/workbenchOverlaySyncRenderer.ts");
const customConsoleSource = readSource("../src/customConsole.ts");

test("inline summaries prioritize arguments then locals while filtering private, duplicate, and preview rows", () => {
  const { debugInlineValueText } = inlineModule();
  const text = debugInlineValueText([
    { name: "Globals", variables: [{ name: "global_only", value: "99" }] },
    { name: "Locals", variables: [
      { name: "shared", value: "local-copy" },
      { name: "total", value: "7" },
      { name: "_private", value: "hidden" },
      { name: "orders[:10]", querysetPreview: true, value: "[large preview]" }
    ] },
    { name: "Arguments", variables: [
      { name: "user_id", value: "42" },
      { name: "shared", value: "argument-copy" },
      { name: "__secret", value: "hidden" }
    ] }
  ]);

  assert.match(text, /user_id\s*=\s*42/);
  assert.match(text, /shared\s*=\s*argument-copy/);
  assert.match(text, /total\s*=\s*7/);
  assert.equal((text.match(/\bshared\s*=/g) ?? []).length, 1);
  for (const hidden of ["global_only", "local-copy", "_private", "__secret", "orders[:10]", "large preview"]) {
    assert.equal(text.includes(hidden), false, `${hidden} must stay out of paused inline values`);
  }
  assert.ok(text.indexOf("user_id") < text.indexOf("total"), "arguments render ahead of locals");
});

test("inline summaries cap each value, entry count, and total renderer payload", () => {
  const { debugInlineValueText } = inlineModule();
  const oneLongValue = debugInlineValueText([{ name: "Locals", variables: [{ name: "description", value: "x".repeat(500) }] }]);
  const manyValues = debugInlineValueText([{ name: "Locals", variables: Array.from({ length: 30 }, (_, index) => ({ name: `value_${index}`, value: `item-${index}-${"y".repeat(80)}` })) }]);

  assert.ok(oneLongValue.length <= 96, `one inline value grew to ${oneLongValue.length} characters`);
  assert.equal(oneLongValue.includes("x".repeat(100)), false, "individual values are truncated before rendering");
  assert.ok((manyValues.match(/\bvalue_\d+\s*=/g) ?? []).length <= 6, "only a small local summary is rendered");
  assert.ok(manyValues.length <= 240, `inline payload grew to ${manyValues.length} characters`);
  assert.equal(/[\r\n]/.test(manyValues), false, "adapter values are normalized to one line");
});

test("overlay keys paused decorations by line and inline payload and renders an inlay-style suffix", () => {
  const { debugInlineRenderKey } = inlineModule();
  const first = debugInlineRenderKey(12, "count = 1");
  const stepped = debugInlineRenderKey(12, "count = 2");

  assert.notEqual(first, stepped, "stepping on the same source line must still replace changed values");
  assert.equal(debugInlineRenderKey(12, "count = 1"), first);
  assert.ok(overlaySource.includes('from "./debugInlineValues"'));
  assert.ok(overlaySource.includes("debugInlineValueText(info.scopes"));
  assert.ok(overlaySource.includes("debugInlineRenderKey"));
  assert.match(overlaySource, /function debugLineExpression\([^)]*inline/i);
  assert.match(syncRendererSource, /__dsoSetOverlayDebugLine\s*=\s*function\s*\(line,\s*inline/i);
  assert.ok(syncRendererSource.includes("__dsoDebugRenderInlineText"), "renderer idempotence includes inline text, not only the line");
  assert.match(syncRendererSource, /after:\s*\{[^}]*content:/s);
  assert.ok(syncRendererSource.includes('inlineClassName: "dso-debug-inline-value"'));
  assert.ok(rendererSource.includes(".dso-debug-inline-value"));
  assert.ok(rendererSource.includes("--vscode-editorInlayHint-foreground"));
});

test("running preserves the current display while the next pause replaces it and terminal states clear it", () => {
  const updateStart = overlaySource.indexOf("async updateDebugInfo(info: DebugFrameInfo)");
  const updateEnd = overlaySource.indexOf("private queueDebugLineFlush", updateStart);
  const updateBody = overlaySource.slice(updateStart, updateEnd);
  const flushStart = overlaySource.indexOf("private async flushDebugLine()");
  const flushEnd = overlaySource.indexOf("async updateBreakpoints", flushStart);
  const flushBody = overlaySource.slice(flushStart, flushEnd);
  const endRunStart = customConsoleSource.indexOf("private async endDebugRun(");
  const endRunEnd = customConsoleSource.indexOf("private async stopDebugRun(", endRunStart);
  const endRunBody = customConsoleSource.slice(endRunStart, endRunEnd);
  const teardownStart = customConsoleSource.indexOf("private async teardownDebug()");
  const teardownEnd = customConsoleSource.indexOf("private startPythonProgress", teardownStart);
  const teardownBody = customConsoleSource.slice(teardownStart, teardownEnd);

  assert.ok(updateBody.includes('if (info.state === "running")'));
  assert.ok(updateBody.indexOf('if (info.state === "running")') < updateBody.indexOf("debugInlineValueText"), "step transitions retain the current decoration until the next pause");
  assert.ok(updateBody.includes('info.state === "paused"'));
  assert.match(updateBody, /inline[^=]*=\s*visibleLine\s*>\s*0\s*\?[^:]+:\s*""/is);
  assert.ok(flushBody.includes("debugInlineRenderKey"), "the applied key changes when a same-line step changes values");
  assert.equal(flushBody.includes("this.debugLineApplied === this.debugLineTarget"), false, "line-only equality cannot suppress same-line replacements");
  assert.ok(endRunBody.includes('this.postDebugInfo({ state: "idle" })'));
  assert.ok(teardownBody.includes('this.postDebugInfo({ state: "idle" })'));
  assert.ok(overlaySource.includes("inlineValueText"), "idle/error targets carry an explicit empty inline payload to the renderer");
});

/** Loads the formatter module after compile and reports a focused TDD failure while it is absent. */
function inlineModule() {
  try {
    return require("../out/debugInlineValues.js");
  } catch (error) {
    assert.fail(`debugInlineValues module is not implemented: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Reads one source file while allowing tests to report feature-specific assertions before it exists. */
function readSource(relativePath) {
  try {
    return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
  } catch {
    return "";
  }
}

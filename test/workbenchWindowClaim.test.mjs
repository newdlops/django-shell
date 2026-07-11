// Source-contract tests for the extension-host focused-window claim handshake.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const overlaySource = fs.readFileSync(new URL("../src/workbenchOverlay.ts", import.meta.url), "utf8");
const windowEvalSource = fs.readFileSync(new URL("../src/workbenchWindowEval.ts", import.meta.url), "utf8");

test("window focus changes invalidate in-flight focused claims", () => {
  assert.ok(overlaySource.includes("private workbenchFocusGeneration = 0"));
  assert.ok(overlaySource.includes("vscode.window.onDidChangeWindowState(() => { this.workbenchFocusGeneration += 1; })"));

  const evalStart = overlaySource.indexOf("private async evalInWorkbench");
  const evalEnd = overlaySource.indexOf("private recordWorkbenchWindow", evalStart);
  const body = overlaySource.slice(evalStart, evalEnd);
  assert.ok(body.includes("const focusGeneration = this.workbenchFocusGeneration"));
  assert.ok(body.includes("vscode.window.state.focused && focusGeneration === this.workbenchFocusGeneration"));
  assert.ok(body.includes("!vscode.window.state.focused || focusGeneration !== this.workbenchFocusGeneration"));
  assert.ok(body.includes('return "stale-focused-workbench-candidate"'));
});

test("candidate claims require a second requested-id pass before renderer execution", () => {
  const evalStart = overlaySource.indexOf("private async evalInWorkbench");
  const evalEnd = overlaySource.indexOf("private recordWorkbenchWindow", evalStart);
  const body = overlaySource.slice(evalStart, evalEnd);
  const parseIndex = body.indexOf("parseFocusedWorkbenchCandidate(responseText)");
  const candidateIndex = body.indexOf("focusedClaimId = focusedCandidate", parseIndex);
  const continueIndex = body.indexOf("continue", candidateIndex);
  const recordIndex = body.indexOf("this.recordWorkbenchWindow(responseText)", parseIndex);

  assert.ok(body.includes("for (let attempt = 0; attempt < 3; attempt += 1)"));
  assert.ok(body.includes("const requestedWindowId = this.workbenchWindowId ?? focusedClaimId"));
  assert.ok(parseIndex >= 0 && candidateIndex > parseIndex && continueIndex > candidateIndex && recordIndex > continueIndex);
  assert.equal(body.slice(parseIndex, continueIndex).includes("this.workbenchWindowId ="), false, "an unexecuted claim is never cached as confirmed");
});

test("every workbench main-process evaluation receives the current workspace name", () => {
  const calls = overlaySource.match(/mainProcessEvalExpression\([^;]+/g) ?? [];

  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('this.profile.panelTitle, vscode.workspace.name ?? "", allowFocusedPanelClaim'));
});

test("main-process focus claims are stable, matching, and execution-free", () => {
  const beforeIndex = windowEvalSource.indexOf("const focusedBefore");
  const afterIndex = windowEvalSource.indexOf("const focusedAfter", beforeIndex);
  const stableIndex = windowEvalSource.indexOf("const stableFocusedPanel", afterIndex);
  const claimIndex = windowEvalSource.indexOf("__DSO_FOCUSED_WINDOW_CANDIDATE__", stableIndex);
  const executionIndex = windowEvalSource.indexOf("target.webContents.executeJavaScript", claimIndex);

  assert.ok(beforeIndex >= 0 && afterIndex > beforeIndex && stableIndex > afterIndex && claimIndex > stableIndex && executionIndex > claimIndex);
  assert.ok(windowEvalSource.includes("focusedBefore === focusedAfter"));
  assert.ok(windowEvalSource.includes("const focusedCandidates = workspaceMatches.length ? workspaceMatches : panelMatches"));
  assert.ok(windowEvalSource.includes("focusedCandidates.some(function (probe) { return probe.win === focusedBefore; })"));
  assert.ok(windowEvalSource.includes('probe.match === "workspace-panel"'));
  assert.ok(windowEvalSource.includes("const allowFocusedClaim"));
  assert.ok(windowEvalSource.includes("else if (ownerMatches.length > 1)"), "duplicate token owners remain an error before focus claims");
});

test("transient unclaimed selection retries once without bypassing the claim handshake", () => {
  const evalStart = overlaySource.indexOf("private async evalInWorkbench");
  const evalEnd = overlaySource.indexOf("private recordWorkbenchWindow", evalStart);
  const body = overlaySource.slice(evalStart, evalEnd);

  assert.ok(overlaySource.includes("const INITIAL_WINDOW_FOCUS_RETRY_MS = 100"));
  assert.ok(body.includes("attempt === 0 && requestedWindowId === undefined && allowFocusedPanelClaim"));
  assert.ok(body.includes("unclaimed-panel-workbench-window:"));
  assert.ok(body.includes("ambiguous-(?:panel|workspace)-workbench-window:"));
  assert.ok(body.includes("await delay(INITIAL_WINDOW_FOCUS_RETRY_MS)"));
  assert.equal(body.includes("wins[0]"), false);
});

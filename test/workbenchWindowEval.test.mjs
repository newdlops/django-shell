// Unit tests for safe multi-window workbench renderer selection and focused-window claims.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const requireModule = createRequire(import.meta.url);
const { mainProcessEvalExpression, parseFocusedWorkbenchCandidate } = requireModule("../out/workbenchWindowEval.js");

/** Creates one fake workbench BrowserWindow with a configurable ownership-probe result. */
function fakeWindow(id, probeResult) {
  const calls = [];
  const win = {
    id,
    webContents: {
      executeJavaScript(source) {
        calls.push(source);
        if (source.includes("const owner =")) { return Promise.resolve(probeResult); }
        if (source.startsWith("try{const root=")) { return Promise.resolve(undefined); }
        return Promise.resolve(`renderer-${id}`);
      },
      getURL() { return "file:///application/workbench.html"; }
    }
  };
  return { calls, win };
}

/** Returns whether one fake window received the protected renderer payload. */
function receivedPayload(item) {
  return item.calls.some((source) => source.includes("payload"));
}

/** Evaluates one generated main-process expression with explicit requested and focused-window state. */
async function evaluateTarget(windows, options = {}) {
  const focusedIds = options.focusedIds ?? [options.focusedId, options.focusedId];
  let focusCalls = 0;
  const BrowserWindow = {
    fromId(id) { return windows.map((item) => item.win).find((win) => win.id === id); },
    getAllWindows() { return windows.map((item) => item.win); },
    getFocusedWindow() {
      const index = Math.min(focusCalls, Math.max(0, focusedIds.length - 1));
      const id = focusedIds[index];
      focusCalls += 1;
      return windows.map((item) => item.win).find((win) => win.id === id);
    }
  };
  const context = vm.createContext({
    clearTimeout,
    process: {},
    require(name) { if (name !== "electron") { throw new Error(`unexpected module ${name}`); } return { BrowserWindow }; },
    setTimeout
  });
  const expression = mainProcessEvalExpression(
    "'payload'",
    options.requestedId,
    500,
    "owner-token",
    "Django Shell",
    options.workspaceTitle ?? "Payroll",
    options.allowFocusedClaim ?? true
  );
  const result = await vm.runInContext(expression, context);
  return { focusCalls, result };
}

test("parses only positive focused-window candidate claims", () => {
  assert.equal(parseFocusedWorkbenchCandidate("__DSO_FOCUSED_WINDOW_CANDIDATE__:17"), 17);
  for (const raw of ["", "__DSO_FOCUSED_WINDOW_CANDIDATE__:0", "__DSO_FOCUSED_WINDOW_CANDIDATE__:-2", "__DSO_WINDOW_ID__:17", "prefix __DSO_FOCUSED_WINDOW_CANDIDATE__:17"]) {
    assert.equal(parseFocusedWorkbenchCandidate(raw), undefined);
  }
});

test("a unique token owner outranks another focused matching panel", async () => {
  const owner = fakeWindow(11, "owner");
  const focusedPanel = fakeWindow(22, "panel");
  const { result } = await evaluateTarget([owner, focusedPanel], { focusedId: 22 });

  assert.equal(result, "__DSO_WINDOW_ID__:11\nrenderer-11");
  assert.equal(receivedPayload(owner), true);
  assert.equal(receivedPayload(focusedPanel), false);
});

test("duplicate token owners remain ambiguous even when one is stably focused", async () => {
  const first = fakeWindow(1, "owner");
  const focusedSecond = fakeWindow(2, "owner");
  const { result } = await evaluateTarget([first, focusedSecond], { focusedId: 2 });

  assert.equal(result, "ambiguous-owned-workbench-window:2");
  assert.equal(receivedPayload(first), false);
  assert.equal(receivedPayload(focusedSecond), false);
});

test("a unique workspace panel outranks a differently focused generic panel", async () => {
  const workspacePanel = fakeWindow(13, "workspace-panel");
  const focusedGenericPanel = fakeWindow(14, "panel");
  const { result } = await evaluateTarget([workspacePanel, focusedGenericPanel], { focusedId: 14, workspaceTitle: "Payroll" });

  assert.equal(result, "__DSO_WINDOW_ID__:13\nrenderer-13");
  assert.equal(receivedPayload(workspacePanel), true);
  assert.equal(receivedPayload(focusedGenericPanel), false);
});

test("duplicate workspace panels return only a stable focused claim", async () => {
  const first = fakeWindow(23, "workspace-panel");
  const focused = fakeWindow(24, "workspace-panel");
  const claim = await evaluateTarget([first, focused], { focusedId: 24, workspaceTitle: "Payroll" });

  assert.equal(claim.result, "__DSO_FOCUSED_WINDOW_CANDIDATE__:24");
  assert.equal(claim.focusCalls, 2);
  assert.equal(receivedPayload(first), false);
  assert.equal(receivedPayload(focused), false);

  const execution = await evaluateTarget([first, focused], { requestedId: 24, workspaceTitle: "Payroll" });
  assert.equal(execution.result, "__DSO_WINDOW_ID__:24\nrenderer-24");
  assert.equal(execution.focusCalls, 0);
  assert.equal(receivedPayload(first), false);
  assert.equal(receivedPayload(focused), true);
});

test("duplicate workspace panels refuse an unstable focused claim", async () => {
  const first = fakeWindow(25, "workspace-panel");
  const second = fakeWindow(26, "workspace-panel");
  const { result } = await evaluateTarget([first, second], { focusedIds: [25, 26], workspaceTitle: "Payroll" });

  assert.equal(result, "ambiguous-workspace-workbench-window:2");
  assert.equal(receivedPayload(first), false);
  assert.equal(receivedPayload(second), false);
});

test("a stable focused matching panel is claimed without executing until requested", async () => {
  const first = fakeWindow(31, "panel");
  const focused = fakeWindow(32, "panel");
  const claim = await evaluateTarget([first, focused], { focusedId: 32 });

  assert.equal(claim.result, "__DSO_FOCUSED_WINDOW_CANDIDATE__:32");
  assert.equal(claim.focusCalls, 2);
  assert.equal(receivedPayload(first), false);
  assert.equal(receivedPayload(focused), false, "claim phase must not execute protected renderer code");

  const execution = await evaluateTarget([first, focused], { requestedId: 32 });
  assert.equal(execution.result, "__DSO_WINDOW_ID__:32\nrenderer-32");
  assert.equal(execution.focusCalls, 0, "a requested candidate no longer consults mutable focus");
  assert.equal(receivedPayload(first), false);
  assert.equal(receivedPayload(focused), true);
});

test("focus changing during ownership probes cannot produce a claim", async () => {
  const first = fakeWindow(41, "panel");
  const second = fakeWindow(42, "panel");
  const { result } = await evaluateTarget([first, second], { focusedIds: [41, 42] });

  assert.equal(result, "ambiguous-panel-workbench-window:2");
  assert.equal(receivedPayload(first), false);
  assert.equal(receivedPayload(second), false);
});

test("an unrelated focused workbench cannot claim a unique matching panel", async () => {
  const panel = fakeWindow(51, "panel");
  const focusedOther = fakeWindow(52, "");
  const { result } = await evaluateTarget([panel, focusedOther], { focusedId: 52 });

  assert.equal(result, "unclaimed-panel-workbench-window:1");
  assert.equal(receivedPayload(panel), false);
  assert.equal(receivedPayload(focusedOther), false);
});

test("disabled focused claims refuse duplicate panels without reading focus", async () => {
  const first = fakeWindow(61, "panel");
  const second = fakeWindow(62, "panel");
  const { focusCalls, result } = await evaluateTarget([first, second], { allowFocusedClaim: false, focusedId: 62 });

  assert.equal(result, "ambiguous-panel-workbench-window:2");
  assert.equal(focusCalls, 0);
  assert.equal(receivedPayload(first), false);
  assert.equal(receivedPayload(second), false);
});

test("a cached BrowserWindow id executes without probes, claims, or focus reads", async () => {
  const cached = fakeWindow(71, "");
  const focusedOwner = fakeWindow(72, "owner");
  const { focusCalls, result } = await evaluateTarget([cached, focusedOwner], { focusedId: 72, requestedId: 71 });

  assert.equal(result, "__DSO_WINDOW_ID__:71\nrenderer-71");
  assert.equal(focusCalls, 0);
  assert.equal(cached.calls.some((source) => source.includes("const owner =")), false);
  assert.equal(focusedOwner.calls.length, 0);
  assert.equal(receivedPayload(cached), true);
});

// Runtime regression tests for fast paused-frame presentation before DAP variable inspection settles.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const NodeModule = require("node:module");
const mockState = { debugListeners: new Map() };
const vscodeMock = createVscodeMock();
const originalLoad = NodeModule._load;
let registerCustomConsoleDebugEvents;

try {
  NodeModule._load = function loadWithVscodeMock(request, parent, isMain) {
    return request === "vscode" ? vscodeMock : originalLoad.call(this, request, parent, isMain);
  };
  ({ registerCustomConsoleDebugEvents } = require("../out/customConsoleDebugEvents.js"));
} finally {
  NodeModule._load = originalLoad;
}

test("posts the stopped frame before its variables request settles", async () => {
  const variables = deferred();
  const requests = [];
  const posts = [];
  let variablesSettled = false;
  const session = {
    configuration: { __djangoShellSession: true },
    id: "latency-session",
    type: "python",
    customRequest(command) {
      requests.push(command);
      if (command === "stackTrace") {
        return Promise.resolve({ stackFrames: [{ column: 3, id: 31, line: 42, name: "shell expression", source: { name: "<django-shell>" } }] });
      }
      if (command === "scopes") {
        return Promise.resolve({ scopes: [{ expensive: false, name: "Locals", namedVariables: 1, variablesReference: 91 }] });
      }
      if (command === "variables") { return variables.promise; }
      throw new Error(`Unexpected DAP request: ${command}`);
    }
  };
  const hooks = debugHooks(session, (info) => posts.push({ info, variablesSettled }));
  registerCustomConsoleDebugEvents([], hooks);

  mockState.debugListeners.get("customEvent")({ body: { reason: "step", threadId: 7 }, event: "stopped", session });
  await waitFor(() => posts.length >= 1);

  assert.equal(posts[0].variablesSettled, false, "the location must render while the variables request is still pending");
  assert.deepEqual(posts[0].info.frame, { column: 3, line: 42, name: "shell expression", path: "<django-shell>", sourceLine: "" });
  assert.equal(posts[0].info.scopes, undefined, "the first paused payload is location-only");
  assert.equal(requests.filter((command) => command === "stackTrace").length, 1, "stack logging and presentation share one stackTrace request");

  await waitFor(() => requests.includes("variables"));
  assert.equal(posts.length, 1, "scope loading cannot publish a duplicate frame before variables settle");
  variablesSettled = true;
  variables.resolve({ variables: [{ name: "count", type: "int", value: "1", variablesReference: 0 }] });
  await waitFor(() => posts.some((post) => post.info.scopes?.length));

  const settled = posts.find((post) => post.info.scopes?.length);
  assert.equal(settled.info.frame.line, 42);
  assert.equal(settled.info.scopes[0].name, "Locals");
  assert.deepEqual(settled.info.scopes[0].variables.map((variable) => [variable.name, variable.value]), [["count", "1"]]);
  assert.deepEqual(requests, ["stackTrace", "scopes", "variables"], "a scalar scope needs no evaluate preview request");
});

test("cancels idle variable inspection when the user continues stepping", async () => {
  const requests = [];
  const posts = [];
  const session = {
    configuration: { __djangoShellSession: true }, id: "rapid-step-session", type: "python",
    customRequest(command) {
      requests.push(command);
      if (command === "stackTrace") { return Promise.resolve({ stackFrames: [{ id: 41, line: 9, name: "cell", source: { name: "<django-shell>" } }] }); }
      if (command === "scopes") { return Promise.resolve({ scopes: [] }); }
      throw new Error(`Unexpected DAP request: ${command}`);
    }
  };
  registerCustomConsoleDebugEvents([], debugHooks(session, (info) => posts.push(info)));

  mockState.debugListeners.get("customEvent")({ body: { reason: "step", threadId: 8 }, event: "stopped", session });
  await waitFor(() => posts.some((info) => info.frame?.line === 9));
  mockState.debugListeners.get("customEvent")({ body: { allThreadsContinued: true, threadId: 8 }, event: "continued", session });
  await new Promise((resolve) => setTimeout(resolve, 1300));

  assert.deepEqual(requests, ["stackTrace"], "rapid next requests cancel scopes before they enter the DAP queue");
});

/** Builds the debug-event hooks used by one active shell session. */
function debugHooks(session, postInfo) {
  return {
    consumeRunOnSessionStart: () => false,
    getSession: () => session,
    interruptExecution: async () => undefined,
    lastControlAction: () => "stepOver",
    postInfo,
    postStatus: () => undefined,
    refreshBreakpoints: () => undefined,
    runCurrentInput: async () => "unused",
    setPausedThread: () => undefined,
    setSession: () => undefined,
    shouldRefocusOverlay: () => false,
    syncBreakpoints: async () => undefined
  };
}

/** Creates the minimal VS Code debug event surface used by the stopped-frame handler. */
function createVscodeMock() {
  const listen = (name) => (listener) => {
    mockState.debugListeners.set(name, listener);
    return { dispose: () => mockState.debugListeners.delete(name) };
  };
  return {
    debug: {
      onDidChangeActiveDebugSession: listen("activeSession"),
      onDidChangeActiveStackItem: listen("activeStack"),
      onDidChangeBreakpoints: listen("breakpoints"),
      onDidReceiveDebugSessionCustomEvent: listen("customEvent"),
      onDidStartDebugSession: listen("start"),
      onDidTerminateDebugSession: listen("terminate"),
      registerDebugAdapterTrackerFactory: () => ({ dispose() {} })
    },
    workspace: { workspaceFolders: [] }
  };
}

/** Creates a manually controlled promise for one delayed DAP response. */
function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

/** Waits until an asynchronous debug-event side effect becomes observable. */
async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.equal(predicate(), true, "timed out waiting for the debug inspection phase");
}

// Unit tests for cross-extension overlay hover anchor normalization and refiring.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import NodeModule from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const commandHandlers = new Map();
let commandRegistrations = 0;

/** Minimal URI implementation used by the compiled handshake module. */
class Uri {
  /** Stores one URI string. */
  constructor(value) { this.scheme = value.split(":", 1)[0]; this.value = value; }
  /** Returns whether a value is one of the mocked URI objects. */
  static isUri(value) { return value instanceof Uri; }
  /** Parses one URI string. */
  static parse(value) { return new Uri(value); }
  /** Returns the serialized URI. */
  toString() { return this.value; }
}

/** Minimal disposable implementation used by command registration. */
class Disposable {
  /** Stores one cleanup callback. */
  constructor(cleanup = () => undefined) { this.cleanup = cleanup; }
  /** Combines child disposables. */
  static from(...items) { return new Disposable(() => items.forEach((item) => item.dispose())); }
  /** Runs this disposable's cleanup callback. */
  dispose() { this.cleanup(); }
}

const vscodeMock = {
  commands: {
    /** Captures one command handler for direct unit invocation. */
    registerCommand(command, handler) {
      commandRegistrations += 1;
      commandHandlers.set(command, handler);
      return new Disposable(() => commandHandlers.delete(command));
    }
  },
  Disposable,
  Uri
};

const originalLoad = NodeModule._load;
let handshake;
try {
  NodeModule._load = function loadWithVscodeMock(request, parent, isMain) {
    if (request === "vscode") { return vscodeMock; }
    return originalLoad.call(this, request, parent, isMain);
  };
  handshake = require("../out/overlayHoverHandshake.js");
} finally {
  NodeModule._load = originalLoad;
}

const analysisUri = Uri.parse("file:///workspace/.django-shell/analysis.py");
const editorUri = Uri.parse("file:///workspace/.django-shell/console-cell.py");
const endpoint = { analysisUri, editorUri, lineOffset: () => 4 };

test("normalizes analysis anchors to visible overlay positions", () => {
  const result = handshake.normalizeOverlayHoverAnchor({ character: 7, line: 10, uri: analysisUri }, endpoint);

  assert.deepEqual(result, { character: 7, handled: true, line: 6, uri: editorUri });
});

test("keeps visible editor anchors unchanged and declines foreign or prelude anchors", () => {
  assert.deepEqual(
    handshake.normalizeOverlayHoverAnchor({ character: 3, line: 2, uri: editorUri }, endpoint),
    { character: 3, handled: true, line: 2, uri: editorUri }
  );
  assert.deepEqual(
    handshake.normalizeOverlayHoverAnchor({ character: 0, line: 3, uri: analysisUri }, endpoint),
    { handled: false }
  );
  assert.deepEqual(
    handshake.normalizeOverlayHoverAnchor({ character: 0, line: 8, uri: Uri.parse("file:///workspace/app/models.py") }, endpoint),
    { handled: false }
  );
});

test("refire expression settles native hover before focusing and showing the overlay hover", async () => {
  const actions = [];
  const positions = [];
  let focusCount = 0;
  const editor = {
    focus() { focusCount += 1; },
    getModel: () => ({ uri: editorUri }),
    setPosition(position) { positions.push(position); },
    trigger(source, action) { actions.push({ action, source }); }
  };
  const root = { __djangoShellEditor: editor, __dsoHasActiveConsoleGroup: true, __dsoOwnerToken: "owner-a", style: { display: "block", visibility: "visible" } };
  const document = { getElementById: (id) => id === "django-shell-overlay" ? root : undefined };
  const expression = handshake.overlayHoverRefireExpression("owner-a", { character: 5, line: 8, uri: editorUri });

  const result = await Function("document", `return ${expression};`)(document);

  assert.equal(result, "overlay-hover-refired");
  assert.deepEqual(actions, [
    { action: "editor.action.hideHover", source: "django-shell-hover-handshake" },
    { action: "editor.action.showHover", source: "django-shell-hover-handshake" }
  ]);
  assert.deepEqual(positions, [{ column: 6, lineNumber: 9 }]);
  assert.equal(focusCount, 1);
  assert.ok(expression.includes("setTimeout(resolve,60)"));
});

test("refire expression rejects the wrong owner, hidden roots, and foreign models", async () => {
  const editor = { getModel: () => ({ uri: editorUri }), setPosition() {}, trigger() { throw new Error("must not trigger"); } };
  const evaluate = (owner, root) => Function("document", `return ${handshake.overlayHoverRefireExpression(owner, { character: 0, line: 0, uri: editorUri })};`)({ getElementById: () => root });

  assert.equal(await evaluate("owner-b", { __djangoShellEditor: editor, __dsoOwnerToken: "owner-a", style: {} }), "owner-mismatch");
  assert.equal(await evaluate("owner-a", { __djangoShellEditor: editor, __dsoOwnerToken: "owner-a", style: { display: "none" } }), "overlay-hidden");
  assert.equal(await evaluate("owner-a", { __djangoShellEditor: { ...editor, getModel: () => ({ uri: analysisUri }) }, __dsoOwnerToken: "owner-a", style: {} }), "overlay-model-mismatch");
});

test("registers one command pair per context and removes disposed overlay endpoints", async () => {
  const context = { subscriptions: [] };
  const root = { __dsoHasActiveConsoleGroup: true, __dsoOwnerToken: "owner-a", style: {} };
  const document = { getElementById: () => root };
  const editor = { focus() {}, getModel: () => ({ uri: editorUri }), setPosition() {}, trigger() {} };
  root.__djangoShellEditor = editor;
  const registration = handshake.registerOverlayHoverHandshake(context, {
    ...endpoint,
    evaluate: (expression) => Function("document", `return ${expression};`)(document),
    ownerToken: "owner-a"
  });
  const staleRegistration = handshake.registerOverlayHoverHandshake(context, {
    ...endpoint,
    evaluate: async () => "owner-mismatch",
    ownerToken: "owner-stale"
  });

  assert.equal(commandRegistrations, 2);
  assert.equal(context.subscriptions.length, 1);
  const resolved = await commandHandlers.get("djangoShell.resolveOverlayHoverAnchor")({ character: 2, line: 9, uri: analysisUri });
  assert.deepEqual(resolved, { character: 2, handled: true, line: 5, uri: editorUri });
  assert.deepEqual(await commandHandlers.get("djangoShell.refireOverlayHover")(resolved), { handled: true });

  staleRegistration.dispose();
  registration.dispose();
  assert.deepEqual(await commandHandlers.get("djangoShell.resolveOverlayHoverAnchor")({ character: 2, line: 9, uri: analysisUri }), { handled: false });
});

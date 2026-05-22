// Unit tests for overlay renderer Enter event handling.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { overlaySyncRendererSource } = require("../out/workbenchOverlaySyncRenderer.js");

test("runs Python from lightweight Monaco Enter handling", async () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const editor = fakeEditor(fakeModel("x = 1\n"));
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const posts = [];
  const root = {};
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });

  assert.equal(typeof keyHandler, "function");
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(posts.some((payload) => payload.type === "run" && payload.code === "x = 1"));
});

test("leaves Enter to IntelliSense while parameter hints are visible", () => {
  const source = overlaySyncRendererSource();
  const node = { classList: { contains: (name) => name === "parameter-hints-widget" || name === "visible" }, getBoundingClientRect: () => ({ height: 80, width: 240 }) };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [node], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { suggestOpen: __dsoSuggestOpen };`)(window, document, () => undefined);

  assert.equal(api.suggestOpen(), true);
});

test("does not run Python while completion UI owns Enter", async () => {
  const source = overlaySyncRendererSource();
  const node = { classList: { contains: (name) => name === "suggest-widget" || name === "visible" }, getBoundingClientRect: () => ({ height: 80, width: 240 }) };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [node], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const editor = fakeEditor(fakeModel("Company.objects.count()\n"));
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const posts = [];
  const root = {};

  api.installEnterRunner(root, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(posts.some((payload) => payload.type === "run"), false);
});

test("runs Python when stale suggest DOM is not visible", async () => {
  const source = overlaySyncRendererSource();
  const node = { classList: { contains: (name) => name === "suggest-widget" }, getBoundingClientRect: () => ({ height: 80, width: 240 }) };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [node], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const editor = fakeEditor(fakeModel("print(1)\n"));
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const posts = [];

  api.installEnterRunner({}, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(posts.some((payload) => payload.type === "run" && payload.code === "print(1)"), true);
});

test("indents multiline blocks when backend reports incomplete Python", async () => {
  const source = overlaySyncRendererSource();
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const editor = fakeEditor(fakeModel("if True:\n"));
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const edits = [];
  editor.executeEdits = (_source, value) => edits.push(...value);

  api.installEnterRunner({}, editor, () => ({ json: async () => ({ executed: false }) }));
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(edits.some((edit) => edit.text === "\n    "));
});

test("indents explicit Shift Enter continuations", () => {
  const source = overlaySyncRendererSource();
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const editor = fakeEditor(fakeModel("for item in items:\n"));
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const edits = [];
  editor.executeEdits = (_source, value) => edits.push(...value);

  api.installEnterRunner({}, editor, () => ({ json: async () => ({ executed: true }) }));
  keyHandler(monacoEnterEvent({ shiftKey: true }));

  assert.ok(edits.some((edit) => edit.text === "\n    "));
});

function fakeEditor(model) {
  return {
    addCommand: undefined,
    executeEdits() {},
    getDomNode: () => ({ addEventListener() {}, classList: { contains: () => false }, contains: () => true, removeEventListener() {} }),
    getModel: () => model,
    getPosition: () => ({ column: 1, lineNumber: 1 }),
    getSelection: () => ({ endColumn: 1, endLineNumber: 1, startColumn: 1, startLineNumber: 1 }),
    onKeyDown: () => ({ dispose() {} }),
    revealLineInCenterIfOutsideViewport() {},
    setPosition() {}
  };
}

function monacoEnterEvent(overrides = {}) {
  const raw = { code: "Enter", key: "Enter", preventDefault() {}, shiftKey: false, stopImmediatePropagation() {}, stopPropagation() {}, ...overrides };
  return {
    browserEvent: raw,
    keyCode: 3,
    preventDefault() {},
    shiftKey: Boolean(raw.shiftKey),
    stopImmediatePropagation() {},
    stopPropagation() {}
  };
}

function fakeModel(initialText) {
  let text = initialText;
  const lines = () => text.split("\n");
  return {
    getLineContent: (line) => lines()[line - 1] ?? "",
    getLineCount: () => lines().length,
    getLineMaxColumn(line) { return this.getLineContent(line).length + 1; },
    getValue: () => text,
    getValueInRange(range) { return lines().slice(range.startLineNumber - 1, range.endLineNumber).join("\n").trimEnd(); },
    setValue: (next) => { text = next; }
  };
}

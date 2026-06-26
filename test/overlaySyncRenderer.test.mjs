// Unit tests for overlay renderer Enter event handling.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { overlayRendererSource } = require("../out/workbenchOverlayRenderer.js");
const { overlaySyncRendererSource } = require("../out/workbenchOverlaySyncRenderer.js");
const { overlayPythonRangeRendererSource } = require("../out/workbenchOverlayPythonRangeRenderer.js");

test("emits parseable workbench overlay renderer source", () => {
  assert.equal(typeof Function(overlayRendererSource("file:///tmp/console-cell.py")), "function");
});

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
  const runPayload = posts.find((payload) => payload.type === "run" && payload.code === "x = 1");
  assert.ok(runPayload);
  assert.deepEqual(runPayload.range, { end: 1, start: 1 });
  assert.equal(runPayload.text, "x = 1\n");
  assert.deepEqual(editor.getPosition(), { column: 1, lineNumber: 3 });
});

test("sends full overlay text while running only the selected source", async () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const text = "pass\n# --- django shell input ---\nfirst = 1\nsecond = first + 1\nthird = second + 1\n";
  const editor = fakeEditor(fakeModel(text), { column: 1, lineNumber: 4 });
  editor.getSelection = () => ({ endColumn: 19, endLineNumber: 4, startColumn: 1, startLineNumber: 4 });
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const posts = [];
  const root = { __dsoInputStartLine: 3 };
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));

  const runPayload = posts.find((payload) => payload.type === "run");
  assert.equal(runPayload.code, "second = first + 1");
  assert.deepEqual(runPayload.range, { end: 2, start: 2 });
  assert.equal(runPayload.text, text);
});

test("preserves pasted multiline source with internal blank lines", async () => {
  const source = overlaySyncRendererSource();
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const code = "def build():\n    value = 1\n\n    return value\n\nprint(build())\n";
  const editor = fakeEditor(fakeModel(code), { column: 1, lineNumber: 7 });
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const posts = [];

  api.installEnterRunner({}, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(posts.some((payload) => payload.type === "run" && payload.code === code.trimEnd()));
});

test("keeps leading import block with two blank lines in pasted source", async () => {
  const source = overlaySyncRendererSource();
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const code = "from pathlib import (\n    Path,\n)\n\n\ndef build():\n    return Path.cwd()\n";
  const editor = fakeEditor(fakeModel(code), { column: 1, lineNumber: 8 });
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const posts = [];

  api.installEnterRunner({}, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(posts.some((payload) => payload.type === "run" && payload.code === code.trimEnd()));
});

test("keeps import block continuation after an earlier cell separator", async () => {
  const source = overlaySyncRendererSource();
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const code = "print('old')\n\n\nimport os\n\n\nprint(os.name)\n";
  const editor = fakeEditor(fakeModel(code), { column: 1, lineNumber: 8 });
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const posts = [];

  api.installEnterRunner({}, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));

  const runPayload = posts.find((payload) => payload.type === "run" && payload.code === "import os\n\n\nprint(os.name)");
  assert.ok(runPayload);
  assert.deepEqual(runPayload.range, { end: 7, start: 4 });
});

test("previews the current Enter execution range with editor decorations", () => {
  const source = overlaySyncRendererSource();
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  const code = "print('old')\n\n\nimport os\n\n\nprint(os.name)\n";
  const editor = fakeEditor(fakeModel(code), { column: 1, lineNumber: 8 });
  const root = {};

  api.installEnterRunner(root, editor, () => ({ json: async () => ({ executed: true }) }));

  const rangeDecoration = editor.decorations.find((item) => item.options.className === "dso-exec-range");
  assert.deepEqual(root.__dsoExecutionRangePreview, { end: 7, start: 4 });
  assert.equal(rangeDecoration.options.linesDecorationsClassName, "dso-exec-range-rail");
  assert.equal(rangeDecoration.range.startLineNumber, 4);
  assert.equal(rangeDecoration.range.endLineNumber, 7);
  assert.equal(editor.options.lineNumbers(4), ">>>");
  assert.equal(editor.options.lineNumbers(5), "...");
});

test("draws breakpoint line markers and posts gutter breakpoint toggles", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner, setBreakpoints: window.__dsoSetOverlayBreakpoints, setPrelude: window.__djangoShellOverlaySetPrelude };`)(window, document, () => undefined);
  let mouseHandler;
  const editor = fakeEditor(fakeModel("one\ntwo\nthree\nfour\n"));
  editor.onMouseDown = (callback) => { mouseHandler = callback; return { dispose() {} }; };
  const posts = [];
  const root = { __djangoShellEditor: editor };
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  assert.equal(api.setBreakpoints([2, 4, 99]), "breakpoints:2");
  assert.equal(editor.decorations.filter((item) => item.options.className === "dso-breakpoint-line").length, 2);
  mouseHandler({ event: { preventDefault() {}, stopPropagation() {} }, target: { position: { lineNumber: 3 }, type: 2 } });

  assert.equal(editor.decorations.filter((item) => item.options.className === "dso-breakpoint-line").length, 3);
  assert.equal(editor.decorations.filter((item) => item.options.glyphMarginClassName).length, 0);
  assert.equal(editor.decorations.filter((item) => item.options.linesDecorationsClassName).length, 0);
  assert.equal(editor.options.glyphMargin, false);
  assert.equal(editor.options.lineDecorationsWidth, 0);
  assert.equal(editor.options.lineNumbersMinChars, 1);
  assert.deepEqual(posts.find((payload) => payload.type === "toggleBreakpoint"), { column: 0, inline: false, inputStartLine: 1, line: 3, rawColumn: 0, rawLine: 3, source: "monaco", type: "toggleBreakpoint" });
});

test("maps relative breakpoint lines onto hidden-prelude model lines", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner, setBreakpoints: window.__dsoSetOverlayBreakpoints, setPrelude: window.__djangoShellOverlaySetPrelude };`)(window, document, () => undefined);
  let mouseHandler;
  const editor = fakeEditor(fakeModel("pass\n# --- django shell input ---\none\ntwo\nthree\n"));
  editor.onMouseDown = (callback) => { mouseHandler = callback; return { dispose() {} }; };
  const posts = [];
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 3, style: {} };
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  assert.equal(api.setBreakpoints([1, 2]), "breakpoints:2");
  assert.equal(api.setPrelude("from app.models import one\n"), "ok");
  assert.deepEqual(root.__dsoBreakpointModelLines, [3, 4]);
  mouseHandler({ event: { preventDefault() {}, stopPropagation() {} }, target: { position: { lineNumber: 4 }, type: 2 } });

  assert.deepEqual(root.__dsoBreakpointModelLines, [3]);
  assert.deepEqual(posts.find((payload) => payload.type === "toggleBreakpoint"), { column: 0, inline: false, inputStartLine: 3, line: 2, rawColumn: 0, rawLine: 4, source: "monaco", type: "toggleBreakpoint" });
});

test("captures DOM gutter breakpoint clicks before native breakpoint handling", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let captureHandler;
  const node = { addEventListener(type, callback, capture) { if (type === "mousedown" && capture) { captureHandler = callback; } }, classList: { contains: () => false }, contains: () => true, getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelectorAll: () => [], removeEventListener() {} };
  const editor = fakeEditor(fakeModel("pass\n# --- django shell input ---\none\ntwo\nthree\n"));
  editor.getDomNode = () => node;
  editor.getTargetAtClientPoint = () => ({ position: { lineNumber: 4 }, type: 2 });
  const calls = [];
  const posts = [];
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 3 };
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => { posts.push(payload); return { json: async () => ({ executed: true }) }; });
  captureHandler({ clientX: 10, clientY: 30, preventDefault() { calls.push("prevent"); }, stopImmediatePropagation() { calls.push("immediate"); }, stopPropagation() { calls.push("stop"); } });

  assert.deepEqual(posts.find((payload) => payload.type === "toggleBreakpoint"), { column: 0, inline: false, inputStartLine: 3, line: 2, rawColumn: 0, rawLine: 4, source: "dom-capture", type: "toggleBreakpoint" });
  assert.deepEqual(calls, ["prevent", "stop", "immediate"]);
  assert.equal(editor.options.glyphMargin, false);
  assert.equal(editor.options.lineDecorationsWidth, 0);
  assert.equal(editor.options.lineNumbersMinChars, 1);
});

test("reinstalls breakpoint capture when the patch is reapplied to the same editor", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  const handlers = [];
  const removed = [];
  const node = {
    addEventListener(type, callback, capture) { if (type === "mousedown" && capture) { handlers.push(callback); } },
    classList: { contains: () => false },
    contains: () => true,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    querySelectorAll: () => [],
    removeEventListener(type, callback, capture) { if (type === "mousedown" && capture) { removed.push(callback); } }
  };
  const editor = fakeEditor(fakeModel("pass\n# --- django shell input ---\none\ntwo\n"));
  editor.getDomNode = () => node;
  editor.getTargetAtClientPoint = () => ({ position: { lineNumber: 4 }, type: 2 });
  const posts = [];
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 3 };
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => { posts.push(payload); return { json: async () => ({ executed: true }) }; });
  api.installEnterRunner(root, editor, (payload) => { posts.push(payload); return { json: async () => ({ executed: true }) }; });
  handlers[1]({ button: 0, clientX: 10, clientY: 30, preventDefault() {}, stopImmediatePropagation() {}, stopPropagation() {} });

  assert.equal(handlers.length, 2);
  assert.equal(removed.length, 1);
  assert.deepEqual(posts.find((payload) => payload.type === "toggleBreakpoint"), { column: 0, inline: false, inputStartLine: 3, line: 2, rawColumn: 0, rawLine: 4, source: "dom-capture", type: "toggleBreakpoint" });
});

test("captures breakpoint clicks across the prompt gutter width", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let captureHandler;
  const node = { addEventListener(type, callback, capture) { if (type === "mousedown" && capture) { captureHandler = callback; } }, classList: { contains: () => false }, contains: () => true, getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelectorAll: () => [], removeEventListener() {} };
  const editor = fakeEditor(fakeModel("pass\n# --- django shell input ---\na=1\nb=2\nc=3\n"));
  editor.getDomNode = () => node;
  editor.getLayoutInfo = () => ({ contentLeft: 80 });
  editor.getTargetAtClientPoint = () => ({ position: { lineNumber: 4 }, type: 6 });
  const posts = [];
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 3 };
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => { posts.push(payload); return { json: async () => ({ executed: true }) }; });
  captureHandler({ button: 0, clientX: 58, clientY: 30, preventDefault() {}, stopImmediatePropagation() {}, stopPropagation() {} });

  assert.deepEqual(posts.find((payload) => payload.type === "toggleBreakpoint"), { column: 0, inline: false, inputStartLine: 3, line: 2, rawColumn: 0, rawLine: 4, source: "dom-capture", type: "toggleBreakpoint" });
});

test("captures root-level prompt gutter clicks and renders persistent breakpoint dots", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const created = [];
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, createElement(tag) { const element = fakeElement(tag, []); created.push(element); return element; }, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner, setBreakpoints: window.__dsoSetOverlayBreakpoints };`)(window, document, () => undefined);
  let rootCaptureHandler;
  const node = { addEventListener() {}, classList: { contains: () => false }, contains: () => true, getBoundingClientRect: () => ({ height: 160, left: 0, top: 0 }), querySelectorAll: () => [], removeEventListener() {} };
  const editor = fakeEditor(fakeModel("pass\n# --- django shell input ---\na=1\nb=2\nc=3\n"));
  editor.getDomNode = () => node;
  editor.getLayoutInfo = () => ({ contentLeft: 80 });
  editor.getTargetAtClientPoint = () => ({ position: { lineNumber: 4 }, type: 6 });
  editor.getTopForLineNumber = (line) => (line - 1) * 20;
  editor.getScrollTop = () => 0;
  const posts = [];
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 3, addEventListener(type, callback, capture) { if (type === "mousedown" && capture) { rootCaptureHandler = callback; } }, appendChild(child) { child.parentElement = root; root.children.push(child); }, children: [], getBoundingClientRect: () => ({ height: 180, left: 0, top: 0, width: 420 }), removeEventListener() {} };
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => { posts.push(payload); return { json: async () => ({ executed: true }) }; });
  assert.equal(api.setBreakpoints([2]), "breakpoints:1");

  const layer = root.children.find((item) => item.className === "dso-breakpoint-layer");
  assert.ok(layer);
  assert.equal(layer.children.length, 1);
  assert.equal(layer.children[0].className, "dso-breakpoint-dot");
  assert.equal(layer.children[0].style.top, "66px");
  assert.equal(layer.style.zIndex, "80");
  rootCaptureHandler({ button: 0, clientX: 58, clientY: 30, preventDefault() {}, stopImmediatePropagation() {}, stopPropagation() {} });

  assert.deepEqual(posts.find((payload) => payload.type === "toggleBreakpoint"), { column: 0, inline: false, inputStartLine: 3, line: 2, rawColumn: 0, rawLine: 4, source: "root-capture", type: "toggleBreakpoint" });
  assert.ok(created.some((item) => item.className === "dso-breakpoint-dot"));
});

test("captures document-level prompt gutter clicks without overlay lane hit target", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const handlers = {};
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = {
    activeElement: undefined,
    addEventListener(type, callback, capture) { if (capture) { handlers[type] = callback; } },
    createElement(tag) { return fakeElement(tag, []); },
    getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined,
    querySelectorAll: () => [],
    removeEventListener(type, callback, capture) { if (capture && handlers[type] === callback) { delete handlers[type]; } }
  };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner, setBreakpoints: window.__dsoSetOverlayBreakpoints };`)(window, document, () => undefined);
  const node = { addEventListener() {}, classList: { contains: () => false }, contains: () => false, getBoundingClientRect: () => ({ height: 160, left: 0, top: 0 }), querySelectorAll: () => [], removeEventListener() {} };
  const editor = fakeEditor(fakeModel("pass\n# --- django shell input ---\na=1\nb=2\nc=3\n"));
  editor.getDomNode = () => node;
  editor.getLayoutInfo = () => ({ contentLeft: 80 });
  editor.getTargetAtClientPoint = () => null;
  editor.getTopForLineNumber = (line) => (line - 1) * 20;
  editor.getScrollTop = () => 0;
  const posts = [];
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 3, addEventListener() {}, appendChild(child) { child.parentElement = root; root.children.push(child); }, children: [], getBoundingClientRect: () => ({ height: 180, left: 0, top: 0, width: 420 }), removeEventListener() {} };
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => { posts.push(payload); return { json: async () => ({ executed: true }) }; });
  assert.equal(api.setBreakpoints([]), "breakpoints:0");
  const layer = root.children.find((item) => item.className === "dso-breakpoint-layer");
  handlers.mousedown({ button: 0, clientX: 40, clientY: 70, preventDefault() {}, stopImmediatePropagation() {}, stopPropagation() {}, target: {} });

  assert.equal(layer.style.pointerEvents, "none");
  assert.equal(layer.style.width, "18px");
  assert.equal(layer.children.length, 1);
  assert.equal(layer.children[0].className, "dso-breakpoint-dot");
  assert.deepEqual(posts.find((payload) => payload.type === "toggleBreakpoint"), { column: 0, inline: false, inputStartLine: 3, line: 2, rawColumn: 0, rawLine: 4, source: "document-capture", type: "toggleBreakpoint" });
});

test("logs near-gutter breakpoint clicks that cannot resolve a model line", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let captureHandler;
  const node = { addEventListener(type, callback, capture) { if (type === "mousedown" && capture) { captureHandler = callback; } }, classList: { contains: () => false }, contains: () => true, getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelectorAll: () => [], removeEventListener() {} };
  const editor = fakeEditor(fakeModel("a=1\n"));
  editor.getDomNode = () => node;
  editor.getLayoutInfo = () => ({ contentLeft: 80 });
  editor.getTargetAtClientPoint = () => null;
  editor.getVisibleRanges = () => [];
  const posts = [];
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 1 };
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => { posts.push(payload); return { json: async () => ({ executed: true }) }; });
  captureHandler({ button: 0, clientX: 58, clientY: 90, preventDefault() {}, stopImmediatePropagation() {}, stopPropagation() {} });

  assert.deepEqual(posts.find((payload) => payload.event === "breakpoint.click.skip"), { event: "breakpoint.click.skip", inputStartLine: 1, laneLimit: 80, reason: "no-line", type: "log", x: 58 });
});

test("context menu can toggle inline breakpoints at the clicked column", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const buttons = [];
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, createElement(tag) { return fakeElement(tag, buttons); }, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let contextHandler;
  const node = { addEventListener(type, callback, capture) { if (type === "contextmenu" && capture) { contextHandler = callback; } }, classList: { contains: () => false }, contains: () => true, getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelectorAll: () => [], removeEventListener() {} };
  const editor = fakeEditor(fakeModel("pass\n# --- django shell input ---\none = two + three\n"));
  editor.getDomNode = () => node;
  editor.getTargetAtClientPoint = () => ({ position: { column: 7, lineNumber: 3 }, type: 6 });
  const calls = [];
  const posts = [];
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 3, appendChild(child) { child.parentElement = root; }, getBoundingClientRect: () => ({ height: 200, left: 0, top: 0, width: 400 }), removeChild(child) { child.parentElement = undefined; } };
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => { posts.push(payload); return { json: async () => ({ executed: true }) }; });
  contextHandler({ clientX: 40, clientY: 30, preventDefault() { calls.push("prevent"); }, stopImmediatePropagation() { calls.push("immediate"); }, stopPropagation() { calls.push("stop"); } });
  buttons.find((button) => button.textContent === "Toggle Inline Breakpoint").click({ preventDefault() {}, stopPropagation() {} });

  assert.deepEqual(posts.find((payload) => payload.type === "toggleBreakpoint"), { column: 7, inline: true, inputStartLine: 3, line: 1, rawColumn: 7, rawLine: 3, source: "context-menu-inline", type: "toggleBreakpoint" });
  assert.deepEqual(calls, ["prevent", "stop", "immediate"]);
});

test("maps paused debug line onto hidden-prelude model lines", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { setDebugLine: window.__dsoSetOverlayDebugLine };`)(window, document, () => undefined);
  const editor = fakeEditor(fakeModel("pass\n# --- django shell input ---\none\ntwo\nthree\n"));
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 3 };
  state.overlayRoot = root;

  assert.equal(api.setDebugLine(2), "debug-line:2");

  assert.deepEqual(editor.decorations.map((item) => item.range.startLineNumber), [4]);
  assert.equal(editor.decorations[0].options.className, "dso-debug-line");
});

test("skips the current execution range on Alt Enter without running Python", () => {
  const source = overlaySyncRendererSource();
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const editor = fakeEditor(fakeModel("print('old')\n\n\nprint('next')\n"), { column: 1, lineNumber: 1 });
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const posts = [];
  const root = {};

  api.installEnterRunner(root, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  keyHandler(monacoEnterEvent({ altKey: true }));

  assert.equal(posts.some((payload) => payload.type === "run"), false);
  assert.deepEqual(editor.getPosition(), { column: 1, lineNumber: 4 });
  assert.deepEqual(root.__dsoExecutionRangePreview, { end: 4, start: 4 });
});

test("keeps continuation prompts across single blank lines inside pasted multiline input", () => {
  const source = overlayPythonRangeRendererSource();
  const api = Function(`${source}\nreturn { promptForLine: __dsoPromptForLine };`)();
  const model = fakeModel("def build():\n    value = 1\n\n    return value\n\nprint(build())\n");

  assert.equal(api.promptForLine(model, 1, 1, {}), ">>>");
  assert.equal(api.promptForLine(model, 1, 3, {}), "...");
  assert.equal(api.promptForLine(model, 1, 4, {}), "...");
  assert.equal(api.promptForLine(model, 1, 5, {}), "...");
  assert.equal(api.promptForLine(model, 1, 6, {}), "...");
});

test("keeps continuation prompts after import blocks with two blank lines", () => {
  const source = overlayPythonRangeRendererSource();
  const api = Function(`${source}\nreturn { promptForLine: __dsoPromptForLine };`)();
  const model = fakeModel("print('old')\n\n\nimport os\n\n\nprint(os.name)\n");

  assert.equal(api.promptForLine(model, 1, 4, {}), ">>>");
  assert.equal(api.promptForLine(model, 1, 5, {}), "...");
  assert.equal(api.promptForLine(model, 1, 6, {}), "...");
  assert.equal(api.promptForLine(model, 1, 7, {}), "...");
});

test("uses the live execution preview for prompt starts", () => {
  const source = overlayPythonRangeRendererSource();
  const api = Function(`${source}\nreturn { promptForLine: __dsoPromptForLine };`)();
  const model = fakeModel("import os\n\n\nprint(os.name)\n");
  const root = { __dsoExecutionRangePreview: { end: 4, start: 4 } };

  assert.equal(api.promptForLine(model, 1, 1, root), ">>>");
  assert.equal(api.promptForLine(model, 1, 4, root), ">>>");
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

function fakeEditor(model, position = { column: 1, lineNumber: 1 }) {
  const editor = {
    addCommand: undefined,
    decorations: [],
    deltaDecorations(_oldDecorations, decorations) {
      this.decorations = decorations;
      return decorations.map((_item, index) => String(index));
    },
    executeEdits() {},
    getDomNode: () => ({ addEventListener() {}, classList: { contains: () => false }, contains: () => true, querySelectorAll: () => [], removeEventListener() {} }),
    getModel: () => model,
    getPosition: () => position,
    getSelection: () => ({ endColumn: position.column, endLineNumber: position.lineNumber, startColumn: position.column, startLineNumber: position.lineNumber }),
    onDidChangeCursorPosition(callback) { this.cursorListener = callback; return { dispose() {} }; },
    onKeyDown: () => ({ dispose() {} }),
    revealLineInCenterIfOutsideViewport() {},
    setPosition(next) { position = next; if (this.cursorListener) { this.cursorListener(); } },
    updateOptions(options) { this.options = { ...(this.options || {}), ...options }; }
  };
  return editor;
}

function fakeElement(tag, buttons) {
  let text = "";
  const element = {
    addEventListener(type, callback) { element.listeners[type] = callback; if (type === "click") { element.click = callback; } },
    appendChild(child) { child.parentElement = element; element.children.push(child); },
    children: [],
    className: "",
    contains(child) { return child === element || element.children.includes(child); },
    get textContent() { return text; },
    listeners: {},
    parentElement: undefined,
    removeChild(child) { child.parentElement = undefined; },
    removeEventListener(type, callback) { if (element.listeners[type] === callback) { delete element.listeners[type]; } },
    style: {},
    set textContent(value) { text = String(value); if (text === "") { element.children.length = 0; } },
    type: ""
  };
  if (tag === "button") { buttons.push(element); }
  return element;
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
  const listeners = [];
  const lines = () => text.split("\n");
  return {
    getLineContent: (line) => lines()[line - 1] ?? "",
    getLineCount: () => lines().length,
    getLineMaxColumn(line) { return this.getLineContent(line).length + 1; },
    getValue: () => text,
    getValueInRange(range) { return lines().slice(range.startLineNumber - 1, range.endLineNumber).join("\n").trimEnd(); },
    onDidChangeContent: (listener) => { listeners.push(listener); return { dispose() {} }; },
    setValue: (next) => { text = next; for (const listener of listeners) { listener(); } }
  };
}

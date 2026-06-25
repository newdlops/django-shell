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

test("draws breakpoint glyphs and posts gutter breakpoint toggles", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner, setBreakpoints: window.__dsoSetOverlayBreakpoints };`)(window, document, () => undefined);
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
  mouseHandler({ event: { preventDefault() {}, stopPropagation() {} }, target: { position: { lineNumber: 3 }, type: 2 } });

  assert.equal(editor.decorations.filter((item) => item.options.glyphMarginClassName === "dso-breakpoint-glyph").length, 2);
  assert.deepEqual(posts.find((payload) => payload.type === "toggleBreakpoint"), { line: 3, type: "toggleBreakpoint" });
});

test("maps relative breakpoint lines onto hidden-prelude model lines", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner, setBreakpoints: window.__dsoSetOverlayBreakpoints };`)(window, document, () => undefined);
  let mouseHandler;
  const editor = fakeEditor(fakeModel("pass\n# --- django shell input ---\none\ntwo\nthree\n"));
  editor.onMouseDown = (callback) => { mouseHandler = callback; return { dispose() {} }; };
  const posts = [];
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 3 };
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  assert.equal(api.setBreakpoints([1, 2]), "breakpoints:2");
  mouseHandler({ event: { preventDefault() {}, stopPropagation() {} }, target: { position: { lineNumber: 4 }, type: 2 } });

  assert.deepEqual(editor.decorations.filter((item) => item.options.glyphMarginClassName === "dso-breakpoint-glyph").map((item) => item.range.startLineNumber), [3, 4]);
  assert.deepEqual(posts.find((payload) => payload.type === "toggleBreakpoint"), { line: 2, type: "toggleBreakpoint" });
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
    getDomNode: () => ({ addEventListener() {}, classList: { contains: () => false }, contains: () => true, removeEventListener() {} }),
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

// Unit tests for overlay renderer Enter event handling.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { overlayRendererSource } = require("../out/workbenchOverlayRenderer.js");
const { overlaySyncRendererSource } = require("../out/workbenchOverlaySyncRenderer.js");
const { overlayPythonRangeRendererSource } = require("../out/workbenchOverlayPythonRangeRenderer.js");
const { overlayWidgetRendererSource } = require("../out/workbenchOverlayWidgetRenderer.js");

test("routes popup file links through the bridge and leaves command links to the workbench", () => {
  const source = overlayWidgetRendererSource();
  const window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 0 };
  const document = { addEventListener() {}, body: {}, getElementById: () => undefined, head: { appendChild() {} }, createElement: () => ({ style: {} }), querySelector: () => undefined, querySelectorAll: () => [], removeEventListener() {} };
  const posts = [];
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installRouter: __dsoInstallWidgetLinkRouter };`)(window, document, (payload) => posts.push(payload));
  let clickHandler;
  let captured = false;
  const layerRoot = { addEventListener(type, callback, capture) { if (type === "click") { clickHandler = callback; captured = capture; } } };
  api.installRouter({ __dsoWidgetRoot: layerRoot });
  assert.equal(typeof clickHandler, "function");
  assert.equal(captured, true);
  assert.equal(layerRoot.__dsoLinkRouterInstalled, true);

  const fileAnchor = { getAttribute: (name) => name === "data-href" ? "file:///work/app/models.py#L10,5" : "" };
  const fileEvent = { prevented: false, stopped: false, target: { closest: () => fileAnchor }, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  clickHandler(fileEvent);
  assert.deepEqual(posts, [{ type: "openLink", href: "file:///work/app/models.py#L10,5" }]);
  assert.equal(fileEvent.prevented, true);
  assert.equal(fileEvent.stopped, true);

  const commandAnchor = { getAttribute: (name) => name === "data-href" ? "command:editor.action.showHover" : "" };
  const commandEvent = { prevented: false, stopped: false, target: { closest: () => commandAnchor }, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  clickHandler(commandEvent);
  assert.equal(posts.length, 1);
  assert.equal(commandEvent.prevented, false);
  assert.equal(commandEvent.stopped, false);

  // A second install on the same layer must not stack duplicate listeners.
  let reinstalls = 0;
  layerRoot.addEventListener = () => { reinstalls += 1; };
  api.installRouter({ __dsoWidgetRoot: layerRoot });
  assert.equal(reinstalls, 0);
});

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

test("query submit mode leaves plain Enter to Monaco and runs the whole document on Ctrl/Cmd Enter", async () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const code = "from app.models import Company\n\nCompany.objects.filter(active=True)\n";
  const editor = fakeEditor(fakeModel(code), { column: 10, lineNumber: 3 });
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const posts = [];
  const root = { __dsoExecutionMode: "submit", __dsoInputStartLine: 1 };
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  keyHandler(monacoEnterEvent());
  assert.equal(posts.some((payload) => payload.type === "run"), false);

  keyHandler(monacoEnterEvent({ ctrlKey: true }));
  await new Promise((resolve) => setImmediate(resolve));
  const runPayload = posts.find((payload) => payload.type === "run");
  assert.equal(runPayload.code, code.trimEnd());
  assert.deepEqual(runPayload.range, { end: 4, start: 1 });
  assert.equal(runPayload.text, code);
  assert.deepEqual(editor.getPosition(), { column: 10, lineNumber: 3 });
  assert.equal(root.__dsoExecutionRangePreview, null);
  assert.equal(editor.options.lineNumbers, "on");
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
  assert.equal(rangeDecoration.options.isWholeLine, true);
  assert.equal(rangeDecoration.options.linesDecorationsClassName, undefined);
  assert.equal(editor.decorations.some((item) => item.options.linesDecorationsClassName === "dso-exec-range-rail"), false);
  assert.equal(rangeDecoration.range.startLineNumber, 4);
  assert.equal(rangeDecoration.range.endLineNumber, 7);
  assert.equal(rangeDecoration.range.startColumn, 1);
  assert.equal(editor.options.lineNumbers(4), ">>>");
  assert.equal(editor.options.lineNumbers(5), "...");
});

test("reveals breakpoint lines as glyph-margin dots while leaving breakpoint SETTING native", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const events = [];
  const window = { addEventListener(type, _callback, capture) { events.push({ capture: !!capture, target: "window", type }); }, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener(type, _callback, capture) { events.push({ capture: !!capture, target: "document", type }); }, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installBreakpointToggle: window.__dsoInstallBreakpointToggle, setBreakpoints: window.__dsoSetOverlayBreakpoints };`)(window, document, () => undefined);
  let mouseHandler;
  const node = { addEventListener(type, _callback, capture) { events.push({ capture: !!capture, target: "node", type }); }, classList: { contains: () => false }, contains: () => true, querySelectorAll: () => [], removeEventListener() {} };
  const editor = fakeEditor(fakeModel("one\ntwo\nthree\nfour\n"));
  editor.onMouseDown = (callback) => { mouseHandler = callback; return { dispose() {} }; };
  editor.getDomNode = () => node;
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 1 };
  state.overlayRoot = root;

  api.setBreakpoints([2, 4]);

  // Reveal: each breakpoint line is marked whole-line (no extra glyph-margin dot).
  assert.equal(typeof api.setBreakpoints, "function");
  const lineMarks = editor.decorations.filter((item) => item.options.className === "dso-breakpoint-line" && item.options.isWholeLine);
  assert.equal(lineMarks.length, 2);
  assert.deepEqual(lineMarks.map((item) => item.range.startLineNumber).sort((a, b) => a - b), [2, 4]);
  assert.equal(editor.decorations.some((item) => item.options.glyphMarginClassName === "dso-breakpoint"), false);
  // Setting stays native: no custom toggle API, no mouse/context handlers.
  assert.equal(api.installBreakpointToggle, undefined);
  assert.equal(mouseHandler, undefined);
  assert.equal(events.some((event) => event.type === "mousedown" || event.type === "contextmenu"), false);
});

test("strips legacy prelude markers instead of hiding user import lines", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, queueMicrotask(callback) { callback(); }, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { applyPrelude: window.__dsoApplyPreludeHiddenArea };`)(window, document, () => undefined);
  const prelude = "from app.models import Company\n";
  const model = fakeModel(`${prelude}# --- django shell input ---\nfrom app.models import Company\nCompany.objects\n`);
  const rendered = [
    { style: { top: "0px" }, textContent: "from app.models import Company" },
    { style: { top: "18px" }, textContent: "Company.objects" }
  ];
  const node = { querySelector: () => undefined, querySelectorAll: () => rendered };
  const editor = fakeEditor(model);
  editor.getDomNode = () => node;
  editor.getVisibleRanges = () => [];
  editor.setHiddenAreas = (areas) => { editor.hiddenAreas = areas; };
  const root = { __djangoShellEditor: editor, __dsoPreludeText: prelude, style: {} };
  state.overlayRoot = root;
  window.__djangoShellOverlayPrelude = prelude;

  api.applyPrelude(root, editor);

  assert.deepEqual(editor.hiddenAreas, []);
  assert.equal(model.getValue(), "from app.models import Company\nCompany.objects\n");
  assert.equal(rendered[0].style.display || "", "");
  assert.equal(rendered[1].style.display || "", "");
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

test("keeps shell debug and breakpoint decorations out of query submit mode", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "", __dsoOverlayBreakpointLines: [1, 3], __dsoOverlayDebugLine: 2 };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { applyBreakpoints: window.__dsoApplyOverlayBreakpoints, applyDebugLine: window.__dsoApplyOverlayDebugLine };`)(window, document, () => undefined);
  const editor = fakeEditor(fakeModel("one\ntwo\nthree\n"));
  const root = { __djangoShellEditor: editor, __dsoExecutionMode: "submit", __dsoInputStartLine: 1 };
  state.overlayRoot = root;

  assert.equal(api.applyDebugLine(root, editor), "debug-line:0");
  assert.deepEqual(editor.decorations, []);
  assert.equal(api.applyBreakpoints(root, editor), "breakpoints:0");
  assert.deepEqual(editor.decorations, []);
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

test("reveals the cursor after typing or moving inside a growing overlay input", () => {
  const source = overlaySyncRendererSource();
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  const model = fakeModel("one\ntwo\nthree\n");
  const editor = fakeEditor(model, { column: 1, lineNumber: 1 });

  api.installEnterRunner({}, editor, () => undefined);
  editor.revealedPositions.length = 0;
  editor.setPosition({ column: 6, lineNumber: 3 });
  assert.deepEqual(editor.revealedPositions.at(-1), { column: 6, lineNumber: 3 });

  editor.revealedPositions.length = 0;
  model.setValue("one\ntwo\nthree\nfour\nfive\n");
  assert.deepEqual(editor.revealedPositions.at(-1), { column: 6, lineNumber: 3 });
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
    revealedLines: [],
    revealedPositions: [],
    revealLineInCenterIfOutsideViewport(lineNumber) { this.revealedLines.push(lineNumber); },
    revealPositionInCenterIfOutsideViewport(next) { this.revealedPositions.push(next); },
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

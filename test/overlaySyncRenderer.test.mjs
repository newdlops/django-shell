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

test("parks and restores only the owner-matched body widget portal", () => {
  const source = overlayWidgetRendererSource();
  const values = new Map();
  const priorities = new Map();
  const attributes = new Map();
  const style = {
    display: "",
    visibility: "",
    removeProperty(name) { values.delete(name); priorities.delete(name); },
    setProperty(name, value, priority) { values.set(name, value); priorities.set(name, priority); }
  };
  const portal = {
    dataset: { djangoShellOverlayOwner: "owner-a" },
    isConnected: true,
    parentElement: { removeChild(node) { node.isConnected = false; } },
    removeAttribute(name) { attributes.delete(name); },
    setAttribute(name, value) { attributes.set(name, value); },
    style
  };
  const document = { getElementById: (id) => id === "django-shell-overlay-widget-root" ? portal : undefined };
  const window = { __djangoShellOverlayOwnerToken: "owner-a" };
  const actions = [];
  let editorBlurs = 0;
  let inputBlurs = 0;
  const editor = { blur() { editorBlurs += 1; }, getDomNode: () => ({ querySelector: () => ({ blur() { inputBlurs += 1; } }) }), trigger(_source, action) { actions.push(action); } };
  const root = { __djangoShellEditor: editor, __dsoHasActiveConsoleGroup: true, __dsoOwnerToken: "owner-a", __dsoWidgetRoot: portal, style: { display: "block", visibility: "visible" } };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { remove: window.__dsoRemoveOverlayWidgetPortal, setVisible: window.__dsoSetOverlayWidgetVisibility };`)(window, document, () => undefined);

  assert.equal(api.setVisible(root, false, true), "hidden");
  assert.deepEqual(Object.fromEntries(values), { display: "none", opacity: "0", "pointer-events": "none", visibility: "hidden" });
  assert.ok([...priorities.values()].every((priority) => priority === "important"));
  assert.equal(attributes.get("aria-hidden"), "true");
  assert.deepEqual(actions, ["hideSuggestWidget", "editor.action.hideHover", "closeParameterHints"]);
  assert.equal(editorBlurs, 1);
  assert.equal(inputBlurs, 1);

  assert.equal(api.setVisible(root, true, false), "visible");
  assert.equal(values.size, 0);
  assert.equal(attributes.has("aria-hidden"), false);
  root.__dsoExplicitlyParked = true;
  assert.equal(api.setVisible(root, true, false), "hidden", "an explicitly parked root cannot revive its portal");
  assert.equal(api.remove(null, "owner-b"), "no-widget-portal", "an older overlay cannot remove a newer owner's portal");
  assert.equal(portal.isConnected, true);
  assert.equal(api.remove(null, "owner-a"), "removed");
  assert.equal(portal.isConnected, false);
});

test("emits parseable workbench overlay renderer source", () => {
  assert.equal(typeof Function(overlayRendererSource("file:///tmp/console-cell.py")), "function");
});

test("isolates shell providers while retaining ordinary Python for submit overlays", () => {
  const shell = overlayRendererSource("file:///tmp/console-cell.py");
  const query = overlayRendererSource("file:///tmp/query-cell.py", { executionMode: "submit" });

  assert.match(shell, /const __dsoOverlayLanguageId = "django-shell-python"/);
  assert.match(query, /const __dsoOverlayLanguageId = "python"/);
  assert.ok(shell.includes("setModelLanguage(model, __dsoOverlayLanguageId)"));
  assert.ok(shell.includes("createModel(window.__dsoInitialModelText ? window.__dsoInitialModelText() : \"\", __dsoOverlayLanguageId, uri)"));
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
  assert.deepEqual(editor.getPosition(), { column: 1, lineNumber: 4 });
});

test("keeps the current execution unit in place until the host run response settles", async () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  let settleRun;
  const hostResponse = new Promise((resolve) => { settleRun = resolve; });
  const model = fakeModel("value\n");
  const editor = fakeEditor(model);
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const root = {};
  state.overlayRoot = root;
  api.installEnterRunner(root, editor, () => hostResponse);

  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(editor.getPosition(), { column: 1, lineNumber: 1 });
  assert.equal(model.getValue(), "value\n");

  settleRun({ json: async () => ({ executed: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(editor.getPosition(), { column: 1, lineNumber: 4 });
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

test("runs import-led execution units independently in arbitrary cursor order", async () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const upperCode = "import unexecuted_upper_side_effect";
  const lowerCode = "from workspace_context import WorkspaceClient\nclient = WorkspaceClient()";
  const text = `${upperCode}\n\n\n${lowerCode}\n`;
  const editor = fakeEditor(fakeModel(text), { column: 1, lineNumber: 5 });
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const posts = [];
  const root = { __dsoInputStartLine: 1 };
  state.overlayRoot = root;

  api.installEnterRunner(root, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });

  const lowerDebugPayload = root.__dsoCurrentInputPayload();
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));
  editor.setPosition({ column: 1, lineNumber: 1 });
  root.__dsoLastEnterRunAt = 0;
  const upperDebugPayload = root.__dsoCurrentInputPayload();
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));

  const runPayloads = posts.filter((payload) => payload.type === "run");
  assert.deepEqual(runPayloads.map((payload) => payload.code), [lowerCode, upperCode], "ordinary execution follows cursor order without implicitly running an earlier unit");
  assert.deepEqual(runPayloads.map((payload) => payload.range), [{ end: 5, start: 4 }, { end: 1, start: 1 }]);
  assert.equal(lowerDebugPayload.code, lowerCode, "Debug Current excludes an unexecuted unit above the cursor");
  assert.deepEqual(lowerDebugPayload.range, { end: 5, start: 4 });
  assert.equal(upperDebugPayload.code, upperCode, "the upper unit remains independently runnable after the lower unit");
  assert.deepEqual(upperDebugPayload.range, { end: 1, start: 1 });
  assert.deepEqual(editor.getPosition(), { column: 1, lineNumber: 4 }, "running an upper unit only moves to the existing lower unit without executing it");
  assert.ok(runPayloads.every((payload) => payload.text === text || payload.text.startsWith(text)), "source mapping may carry the full document without executing it");
});

test("creates a hard separator after execution and never reruns from its empty prompt", async () => {
  const source = overlaySyncRendererSource();
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", source + "\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };")(window, document, () => undefined);
  let keyHandler;
  const model = fakeModel("first = 1");
  const editor = fakeEditor(model);
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const posts = [];
  const root = {};

  api.installEnterRunner(root, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(model.getValue(), "first = 1\n\n\n");
  assert.deepEqual(editor.getPosition(), { column: 1, lineNumber: 4 });
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posts.filter((payload) => payload.type === "run").map((payload) => payload.code), ["first = 1"], "an empty separated prompt does not select the previous unit");

  model.setValue("first = 1\n\n\nsecond = 2");
  editor.setPosition({ column: 1, lineNumber: 4 });
  root.__dsoLastEnterRunAt = 0;
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posts.filter((payload) => payload.type === "run").map((payload) => payload.code), ["first = 1", "second = 2"]);
});

test("does not leak upper multiline continuation state into a lower execution unit", async () => {
  const source = overlaySyncRendererSource();
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const upperCode = "if True:\n    upper_draft = 1";
  const lowerCode = "lower_runs_independently = 2";
  const editor = fakeEditor(fakeModel(`${upperCode}\n\n\n${lowerCode}`), { column: 1, lineNumber: 1 });
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const posts = [];
  const root = {};

  api.installEnterRunner(root, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  keyHandler(monacoEnterEvent({ shiftKey: true }));
  assert.equal(root.__dsoMultilineMode, true);

  editor.setPosition({ column: 1, lineNumber: 5 });
  assert.equal(root.__dsoMultilineMode, false, "moving across a hard separator clears upper continuation state");
  keyHandler(monacoEnterEvent());
  await new Promise((resolve) => setImmediate(resolve));

  const runPayloads = posts.filter((payload) => payload.type === "run");
  assert.deepEqual(runPayloads.map((payload) => payload.code), [lowerCode]);
  assert.deepEqual(runPayloads[0].range, { end: 5, start: 5 });
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

test("treats a leading import block as an independent execution unit", async () => {
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

  const runPayload = posts.find((payload) => payload.type === "run");
  assert.equal(runPayload.code, "def build():\n    return Path.cwd()");
  assert.deepEqual(runPayload.range, { end: 7, start: 6 });
});

test("keeps every import-led unit independent after an earlier separator", async () => {
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

  const runPayload = posts.find((payload) => payload.type === "run");
  assert.equal(runPayload.code, "print(os.name)");
  assert.deepEqual(runPayload.range, { end: 7, start: 7 });
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
  assert.deepEqual(root.__dsoExecutionRangePreview, { end: 7, start: 7 });
  assert.equal(rangeDecoration.options.isWholeLine, true);
  assert.equal(rangeDecoration.options.linesDecorationsClassName, undefined);
  assert.equal(editor.decorations.some((item) => item.options.linesDecorationsClassName === "dso-exec-range-rail"), false);
  assert.equal(rangeDecoration.range.startLineNumber, 7);
  assert.equal(rangeDecoration.range.endLineNumber, 7);
  assert.equal(rangeDecoration.range.startColumn, 1);
  assert.equal(editor.options.lineNumbers(4), ">>>");
  assert.equal(editor.options.lineNumbers(5), "");
});

test("reveals breakpoint lines as glyph-margin dots while leaving breakpoint SETTING native", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const events = [];
  const window = { addEventListener(type, _callback, capture) { events.push({ capture: !!capture, target: "window", type }); }, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener(type, _callback, capture) { events.push({ capture: !!capture, target: "document", type }); }, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installBreakpointToggle: window.__dsoInstallBreakpointToggle, setBreakpoints: window.__dsoSetOverlayBreakpoints };`)(window, document, () => undefined);
  let contextMenuHandler;
  let mouseHandler;
  const node = { addEventListener(type, _callback, capture) { events.push({ capture: !!capture, target: "node", type }); }, classList: { contains: () => false }, contains: () => true, querySelectorAll: () => [], removeEventListener() {} };
  const editor = fakeEditor(fakeModel("one\ntwo\nthree\nfour\n"));
  editor.onContextMenu = (callback) => { contextMenuHandler = callback; return { dispose() {} }; };
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
  assert.equal(contextMenuHandler, undefined, "native conditional, hit-count, and logpoint menus are not replaced");
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

test("coalesces repeated paused-line rendering without repainting the execution preview", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { setDebugLine: window.__dsoSetOverlayDebugLine };`)(window, document, () => undefined);
  const model = fakeModel("pass\n# --- django shell input ---\none\ntwo\nthree\n");
  let lineReads = 0;
  const readLine = model.getLineContent;
  model.getLineContent = (line) => { lineReads += 1; return readLine(line); };
  const editor = fakeEditor(model);
  const renderCalls = [];
  const render = editor.deltaDecorations.bind(editor);
  editor.deltaDecorations = (previous, decorations) => {
    renderCalls.push(decorations.map((item) => item.options.className));
    return render(previous, decorations);
  };
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 3 };
  state.overlayRoot = root;

  assert.equal(api.setDebugLine(2), "debug-line:2");
  assert.deepEqual(renderCalls, [[], ["dso-debug-line"]]);
  assert.deepEqual(editor.revealedLines, [4]);
  assert.equal(lineReads, 1);

  assert.equal(api.setDebugLine(2), "debug-line:2");
  assert.deepEqual(renderCalls, [[], ["dso-debug-line"]]);
  assert.deepEqual(editor.revealedLines, [4]);
  assert.equal(lineReads, 1);

  assert.equal(api.setDebugLine(3), "debug-line:3");
  assert.deepEqual(renderCalls, [[], ["dso-debug-line"], ["dso-debug-line"]]);
  assert.deepEqual(editor.revealedLines, [4, 5]);
  assert.equal(lineReads, 2);
});

test("replaces same-line inline values atomically and clears them with the paused marker", () => {
  const source = overlaySyncRendererSource();
  const state = { overlayRoot: undefined };
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { setDebugLine: window.__dsoSetOverlayDebugLine, setVisibleText: window.__dsoSetOverlayVisibleText };`)(window, document, () => undefined);
  const model = fakeModel("one\ntwo\nthree\n");
  const editor = fakeEditor(model);
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 1, style: { display: "block", visibility: "visible" } };
  state.overlayRoot = root;

  assert.equal(api.setDebugLine(2, "count = 1"), "debug-line:2");
  assert.match(editor.decorations[0].options.after.content, /count = 1$/);
  const firstDecorations = root.__dsoDebugLineDecorationIds;

  assert.equal(api.setDebugLine(2, "count = 1"), "debug-line:2");
  assert.equal(root.__dsoDebugLineDecorationIds, firstDecorations, "identical line and values do not repaint");

  assert.equal(api.setDebugLine(2, "count = 2"), "debug-line:2");
  assert.match(editor.decorations[0].options.after.content, /count = 2$/);
  assert.notEqual(root.__dsoDebugLineDecorationIds, firstDecorations, "same-line value changes replace the decoration");

  let reappliedInline = "";
  const deltaDecorations = editor.deltaDecorations.bind(editor);
  editor.deltaDecorations = (previous, decorations) => {
    reappliedInline = decorations.find((decoration) => decoration.options.after)?.options.after.content || reappliedInline;
    return deltaDecorations(previous, decorations);
  };
  const setValue = model.setValue;
  model.setValue = (text) => { setValue(text); editor.decorations = []; };
  assert.equal(api.setVisibleText("alpha\nbeta\ngamma\n"), "ok");
  assert.match(reappliedInline, /count = 2$/, "model replacement reapplies the paused inline decoration");

  assert.equal(api.setDebugLine(0, ""), "debug-line:0");
  assert.deepEqual(editor.decorations, []);
  assert.equal(root.__dsoDebugInlineText, "");
});

test("places debug idempotence before preview work and gives paused previews a stable key", () => {
  const source = overlaySyncRendererSource();
  const debugStart = source.indexOf("window.__dsoApplyOverlayDebugLine = function");
  const debugEnd = source.indexOf("window.__dsoSetOverlayDebugLine = function", debugStart);
  const debugBody = source.slice(debugStart, debugEnd);
  const debugGuard = debugBody.indexOf("root.__dsoDebugRenderEditor === editor");
  const previewCall = debugBody.indexOf("__dsoUpdateExecutionRangePreview(root, editor)");
  assert.ok(debugGuard >= 0 && previewCall >= 0 && debugGuard < previewCall);

  const previewStart = source.indexOf("function __dsoUpdateExecutionRangePreview");
  const previewEnd = source.indexOf("function __dsoInstallExecutionRangePreview", previewStart);
  const previewBody = source.slice(previewStart, previewEnd);
  assert.ok(previewBody.includes('const inactiveKey = pausedLine > 0 ? "paused"'));
  const pausedGuard = previewBody.indexOf("root.__dsoExecutionRangeRenderKey === inactiveKey");
  const payloadRead = previewBody.indexOf("__dsoPreviewPayload(root, editor)");
  assert.ok(pausedGuard >= 0 && payloadRead >= 0 && pausedGuard < payloadRead);
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

test("creates a hard separator when Alt Enter skips the final execution unit", () => {
  const source = overlaySyncRendererSource();
  const window = { addEventListener() {}, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  let keyHandler;
  const model = fakeModel("draft = 1");
  const editor = fakeEditor(model);
  editor.executeEdits = (_source, edits) => { model.setValue(model.getValue() + edits[0].text); };
  editor.onKeyDown = (callback) => { keyHandler = callback; return { dispose() {} }; };
  const posts = [];

  api.installEnterRunner({}, editor, (payload) => { posts.push(payload); return { json: async () => ({ executed: true }) }; });
  keyHandler(monacoEnterEvent({ altKey: true }));

  assert.equal(model.getValue(), "draft = 1\n\n\n");
  assert.deepEqual(editor.getPosition(), { column: 1, lineNumber: 4 });
  assert.equal(posts.some((payload) => payload.type === "run"), false);
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

test("shows a fresh prompt after an import unit's hard separator", () => {
  const source = overlayPythonRangeRendererSource();
  const api = Function(`${source}\nreturn { promptForLine: __dsoPromptForLine };`)();
  const model = fakeModel("print('old')\n\n\nimport os\n\n\nprint(os.name)\n");

  assert.equal(api.promptForLine(model, 1, 4, {}), ">>>");
  assert.equal(api.promptForLine(model, 1, 5, {}), "");
  assert.equal(api.promptForLine(model, 1, 6, {}), "");
  assert.equal(api.promptForLine(model, 1, 7, {}), ">>>");
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

test("leaves Enter to the conditional breakpoint widget", async () => {
  const source = overlaySyncRendererSource();
  let windowKeyHandler;
  const window = { addEventListener(type, callback) { if (type === "keydown") { windowKeyHandler = callback; } }, clearTimeout() {}, removeEventListener() {}, setTimeout(callback) { callback(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: undefined, addEventListener() {}, getElementById: () => undefined, querySelectorAll: () => [], removeEventListener() {} };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { installEnterRunner: window.__dsoInstallEnterRunner };`)(window, document, () => undefined);
  const editor = fakeEditor(fakeModel("if ready:\n"));
  const breakpointWidget = { classList: { contains: (name) => name === "breakpoint-widget" } };
  const conditionInput = { closest: (selector) => selector === ".breakpoint-widget" ? breakpointWidget : null };
  const posts = [];
  const edits = [];
  const eventCalls = { prevented: 0, stopped: 0 };
  editor.executeEdits = (_source, value) => edits.push(...value);

  api.installEnterRunner({}, editor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  assert.equal(typeof windowKeyHandler, "function");
  windowKeyHandler({
    code: "Enter",
    key: "Enter",
    preventDefault() { eventCalls.prevented += 1; },
    stopImmediatePropagation() { eventCalls.stopped += 1; },
    stopPropagation() { eventCalls.stopped += 1; },
    target: conditionInput
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(posts.some((payload) => payload.type === "run"), false);
  assert.deepEqual(edits, []);
  assert.deepEqual(eventCalls, { prevented: 0, stopped: 0 });
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

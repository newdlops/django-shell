// E2E renderer harness for workbench overlay model language selection.

const assert = require("node:assert/strict");
const path = require("node:path");

/** Verifies captured workbench model creation receives a language selection object. */
function assertWorkbenchModelLanguageSelection(extension) {
  const renderer = require(path.join(extension.extensionPath, "out", "workbenchOverlayRenderer.js"));
  const harness = createRendererHarness(renderer.overlayRendererSource("file:///workspace/.django-shell/console-cell.py"));
  const report = harness.window.__djangoShellOverlayShow({ height: 180, left: 12, top: 24, width: 640 });
  const root = harness.document.getElementById("django-shell-overlay");
  assert.ok(report.includes(":editor:"), report);
  assert.equal(harness.state.createdLanguageId, "python");
  assert.equal(root.__dsoLastEditorError || "", "");
  assert.equal(root.__djangoShellEditor.getModel().getLanguageId(), "python");
}

/** Creates a minimal workbench renderer environment for the injected overlay source. */
function createRendererHarness(source) {
  const state = {};
  const document = fakeDocument(state);
  const window = fakeWindow(document);
  const editorCtor = function FakeEditorCtor() {};
  const inst = { createInstance: (_ctor, host) => fakeEditor(host), invokeFunction: (fn) => fn() };
  window.__dsoCaptures = { ctors: [editorCtor], insts: [inst], modelSvcs: [badModelService(), fakeModelService(state)], widgets: [] };
  Function("window", "document", "ResizeObserver", "MutationObserver", "fetch", "globalThis", `${source}\nreturn window;`)(window, document, FakeResizeObserver, FakeMutationObserver, fakeFetch, window);
  return { document, state, window };
}

/** Builds a fake renderer window with just the APIs used by the overlay. */
function fakeWindow(document) {
  return {
    __djangoShellOverlayInitialText: "# --- django shell input ---\n",
    __djangoShellOverlayPrelude: "",
    addEventListener: () => undefined,
    cancelAnimationFrame: () => undefined,
    clearInterval: () => undefined,
    clearTimeout: () => undefined,
    document,
    getComputedStyle: computedStyle,
    innerHeight: 768,
    innerWidth: 1024,
    monaco: { Uri: { parse: fakeUri } },
    removeEventListener: () => undefined,
    requestAnimationFrame: (fn) => { fn(); return 0; },
    setInterval: () => 0,
    setTimeout: (fn) => { fn(); return 0; }
  };
}

/** Builds a document containing one visible custom-console webview frame. */
function fakeDocument(state) {
  const host = fakeElement("div", { bottom: 720, height: 720, left: 0, right: 900, top: 0, width: 900 });
  const frame = fakeElement("iframe", { bottom: 720, height: 720, left: 0, right: 900, top: 0, width: 900 });
  host.className = "webview monaco-workbench";
  frame.className = "webview";
  host.appendChild(frame);
  state.host = host;
  state.frame = frame;
  return {
    addEventListener: () => undefined,
    body: host,
    createElement: (tag) => fakeElement(tag),
    getElementById: (id) => findById(host, id) || findById(state.head, id),
    head: state.head = fakeElement("head"),
    querySelector: (selector) => selector === ".monaco-workbench" ? host : host.querySelector(selector),
    querySelectorAll: (selector) => selector.includes("iframe") ? [frame] : host.querySelectorAll(selector),
    removeEventListener: () => undefined
  };
}

/** Returns a fake DOM element with recursive selector helpers. */
function fakeElement(tag, rect = { bottom: 220, height: 180, left: 0, right: 640, top: 0, width: 640 }) {
  const attrs = new Map();
  const node = {
    children: [],
    className: "",
    id: "",
    isConnected: true,
    parentElement: null,
    style: fakeStyle(),
    tagName: tag.toUpperCase(),
    textContent: "",
    addEventListener: () => undefined,
    appendChild(child) { child.parentElement = node; node.children.push(child); return child; },
    closest(selector) { return closest(node, selector); },
    getAttribute: (name) => attrs.has(name) ? attrs.get(name) : null,
    getBoundingClientRect: () => rect,
    querySelector(selector) { return queryAll(node, selector)[0] || null; },
    querySelectorAll(selector) { return queryAll(node, selector); },
    removeEventListener: () => undefined,
    setAttribute: (name, value) => attrs.set(name, String(value))
  };
  node.classList = { contains: (name) => node.className.split(/\s+/).includes(name) };
  return node;
}

/** Returns a fake model service that rejects raw string language IDs. */
function fakeModelService(state) {
  const seed = fakeModel("", fakeUri("file:///seed.py"), "plaintext");
  return {
    createModel(value, language, uri) {
      const languageId = languageIdFromSelection(language);
      state.createdLanguageId = languageId;
      return fakeModel(value, uri, languageId);
    },
    getModel: () => null,
    getModels: () => [seed],
    onModelAdded: () => undefined
  };
}

/** Builds a fake Monaco text model. */
function fakeModel(initialValue, uri, initialLanguageId) {
  let languageId = initialLanguageId;
  let value = initialValue;
  const listeners = [];
  const lines = () => value.split(/\r?\n/);
  return {
    uri,
    getLanguageId: () => languageId,
    getLineContent: (line) => lines()[line - 1] || "",
    getLineCount: () => lines().length,
    getLineMaxColumn: (line) => (lines()[line - 1] || "").length + 1,
    getValue: () => value,
    onDidChangeContent: (listener) => { listeners.push(listener); return { dispose: () => undefined }; },
    setLanguage: (selection) => { languageId = languageIdFromSelection(selection); },
    setValue(next) { value = next; for (const listener of listeners) { listener(); } }
  };
}

/** Builds a fake CodeEditorWidget. */
function fakeEditor(host) {
  return {
    focus: () => undefined,
    getDomNode: () => host,
    getModel() { return this.model; },
    getPosition: () => ({ column: 1, lineNumber: 1 }),
    layout(size) { this.layoutSize = size; },
    onDidChangeCursorPosition: () => ({ dispose: () => undefined }),
    onKeyDown: () => ({ dispose: () => undefined }),
    setHiddenAreas(areas) { this.hiddenAreas = areas; },
    setModel(model) { this.model = model; },
    setPosition(position) { this.position = position; },
    updateOptions(options) { this.options = options; }
  };
}

/** Returns the language ID from a workbench language selection. */
function languageIdFromSelection(selection) {
  assert.equal(typeof selection, "object");
  assert.equal(typeof selection.getLanguageId, "function");
  assert.equal(typeof selection.onDidChange, "function");
  return selection.getLanguageId();
}

/** Builds a false-positive model service candidate that must not be selected. */
function badModelService() {
  return {
    createModel: () => { throw new Error("bad model service selected"); },
    getModel: () => null,
    getModels: () => [{ uri: fakeUri("file:///bad.py") }]
  };
}

/** Builds a fake URI with the parse API exposed through its constructor. */
function fakeUri(value) {
  return { constructor: { parse: fakeUri }, toString: () => value };
}

/** Returns a minimal mutable style object. */
function fakeStyle() {
  const values = Object.create(null);
  return { getPropertyValue: (name) => values[name] || "", length: 0, setProperty(name, value) { values[name] = value; this[name] = value; } };
}

/** Returns computed style values used by geometry and theme code. */
function computedStyle(node) {
  return { color: "", display: "block", fontFamily: "", fontSize: "", getPropertyValue: () => "", length: 0, position: node.style.position || "relative", visibility: "visible" };
}

/** Finds a descendant by ID. */
function findById(root, id) {
  if (!root) { return null; }
  if (root.id === id) { return root; }
  for (const child of root.children) {
    const found = findById(child, id);
    if (found) { return found; }
  }
  return null;
}

/** Returns all descendants matching one selector list. */
function queryAll(root, selector) {
  const results = [];
  for (const child of root.children) {
    if (matchesAny(child, selector)) { results.push(child); }
    results.push(...queryAll(child, selector));
  }
  return results;
}

/** Finds the closest ancestor matching a selector. */
function closest(node, selector) {
  for (let cursor = node; cursor; cursor = cursor.parentElement) {
    if (matchesAny(cursor, selector)) { return cursor; }
  }
  return null;
}

/** Returns whether a node matches any simple selector in a comma list. */
function matchesAny(node, selector) {
  return selector.split(",").some((part) => matchesSimple(node, part.trim()));
}

/** Returns whether a node matches the simple selectors used by the overlay. */
function matchesSimple(node, selector) {
  if (selector === "[data-run]") { return node.getAttribute("data-run") !== null; }
  if (selector.startsWith(".")) { return node.classList.contains(selector.slice(1)); }
  if (selector === node.tagName.toLowerCase()) { return true; }
  const tagClass = selector.match(/^(\w+)\.(.+)$/);
  return Boolean(tagClass && node.tagName.toLowerCase() === tagClass[1] && node.classList.contains(tagClass[2]));
}

/** Fake ResizeObserver for renderer source evaluation. */
function FakeResizeObserver(callback) {
  this.disconnect = () => undefined;
  this.observe = () => callback();
}

/** Fake MutationObserver for renderer source evaluation. */
function FakeMutationObserver() {
  this.disconnect = () => undefined;
  this.observe = () => undefined;
}

/** Returns a fake fetch response for renderer bridge posts. */
function fakeFetch() {
  return Promise.resolve({ json: async () => ({ executed: true }) });
}

module.exports = { assertWorkbenchModelLanguageSelection };

// Tests ORM Query result-candidate and backend-confirmed expression decorations.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseModelQueryResponse, parseOrmQueryResponse } = require("../out/modelBackend.js");
const { overlayPythonRangeRendererSource } = require("../out/workbenchOverlayPythonRangeRenderer.js");
const { overlayQueryResultRendererSource } = require("../out/workbenchOverlayQueryResultRenderer.js");

/** Creates a mutable Monaco-like model for result-decoration tests. */
function fakeModel(initialText) {
  let text = initialText;
  let listener;
  return {
    change(nextText) { text = nextText; listener?.({}); },
    getLineContent(line) { return text.split("\n")[line - 1] ?? ""; },
    getLineCount() { return text.split("\n").length; },
    getLineMaxColumn(line) { return this.getLineContent(line).length + 1; },
    getValue() { return text; },
    onDidChangeContent(callback) { listener = callback; return { dispose() { listener = undefined; } }; }
  };
}

/** Creates a Monaco-like editor that records the latest decorations. */
function fakeEditor(model) {
  return {
    decorations: [],
    deltaDecorations(_previous, next) { this.decorations = next; return next.map((_item, index) => `d${index}`); },
    getModel() { return model; }
  };
}

test("marks a pre-run final expression candidate, then replaces it with the exact backend QuerySet result", () => {
  const code = [
    "from app.models import Order",
    "",
    "base = Order.objects.all()",
    "",
    "Order.objects.filter(",
    "    active=True",
    ")",
    ""
  ].join("\n");
  const model = fakeModel(code);
  const editor = fakeEditor(model);
  const root = { __djangoShellEditor: editor, __dsoExecutionMode: "submit", __dsoInputStartLine: 1, __dsoOwnerToken: "query-owner", __dsoUserStartLine: 1 };
  const window = { __djangoShellOverlayOwnerToken: "query-owner" };
  const document = { getElementById: (id) => id === "django-shell-overlay" ? root : undefined };
  const source = `${overlayPythonRangeRendererSource()}\n${overlayQueryResultRendererSource()}`;
  const api = Function("window", "document", `${source}\nreturn { install: window.__dsoInstallQueryResultDecoration, set: window.__dsoSetOverlayQueryResult };`)(window, document);

  api.install(root, editor);
  assert.equal(editor.decorations[0].options.className, "dso-query-result dso-query-result-candidate");
  assert.deepEqual(editor.decorations[0].range, { endColumn: 2, endLineNumber: 7, startColumn: 1, startLineNumber: 5 });
  assert.match(editor.decorations[1].options.after.content, /result candidate/);

  const report = api.set({ endLine: 7, expression: "Order.objects.filter( active=True )", kind: "queryset", label: "QuerySet[shop.Order]", startLine: 5 }, code.trimEnd(), "query-owner");
  assert.equal(report, "query-result:5:7:queryset", "a submitted trimEnd source must match the editor's trailing newline source");
  assert.equal(editor.decorations[0].options.className, "dso-query-result dso-query-result-queryset");
  assert.match(editor.decorations[1].options.after.content, /result: QuerySet\[shop\.Order\]/);

  const ownerMismatch = api.set({ endLine: 1, kind: "scalar", label: "int", startLine: 1 }, code, "another-owner");
  assert.equal(ownerMismatch, "owner-mismatch");
  assert.equal(editor.decorations[0].options.className, "dso-query-result dso-query-result-queryset");

  const stale = api.set({ endLine: 1, kind: "scalar", label: "int", startLine: 1 }, "different source", "query-owner");
  assert.equal(stale, "query-result:stale-source");
  assert.equal(editor.decorations[0].options.className, "dso-query-result dso-query-result-queryset", "a stale result must not erase the newer confirmed marker");
  const staleClear = api.set(undefined, "different source", "query-owner");
  assert.equal(staleClear, "query-result:stale-source");
  assert.equal(editor.decorations[0].options.className, "dso-query-result dso-query-result-queryset", "a stale clear must not erase the newer confirmed marker");

  model.change(`${code.trimEnd()}\n.values("id")\n`);
  assert.equal(root.__dsoQueryResult, null, "editing invalidates backend-confirmed metadata");
  assert.equal(editor.decorations[0].options.className, "dso-query-result dso-query-result-candidate");
});

test("does not advertise assignment statements as ORM result expressions", () => {
  const statements = [
    "orders = Order.objects.all()",
    "state.orders = Order.objects.all()",
    "states[0] = Order.objects.all()",
    "left, right = split_orders",
    "(left, right) = split_orders",
    "[left, right] = split_orders",
    "orders += more_orders",
    "orders: QuerySet[Order]"
  ];
  for (const statement of statements) {
    const model = fakeModel(`${statement}\n`);
    const editor = fakeEditor(model);
    const root = { __djangoShellEditor: editor, __dsoExecutionMode: "submit", __dsoInputStartLine: 1, __dsoUserStartLine: 1 };
    const window = {};
    const document = { getElementById: () => root };
    const source = `${overlayPythonRangeRendererSource()}\n${overlayQueryResultRendererSource()}`;
    const install = Function("window", "document", `${source}\nreturn window.__dsoInstallQueryResultDecoration;`)(window, document);
    install(root, editor);
    assert.deepEqual(editor.decorations, [], statement);
  }
});

test("ignores trailing comment-only lines when choosing a result candidate", () => {
  const model = fakeModel("Order.objects.all()\n# inspect active orders\n");
  const editor = fakeEditor(model);
  const root = { __djangoShellEditor: editor, __dsoExecutionMode: "submit", __dsoInputStartLine: 1, __dsoUserStartLine: 1 };
  const source = `${overlayPythonRangeRendererSource()}\n${overlayQueryResultRendererSource()}`;
  const install = Function("window", "document", `${source}\nreturn window.__dsoInstallQueryResultDecoration;`)({}, { getElementById: () => root });

  install(root, editor);
  assert.deepEqual(editor.decorations[0].range, { endColumn: 20, endLineNumber: 1, startColumn: 1, startLineNumber: 1 });
});

test("preserves validated result metadata over socket and terminal query transports", () => {
  const result = { endLine: 4, expression: "orders", kind: "queryset", label: "QuerySet[shop.Order]", startLine: 4 };
  const socket = parseModelQueryResponse(JSON.stringify({ columns: [], editable: false, ok: true, result, rows: [] }));
  const terminal = parseOrmQueryResponse(JSON.stringify({ grid: { columns: [], editable: false, result, rows: [] } }), 50, 0);
  const invalid = parseModelQueryResponse(JSON.stringify({ columns: [], editable: false, ok: true, result: { ...result, kind: "unknown" }, rows: [] }));

  assert.deepEqual(socket.result, result);
  assert.deepEqual(terminal.result, result);
  assert.equal(invalid.result, undefined);
});

test("does not install result tracking in the ordinary Python shell overlay", () => {
  let listenerCount = 0;
  const model = fakeModel("Order.objects.all()\n");
  model.onDidChangeContent = () => { listenerCount += 1; return { dispose() {} }; };
  const editor = fakeEditor(model);
  const root = { __djangoShellEditor: editor, __dsoExecutionMode: "shell", __dsoInputStartLine: 1, __dsoUserStartLine: 1 };
  const source = overlayQueryResultRendererSource();
  const install = Function("window", "document", `${source}\nreturn window.__dsoInstallQueryResultDecoration;`)({}, { getElementById: () => root });

  install(root, editor);
  assert.equal(listenerCount, 0);
  assert.deepEqual(editor.decorations, []);
});

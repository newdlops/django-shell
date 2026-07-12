// Tests native completion import relocation inside independent overlay execution units.

import assert from "node:assert/strict";
import test from "node:test";
import { overlayCleanupRendererSource } from "../out/workbenchOverlayCleanupRenderer.js";
import { overlayNativeCompletionRendererSource } from "../out/workbenchOverlayNativeCompletionRenderer.js";
import { overlayRendererSource } from "../out/workbenchOverlayRenderer.js";

/** Evaluates the renderer source and returns its testable functions. */
function rendererApi() {
  const window = {};
  return Function("window", `${overlayNativeCompletionRendererSource()}\nreturn { install: window.__dsoInstallNativeCompletionImports, relocate: __dsoRelocateNativeCompletionImports };`)(window);
}

/** Creates a minimal Monaco text model for completion relocation tests. */
function fakeModel(text, eol = "\n") {
  const lines = text.split(/\r\n|\n|\r/);
  return {
    getEOL: () => eol,
    getLineContent: (line) => lines[line - 1] ?? "",
    getLineCount: () => lines.length
  };
}

/** Creates an editor and captures the SuggestController insertion listener. */
function fakeEditor(text, lineNumber) {
  let listener;
  const controller = {
    onWillInsertSuggestItem(callback) {
      listener = callback;
      return { dispose() { listener = undefined; } };
    }
  };
  return {
    editor: {
      getContribution: () => controller,
      getModel: () => fakeModel(text),
      getPosition: () => ({ column: 30, lineNumber })
    },
    fire(item) { listener({ item }); }
  };
}

/** Creates one internal Monaco suggestion item. */
function suggestion(label, additionalTextEdits) {
  return { completion: { additionalTextEdits, label }, isResolved: true };
}

test("relocates an eager native auto-import to the focused lower execution unit", () => {
  const api = rendererApi();
  const fixture = fakeEditor("upper = 1\n\n\nclient = NativeProviderSen", 4);
  const root = { __dsoInputStartLine: 1 };
  const item = suggestion("NativeProviderSentinel", [{
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    text: "from native_provider_fixture import NativeProviderSentinel\n"
  }]);
  api.install(root, fixture.editor);
  fixture.fire(item);
  assert.deepEqual(item.completion.additionalTextEdits, [{
    range: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 1 },
    text: "from native_provider_fixture import NativeProviderSentinel\n\n"
  }]);
  assert.equal(root.__dsoNativeCompletionRelocations, 1);
});

test("copies an identical upper-unit import when a provider omits its edit", () => {
  const api = rendererApi();
  const fixture = fakeEditor("from native_provider_fixture import NativeProviderSentinel\nupper = 1\n\n\nclient = NativeProviderSen", 5);
  const root = { __dsoInputStartLine: 1 };
  const item = suggestion("NativeProviderSentinel", undefined);
  api.install(root, fixture.editor);
  fixture.fire(item);
  assert.equal(item.completion.additionalTextEdits.length, 1);
  assert.equal(item.completion.additionalTextEdits[0].range.startLineNumber, 5);
  assert.equal(item.completion.additionalTextEdits[0].text, "from native_provider_fixture import NativeProviderSentinel\n\n");
});

test("narrows an upper import expansion to the selected binding", () => {
  const api = rendererApi();
  const line = "from workspace_context import Existing";
  const item = suggestion("AutoImportedClient", [{
    range: { startLineNumber: 1, startColumn: line.length + 1, endLineNumber: 1, endColumn: line.length + 1 },
    text: ", AutoImportedClient"
  }]);
  const outcome = api.relocate(
    { __dsoInputStartLine: 1 },
    fakeEditor(`${line}\nupper = Existing()\n\n\nclient = AutoImportedCli`, 5).editor,
    item
  );
  assert.equal(outcome.changed, true);
  assert.equal(item.completion.additionalTextEdits[0].text, "from workspace_context import AutoImportedClient\n\n");
  assert.equal(item.completion.additionalTextEdits[0].range.startLineNumber, 5);
});

test("relocates an expansion of a parenthesized upper import", () => {
  const api = rendererApi();
  const text = "from workspace_context import (\n    Existing,\n)\nupper = Existing()\n\n\nclient = AutoImportedCli";
  const item = suggestion("AutoImportedClient", [{
    range: { startLineNumber: 2, startColumn: 14, endLineNumber: 2, endColumn: 14 },
    text: " AutoImportedClient,"
  }]);
  const outcome = api.relocate({ __dsoInputStartLine: 1 }, fakeEditor(text, 7).editor, item);
  assert.equal(outcome.changed, true);
  assert.equal(item.completion.additionalTextEdits[0].range.startLineNumber, 7);
  assert.equal(item.completion.additionalTextEdits[0].text, "from workspace_context import AutoImportedClient\n\n");
});

test("relocates imports added by lazy completion resolution", async () => {
  const api = rendererApi();
  const fixture = fakeEditor("upper = 1\n\n\nclient = LazyNativeSen", 4);
  const root = { __dsoInputStartLine: 1 };
  const item = {
    completion: { label: "LazyNativeSentinel" },
    isResolved: false,
    async resolve() {
      this.completion.additionalTextEdits = [{
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        text: "from native_provider_fixture import LazyNativeSentinel\n"
      }];
      return this;
    }
  };
  api.install(root, fixture.editor);
  fixture.fire(item);
  await item.resolve();
  assert.equal(item.completion.additionalTextEdits[0].range.startLineNumber, 4);
  assert.equal(item.completion.additionalTextEdits[0].text, "from native_provider_fixture import LazyNativeSentinel\n\n");
});

test("leaves the first execution unit on the provider's native edit path", () => {
  const api = rendererApi();
  const item = suggestion("NativeProviderSentinel", [{
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    text: "from native_provider_fixture import NativeProviderSentinel\n"
  }]);
  const outcome = api.relocate(
    { __dsoInputStartLine: 1 },
    fakeEditor("client = NativeProviderSen", 1).editor,
    item
  );
  assert.equal(outcome.changed, false);
  assert.equal(item.completion.additionalTextEdits[0].text, "from native_provider_fixture import NativeProviderSentinel\n");
});

test("relocates native imports only after an import's three-blank separator", () => {
  const api = rendererApi();
  const edit = {
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    text: "from native_provider_fixture import NativeProviderSentinel\n"
  };
  const conventional = suggestion("NativeProviderSentinel", [{ ...edit, range: { ...edit.range } }]);
  const separated = suggestion("NativeProviderSentinel", [{ ...edit, range: { ...edit.range } }]);

  const conventionalOutcome = api.relocate(
    { __dsoInputStartLine: 1 },
    fakeEditor("import os\n\n\nclient = NativeProviderSen", 4).editor,
    conventional
  );
  const separatedOutcome = api.relocate(
    { __dsoInputStartLine: 1 },
    fakeEditor("import os\n\n\n\nclient = NativeProviderSen", 5).editor,
    separated
  );

  assert.equal(conventionalOutcome.changed, false);
  assert.equal(conventionalOutcome.reason, "first-unit");
  assert.equal(conventional.completion.additionalTextEdits[0].range.startLineNumber, 1);
  assert.equal(separatedOutcome.changed, true);
  assert.equal(separated.completion.additionalTextEdits[0].range.startLineNumber, 5);
});

test("installs and disposes the native import hook with the shell overlay", () => {
  const source = overlayRendererSource("file:///workspace/.django-shell/console-cell.py");
  assert.ok(source.includes("window.__dsoInstallNativeCompletionImports = function"));
  assert.ok(source.includes('root.__dsoExecutionMode === "shell" && window.__dsoInstallNativeCompletionImports'));
  assert.ok(overlayCleanupRendererSource().includes("__dsoDisposeValue(root.__dsoNativeCompletionDisposable)"));
});

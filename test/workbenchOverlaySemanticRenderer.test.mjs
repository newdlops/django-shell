// Tests runtime-only semantic decorations layered over native Python highlighting.

import assert from "node:assert/strict";
import test from "node:test";
import { overlayRendererSource } from "../out/workbenchOverlayRenderer.js";
import { overlaySemanticRendererSource } from "../out/workbenchOverlaySemanticRenderer.js";

/** Evaluates semantic renderer helpers with a minimal DOM. */
function semanticApi(prelude = "from orm_runtime.models import Company\n") {
  const styles = new Map();
  const document = {
    createElement: () => ({ id: "", parentElement: null, textContent: "" }),
    getElementById: (id) => styles.get(id),
    head: {
      appendChild(style) { style.parentElement = this; styles.set(style.id, style); }
    }
  };
  const window = {
    __djangoShellOverlayPrelude: prelude,
    clearTimeout: () => undefined,
    setTimeout(callback) { callback(); return 1; }
  };
  const refresh = Function("window", "document", `${overlaySemanticRendererSource()}\nreturn window.__dsoRefreshPreludeSemanticDecorations;`)(window, document);
  return { document, refresh, window };
}

/** Creates a mutable Monaco-like model. */
function fakeModel(initialText) {
  let text = initialText;
  const listeners = [];
  return {
    getLineContent: (line) => text.split("\n")[line - 1] ?? "",
    getLineCount: () => text.split("\n").length,
    onDidChangeContent(listener) { listeners.push(listener); return { dispose() {} }; },
    setValue(value) { text = value; for (const listener of listeners) { listener(); } }
  };
}

/** Creates an editor that records semantic decoration updates. */
function fakeEditor(model) {
  return {
    decorations: [],
    deltaDecorations(_previous, decorations) {
      this.decorations = decorations;
      return decorations.map((_decoration, index) => `semantic-${index}`);
    },
    getModel: () => model
  };
}

test("decorates runtime symbols in code but not strings, comments, helpers, or shadowed units", () => {
  const api = semanticApi("from orm_runtime.models import Company\nimport os\ncurrent_user: User\n__dso_generated: int\n");
  const model = fakeModel([
    "company = Company()",
    "print('Company', os)  # Company",
    "print(current_user, __dso_generated)",
    "",
    "",
    "Company = object()",
    "print(Company)"
  ].join("\n"));
  const editor = fakeEditor(model);
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 1, __dsoPreludeText: api.window.__djangoShellOverlayPrelude };

  api.refresh(root);

  assert.deepEqual(editor.decorations.map((item) => [item.options.inlineClassName, item.range.startLineNumber]), [
    ["django-shell-semantic-class", 1],
    ["django-shell-semantic-namespace", 2],
    ["django-shell-semantic-variable", 3]
  ]);
  assert.equal(api.document.getElementById("django-shell-overlay-semantic-style").textContent.includes("symbolIcon-classForeground"), true);
});

test("scopes import shadowing across the import-specific blank separator", () => {
  const api = semanticApi();
  const model = fakeModel("from local_models import Company\n\n\nCompany.objects");
  const editor = fakeEditor(model);
  const root = { __djangoShellEditor: editor, __dsoInputStartLine: 1, __dsoPreludeText: api.window.__djangoShellOverlayPrelude };

  api.refresh(root);
  assert.deepEqual(editor.decorations, [], "two blank lines keep the local import and expression in one unit");

  model.setValue("from local_models import Company\n\n\n\nCompany.objects");
  api.refresh(root);
  assert.deepEqual(editor.decorations.map((item) => item.range.startLineNumber), [5], "three blank lines isolate the lower runtime symbol");
});

test("full overlay installs renderer decoration augmentation without a semantic-token provider", () => {
  const source = overlayRendererSource("file:///workspace/.django-shell/console-cell.py");

  assert.match(source, /__dsoInstallPreludeSemanticDecorations\(root, editor\)/);
  assert.match(source, /django-shell-runtime-semantic/);
  assert.match(source, /root\.__dsoSemanticTimer = 0;/);
  assert.match(source, /if \(!root\.__dsoSemanticTimer\)/);
  assert.match(source, /\}, 500\);/);
  assert.equal(source.includes("registerDocumentSemanticTokensProvider"), false);
  assert.equal(source.includes("vscode.provideDocumentSemanticTokens"), false);
});

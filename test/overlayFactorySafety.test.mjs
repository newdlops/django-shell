// Regression checks for transactional overlay editor construction and cleanup.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const rendererSource = fs.readFileSync(new URL("../src/workbenchOverlayRenderer.ts", import.meta.url), "utf8");
const cleanupSource = fs.readFileSync(new URL("../src/workbenchOverlayCleanupRenderer.ts", import.meta.url), "utf8");

test("failed workbench editor construction rolls back owned widgets and models", () => {
  const createStart = rendererSource.indexOf("function __dsoCreateWorkbenchEditor");
  const createEnd = rendererSource.indexOf("function __dsoCreateGlobalMonacoEditor", createStart);
  const createBody = rendererSource.slice(createStart, createEnd);

  assert.ok(rendererSource.includes("function __dsoRollbackWorkbenchResources(editor, ownedModel)"));
  assert.ok(createBody.includes("let ownedModel = null"));
  assert.ok(createBody.includes("else if (model) { ownedModel = model; }"));
  assert.ok((createBody.match(/__dsoRollbackWorkbenchResources\(/g) ?? []).length >= 7);
  assert.ok(createBody.includes("__dsoRememberBadInst(factory.inst)"), "a mismatched instantiation scope is not retried forever");
  assert.ok(createBody.indexOf("editor.setModel(model)") < createBody.indexOf("if (!__dsoIsLiveWidget(editor))"), "CodeEditorWidget creates its DOM node only after the model is attached");
  assert.equal(rendererSource.includes("__dsoSkipWorkbenchEditor = true"), false, "one UNKNOWN service failure cannot permanently disable native overlay creation");
});

test("successful and disposed overlays release captured warmup widget references", () => {
  assert.ok(rendererSource.includes("caps.widgets.length = 0; __dsoRemember(caps.widgets, editor, 40)"));
  assert.ok(rendererSource.includes("exact.widget = editor; exact.ctor = __dsoRealCtor(editor)"));
  assert.ok(cleanupSource.includes("if (!editor || exact.widget === editor) { exact.widget = null; }"));
  assert.ok(cleanupSource.includes("else if (caps.widgets) { caps.widgets.length = 0; }"));
});

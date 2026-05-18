// VS Code extension host E2E checks for the Django Shell custom console.

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

/** Runs the extension host E2E suite. */
async function run() {
  const extension = vscode.extensions.getExtension("local.django-shell");
  assert.ok(extension, "Django Shell extension should be loaded in the extension host.");
  await extension.activate();
  await vscode.commands.executeCommand("djangoShell.openConsole");
  const opened = await waitForSnapshot((snapshot) => snapshot.panelOpen && snapshot.hasEditorAnchor && snapshot.overlayDocumentOpen && snapshot.overlayAnalysisDocumentOpen);
  assert.equal(opened.panelVisible, true);
  assert.equal(opened.hasShowEditorButton, true);
  assert.equal(opened.overlayDocumentLanguage, "python");
  assert.equal(opened.overlayDocumentHasMarker, true);
  assert.equal(opened.overlayAnalysisDocumentOpen, true);
  assert.equal(opened.overlayAnalysisDocumentHasMarker, true);
  assert.equal(generatedShadowTabOpen(), false);

  const measured = await waitForSnapshot((snapshot) => {
    const rect = snapshot.lastEditorGeometry;
    return rect && rect.width > 40 && rect.height > 40;
  }, 15000);
  assert.ok(measured.lastEditorGeometry.width > 40);
  assert.ok(measured.lastEditorGeometry.height > 40);

  const bridge = require(path.join(extension.extensionPath, "out", "overlayPythonFeatureBridge.js"));
  const item = new vscode.CompletionItem("Company", vscode.CompletionItemKind.Class);
  item.range = new vscode.Range(12, 4, 12, 7);
  item.textEdit = new vscode.TextEdit(new vscode.Range(12, 4, 12, 7), "Company");
  item.additionalTextEdits = [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), "from app.models import Company\n")];
  const [mapped] = bridge.__test.mapCompletionResult([item], 10);
  assert.equal(mapped.range.start.line, 2);
  assert.equal(mapped.range.start.character, 4);
  assert.equal(mapped.textEdit.range.start.line, 2);
  assert.equal(mapped.textEdit.range.start.character, 4);
  assert.equal(mapped.additionalTextEdits, undefined);

  const objectItem = new vscode.CompletionItem("objects", vscode.CompletionItemKind.Property);
  objectItem.range = { inserting: new vscode.Range(210, 18, 210, 23), replacing: new vscode.Range(210, 18, 210, 23) };
  objectItem.textEdit = new vscode.TextEdit(new vscode.Range(210, 18, 210, 23), "objects");
  objectItem.additionalTextEdits = [new vscode.TextEdit(new vscode.Range(2, 0, 2, 0), "from app.models import Company\n")];
  const [mappedObjects] = bridge.__test.mapCompletionResult([objectItem], 210);
  assert.equal(mappedObjects.range.inserting.start.line, 0);
  assert.equal(mappedObjects.range.inserting.start.character, 18);
  assert.equal(mappedObjects.textEdit.range.start.character, 18);
  assert.equal(mappedObjects.additionalTextEdits, undefined);

  assertRuntimePreludeFallbacks(extension);
  assertBackendInspectSeparation(extension);
  assertDjangoManagerCompletion(bridge);
  assertNoFakeInlaySemanticProviders(extension);
  assertOverlayRendererGuards(extension);
  assertOverlayChromeIsEmbedded(extension);
  await assertGeneratedShadowCleanup(extension);
}

/** Polls the hidden E2E snapshot command until one predicate passes. */
async function waitForSnapshot(predicate, timeoutMs = 10000) {
  const started = Date.now();
  let last = {};
  while (Date.now() - started < timeoutMs) {
    try {
      last = await vscode.commands.executeCommand("djangoShell.e2eSnapshot");
      if (last && predicate(last)) {
        return last;
      }
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Django Shell E2E snapshot: ${JSON.stringify(last)}`);
}

/** Waits for the requested number of milliseconds. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Verifies Django model managers outrank generic Python attribute guesses. */
function assertDjangoManagerCompletion(bridge) {
  const analysis = "from zuzu.db.models.company import Company\n# --- django shell input ---\nCompany.obj";
  const item = bridge.__test.djangoManagerCompletionForText("Company.obj", new vscode.Position(0, 11), analysis);
  assert.ok(item, "Django model classes should offer objects completion.");
  assert.equal(item.label, "objects");
  assert.equal(item.sortText, "\u0000objects");
  assert.equal(item.textEdit.range.start.character, 8);
  const hover = bridge.__test.preludeHoverForText("Company.objects", new vscode.Position(0, 2), analysis);
  assert.ok(String(hover.contents[0].value).includes("from zuzu.db.models.company import Company"));
}

/** Verifies initial namespace values without import lines still enter the analysis prelude. */
function assertRuntimePreludeFallbacks(extension) {
  const prelude = require(path.join(extension.extensionPath, "out", "runtimePrelude.js"));
  const lines = prelude.runtimePreludeLines([
    { importLine: "from app.models import Company", kind: "class", name: "Company", origin: "initial", preview: "class app.models.Company", type: "type" },
    { kind: "object", name: "settings", origin: "initial", preview: "<LazySettings>", type: "django.conf.LazySettings", typeImportLine: "from django.conf import LazySettings" },
    { kind: "object", name: "cache", origin: "initial", preview: "<ConnectionProxy>", type: "django.utils.connection.ConnectionProxy" }
  ]);
  assert.ok(lines.includes("from app.models import Company"));
  assert.ok(lines.includes("from django.conf import LazySettings"));
  assert.ok(lines.includes("settings: LazySettings"));
  assert.ok(lines.includes("from typing import Any as _DjsAny"));
  assert.ok(lines.includes("cache: _DjsAny"));
  const crowded = Array.from({ length: 220 }, (_, index) => ({ importLine: `from zuzu.common.factory.item_${index} import Factory${index}`, kind: "class", name: `Factory${index}`, origin: "initial", preview: "class factory", type: "type" }));
  crowded.push({ importLine: "from zuzu.db.models.company import Company", kind: "class", name: "Company", origin: "initial", preview: "class zuzu.db.models.company.Company", type: "type" });
  assert.ok(prelude.runtimePreludeLines(crowded).some((line) => line.includes("Company")));
  const ambiguousClass = prelude.runtimePreludeLines([{ kind: "object", name: "Company", origin: "initial", preview: "class zuzu.db.models.company.Company", type: "django.db.models.base.ModelBase" }]);
  assert.ok(ambiguousClass.includes("from zuzu.db.models.company import Company"));
  assert.equal(ambiguousClass.some((line) => line === "Company: _DjsAny"), false);
}

/** Verifies backend runtime inspect and editor prelude requests stay separated. */
function assertBackendInspectSeparation(extension) {
  const script = [
    "import importlib.util, json, types",
    `path=${JSON.stringify(path.join(extension.extensionPath, "python", "django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "class LazySettings: pass",
    "namespace={'pd': types.ModuleType('pandas'), 'settings': LazySettings()}",
    "initial=set(namespace)",
    "namespace['user_value']=3",
    "inspect=mod._run_request(namespace, 'tok', {'token':'tok','kind':'inspect','lightweight':True}, initial)",
    "prelude=mod._run_request(namespace, 'tok', {'token':'tok','kind':'prelude'}, initial)",
    "print(json.dumps({'inspect':[v['name'] for v in inspect['variables']], 'prelude':[v['name'] for v in prelude['variables']]}))"
  ].join("\n");
  const result = childProcess.spawnSync(pythonExecutable(), ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.inspect.includes("settings"), false);
  assert.equal(payload.inspect.includes("user_value"), true);
  assert.equal(payload.prelude.includes("settings"), true);
}

/** Returns a concrete Python executable path for backend E2E probes. */
function pythonExecutable() {
  const candidates = [
    process.env.DJANGO_SHELL_E2E_PYTHON,
    process.env.DJLS_E2E_BASE_PYTHON,
    "/Users/lky/.asdf/installs/python/3.11.15/bin/python3.11",
    "/usr/bin/python3"
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(found, "Python executable is required for backend E2E probes.");
  return found;
}

/** Verifies fake inlay and semantic providers do not compete with Pylance. */
function assertNoFakeInlaySemanticProviders(extension) {
  const source = fs.readFileSync(path.join(extension.extensionPath, "out", "overlayPythonFeatureBridge.js"), "utf8");
  assert.equal(source.includes("registerInlayHintsProvider"), false);
  assert.equal(source.includes("registerDocumentSemanticTokensProvider"), false);
}

/** Verifies generated file-only provider artifacts stay hidden and are removable. */
async function assertGeneratedShadowCleanup(extension) {
  const shadow = require(path.join(extension.extensionPath, "out", "filePythonShadow.js"));
  const root = vscode.workspace.workspaceFolders[0].uri;
  const directory = vscode.Uri.joinPath(root, ".django-shell");
  const generated = vscode.Uri.joinPath(directory, "django_shell_console_cell_42.py");
  const keep = vscode.Uri.joinPath(directory, "keep.py");
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(generated, Buffer.from("# Django workspace imports for editor analysis.\nvalue = 1\n"));
  await vscode.workspace.fs.writeFile(keep, Buffer.from("value = 2\n"));
  assert.equal(generatedShadowTabOpen(), false);
  await shadow.deleteGeneratedShadowArtifacts();
  await assertMissing(generated);
  await assertMissing(vscode.Uri.joinPath(directory, "console-cell.py"));
  assert.ok(await exists(keep));
  assert.equal(generatedShadowTabOpen(), false);
}

/** Returns whether any generated shadow file is currently exposed as a tab. */
function generatedShadowTabOpen() {
  return vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => {
    const uri = tabUri(tab);
    return Boolean(uri && uri.path.includes("/.django-shell/") && /\.py$/.test(uri.path));
  }));
}

/** Extracts a URI from a text-like tab input. */
function tabUri(tab) {
  const input = tab.input || {};
  return input.uri;
}

/** Asserts that a URI is absent from the workspace file system. */
async function assertMissing(uri) {
  assert.equal(await exists(uri), false, `${uri.toString()} should have been removed`);
}

/** Returns whether a URI exists. */
async function exists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Verifies renderer guards that protect completion Enter and hidden preludes. */
function assertOverlayRendererGuards(extension) {
  const sync = require(path.join(extension.extensionPath, "out", "workbenchOverlaySyncRenderer.js"));
  const source = sync.overlaySyncRendererSource();
  const state = { nodes: [] };
  const window = { clearTimeout: () => undefined, setTimeout: (fn) => { fn(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { querySelectorAll: (selector) => state.nodes.filter((node) => selectorMatches(selector, node)) };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { applyPrelude: window.__dsoApplyPreludeHiddenArea, suggestOpen: __dsoSuggestOpen };`)(window, document, () => undefined);

  state.nodes = [popupNode(["suggest-widget"], { height: 120, width: 240 })];
  assert.equal(api.suggestOpen(), true);
  state.nodes = [popupNode(["suggest-widget", "hidden"], { height: 120, width: 240 })];
  assert.equal(api.suggestOpen(), false);

  const prelude = "# Django shell runtime imports for analysis.\n# ruff: noqa\nfrom app.models import Company\n\n";
  const marker = "# --- django shell input ---";
  const prefix = `${prelude}${marker}\n`;
  const model = fakeModel(`from app.models import Company\n${prefix}objectsa = Company.objec`);
  const editor = fakeEditor(model, { column: 24, lineNumber: 7 });
  const root = { __dsoPreludeText: prelude, __dsoUseVisiblePrelude: true };
  window.__djangoShellOverlayPrelude = prelude;
  api.applyPrelude(root, editor);

  assert.equal(model.getValue(), `${prefix}objectsa = Company.objec`);
  assert.equal(editor.hiddenAreas[0].startLineNumber, 1);
  assert.equal(editor.hiddenAreas[0].endLineNumber, root.__dsoUserStartLine - 1);
  assert.equal(editor.position.lineNumber, root.__dsoUserStartLine);

  editor.hiddenAreas = [];
  model.setValue(`${prefix}objectsa = Company.objects`);
  assert.equal(editor.hiddenAreas[0].startLineNumber, 1);
  assert.equal(editor.hiddenAreas[0].endLineNumber, root.__dsoUserStartLine - 1);
}

/** Verifies the captured Monaco editor visually occupies the cell instead of a floating frame. */
function assertOverlayChromeIsEmbedded(extension) {
  const renderer = require(path.join(extension.extensionPath, "out", "workbenchOverlayRenderer.js"));
  const source = renderer.overlayRendererSource("file:///workspace/.django-shell/console-cell.py");
  assert.ok(source.includes(".django-shell-overlay-head{display:none}"));
  assert.ok(source.includes("border:0"));
  assert.ok(source.includes(".django-shell-overlay-editor{height:100%"));
  assert.ok(source.includes("__dsoGeometryTimer"));
}

/** Returns a fake popup node for renderer suggest visibility checks. */
function popupNode(classes, rect) {
  return {
    classList: { contains: (name) => classes.includes(name) },
    getBoundingClientRect: () => rect
  };
}

/** Returns whether a fake node matches one simple class selector list. */
function selectorMatches(selector, node) {
  return selector.split(",").some((part) => node.classList.contains(part.trim().replace(/^\./, "")));
}

/** Builds a minimal Monaco-like model used by renderer source E2E checks. */
function fakeModel(initialText) {
  let value = initialText;
  const listeners = [];
  const lines = () => value.split(/\r?\n/);
  return {
    getLineContent: (line) => lines()[line - 1] ?? "",
    getLineCount: () => lines().length,
    getLineMaxColumn: (line) => (lines()[line - 1] ?? "").length + 1,
    getValue: () => value,
    onDidChangeContent: (listener) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
    setValue: (next) => {
      value = next;
      for (const listener of listeners) {
        listener();
      }
    }
  };
}

/** Builds a minimal Monaco-like editor used by renderer source E2E checks. */
function fakeEditor(model, position) {
  return {
    hiddenAreas: [],
    decorations: [],
    position,
    deltaDecorations(_oldDecorations, decorations) {
      this.decorations = decorations;
      return decorations.map((_, index) => String(index));
    },
    getModel: () => model,
    getPosition() { return this.position; },
    onDidChangeContent: () => ({ dispose: () => undefined }),
    onDidChangeCursorPosition: () => ({ dispose: () => undefined }),
    onKeyDown: () => ({ dispose: () => undefined }),
    setHiddenAreas(areas) { this.hiddenAreas = areas; },
    setPosition(next) { this.position = next; },
    updateOptions(options) { this.options = options; }
  };
}

/** Builds a minimal DOM document for renderer source E2E checks. */
function fakeDocument() {
  const nodes = new Map();
  return {
    createElement: () => ({ parentElement: null, style: {}, textContent: "" }),
    getElementById: (id) => nodes.get(id) ?? null,
    head: {
      appendChild(node) {
        node.parentElement = this;
        nodes.set(node.id, node);
      }
    }
  };
}

module.exports = { run };

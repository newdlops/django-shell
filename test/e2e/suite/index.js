// VS Code extension host E2E checks for the Django Shell custom console.

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { assertPythonCellBehavior } = require("./pythonCellBehavior.js");
const { assertWorkbenchModelLanguageSelection } = require("./workbenchOverlayModelLanguage.js");

/** Runs the extension host E2E suite. */
async function run() {
  const extension = vscode.extensions.getExtension(process.env.DJANGO_SHELL_E2E_EXTENSION_ID || "local.django-shell");
  assert.ok(extension, "Django Shell extension should be loaded in the extension host.");
  await writePreActivationStaleOverlayFiles();
  await extension.activate();
  await vscode.commands.executeCommand("djangoShell.openConsole");
  const opened = await waitForSnapshot((snapshot) => snapshot.panelOpen && snapshot.hasEditorAnchor);
  assert.equal(opened.panelVisible, true);
  assert.equal(opened.hasCellResizers, true);
  assert.equal(opened.hasDebugButton, true);
  assert.equal(opened.hasDebugControls, true);
  assert.equal(opened.hasNotebookChrome, true);
  assert.equal(opened.hasPythonDisabledState, true);
  assert.equal(opened.hasPythonIcon, true);
  assert.equal(opened.hasPythonRunButton, false);
  assert.equal(opened.hasOverlayTabButton, true);
  assert.equal(opened.hasSetupAutoMinimize, true);
  const overlayText = await waitForOverlayText((value) => value.editor.includes("# --- django shell input ---") && value.analysis === "");
  assert.equal(overlayText.editor.includes("# --- django shell input ---"), true);
  assert.equal(overlayText.analysis, "");
  assert.equal(generatedShadowTabOpen(), false);
  await assertPreActivationStaleOverlayFilesCleaned();

  const measured = await waitForSnapshot((snapshot) => {
    const rect = snapshot.lastEditorGeometry;
    return rect && rect.width > 40 && rect.height > 40;
  }, 15000);
  assert.ok(measured.lastEditorGeometry.width > 40);
  assert.ok(measured.lastEditorGeometry.height > 40);
  await assertRestartClearsOverlayDocuments();

  const bridge = require(path.join(extension.extensionPath, "out", "overlayPythonFeatureBridge.js"));
  const item = new vscode.CompletionItem("Company", vscode.CompletionItemKind.Class);
  item.range = new vscode.Range(13, 4, 13, 7);
  item.textEdit = new vscode.TextEdit(new vscode.Range(13, 4, 13, 7), "Company");
  item.additionalTextEdits = [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), "from app.models import Company\n")];
  const [mapped] = bridge.__test.mapCompletionResult([item], 10, 10, { focusLine: 3, text: "upper = 1\n\n\nuse Company" });
  assert.equal(mapped.range.start.line, 3);
  assert.equal(mapped.range.start.character, 4);
  assert.equal(mapped.textEdit.range.start.line, 3);
  assert.equal(mapped.textEdit.range.start.character, 4);
  assert.equal(mapped.additionalTextEdits[0].range.start.line, 3);
  assert.equal(mapped.additionalTextEdits[0].newText, "from app.models import Company\n\n");

  const objectItem = new vscode.CompletionItem("objects", vscode.CompletionItemKind.Property);
  objectItem.range = { inserting: new vscode.Range(210, 18, 210, 23), replacing: new vscode.Range(210, 18, 210, 23) };
  objectItem.textEdit = new vscode.TextEdit(new vscode.Range(210, 18, 210, 23), "objects");
  objectItem.additionalTextEdits = [new vscode.TextEdit(new vscode.Range(2, 0, 2, 0), "from app.models import Company\n")];
  const [mappedObjects] = bridge.__test.mapCompletionResult([objectItem], 210, 210, { focusLine: 0, text: "Company.objects" });
  assert.equal(mappedObjects.range.inserting.start.line, 0);
  assert.equal(mappedObjects.range.inserting.start.character, 18);
  assert.equal(mappedObjects.textEdit.range.start.character, 18);
  assert.equal(mappedObjects.additionalTextEdits[0].range.start.line, 0);
  assert.equal(mappedObjects.additionalTextEdits[0].newText, "from app.models import Company\n\n");
  assert.equal(bridge.__test.analysisOffsetForText("from app.models import Company\n# --- django shell input ---\nCompany.obj", 2, 1), -1);
  assert.equal(bridge.__test.analysisOffsetForText("Company.obj", 2, 1), 1);
  objectItem.additionalTextEdits = [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), "from app.models import Company\n")];
  const [protectedObjects] = bridge.__test.mapCompletionResult([objectItem], 0, 2, { focusLine: 0, text: "Company.objects" });
  assert.equal(protectedObjects.additionalTextEdits[0].range.start.line, 0);
  const memory = require(path.join(extension.extensionPath, "out", "overlayMemoryDocument.js"));
  assert.equal(memory.__test.extractUserText("from stale import Old\n# --- django shell input ---\nfrom fresh import New\n# --- django shell input ---\nCompany.objects", "from fresh import New\n"), "Company.objects");

  assertRuntimePreludeFallbacks(extension);
  assertBackendInspectSeparation(extension);
  assertDjangoManagerCompletion(bridge);
  assertNoFakeInlaySemanticProviders(extension);
  assertNoStructuralFormatOnEnter(extension);
  assertNoHiddenDocumentEnterRunner(extension);
  assertCmdEnterKeybinding(extension);
  assertOverlayReinjectsAfterRendererLoss(extension);
  assertRestartResetGuards(extension);
  assertOverlayRendererGuards(extension);
  assertOverlayChromeIsEmbedded(extension);
  assertWorkbenchModelLanguageSelection(extension);
  await assertGeneratedShadowCleanup(extension);
  await assertPythonCellBehavior(extension);
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

/** Returns a compact text line count for document size assertions. */
function textLineCount(text) {
  return text ? text.split(/\r?\n/).length : 0;
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
    "class Base: base_field=7",
    "class Child(Base): child_field=8",
    "namespace={'pd': types.ModuleType('pandas'), 'settings': LazySettings()}",
    "namespace['Child']=Child",
    "initial=set(namespace)",
    "namespace['user_value']=3",
    "inspect=mod._run_request(namespace, 'tok', {'token':'tok','kind':'inspect','lightweight':True}, initial)",
    "prelude=mod._run_request(namespace, 'tok', {'token':'tok','kind':'prelude'}, initial)",
    "children=mod._run_request(namespace, 'tok', {'token':'tok','kind':'children','path':[{'op':'name','name':'Child'}]}, initial)",
    "print(json.dumps({'children':[v['name'] for v in children['children']], 'inspect':[v['name'] for v in inspect['variables']], 'prelude':[v['name'] for v in prelude['variables']]}))"
  ].join("\n");
  const result = childProcess.spawnSync(pythonExecutable(), ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.inspect.includes("settings"), false);
  assert.equal(payload.inspect.includes("user_value"), true);
  assert.equal(payload.prelude.includes("settings"), true);
  assert.equal(payload.children.includes("base_field"), true);
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

/** Verifies hidden console-cell.py document changes cannot execute Python code. */
function assertNoHiddenDocumentEnterRunner(extension) { const source = fs.readFileSync(path.join(extension.extensionPath, "out", "overlayShellCommand.js"), "utf8"); assert.equal(source.includes("onDidChangeTextDocument") || source.includes("overlay.document.enter"), false); }

/** Verifies fake inlay and semantic providers do not compete with Pylance. */
function assertNoFakeInlaySemanticProviders(extension) {
  const source = fs.readFileSync(path.join(extension.extensionPath, "out", "overlayPythonFeatureBridge.js"), "utf8");
  assert.equal(source.includes("registerInlayHintsProvider"), false);
  assert.equal(source.includes("registerDocumentSemanticTokensProvider"), false);
}

/** Verifies shell Enter cannot trigger formatter rewrites such as Black list expansion. */
function assertNoStructuralFormatOnEnter(extension) {
  const lintSource = fs.readFileSync(path.join(extension.extensionPath, "out", "overlayLint.js"), "utf8");
  assert.equal(lintSource.includes("executeFormatRangeProvider"), false);
}

/** Verifies the workbench keybinding layer routes Cmd+Enter to rerun current input. */
function assertCmdEnterKeybinding(extension) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, "package.json"), "utf8"));
  const keybinding = manifest.contributes.keybindings.find((item) => item.command === "djangoShell.overlayRunCurrentInput");
  assert.equal(keybinding.mac, "cmd+enter");
  assert.ok(keybinding.when.includes("djangoShell.overlayVisible"));
}

/** Verifies overlay show retries renderer patching after a stale workbench context. */
function assertOverlayReinjectsAfterRendererLoss(extension) {
  const source = fs.readFileSync(path.join(extension.extensionPath, "out", "workbenchOverlay.js"), "utf8");
  assert.ok(source.includes("overlay-not-installed"));
  assert.ok(source.includes("await this.inject()"));
  assert.ok(source.includes("waitForOverlayCapture"));
  assert.ok(source.includes("report.includes(\":editor:\")"));
}

/** Verifies restart clears stale overlay input and generated prelude documents. */
async function assertRestartClearsOverlayDocuments() {
  const uris = overlayUris();
  const stale = "from stale.models import Old\n# --- django shell input ---\nold_value = 1\n";
  await replaceDocument(uris.editor, stale);
  await replaceDocument(uris.analysis, stale);
  await vscode.commands.executeCommand("djangoShell.e2eRestartKernel");
  const texts = await waitForOverlayText((value) => value.editor === "# --- django shell input ---\n" && value.analysis === "");
  assert.equal(texts.editor.includes("old_value"), false);
  assert.equal(texts.analysis.includes("from stale.models import Old"), false);
}

/** Writes stale generated overlay files before activation to verify startup cleanup. */
async function writePreActivationStaleOverlayFiles() {
  const uris = overlayUris();
  const stale = "from stale.models import Old\n# --- django shell input ---\nstale_value = 1\n".repeat(80);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ".django-shell"));
  await vscode.workspace.fs.writeFile(uris.editor, Buffer.from(stale));
  await vscode.workspace.fs.writeFile(uris.analysis, Buffer.from(stale));
}

/** Verifies startup truncates stale generated files instead of importing them as user code. */
async function assertPreActivationStaleOverlayFilesCleaned() {
  const texts = await waitForOverlayText((value) => !value.editor.includes("stale_value") && !value.analysis.includes("stale_value"));
  assert.ok(textLineCount(texts.editor) < 20, `editor stayed too large: ${textLineCount(texts.editor)} lines`);
  assert.ok(textLineCount(texts.analysis) < 20, `analysis stayed too large: ${textLineCount(texts.analysis)} lines`);
}

/** Verifies restart guards against stale prelude refreshes from the old backend. */
function assertRestartResetGuards(extension) {
  const consoleSource = fs.readFileSync(path.join(extension.extensionPath, "out", "customConsole.js"), "utf8");
  const overlaySource = fs.readFileSync(path.join(extension.extensionPath, "out", "workbenchOverlay.js"), "utf8");
  assert.ok(consoleSource.includes("runtimeGeneration"));
  assert.ok(consoleSource.includes("resetPythonCell"));
  assert.ok(consoleSource.includes("this.runtimeInspection.invalidate()"));
  assert.ok(consoleSource.includes("this.runtimePrelude.invalidate()"));
  assert.ok(overlaySource.includes("resetExpression")); assert.ok((consoleSource.match(/show: this\.runtimeReady/g) ?? []).length >= 2);
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

/** Returns the generated overlay document URIs in the E2E workspace. */
function overlayUris() {
  const root = vscode.workspace.workspaceFolders[0].uri;
  return {
    analysis: vscode.Uri.joinPath(root, ".django-shell", "analysis.py"),
    editor: vscode.Uri.joinPath(root, ".django-shell", "console-cell.py")
  };
}

/** Replaces one open text document with the requested content. */
async function replaceDocument(uri, text) {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ".django-shell"));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

/** Waits until both generated overlay documents match a predicate. */
async function waitForOverlayText(predicate, timeoutMs = 10000) {
  const started = Date.now();
  let last = {};
  while (Date.now() - started < timeoutMs) {
    const uris = overlayUris();
    last = { analysis: await readTextFile(uris.analysis), editor: await readTextFile(uris.editor) };
    if (predicate(last)) {
      return last;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for overlay documents: ${JSON.stringify(last)}`);
}

/** Reads a UTF-8 workspace file, returning an empty string while it is absent. */
async function readTextFile(uri) {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return "";
  }
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

/** Verifies renderer guards that protect completion Enter and user-only prelude models. */
function assertOverlayRendererGuards(extension) {
  const sync = require(path.join(extension.extensionPath, "out", "workbenchOverlaySyncRenderer.js"));
  const source = sync.overlaySyncRendererSource();
  const state = { nodes: [], overlayRoot: null };
  const window = { addEventListener: () => undefined, clearTimeout: () => undefined, removeEventListener: () => undefined, setTimeout: (fn) => { fn(); return 0; }, __djangoShellOverlayPrelude: "" };
  const document = { activeElement: null, addEventListener: () => undefined, getElementById: (id) => id === "django-shell-overlay" ? state.overlayRoot : null, querySelectorAll: (selector) => state.nodes.filter((node) => selectorMatches(selector, node)), removeEventListener: () => undefined };
  const api = Function("window", "document", "__dsoPost", `${source}\nreturn { applyPrelude: window.__dsoApplyPreludeHiddenArea, enterPayload: __dsoEnterPayload, installEnterRunner: window.__dsoInstallEnterRunner, suggestOpen: __dsoSuggestOpen };`)(window, document, () => undefined);

  state.nodes = [popupNode(["suggest-widget", "visible"], { height: 120, width: 240 })];
  assert.equal(api.suggestOpen(), true);
  state.nodes = [popupNode(["suggest-widget"], { height: 120, width: 240 })];
  assert.equal(api.suggestOpen(), false);
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

  assert.equal(model.getValue(), "objectsa = Company.objec");
  assert.deepEqual(editor.hiddenAreas, []);
  assert.equal(root.__dsoUserStartLine, 1);
  assert.deepEqual(editor.position, { column: 24, lineNumber: 1 });

  const duplicatedModel = fakeModel(`${prefix}${prefix}Company.objects`);
  api.applyPrelude({ __dsoPreludeText: prelude, __dsoUseVisiblePrelude: true }, fakeEditor(duplicatedModel, { column: 1, lineNumber: 7 }));
  assert.equal(duplicatedModel.getValue(), "Company.objects");

  editor.hiddenAreas = [];
  model.setValue(`${prefix}objectsa = Company.objects`);
  assert.equal(model.getValue(), "objectsa = Company.objects");
  assert.deepEqual(editor.hiddenAreas, []);

  const listModel = fakeModel("a = [\n    1,\n    2,\n    3,\n]");
  const listPayload = api.enterPayload({ __dsoInputStartLine: 1, __dsoUserStartLine: 1 }, fakeEditor(listModel, { column: 2, lineNumber: 5 }));
  assert.equal(listPayload.code, "a = [\n    1,\n    2,\n    3,\n]");
  const tupleModel = fakeModel("a = (\n    1,\n    2,\n)");
  const tuplePayload = api.enterPayload({ __dsoInputStartLine: 1, __dsoUserStartLine: 1 }, fakeEditor(tupleModel, { column: 2, lineNumber: 4 }));
  assert.equal(tuplePayload.code, "a = (\n    1,\n    2,\n)");

  const commands = new Map();
  const rerunEditor = fakeEditor(fakeModel("x = 1\nx + 1\n"), { column: 2, lineNumber: 1 });
  rerunEditor.addCommand = (key, callback) => { commands.set(key, callback); return key; };
  rerunEditor.executeEdits = (_source, edits) => { rerunEditor.edits = edits; };
  rerunEditor.getSelection = () => ({ endColumn: 2, endLineNumber: 1, startColumn: 2, startLineNumber: 1 });
  rerunEditor.getDomNode = () => ({ addEventListener: () => undefined, contains: () => true, removeEventListener: () => undefined });
  const posts = [];
  const runnerRoot = {};
  state.overlayRoot = runnerRoot;
  api.installEnterRunner(runnerRoot, rerunEditor, (payload) => {
    posts.push(payload);
    return { json: async () => ({ executed: true }) };
  });
  assert.equal(commands.size, 1, "only explicit Shift Enter installs a Monaco command");
  assert.equal(posts.some((payload) => payload.type === "run"), false);
  rerunEditor.position = { column: 2, lineNumber: 1 };
  assert.equal(window.__dsoRunCurrentOverlayInput(), "requested");
  assert.equal(posts.some((payload) => payload.type === "run" && payload.code === "x = 1\nx + 1"), true);
}

/** Verifies the captured Monaco editor visually occupies the cell instead of a floating frame. */
function assertOverlayChromeIsEmbedded(extension) {
  const renderer = require(path.join(extension.extensionPath, "out", "workbenchOverlayRenderer.js"));
  const source = renderer.overlayRendererSource("file:///workspace/.django-shell/console-cell.py");
  assert.ok(source.includes(".django-shell-overlay-head{display:none}"));
  assert.ok(source.includes("border:0"));
  assert.ok(source.includes("formatOnPaste: false"));
  assert.ok(source.includes("formatOnType: false"));
  assert.ok(source.includes(".django-shell-overlay-editor{width:100%;height:100%"));
  assert.ok(source.includes("__dsoGeometryTimer"));
  assert.ok(source.includes("__dsoDisposeOverlay"));
  assert.ok(source.includes("__djangoShellOverlayReset"));
  assert.ok(source.includes("__dsoResetOverlayText"));
  assert.ok(source.includes("__dsoPendingRetryTimer")); assert.ok(source.includes("root.__dsoPendingRetries <= 10")); assert.ok(source.includes("eNestedKeys"));
  assert.ok(source.includes("__dsoResizeObserver"));
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
    getValueInRange: (range) => {
      const current = lines();
      const selected = current.slice(range.startLineNumber - 1, range.endLineNumber);
      if (!selected.length) {
        return "";
      }
      selected[0] = selected[0].slice(range.startColumn - 1);
      selected[selected.length - 1] = selected[selected.length - 1].slice(0, range.endColumn - 1);
      return selected.join("\n");
    },
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

module.exports = { run };

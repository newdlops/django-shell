// Strict E2E checks for the v0.0.2-style file-backed Python cell.

const assert = require("node:assert/strict");
const vscode = require("vscode");
const { assertGoldenPythonExecution } = require("./pythonCellGolden.js");
const { assertOverlayHoverPointerHandoff } = require("./overlayHoverPointer.js");

const INPUT_MARKER = "# --- django shell input ---";
const SHELL_LANGUAGE_ID = "django-shell-python";
const PRELUDE = "# Django shell runtime imports for analysis.\n# ruff: noqa\nfrom orm_runtime.models import Company\n\n";
const GOLDEN_PRELUDE_LINES = ["from orm_runtime.models import Company", ...Array.from({ length: 4100 }, (_, index) => `__dso_large_prelude_${index} = ${index}`)];
const GOLDEN_PRELUDE = `# Django shell runtime imports for analysis.\n# ruff: noqa\n${GOLDEN_PRELUDE_LINES.join("\n")}\n\n`;
const USER_CODE = "company = Company()\nprint(company.name.upper())\ncompanies = Company.objects.filter(name__icontains='Acme')\nfor item in companies:\n    print(item)";
const THEMED_SYMBOLS = ["company", "Company", "print", "name", "upper", "companies", "objects", "filter", "name__icontains", "Acme", "item"];

/** Verifies theme, completion, latency, and extension behavior on the current Python cell path. */
async function assertPythonCellBehavior(extension) {
  const root = vscode.workspace.workspaceFolders[0].uri;
  await writeDjangoOrmRuntimeFixture(root);
  await activatePythonExtensions();
  await vscode.commands.executeCommand("djangoShell.e2eSetPrelude", ["from orm_runtime.models import Company"]);
  await withStageTimeout("initial overlay show", vscode.commands.executeCommand("djangoShell.showOverlayEditor"), 20000);
  await assertGeneratedOverlayFilesHidden("initial overlay show");
  const generatedText = `${PRELUDE}${INPUT_MARKER}\n${USER_CODE}`;
  await withStageTimeout("overlay document install", installOverlayDocument(generatedText), 20000);
  await assertGeneratedOverlayFilesHidden("overlay document install");
  await withStageTimeout("overlay editor show", vscode.commands.executeCommand("djangoShell.showOverlayEditor"), 20000);
  await assertGeneratedOverlayFilesHidden("overlay editor show");
  if (process.env.DJANGO_SHELL_E2E_HOVER_ONLY === "1") {
    await withStageTimeout("renderer hover pointer handoff", assertOverlayHoverPointerHandoff(extension), 30000);
    await assertGeneratedOverlayFilesHidden("renderer hover pointer handoff");
    return;
  }
  if (process.env.DJANGO_SHELL_E2E_AUTO_IMPORT_ONLY === "1") {
    await withStageTimeout("unit-local auto import", assertUnitLocalAutoImport(generatedText), 45000);
    await assertGeneratedOverlayFilesHidden("unit-local auto import");
    return;
  }
  if (process.env.DJANGO_SHELL_E2E_THEME_ONLY === "1") {
    const text = await withStageTimeout("overlay document open", waitForOpenDocumentText((value) => value.includes(USER_CODE)), 20000);
    await withStageTimeout("forwarded semantic tokens", assertForwardedSemanticTokens(overlayUris().editor, text), 30000);
    await withStageTimeout("renderer theme checks", assertRendererTheme(extension), 30000);
    await assertGeneratedOverlayFilesHidden("renderer theme checks");
    return;
  }
  await withStageTimeout("golden python execution", assertGoldenPythonExecution({ extension, generatedText, importLines: GOLDEN_PRELUDE_LINES, inputMarker: INPUT_MARKER, installOverlayDocument, prelude: GOLDEN_PRELUDE, restoreImportLines: ["from orm_runtime.models import Company"], waitForOpenDocumentText }), 90000);
  await assertGeneratedOverlayFilesHidden("golden python execution");
  await withStageTimeout("overlay input smoke", assertOverlayAcceptsPythonInput(extension), 20000);
  await assertGeneratedOverlayFilesHidden("overlay input smoke");
  await withStageTimeout("overlay block indent smoke", assertOverlayBlockIndentOnEnter(extension), 30000);
  await assertGeneratedOverlayFilesHidden("overlay block indent smoke");
  await withStageTimeout("external enter dispatch", assertExternalEnterDoesNotRun(extension), 30000);
  await assertGeneratedOverlayFilesHidden("external enter dispatch");
  const text = await withStageTimeout("overlay document open", waitForOpenDocumentText((value) => value.includes(USER_CODE)), 20000);
  await assertGeneratedOverlayFilesHidden("overlay document open");
  await withStageTimeout("provider feature checks", assertProviderFeatures(overlayUris().editor, text), 45000);
  await assertGeneratedOverlayFilesHidden("provider feature checks");
  await withStageTimeout("cross-unit workspace context", assertCrossUnitWorkspaceContext(generatedText), 45000);
  await assertGeneratedOverlayFilesHidden("cross-unit workspace context");
  await withStageTimeout("unit-local auto import", assertUnitLocalAutoImport(generatedText), 45000);
  await assertGeneratedOverlayFilesHidden("unit-local auto import");
  await withStageTimeout("renderer theme checks", assertRendererTheme(extension), 30000);
  await assertGeneratedOverlayFilesHidden("renderer theme checks");
  await withStageTimeout("renderer hover pointer handoff", assertOverlayHoverPointerHandoff(extension), 30000);
  await assertGeneratedOverlayFilesHidden("renderer hover pointer handoff");
  await withStageTimeout("input latency checks", assertInputLatency(extension), 15000);
  await assertGeneratedOverlayFilesHidden("input latency checks");
}

/** Fails one long E2E stage with a precise boundary instead of hanging. */
async function withStageTimeout(stage, promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out during ${stage} after ${timeoutMs}ms`)), timeoutMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Verifies the overlay editor exists, accepts Python edits, and syncs them to the hidden backing file. */
async function assertOverlayAcceptsPythonInput(extension) {
  let result = {};
  let attempts = 0;
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      await withStageTimeout("overlay input show attempt", vscode.commands.executeCommand("djangoShell.showOverlayEditor"), 7000);
    } catch (error) {
      result = { ok: false, reason: "show-attempt-error", error: error instanceof Error ? error.message : String(error) };
      break;
    }
    try {
      result = JSON.parse(await withStageTimeout("overlay input eval attempt", evalInWorkbench(extension, overlayInputSmokeExpression()), 7000));
    } catch (error) {
      result = { ok: false, reason: "eval-attempt-error", error: error instanceof Error ? error.message : String(error) };
      break;
    }
    if (result.ok) {
      try {
        await waitForOpenDocumentText((value) => value.includes(result.line));
      } catch (error) {
        const debug = JSON.parse(await evalInWorkbench(extension, overlaySyncDebugExpression(result.line)));
        const fileText = await readTextFile(overlayUris().editor);
        throw new Error(`overlay input sync failed: result=${JSON.stringify(result)} debug=${JSON.stringify(debug)} fileTail=${JSON.stringify(fileText.slice(-400))} error=${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    await delay(150);
  }
  const debug = await withStageTimeout("overlay input final debug", evalInWorkbench(extension, overlaySyncDebugExpression(result.line || "")), 7000).catch((error) => JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  const fileText = await readTextFile(overlayUris().editor).catch((error) => `read-error:${error instanceof Error ? error.message : String(error)}`);
  assert.equal(result.ok, true, `overlay input smoke failed after ${attempts} attempts: result=${JSON.stringify(result)} debug=${debug} fileTail=${JSON.stringify(String(fileText).slice(-400))}`);
}

/** Verifies Enter on an incomplete Python block inserts an indented continuation without execution. */
async function assertOverlayBlockIndentOnEnter(extension) {
  const before = await e2eExecutionCount();
  let result = {};
  for (let attempt = 0; attempt < 30; attempt++) {
    await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
    result = JSON.parse(await evalInWorkbench(extension, overlayBlockIndentExpression()));
    if (result.ok) {
      await delay(500);
      assert.equal(await e2eExecutionCount(), before, `incomplete block Enter executed Python: ${JSON.stringify(result)}`);
      return;
    }
    await delay(150);
  }
  assert.equal(result.ok, true, `overlay block indent probe failed: ${JSON.stringify(result)}`);
}

/** Verifies Enter outside the overlay editor is not captured by stale focused CSS. */
async function assertExternalEnterDoesNotRun(extension) {
  const before = await e2eExecutionCount();
  let result = {};
  for (let attempt = 0; attempt < 40; attempt++) {
    await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
    result = JSON.parse(await evalInWorkbench(extension, externalEnterExpression()));
    if (result.ok) {
      break;
    }
    await delay(150);
  }
  assert.equal(result.ok, true, `external enter probe failed: ${JSON.stringify(result)}`);
  await delay(500);
  assert.equal(await e2eExecutionCount(), before, "external Enter keydown triggered Python execution");
}

/** Writes a small Django-like runtime fixture for Python and ORM extension probes. */
async function writeDjangoOrmRuntimeFixture(root) {
  await writeFile(root, "manage.py", "import code, os, sys\n\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'orm_project.settings')\nimport django\ndjango.setup()\nfrom orm_runtime.models import Company\n\nif __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == 'shell':\n    code.interact(local=globals())\n");
  await writeFile(root, "orm_project/__init__.py", "");
  await writeFile(root, "orm_project/settings.py", "INSTALLED_APPS = ['orm_runtime']\nSECRET_KEY = 'e2e'\n");
  await writeFile(root, "django/__init__.py", "VERSION = (5, 0, 0)\n\ndef get_version():\n    return '5.0.e2e'\n\ndef setup():\n    from django.apps import apps\n    apps.ready = True\n");
  await writeFile(root, "django/apps.py", "class _Apps:\n    ready = False\n    def get_app_configs(self):\n        from django.conf import settings\n        return [type('AppConfig', (), {'name': name})() for name in settings.INSTALLED_APPS]\napps = _Apps()\n");
  await writeFile(root, "django/conf.py", "import importlib, os\n\nclass _Settings:\n    @property\n    def configured(self):\n        return bool(self.SETTINGS_MODULE)\n    @property\n    def SETTINGS_MODULE(self):\n        return os.environ.get('DJANGO_SETTINGS_MODULE', '')\n    def __getattr__(self, name):\n        return getattr(importlib.import_module(self.SETTINGS_MODULE), name)\nsettings = _Settings()\n");
  await writeFile(root, "django/db/__init__.py", "from . import models\n");
  await writeFile(root, "django/db/models.py", [
    "from __future__ import annotations",
    "from typing import Generic, TypeVar",
    "_T = TypeVar('_T')",
    "class QuerySet(list[_T], Generic[_T]):",
    "    pass",
    "class Manager(Generic[_T]):",
    "    def __init__(self, model_name='Model'):",
    "        self.model_name = model_name",
    "    def filter(self, **kwargs: object) -> QuerySet[_T]:",
    "        return QuerySet([f'{self.model_name}:{kwargs}'])",
    "class Field:",
    "    def __init__(self, *args, **kwargs):",
    "        pass",
    "class CharField(Field):",
    "    pass",
    "class Model:",
    "    pass",
    ""
  ].join("\n"));
  await writeFile(root, "django/db/models.pyi", [
    "from __future__ import annotations",
    "from typing import Generic, TypeVar",
    "_T = TypeVar('_T')",
    "class QuerySet(list[_T], Generic[_T]):",
    "    pass",
    "class Manager(Generic[_T]):",
    "    def __init__(self, model_name: str = 'Model') -> None: ...",
    "    def filter(self, **kwargs: object) -> QuerySet[_T]: ...",
    "class Field:",
    "    def __init__(self, *args: object, **kwargs: object) -> None: ...",
    "class CharField(Field):",
    "    pass",
    "class Model:",
    "    pass",
    ""
  ].join("\n"));
  await writeFile(root, "orm_runtime/__init__.py", "");
  await writeFile(root, "orm_runtime/models.py", [
    "from __future__ import annotations",
    "from django.db import models",
    "class Company(models.Model):",
    "    name = models.CharField(max_length=100)",
    "    objects: models.Manager[Company] = models.Manager('Company')",
    ""
  ].join("\n"));
  await writeFile(root, "orm_runtime/models.pyi", [
    "from __future__ import annotations",
    "from django.db import models",
    "class Company(models.Model):",
    "    name: str",
    "    objects: models.Manager[Company]",
    ""
  ].join("\n"));
  await writeFile(root, "workspace_context.py", "class AutoImportedClient:\n    def auto_imported_method(self) -> str:\n        return 'auto-imported'\n\nclass WidgetImportedClient:\n    pass\n\nclass WorkspaceClient:\n    def workspace_method(self) -> str:\n        return 'workspace'\n\ndef make_workspace_client() -> WorkspaceClient:\n    return WorkspaceClient()\n");
}

/** Writes one UTF-8 fixture file under the E2E workspace root. */
async function writeFile(root, relativePath, text) {
  const parts = relativePath.split("/");
  const fileName = parts.pop();
  const directory = parts.length ? vscode.Uri.joinPath(root, ...parts) : root;
  assert.ok(fileName, `file path required: ${relativePath}`);
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, fileName), Buffer.from(text, "utf8"));
}

/** Activates the real Python, Pylance, and Django ORM extensions. */
async function activatePythonExtensions() {
  await assertExtensionLoaded("ms-python.python");
  await assertExtensionLoaded("ms-python.vscode-pylance");
  await assertExtensionLoaded("newdlops.django-orm-intellisense");
}

/** Activates one required extension by id. */
async function assertExtensionLoaded(id) {
  const extension = vscode.extensions.getExtension(id);
  assert.ok(extension, `${id} must be available for strict Python cell E2E.`);
  await extension.activate();
  assert.equal(extension.isActive, true);
}

/** Installs user-only editor text and marker-free full analysis text. */
async function installOverlayDocument(text) {
  const uris = overlayUris();
  const marker = `${INPUT_MARKER}\n`;
  const markerIndex = text.lastIndexOf(marker);
  const visibleText = markerIndex >= 0 ? text.slice(markerIndex + marker.length) : text;
  const analysisText = markerIndex >= 0 ? `${text.slice(0, markerIndex)}${visibleText}` : text;
  await replaceDocument(uris.editor, visibleText);
  await replaceDocument(uris.analysis, analysisText);
  return await waitForOpenDocumentText((value) => value === visibleText);
}

/** Replaces one workspace text document. */
async function replaceDocument(uri, text) {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ".django-shell"));
  let opened = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
  if (!opened) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
    opened = await vscode.workspace.openTextDocument(uri);
  }
  const languageId = uri.path.endsWith("/console-cell.py") ? SHELL_LANGUAGE_ID : "python";
  const document = opened.languageId === languageId ? opened : await vscode.languages.setTextDocumentLanguage(opened, languageId);
  if (document.getText() !== text) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    await vscode.workspace.applyEdit(edit);
  }
  await document.save();
}

/** Waits until the visible overlay file document matches one predicate. */
async function waitForOpenDocumentText(predicate) {
  const uri = overlayUris().editor;
  let last = "";
  for (let attempt = 0; attempt < 80; attempt++) {
    const text = await readOpenOrFileText(uri);
    last = text;
    if (predicate(text)) {
      return text;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for overlay document: ${uri.toString()} tail=${JSON.stringify(last.slice(-600))}`);
}

/** Verifies generated provider files are open only as hidden documents, never visible UI tabs. */
async function assertGeneratedOverlayFilesHidden(stage) {
  let exposed = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    exposed = generatedOverlayFileExposure();
    if (!exposed.length) {
      return;
    }
    await closeGeneratedOverlayTabsForTest();
    await delay(100);
  }
  assert.deepEqual(exposed, [], `generated overlay files are visible after ${stage}`);
}

/** Saves and closes generated file tabs that appeared before the app cleanup timer fired. */
async function closeGeneratedOverlayTabsForTest() {
  const generated = new Set([overlayUris().analysis.toString(), overlayUris().editor.toString()]);
  for (const document of vscode.workspace.textDocuments) {
    if (document.isDirty && generated.has(document.uri.toString())) { await document.save(); }
  }
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => generated.has(tab.input?.uri?.toString?.()));
  if (tabs.length) { await vscode.window.tabGroups.close(tabs, true); }
}

/** Returns UI-visible generated overlay file exposures. */
function generatedOverlayFileExposure() {
  const generated = new Set([overlayUris().analysis.toString(), overlayUris().editor.toString()]);
  const tabUris = vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.input?.uri?.toString?.()).filter(Boolean));
  return [
    ...tabUris.filter((uri) => generated.has(uri)).map((uri) => `tab:${uri}`),
    ...vscode.workspace.textDocuments.filter((document) => document.isDirty && generated.has(document.uri.toString())).map((document) => `dirty:${document.uri.toString()}`)
  ];
}

/** Verifies Python/Pylance completion, type hover, definition, and Django ORM hover. */
async function assertProviderFeatures(uri, text) {
  const labels = completionLabels(await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, positionOfText(text, "Company.objects").translate(0, "Company.".length), "."));
  assert.ok(labels.includes("objects"), `missing objects completion: ${labels.slice(0, 40).join(",")}`);
  const companyHover = hoverText(await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, positionOfText(text, "company =").translate(0, 1)));
  assertConcreteHover(companyHover, /\bCompany\b[\s\S]*\bModel:\s*`?(?:orm_runtime\.)?Company`?|\bResolved symbol:\s*`?orm_runtime\.models\.Company`?/, "Company");
  const nameHover = hoverText(await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, positionOfText(text, "name.upper").translate(0, 1)));
  assertConcreteHover(nameHover, /\bstr\b|Field kind:\s*`?CharField`?/, "name");
  const ormHover = await waitForHoverText(uri, positionOfText(text, "name__icontains").translate(0, 2), /Resolved from lookup path `?name__icontains`?/);
  assert.match(ormHover, /Base model:\s*`?(?:orm_runtime\.)?Company`?/, `missing Django ORM extension hover: ${ormHover}`);
  const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, positionOfText(text, "Company()").translate(0, 1));
  assert.ok(definitionUris(definitions).some((uri) => uri.includes("/orm_runtime/models")), `definition failed for Company: ${JSON.stringify(definitionUris(definitions))}`);
  await assertForwardedSemanticTokens(uri, text);
}

/** Verifies visible custom-language tokens retain Pylance class and variable distinctions. */
async function assertForwardedSemanticTokens(uri, text) {
  let legend;
  let tokens;
  let entries = [];
  let company;
  let variable;
  for (let attempt = 0; attempt < 80; attempt++) {
    legend = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokensLegend", uri);
    tokens = legend ? await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", uri) : undefined;
    if (legend?.tokenTypes?.length && tokens?.data?.length) {
      entries = semanticTokenEntries(tokens, legend);
      company = semanticTokenAt(entries, positionOfText(text, "Company()").translate(0, 1));
      variable = semanticTokenAt(entries, positionOfText(text, "company =").translate(0, 1));
      if (company && variable && company.type !== variable.type) { return; }
    }
    await delay(100);
  }
  assert.ok(legend?.tokenTypes?.length, "custom Python semantic legend was not registered");
  assert.ok(tokens?.data?.length, "custom Python semantic tokens were not forwarded");
  assert.ok(company, `missing Company semantic token: ${JSON.stringify(entries.slice(0, 80))}`);
  assert.ok(variable, `missing company semantic token: ${JSON.stringify(entries.slice(0, 80))}`);
  assert.notEqual(company.type, variable.type, `class and variable collapsed to one semantic color type: ${JSON.stringify({ company, variable })}`);
}

/** Decodes delta-encoded semantic token data into absolute visible positions. */
function semanticTokenEntries(tokens, legend) {
  const entries = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index + 4 < tokens.data.length; index += 5) {
    const deltaLine = tokens.data[index];
    line += deltaLine;
    character = deltaLine === 0 ? character + tokens.data[index + 1] : tokens.data[index + 1];
    entries.push({ character, length: tokens.data[index + 2], line, type: legend.tokenTypes[tokens.data[index + 3]] });
  }
  return entries;
}

/** Returns the semantic token covering one source position. */
function semanticTokenAt(entries, position) {
  return entries.find((entry) => entry.line === position.line && position.character >= entry.character && position.character < entry.character + entry.length);
}

/** Verifies a lower execution unit keeps completion, hover, and definition context from an upper workspace import. */
async function assertCrossUnitWorkspaceContext(originalText) {
  const source = "from workspace_context import make_workspace_client\n\n\nclient = make_workspace_client()\nclient.";
  const installed = await installOverlayDocument(`${PRELUDE}${INPUT_MARKER}\n${source}`);
  const uri = overlayUris().editor;
  try {
    const completionPosition = positionOfText(installed, "client.").translate(0, "client.".length);
    let labels = [];
    for (let attempt = 0; attempt < 60 && !labels.includes("workspace_method"); attempt++) {
      labels = completionLabels(await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, completionPosition, "."));
      if (!labels.includes("workspace_method")) { await delay(150); }
    }
    assert.ok(labels.includes("workspace_method"), `lower-unit completion lost the upper workspace import: ${labels.slice(0, 60).join(",")}`);
    const hover = await waitForHoverText(uri, positionOfText(installed, "client =").translate(0, 1), /WorkspaceClient/);
    assert.match(hover, /WorkspaceClient/, `lower-unit hover lost workspace type context: ${hover}`);
    const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, positionOfText(installed, "make_workspace_client()").translate(0, 2));
    assert.ok(definitionUris(definitions).some((value) => value.includes("/workspace_context.py")), `lower-unit definition lost workspace context: ${JSON.stringify(definitionUris(definitions))}`);
  } finally {
    await installOverlayDocument(originalText);
  }
}

/** Verifies Pylance auto-imports and full-source fallback imports target only the focused unit. */
async function assertUnitLocalAutoImport(originalText) {
  try {
    await assertAutoImportForSource("upper = 1\n\n\nclient = AutoImportedCli");
    await assertSuggestionWidgetSurvivesTypingBurst();
    await assertAutoImportForSource("upper = 1\n\n\nclient = AutoImportedClient", 1);
    await assertAutoImportForSource("from workspace_context import AutoImportedClient\nupper = AutoImportedClient()\n\n\nclient = AutoImportedClient", 1);
  } finally {
    await installOverlayDocument(originalText);
  }
}

/** Verifies a live suggest widget keeps compatible candidates while the active prefix grows. */
async function assertSuggestionWidgetSurvivesTypingBurst() {
  await installOverlayDocument(`${PRELUDE}${INPUT_MARKER}\nupper = 1\n\n\nclient = WidgetImp`);
  let result = JSON.parse(await evalInWorkbench(undefined, suggestionWidgetBurstStartExpression()));
  for (let attempt = 0; attempt < 75 && !result.ok && result.reason !== "missing-overlay"; attempt++) {
    await delay(40);
    result = JSON.parse(await evalInWorkbench(undefined, suggestionWidgetSnapshotExpression()));
  }
  assert.equal(result.ok, true, `suggest widget lost a known completion during typing: ${JSON.stringify(result)}`);
  assert.equal(result.sawNoSuggestions, false, `suggest widget exposed a false empty result: ${JSON.stringify(result)}`);
  assert.ok(result.elapsedMs <= 3000, `suggest widget reacted too slowly: ${JSON.stringify(result)}`);
}

/** Verifies one partial completion carries its import edit at the lower execution-unit start. */
async function assertAutoImportForSource(source, attempts = 60) {
  const installed = await installOverlayDocument(`${PRELUDE}${INPUT_MARKER}\n${source}`);
  const uri = overlayUris().editor;
  const inputLine = source.split(/\r?\n/).find((line) => line.startsWith("client = AutoImportedCli"));
  assert.ok(inputLine, `missing auto-import input line: ${source}`);
  const unitPosition = positionOfText(installed, inputLine);
  const completionPosition = unitPosition.translate(0, inputLine.length);
  const unitStart = unitPosition.line;
  let item;
  let observed = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    let result = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, completionPosition);
    let items = completionItems(result);
    observed = items.slice(0, 80).map(completionDebugValue);
    const index = items.findIndex((candidate) => completionLabel(candidate) === "AutoImportedClient");
    item = index >= 0 ? items[index] : undefined;
    if (item && !item.additionalTextEdits?.length) {
      result = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, completionPosition, undefined, index + 1);
      items = completionItems(result);
      item = items.find((candidate) => completionLabel(candidate) === "AutoImportedClient");
    }
    if (item?.additionalTextEdits?.some((edit) => edit.newText.includes("from workspace_context import AutoImportedClient"))) { break; }
    if (attempt + 1 < attempts) { await delay(150); }
  }
  assert.ok(item, `missing AutoImportedClient completion: ${JSON.stringify(observed)}`);
  const importEdit = item.additionalTextEdits?.find((edit) => edit.newText.includes("from workspace_context import AutoImportedClient"));
  assert.ok(importEdit, `AutoImportedClient completion lost its auto-import: ${JSON.stringify(completionDebugValue(item))}`);
  assert.equal(importEdit.range.start.line, unitStart, `auto-import targeted another execution unit: ${JSON.stringify(completionDebugValue(item))}`);
  assert.equal(importEdit.range.start.character, 0);
  assert.equal(importEdit.range.end.line, unitStart);
  assert.equal(item.textEdit?.range.start.line, unitStart, `primary completion edit left the focused unit: ${JSON.stringify(completionDebugValue(item))}`);
}

/** Verifies a hover contains a concrete signal even when lower-priority providers add noise. */
function assertConcreteHover(text, pattern, label) {
  assert.match(text, pattern, `missing concrete ${label} hover: ${text}`);
}

/** Waits for one hover provider result matching a pattern. */
async function waitForHoverText(uri, position, pattern) {
  let text = "";
  for (let attempt = 0; attempt < 80; attempt++) {
    text = hoverText(await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, position));
    if (pattern.test(text)) {
      return text;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for hover: ${text}`);
}

/** Reads an open dirty document first, falling back to the saved workspace file. */
async function readOpenOrFileText(uri) {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
  return open ? open.getText() : readTextFile(uri);
}

/** Reads a UTF-8 workspace file, returning an empty string while it is absent. */
async function readTextFile(uri) {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return "";
  }
}

/** Verifies rendered Monaco theme colors are applied to every expected symbol. */
async function assertRendererTheme(extension) {
  const snapshot = await waitForRendererSnapshot(extension);
  assert.equal(snapshot.language, SHELL_LANGUAGE_ID);
  assert.ok(String(snapshot.uri).endsWith("/.django-shell/console-cell.py"), String(snapshot.uri));
  assert.ok(renderedText(snapshot).includes("name__icontains"), JSON.stringify(snapshot.tokens));
  assert.ok(themeColorCount(snapshot) >= 3, `expected multiple theme colors: ${JSON.stringify(snapshot.tokens)}`);
  for (const symbol of THEMED_SYMBOLS) {
    const token = symbolToken(snapshot, symbol);
    assert.ok(token, `missing rendered symbol ${symbol}: ${JSON.stringify(snapshot.tokens)}`);
    assert.ok(visibleColor(token.color), `symbol ${symbol} has no theme color: ${JSON.stringify(token)}`);
    assert.match(String(token.className), /\bmtk\d+\b/, `symbol ${symbol} has no Monaco token class: ${JSON.stringify(token)}`);
  }
}

/** Waits for renderer syntax token data to become available. */
async function waitForRendererSnapshot(extension) {
  let last = {};
  for (let attempt = 0; attempt < 60; attempt++) {
    last = JSON.parse(await evalInWorkbench(extension, rendererSnapshotExpression()));
    if (last.hasEditor && last.tokens?.length && renderedText(last).includes("Acme")) {
      return last;
    }
    await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
    await delay(150);
  }
  throw new Error(`Timed out waiting for renderer syntax snapshot: ${JSON.stringify(last)}`);
}

/** Verifies overlay input render latency stays within a strict absolute budget. */
async function assertInputLatency(extension) {
  await evalInWorkbench(extension, `(function(){try{if(typeof __dsoStartCapture==="function"){__dsoStartCapture();return "ok";}return "missing-start-capture";}catch(e){return "capture-error:"+String(e&&e.message||e);}})()`);
  const latency = await waitForOverlayLatencyProbe(extension);
  assert.equal(latency.reason, undefined, `overlay latency probe failed: ${JSON.stringify(latency)}`);
  assert.ok(latency.overlayMedianMs <= 80, `overlay input latency exceeded 80ms: ${JSON.stringify(latency)}`);
  assert.ok(latency.overlayMaxMs <= 160, `overlay input latency had a slow visible frame: ${JSON.stringify(latency)}`);
}

/** Waits for the overlay-only latency probe to find the editor after focus changes. */
async function waitForOverlayLatencyProbe(extension) {
  let latency = {};
  for (let attempt = 0; attempt < 30; attempt++) {
    await vscode.commands.executeCommand("djangoShell.showOverlayEditor");
    latency = JSON.parse(await evalInWorkbench(extension, overlayOnlyLatencyExpression()));
    if (latency.reason !== "missing-overlay-editor") {
      return latency;
    }
    await delay(150);
  }
  return latency;
}

/** Evaluates one expression in the active VS Code workbench renderer. */
async function evalInWorkbench(extension, rendererExpression) {
  return vscode.commands.executeCommand("djangoShell.e2eEvaluateOverlay", rendererExpression);
}

/** Builds the renderer expression that captures tokens and theme colors. */
function rendererSnapshotExpression() {
  return `(async()=>{const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));await delay(220);const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();const node=editor&&editor.getDomNode&&editor.getDomNode();const css=(el)=>{const s=el&&window.getComputedStyle?window.getComputedStyle(el):null;return s?{backgroundColor:s.backgroundColor,borderColor:s.borderColor,color:s.color}:{};};const allSpans=Array.from((node||root||document).querySelectorAll(".view-line span"));const leafSpans=allSpans.filter((span)=>!span.querySelector("span"));const spans=leafSpans.length?leafSpans:allSpans;const tokens=spans.map((span)=>Object.assign({className:String(span.className||""),text:String(span.textContent||"")},css(span))).filter((token)=>token.text.trim());return JSON.stringify({editorBackground:css(node).backgroundColor,hasEditor:!!editor,language:model&&model.getLanguageId&&model.getLanguageId(),overlayBackground:css(root).backgroundColor,text:model&&model.getValue&&model.getValue(),tokens,uri:model&&model.uri&&String(model.uri)});})()`;
}

/** Builds a renderer probe that starts completion and records every suggest-widget mutation. */
function suggestionWidgetBurstStartExpression() {
  return `(async()=>{const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(!root||!editor||!model){return JSON.stringify({ok:false,reason:"missing-overlay"});}const prior=window.__dsoSuggestionProbe;try{prior&&prior.observer&&prior.observer.disconnect();}catch(e){}const state={candidateAt:0,candidateSeen:false,finalTypedAt:0,lastText:"",sawNoSuggestions:false,tracking:false};const visible=(node)=>{if(!node){return false;}const aria=node.getAttribute&&node.getAttribute("aria-hidden");const style=getComputedStyle(node);const rect=node.getBoundingClientRect();return aria!=="true"&&!(node.classList&&node.classList.contains("hidden"))&&style.display!=="none"&&style.visibility!=="hidden"&&rect.width>0&&rect.height>0;};state.scan=()=>{const widget=Array.from(document.querySelectorAll(".suggest-widget")).find(visible);const text=String(widget&&widget.textContent||"");if(text){state.lastText=text;}if(state.tracking){state.sawNoSuggestions=state.sawNoSuggestions||/no suggestions/i.test(text);}if(String(model.getValue&&model.getValue()||"").endsWith("WidgetImportedCli")&&text.includes("WidgetImportedClient")){state.candidateSeen=true;state.candidateAt=state.candidateAt||Date.now();}};state.observer=new MutationObserver(state.scan);state.observer.observe(document.body,{attributes:true,characterData:true,childList:true,subtree:true});window.__dsoSuggestionProbe=state;const line=model.getLineCount(),startColumn=model.getLineMaxColumn(line),chunks=["orted","Cl","i"];let column=startColumn;editor.focus&&editor.focus();editor.setPosition&&editor.setPosition({lineNumber:line,column});editor.trigger&&editor.trigger("django-shell-e2e","editor.action.triggerSuggest",{});state.tracking=true;for(let index=0;index<chunks.length;index++){const text=chunks[index];await delay(8);editor.executeEdits("django-shell-e2e-suggest-burst",[{forceMoveMarkers:true,range:{endColumn:column,endLineNumber:line,startColumn:column,startLineNumber:line},text}]);column+=text.length;editor.setPosition&&editor.setPosition({lineNumber:line,column});if(index===chunks.length-1){state.finalTypedAt=Date.now();}editor.trigger&&editor.trigger("django-shell-e2e","editor.action.triggerSuggest",{});}state.scan();const elapsedMs=state.candidateSeen?Math.max(0,state.candidateAt-state.finalTypedAt):0;return JSON.stringify({elapsedMs,lastText:state.lastText.slice(0,500),modelTail:String(model.getValue&&model.getValue()||"").slice(-120),ok:state.candidateSeen,sawNoSuggestions:state.sawNoSuggestions});})()`;
}

/** Builds a renderer probe that snapshots the active completion observation. */
function suggestionWidgetSnapshotExpression() {
  return `(function(){const state=window.__dsoSuggestionProbe;if(!state){return JSON.stringify({ok:false,reason:"missing-probe"});}state.scan&&state.scan();const now=Date.now(),elapsedMs=state.candidateSeen?Math.max(0,state.candidateAt-state.finalTypedAt):state.finalTypedAt?now-state.finalTypedAt:0;const root=document.getElementById("django-shell-overlay"),editor=root&&root.__djangoShellEditor,model=editor&&editor.getModel&&editor.getModel();const result={elapsedMs,lastText:String(state.lastText||"").slice(0,500),modelTail:String(model&&model.getValue&&model.getValue()||"").slice(-120),ok:!!state.candidateSeen,sawNoSuggestions:!!state.sawNoSuggestions};if(result.ok||result.elapsedMs>3000){try{state.observer&&state.observer.disconnect();}catch(e){}}return JSON.stringify(result);})()`;
}

/** Builds a renderer expression that proves the overlay editor model accepts Python text. */
function overlayInputSmokeExpression() {
  return `(async()=>{const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();const caps=window.__dsoCaptures||{};if(!root||!editor||!model){return JSON.stringify({ok:false,reason:"missing-overlay",badModelSvcs:(window.__dsoBadModelSvcs||[]).length,ctors:(caps.ctors||[]).length,editorError:root&&root.__dsoLastEditorError,goodModelSvcs:(window.__dsoGoodModelSvcs||[]).length,hasEditor:!!editor,hasModel:!!model,hasRoot:!!root,insts:(caps.insts||[]).length,modelSvcs:(caps.modelSvcs||[]).length,pendingRetries:root&&root.__dsoPendingRetries,widgets:(caps.widgets||[]).length});}const marker="__dso_input_smoke_"+Date.now().toString(36);const line=marker+" = 41";try{editor.focus&&editor.focus();}catch(eFocus){}const lineNumber=model.getLineCount();const column=model.getLineMaxColumn(lineNumber);try{editor.executeEdits("django-shell-e2e-input-smoke",[{forceMoveMarkers:true,range:{endColumn:column,endLineNumber:lineNumber,startColumn:column,startLineNumber:lineNumber},text:"\\n"+line}]);}catch(error){return JSON.stringify({ok:false,reason:"execute-edits",error:String(error&&error.message||error)});}await delay(80);const text=String(model.getValue&&model.getValue()||"");const includes=text.includes(line);return JSON.stringify({chars:text.length,language:model.getLanguageId&&model.getLanguageId(),line,ok:includes,reason:includes?undefined:"text-not-applied",uri:model.uri&&String(model.uri)});})()`;
}

/** Builds a renderer expression that reports why overlay model sync did not reach the backing file. */
function overlaySyncDebugExpression(line) {
  return `(function(){const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();const text=String(model&&model.getValue&&model.getValue()||"");const syncText=String(root&&root.__dsoLastSyncText||"");const bridge=window.__djangoShellOverlayBridge||{};const caps=window.__dsoCaptures||{};const svc=(caps.modelSvcs||[]).map((s)=>{let own=[],proto=[],ctor="";try{own=Object.getOwnPropertyNames(s).slice(0,12)}catch(e){}try{proto=Object.getOwnPropertyNames(Object.getPrototypeOf(s)||{}).slice(0,12)}catch(e){}try{ctor=s.constructor&&s.constructor.name||""}catch(e){}return{ctor,own,proto};});return JSON.stringify({badModelSvcs:(window.__dsoBadModelSvcs||[]).length,bridgePort:bridge.port,editorError:root&&root.__dsoLastEditorError,goodModelSvcs:(window.__dsoGoodModelSvcs||[]).length,hasRoot:!!root,hasEditor:!!editor,hasModel:!!model,hasSyncDisposable:!!(root&&root.__dsoSyncDisposable),lastPostError:window.__dsoLastPostError,lastPostType:window.__dsoLastPostType,modelHasLine:text.includes(${JSON.stringify(line)}),modelSvcs:svc,sameSyncEditor:!!(root&&root.__dsoSyncEditor===editor),sameSyncModel:!!(root&&root.__dsoSyncModel===model),syncError:root&&root.__dsoLastSyncError,syncHasLine:syncText.includes(${JSON.stringify(line)}),syncStatus:root&&root.__dsoLastSyncStatus,syncTextTail:syncText.slice(-200),uri:model&&model.uri&&String(model.uri),uriCtor:!!window.__dsoUriCtor});})()`;
}

/** Builds a renderer expression that dispatches Enter on a Python block header. */
function overlayBlockIndentExpression() {
  return `(async()=>{const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();const node=editor&&editor.getDomNode&&editor.getDomNode();if(!root||!editor||!model||!node){return JSON.stringify({ok:false,reason:"missing-overlay",hasRoot:!!root,hasEditor:!!editor,hasModel:!!model,hasNode:!!node});}const name="__dso_block_"+Date.now().toString(36);const header="for "+name+" in [1]:";const startLine=model.getLineCount();const startColumn=model.getLineMaxColumn(startLine);let result={ok:false,reason:"not-run"};try{root.__dsoLastEnterRunAt=0;editor.executeEdits("django-shell-e2e-block-header",[{forceMoveMarkers:true,range:{endColumn:startColumn,endLineNumber:startLine,startColumn:startColumn,startLineNumber:startLine},text:"\\n"+header}]);const lineNumber=startLine+1;const column=model.getLineMaxColumn(lineNumber);try{editor.focus&&editor.focus();editor.setPosition&&editor.setPosition({column,lineNumber});}catch(eFocus){}const event=new KeyboardEvent("keydown",{bubbles:true,cancelable:true,code:"Enter",composed:true,key:"Enter",keyCode:13,which:13});node.dispatchEvent(event);await delay(180);const line=model.getLineContent(lineNumber);const next=model.getLineContent(lineNumber+1);result={defaultPrevented:event.defaultPrevented,line,next,ok:line.trim()===header&&next==="    ",reason:line.trim()===header&&next==="    "?undefined:"missing-indent"};}catch(error){result={ok:false,reason:"exception",error:String(error&&error.message||error)};}finally{try{const endLine=model.getLineCount();const endColumn=model.getLineMaxColumn(endLine);editor.executeEdits("django-shell-e2e-block-restore",[{forceMoveMarkers:true,range:{endColumn,endLineNumber:endLine,startColumn,startLineNumber:startLine},text:""}]);editor.setPosition&&editor.setPosition({column:startColumn,lineNumber:startLine});}catch(eRestore){}}return JSON.stringify(result);})()`;
}

/** Builds a renderer expression that dispatches Enter from outside the overlay editor. */
function externalEnterExpression() {
  return `(async()=>{const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const node=editor&&editor.getDomNode&&editor.getDomNode();if(!root||!editor||!node){return JSON.stringify({ok:false,reason:"missing-overlay"});}const button=document.createElement("button");const hadFocused=!!(node.classList&&node.classList.contains("focused"));button.textContent="outside";button.style.cssText="position:fixed;left:0;top:0;width:1px;height:1px;opacity:0";document.body.appendChild(button);try{node.classList.add("focused");button.focus();const event=new KeyboardEvent("keydown",{bubbles:true,cancelable:true,code:"Enter",composed:true,key:"Enter",keyCode:13,which:13});button.dispatchEvent(event);await delay(120);return JSON.stringify({active:document.activeElement===button,defaultPrevented:event.defaultPrevented,ok:true});}finally{if(!hadFocused){try{node.classList.remove("focused");}catch(e){}}button.remove();try{editor.focus&&editor.focus();}catch(eFocus){}}})()`;
}

/** Builds a renderer expression that measures overlay-only input render latency. */
function overlayOnlyLatencyExpression() {
  return `(async()=>{const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));const frame=()=>new Promise((resolve)=>{let done=false;const finish=()=>{if(done){return;}done=true;resolve();};requestAnimationFrame(finish);setTimeout(finish,32);});const clock=()=>performance&&performance.now?performance.now():Date.now();const round=(v)=>Math.round(v*100)/100;const median=(values)=>{const s=values.slice().sort((a,b)=>a-b);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};const visible=(line)=>{const style=getComputedStyle(line);const rect=line.getBoundingClientRect();return style.display!=="none"&&style.visibility!=="hidden"&&rect.height>0&&rect.width>0;};const root=document.getElementById("django-shell-overlay");const editor=root&&root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();const node=editor&&editor.getDomNode&&editor.getDomNode();if(!editor||!model||!node){return JSON.stringify({ok:false,reason:"missing-overlay-editor"});}const rendered=()=>Array.from(node.querySelectorAll(".view-lines .view-line")).filter(visible).map((line)=>String(line.textContent||"").replace(/\\u00a0/g," ")).join("\\n");const waitRendered=async(marker,start)=>{for(let i=0;i<20;i++){if(rendered().includes(marker)){return clock()-start;}await frame();}return 250;};const appendAndMeasure=async(marker)=>{const lineNumber=model.getLineCount();const column=model.getLineMaxColumn(lineNumber);const range={endColumn:column,endLineNumber:lineNumber,startColumn:column,startLineNumber:lineNumber};editor.setPosition&&editor.setPosition({lineNumber,column});editor.revealLineInCenterIfOutsideViewport&&editor.revealLineInCenterIfOutsideViewport(lineNumber);await frame();const start=clock();editor.executeEdits("django-shell-e2e-overlay-latency",[{forceMoveMarkers:true,range,text:"\\n"+marker+" = 1"}]);const elapsed=await waitRendered(marker,start);const endLine=model.getLineCount();const endColumn=model.getLineMaxColumn(endLine);editor.executeEdits("django-shell-e2e-overlay-latency-restore",[{forceMoveMarkers:true,range:{endColumn,endLineNumber:endLine,startColumn:column,startLineNumber:lineNumber},text:""}]);return elapsed;};const samples=[];for(let i=0;i<5;i++){const marker="__dso_overlay_latency_"+Date.now().toString(36)+"_"+i;await delay(5);samples.push(await appendAndMeasure(marker));}const overlayMedianMs=median(samples), overlayMaxMs=Math.max.apply(Math,samples);return JSON.stringify({absoluteLimitMs:80,ok:overlayMedianMs<=80&&overlayMaxMs<=160,overlayMaxMs:round(overlayMaxMs),overlayMedianMs:round(overlayMedianMs),overlaySamplesMs:samples.map(round),samples:5});})()`;
}

/** Returns completion labels from a provider result. */
function completionLabels(result) {
  return completionItems(result).map(completionLabel);
}

/** Returns completion items independently of their result container. */
function completionItems(result) {
  return result instanceof vscode.CompletionList ? result.items : result ?? [];
}

/** Returns one completion label as plain text. */
function completionLabel(item) {
  return typeof item.label === "string" ? item.label : item.label.label;
}

/** Returns compact completion fields for actionable E2E failures. */
function completionDebugValue(item) {
  return {
    additionalTextEdits: item.additionalTextEdits?.map((edit) => ({ newText: edit.newText, range: edit.range })),
    description: typeof item.label === "string" ? undefined : item.label.description,
    detail: item.detail,
    documentation: typeof item.documentation === "string" ? item.documentation.slice(0, 160) : item.documentation?.value?.slice(0, 160),
    label: completionLabel(item),
    textEdit: item.textEdit
  };
}

/** Returns the next Python execution id from the custom console E2E snapshot. */
async function e2eExecutionCount() {
  const snapshot = await vscode.commands.executeCommand("djangoShell.e2eSnapshot");
  assert.equal(typeof snapshot.executionCount, "number", `missing execution count: ${JSON.stringify(snapshot)}`);
  return snapshot.executionCount;
}

/** Returns hover contents as plain text. */
function hoverText(hovers) {
  return (hovers || []).flatMap((hover) => hover.contents || []).map((content) => typeof content === "string" ? content : content.value || "").join("\n");
}

/** Returns URI strings from definition provider output. */
function definitionUris(result) {
  const items = Array.isArray(result) ? result : result ? [result] : [];
  return items.map((item) => item.targetUri?.toString?.() || item.uri?.toString?.() || "");
}

/** Returns the zero-based position where a snippet starts in source text. */
function positionOfText(source, snippet) {
  const index = source.indexOf(snippet);
  assert.notEqual(index, -1, `missing source snippet: ${snippet}`);
  const lines = source.slice(0, index).split(/\r?\n/);
  return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}

/** Returns normalized rendered text from one syntax snapshot. */
function renderedText(snapshot) {
  return (snapshot.tokens || []).map((token) => token.text).join("").replace(/\u00a0/g, " ");
}

/** Returns the token containing one symbol. */
function symbolToken(snapshot, symbol) {
  return (snapshot.tokens || []).find((token) => String(token.text).includes(symbol));
}

/** Returns whether one CSS color is visible. */
function visibleColor(value) {
  const text = String(value || "").replace(/\s+/g, "");
  return /^rgb/.test(text) && text !== "rgba(0,0,0,0)";
}

/** Returns how many distinct token colors are present. */
function themeColorCount(snapshot) {
  return new Set((snapshot.tokens || []).filter((token) => visibleColor(token.color)).map((token) => token.color)).size;
}

/** Returns generated overlay document URIs. */
function overlayUris() {
  const root = vscode.workspace.workspaceFolders[0].uri;
  return { analysis: vscode.Uri.joinPath(root, ".django-shell", "analysis.py"), editor: vscode.Uri.joinPath(root, ".django-shell", "console-cell.py") };
}

/** Waits for a short interval. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { assertPythonCellBehavior };

// Unit tests for v0.0.2-style extension manifest defaults.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("keeps Python language extensions required for v0.0.2 Python cell features", () => {
  assert.deepEqual(manifest.extensionDependencies, ["ms-python.python", "ms-python.vscode-pylance"]);
  assert.equal(manifest.extensionOptionalDependencies.includes("ms-python.python"), false);
  assert.equal(manifest.extensionOptionalDependencies.includes("ms-python.vscode-pylance"), false);
});

test("isolates shell providers behind a Python-syntax wrapper language", () => {
  const language = manifest.contributes.languages.find((item) => item.id === "django-shell-python");
  const grammar = manifest.contributes.grammars.find((item) => item.language === "django-shell-python");
  const breakpoint = manifest.contributes.breakpoints.find((item) => item.language === "django-shell-python");
  const grammarSource = JSON.parse(fs.readFileSync(new URL("../syntaxes/django-shell-python.tmLanguage.json", import.meta.url), "utf8"));

  assert.ok(breakpoint, "VS Code enables native breakpoint widgets through the separate breakpoints contribution");
  assert.equal(language?.configuration, "./syntaxes/django-shell-python-language-configuration.json");
  assert.equal(grammar?.scopeName, "source.python.django-shell");
  assert.equal(grammar?.path, "./syntaxes/django-shell-python.tmLanguage.json");
  assert.equal(grammarSource.scopeName, "source.python.django-shell");
  assert.deepEqual(grammarSource.patterns, [{ include: "source.python" }]);
});

test("restores v0.0.2 Python analysis defaults globally", () => {
  assert.equal(manifest.contributes.configurationDefaults["python.analysis.supportAllPythonDocuments"], true);
  assert.deepEqual(manifest.contributes.configurationDefaults["[python]"], { "editor.semanticHighlighting.enabled": true });
  assert.deepEqual(manifest.contributes.configurationDefaults["[django-shell-python]"], { "editor.semanticHighlighting.enabled": true });
});

test("enables diagnostic logging by default so the shell session is captured for troubleshooting", () => {
  assert.equal(manifest.contributes.configuration.properties["djangoShell.diagnosticLogging"].default, true);
});

test("keeps Python cell Enter from interrupting completion UI", () => {
  const binding = manifest.contributes.keybindings.find((item) => item.command === "djangoShell.overlayAcceptInput");
  assert.ok(binding);
  assert.match(binding.when, /resourceFilename == 'console-cell\.py'/);
  assert.match(binding.when, /editorLangId == 'django-shell-python'/);
  assert.match(binding.when, /!breakpointWidgetVisible/);
  assert.match(binding.when, /suggestWidgetVisible/);
  assert.match(binding.when, /parameterHintsVisible/);
  assert.match(binding.when, /inlineSuggestionVisible/);
});

test("keeps Python cell continuation Enter out of breakpoint widgets", () => {
  const binding = manifest.contributes.keybindings.find((item) => item.command === "djangoShell.overlayInsertNewline");
  assert.ok(binding);
  assert.match(binding.when, /resourceFilename == 'console-cell\.py'/);
  assert.match(binding.when, /editorLangId == 'django-shell-python'/);
  assert.match(binding.when, /!breakpointWidgetVisible/);
});

test("contributes the additive model data browser command and catalog view", () => {
  const commands = manifest.contributes.commands.map((item) => item.command);
  assert.ok(commands.includes("djangoShell.openModelData"));
  assert.ok(commands.includes("djangoShell.refreshModelCatalog"));
  const catalog = manifest.contributes.views.djangoShell.find((item) => item.id === "djangoShell.modelCatalog");
  assert.ok(catalog && catalog.type === "webview", "model catalog is a searchable webview view");
  const views = manifest.contributes.views.djangoShell.map((item) => item.id);
  assert.ok(views.includes("djangoShell.runtimeInspector"), "keeps the existing runtime inspector view");
  assert.ok(views.includes("djangoShell.debugAnalysis"), "adds the debug analysis Activity Bar panel");
  assert.ok(manifest.activationEvents.includes("onView:djangoShell.modelCatalog"));
  assert.ok(manifest.activationEvents.includes("onView:djangoShell.debugAnalysis"));
  assert.ok(manifest.activationEvents.includes("onCommand:djangoShell.openModelData"));
});

test("contributes an overlay skip command and Alt Enter keybinding", () => {
  const commands = manifest.contributes.commands.map((item) => item.command);
  const binding = manifest.contributes.keybindings.find((item) => item.command === "djangoShell.overlaySkipCurrentInput");

  assert.ok(commands.includes("djangoShell.overlaySkipCurrentInput"));
  assert.ok(manifest.activationEvents.includes("onCommand:djangoShell.overlaySkipCurrentInput"));
  assert.equal(binding?.key, "alt+enter");
  assert.match(binding?.when ?? "", /djangoShell\.overlayVisible/);
});

test("contributes a command for debugging the active Django shell", () => {
  const commands = manifest.contributes.commands.map((item) => item.command);
  const palette = manifest.contributes.menus.commandPalette.map((item) => item.command);
  const runtimeTitle = manifest.contributes.menus["view/title"].find((item) => item.command === "djangoShell.debugShell");
  const debugAnalysisTitle = manifest.contributes.menus["view/title"].find((item) => item.command === "djangoShell.debugShell" && item.when === "view == djangoShell.debugAnalysis");
  const editorTitle = manifest.contributes.menus["editor/title"].find((item) => item.command === "djangoShell.debugShell");

  assert.ok(commands.includes("djangoShell.debugShell"));
  assert.ok(manifest.activationEvents.includes("onCommand:djangoShell.debugShell"));
  assert.ok(palette.includes("djangoShell.debugShell"));
  assert.equal(runtimeTitle?.when, "view == djangoShell.runtimeInspector");
  assert.equal(debugAnalysisTitle?.when, "view == djangoShell.debugAnalysis");
  assert.equal(editorTitle?.when, "resourceFilename == 'debug-cell.py'");
});

test("contributes remote debugpy attach settings", () => {
  const properties = manifest.contributes.configuration.properties;

  assert.equal(properties["djangoShell.debug.listenHost"].default, "127.0.0.1");
  assert.equal(properties["djangoShell.debug.listenPort"].default, 0);
  assert.equal(properties["djangoShell.debug.connectHost"].default, "");
  assert.equal(properties["djangoShell.debug.connectPort"].default, 0);
  assert.equal(properties["djangoShell.debug.remoteRoot"].default, "");
});

test("keeps debugpy default while contributing the built-in experimental engine", () => {
  const engine = manifest.contributes.configuration.properties["djangoShell.debug.engine"];
  assert.equal(engine.default, "debugpy");
  assert.deepEqual(engine.enum, ["debugpy", "experimental"]);
  assert.equal(manifest.extensionOptionalDependencies.includes("newdlops.django-process-debugger"), false);
  assert.ok(manifest.activationEvents.includes("onDebug:django-shell-native"));
  const native = manifest.contributes.debuggers.find((item) => item.type === "django-shell-native");
  assert.equal(native?.label, "Django Shell Experimental");
  assert.deepEqual(native?.languages, ["python", "django-shell-python"]);
  assert.deepEqual(native?.configurationAttributes?.attach?.required, ["host", "port"]);
  assert.equal(manifest.contributes.configuration.properties["djangoShell.debug.hotReload"].default, true);
});

test("ships the built-in tracer with its third-party license notice", () => {
  const tracer = fs.readFileSync(new URL("../python/django_shell_native_tracer.py", import.meta.url), "utf8");
  const notices = fs.readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  assert.match(tracer, /TRACER_VERSION = "2026\.07\.11\.3"/);
  assert.match(notices, /Django Process Debugger experimental tracer/);
  assert.match(notices, /MIT License/);
});

test("contributes basic debugger control commands for the custom console", () => {
  const commands = manifest.contributes.commands.map((item) => item.command);
  const controls = ["continue", "pause", "stepOver", "stepInto", "stepOut", "restart", "stop"];
  const debugAnalysisTitleCommands = manifest.contributes.menus["view/title"].filter((item) => item.when === "view == djangoShell.debugAnalysis").map((item) => item.command);
  const externalEditorTitleCommands = manifest.contributes.menus["editor/title"].filter((item) => item.when === "djangoShell.externalDebugFrame").map((item) => item.command);
  const externalKeys = manifest.contributes.keybindings.filter((item) => item.when === "djangoShell.externalDebugFrame").map((item) => `${item.key}:${item.command}`);

  for (const control of controls) {
    assert.ok(commands.includes(`djangoShell.debug.${control}`));
    assert.ok(manifest.activationEvents.includes(`onCommand:djangoShell.debug.${control}`));
  }
  for (const control of ["continue", "pause", "stepOver", "stepInto", "stepOut", "stop"]) {
    assert.ok(debugAnalysisTitleCommands.includes(`djangoShell.debug.${control}`));
  }
  for (const control of ["continue", "stepOver", "stepInto", "stepOut", "stop"]) {
    assert.ok(externalEditorTitleCommands.includes(`djangoShell.debug.${control}`));
  }
  assert.ok(externalKeys.includes("f10:djangoShell.debug.stepOver"));
  assert.ok(externalKeys.includes("f11:djangoShell.debug.stepInto"));
  assert.ok(externalKeys.includes("shift+f11:djangoShell.debug.stepOut"));
});

test("contributes a custom console overlay tab command without standalone file-tab bindings", () => {
  const commands = manifest.contributes.commands.map((item) => item.command);
  const palette = manifest.contributes.menus.commandPalette.map((item) => item.command);
  const fileTabBindings = manifest.contributes.keybindings.filter((item) => String(item.command).includes("pythonTab"));

  assert.ok(commands.includes("djangoShell.newOverlayTab"));
  assert.ok(palette.includes("djangoShell.newOverlayTab"));
  assert.ok(manifest.activationEvents.includes("onCommand:djangoShell.newOverlayTab"));
  assert.equal(commands.includes("djangoShell.openPythonTab"), false);
  assert.equal(fileTabBindings.length, 0);
});

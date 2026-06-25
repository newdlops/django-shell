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

test("restores v0.0.2 Python analysis defaults globally", () => {
  assert.equal(manifest.contributes.configurationDefaults["python.analysis.supportAllPythonDocuments"], true);
  assert.deepEqual(manifest.contributes.configurationDefaults["[python]"], { "editor.semanticHighlighting.enabled": true });
});

test("enables diagnostic logging by default so the shell session is captured for troubleshooting", () => {
  assert.equal(manifest.contributes.configuration.properties["djangoShell.diagnosticLogging"].default, true);
});

test("keeps Python cell Enter from interrupting completion UI", () => {
  const binding = manifest.contributes.keybindings.find((item) => item.command === "djangoShell.overlayAcceptInput");
  assert.ok(binding);
  assert.match(binding.when, /resourceFilename == 'console-cell\.py'/);
  assert.match(binding.when, /suggestWidgetVisible/);
  assert.match(binding.when, /parameterHintsVisible/);
  assert.match(binding.when, /inlineSuggestionVisible/);
});

test("contributes the additive model data browser command and catalog view", () => {
  const commands = manifest.contributes.commands.map((item) => item.command);
  assert.ok(commands.includes("djangoShell.openModelData"));
  assert.ok(commands.includes("djangoShell.refreshModelCatalog"));
  const catalog = manifest.contributes.views.djangoShell.find((item) => item.id === "djangoShell.modelCatalog");
  assert.ok(catalog && catalog.type === "webview", "model catalog is a searchable webview view");
  const views = manifest.contributes.views.djangoShell.map((item) => item.id);
  assert.ok(views.includes("djangoShell.runtimeInspector"), "keeps the existing runtime inspector view");
  assert.ok(manifest.activationEvents.includes("onView:djangoShell.modelCatalog"));
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

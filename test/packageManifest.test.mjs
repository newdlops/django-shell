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

test("keeps diagnostic logging on by default like v0.0.2", () => {
  assert.equal(manifest.contributes.configuration.properties["djangoShell.diagnosticLogging"].default, true);
});

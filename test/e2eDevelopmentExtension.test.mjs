// Verifies that the VS Code E2E development extension keeps executable code inside its root.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareDevelopmentExtension } from "./e2e/developmentExtension.mjs";

test("development extension copies its entrypoint while linking non-code runtime directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-dev-extension-"));
  try {
    const manifest = {
      extensionDependencies: ["ms-python.python"],
      main: "./out/extension.js",
      name: "django-shell",
      publisher: "newdlops",
      version: "0.0.0"
    };
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    for (const name of ["media", "node_modules", "out", "python", "syntaxes"]) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
    }
    fs.writeFileSync(path.join(root, "out", "extension.js"), "module.exports = {};\n");

    const extensionPath = prepareDevelopmentExtension(root);
    const preparedManifest = JSON.parse(fs.readFileSync(path.join(extensionPath, "package.json"), "utf8"));
    const entrypoint = path.join(extensionPath, preparedManifest.main);

    assert.equal(preparedManifest.extensionDependencies, undefined);
    assert.equal(fs.lstatSync(path.join(extensionPath, "out")).isSymbolicLink(), false);
    assert.equal(fs.realpathSync(entrypoint).startsWith(`${fs.realpathSync(extensionPath)}${path.sep}`), true);
    for (const name of ["media", "node_modules", "python", "syntaxes"]) {
      assert.equal(fs.lstatSync(path.join(extensionPath, name)).isSymbolicLink(), true);
    }
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("development extension preparation uses isolated directories and leaves no fixed collision", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-dev-extension-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ main: "./out/extension.js", name: "django-shell", publisher: "newdlops", version: "0.0.0" }));
    for (const name of ["media", "node_modules", "out", "python", "syntaxes"]) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
    }
    fs.writeFileSync(path.join(root, "out", "extension.js"), "module.exports = {};\n");

    const first = prepareDevelopmentExtension(root);
    const second = prepareDevelopmentExtension(root);
    const preparedRoot = path.join(root, ".vscode-test");

    assert.notEqual(first, second);
    assert.equal(fs.existsSync(first), true);
    assert.equal(fs.existsSync(second), true);
    assert.equal(fs.existsSync(path.join(preparedRoot, "django-shell-dev")), false);
    fs.rmSync(first, { force: true, recursive: true });
    fs.rmSync(second, { force: true, recursive: true });
    assert.equal(fs.existsSync(first), false);
    assert.equal(fs.existsSync(second), false);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

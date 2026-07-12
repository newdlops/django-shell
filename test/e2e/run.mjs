// Launches VS Code and runs Django Shell extension host E2E tests.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runTests } from "@vscode/test-electron";
import { prepareDevelopmentExtension } from "./developmentExtension.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Runs the VS Code extension host E2E suite. */
async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-e2e-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-e2e-user-"));
  const extensionPath = prepareDevelopmentExtension(ROOT);
  const python = pythonExecutablePath();
  copyInstalledExtension("ms-python.python-");
  copyInstalledExtension("ms-python.vscode-pylance-");
  copyInstalledExtension("newdlops.django-orm-intellisense-");
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, "package.json"), "utf8"));
  fs.mkdirSync(path.join(workspace, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({
    "djangoOrmIntellisense.autoStart": false,
    "djangoOrmIntellisense.diagnostics.enabled": false,
    "djangoOrmIntellisense.logLevel": "debug",
    "djangoOrmIntellisense.pythonInterpreter": python ?? "",
    "djangoOrmIntellisense.settingsModule": "orm_project.settings",
    "djangoOrmIntellisense.workspaceRoot": workspace,
    "djangoShell.autoActivateWorkspaceVenv": false,
    "python.analysis.autoImportCompletions": true,
    "python.analysis.extraPaths": [workspace],
    "python.analysis.supportAllPythonDocuments": true,
    "python.analysis.typeCheckingMode": "basic",
    "python.defaultInterpreterPath": python ?? ""
  }, null, 2));
  await runTests({
    extensionDevelopmentPath: extensionPath,
    extensionTestsEnv: { DJANGO_SHELL_E2E: "1", DJANGO_SHELL_E2E_EXTENSION_ID: `${manifest.publisher}.${manifest.name}`, ...(process.env.DJANGO_SHELL_E2E_AUTO_IMPORT_ONLY === "1" ? { DJANGO_SHELL_E2E_AUTO_IMPORT_ONLY: "1" } : {}), ...(process.env.DJANGO_SHELL_E2E_HOVER_ONLY === "1" ? { DJANGO_SHELL_E2E_HOVER_ONLY: "1" } : {}), ...(process.env.DJANGO_SHELL_E2E_THEME_ONLY === "1" ? { DJANGO_SHELL_E2E_THEME_ONLY: "1" } : {}), ...(python ? { DJANGO_SHELL_E2E_PYTHON: python } : {}) },
    extensionTestsPath: path.join(ROOT, "test", "e2e", "suite", "index.js"),
    launchArgs: ["--inspect=9239", `--user-data-dir=${userData}`, workspace],
    reuseMachineInstall: Boolean(process.env.VSCODE_E2E_EXECUTABLE),
    vscodeExecutablePath: vscodeExecutablePath()
  });
}

/** Copies one installed extension into the VS Code E2E extension directory. */
function copyInstalledExtension(prefix) {
  const installed = latestInstalledExtension(prefix);
  if (!installed) {
    throw new Error(`${prefix} is required for strict Python cell E2E coverage.`);
  }
  const extensionsDir = path.join(ROOT, ".vscode-test", "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });
  removeExistingExtensionDirs(extensionsDir, prefix);
  const target = path.join(extensionsDir, path.basename(installed));
  fs.cpSync(installed, target, { dereference: true, recursive: true });
  writeExtensionCacheEntry(extensionsDir, target);
}

/** Returns the newest installed extension directory matching one prefix. */
function latestInstalledExtension(prefix) {
  const extensionsDir = path.join(os.homedir(), ".vscode", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return undefined;
  }
  const matches = fs.readdirSync(extensionsDir).filter((name) => name.startsWith(prefix)).sort();
  return matches.length ? path.join(extensionsDir, matches[matches.length - 1]) : undefined;
}

/** Removes old copied extension directories with one prefix. */
function removeExistingExtensionDirs(extensionsDir, prefix) {
  for (const name of fs.readdirSync(extensionsDir).filter((entry) => entry.startsWith(prefix))) {
    fs.rmSync(path.join(extensionsDir, name), { force: true, recursive: true });
  }
}

/** Adds one copied extension to VS Code's extension cache manifest. */
function writeExtensionCacheEntry(extensionsDir, extensionDir) {
  const manifestPath = path.join(extensionsDir, "extensions.json");
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf8"));
  const id = `${manifest.publisher}.${manifest.name}`;
  const existing = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : [];
  const entries = existing.filter((entry) => entry?.identifier?.id !== id);
  entries.push({
    identifier: { id },
    location: { $mid: 1, external: pathToFileURL(extensionDir).href, fsPath: extensionDir, path: extensionDir, scheme: "file" },
    metadata: { installedTimestamp: Date.now(), isApplicationScoped: true, pinned: false, source: "gallery", targetPlatform: "undefined" },
    relativeLocation: path.basename(extensionDir),
    version: manifest.version
  });
  fs.writeFileSync(manifestPath, JSON.stringify(entries));
}

/** Returns a local VS Code executable path that keeps the extension test process attached. */
function vscodeExecutablePath() {
  if (process.env.VSCODE_E2E_EXECUTABLE) {
    return process.env.VSCODE_E2E_EXECUTABLE;
  }
  return undefined;
}

/** Returns a Python executable path for strict E2E language probes. */
function pythonExecutablePath() {
  return [
    process.env.DJANGO_SHELL_E2E_PYTHON,
    process.env.DJLS_E2E_BASE_PYTHON,
    "/Users/lky/.asdf/installs/python/3.11.15/bin/python3.11",
    "/usr/bin/python3"
  ].filter(Boolean).find((candidate) => fs.existsSync(candidate));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

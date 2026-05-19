// Launches VS Code and runs Django Shell extension host E2E tests.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Runs the VS Code extension host E2E suite. */
async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-e2e-"));
  const extensionPath = prepareDevelopmentExtension();
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, "package.json"), "utf8"));
  fs.mkdirSync(path.join(workspace, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({ "djangoShell.autoActivateWorkspaceVenv": false }, null, 2));
  await runTests({
    extensionDevelopmentPath: extensionPath,
    extensionTestsEnv: { DJANGO_SHELL_E2E: "1", DJANGO_SHELL_E2E_EXTENSION_ID: `${manifest.publisher}.${manifest.name}` },
    extensionTestsPath: path.join(ROOT, "test", "e2e", "suite", "index.js"),
    launchArgs: [workspace],
    reuseMachineInstall: Boolean(process.env.VSCODE_E2E_EXECUTABLE),
    vscodeExecutablePath: vscodeExecutablePath()
  });
}

/** Creates a dependency-free development extension wrapper for UI E2E tests. */
function prepareDevelopmentExtension() {
  const directory = path.join(ROOT, ".vscode-test", "django-shell-dev");
  fs.rmSync(directory, { force: true, recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  delete manifest.extensionDependencies;
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest, null, 2));
  for (const name of ["media", "node_modules", "out", "python"]) {
    fs.symlinkSync(path.join(ROOT, name), path.join(directory, name), "dir");
  }
  return directory;
}

/** Returns a local VS Code executable path that keeps the extension test process attached. */
function vscodeExecutablePath() {
  if (process.env.VSCODE_E2E_EXECUTABLE) {
    return process.env.VSCODE_E2E_EXECUTABLE;
  }
  return undefined;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

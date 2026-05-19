// VS Code extension entrypoint for the Django shell custom console.

import * as vscode from "vscode";
import { CustomDjangoConsole } from "./customConsole";
import { DiagnosticLogger } from "./diagnostics";
import { describeShellEnvironment, formatShellEnvironment } from "./env";
import { deleteGeneratedShadowArtifacts } from "./filePythonShadow";
import { DjangoNotebookConsole } from "./notebookConsole";
import { DjangoConsoleController } from "./notebookController";
import { PythonFeatureBridge } from "./pythonFeatureBridge";
import { PythonShadowDocuments } from "./pythonShadow";
import { RuntimeCompletionProvider } from "./runtimeCompletion";
import { RuntimeInspector } from "./runtimeInspector";

/** Activates the custom console while retaining deprecated notebook compatibility. */
export function activate(context: vscode.ExtensionContext): void {
  const environmentOutput = vscode.window.createOutputChannel("Django Shell");
  const diagnostics = new DiagnosticLogger(environmentOutput);
  const customConsole = new CustomDjangoConsole(context.extensionPath, diagnostics);
  const runtimeInspector = new RuntimeInspector(customConsole, diagnostics);
  customConsole.activate(context);
  runtimeInspector.activate(context, () => customConsole.openConsole());
  if (process.env.DJANGO_SHELL_E2E === "1") {
    context.subscriptions.push(
      environmentOutput,
      vscode.commands.registerCommand("djangoShell.e2eRestartKernel", () => customConsole.e2eRestartKernel()),
      vscode.commands.registerCommand("djangoShell.e2eSnapshot", () => customConsole.e2eSnapshot())
    );
    return;
  }
  const consoleController = new DjangoConsoleController(context.extensionPath, diagnostics);
  const pythonShadows = new PythonShadowDocuments(diagnostics);
  const notebookConsole = new DjangoNotebookConsole(consoleController, pythonShadows);
  const pythonFeatureBridge = new PythonFeatureBridge(pythonShadows, diagnostics);
  const runtimeCompletion = new RuntimeCompletionProvider(consoleController, diagnostics);
  notebookConsole.activate(context);
  pythonShadows.activate(context);
  pythonFeatureBridge.activate(context);
  runtimeCompletion.activate(context);
  context.subscriptions.push(
    environmentOutput,
    consoleController,
    vscode.commands.registerCommand("djangoShell.showEnvironment", () => showEnvironment(environmentOutput))
  );
}

/** Removes generated file-backed provider artifacts when VS Code unloads the extension. */
export function deactivate(): Thenable<void> {
  return deleteGeneratedShadowArtifacts();
}

/** Shows the process environment used by setup terminals. */
function showEnvironment(output: vscode.OutputChannel): void {
  const config = vscode.workspace.getConfiguration("djangoShell");
  const info = describeShellEnvironment(workspaceCwd(), {
    autoActivateWorkspaceVenv: config.get<boolean>("autoActivateWorkspaceVenv", true)
  });
  output.appendLine("");
  output.appendLine(formatShellEnvironment(info));
  output.show(true);
}

/** Returns the workspace root used as the child shell working directory. */
function workspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

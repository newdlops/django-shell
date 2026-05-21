// VS Code extension entrypoint for the Django shell custom console.

import * as vscode from "vscode";
import { CustomDjangoConsole } from "./customConsole";
import { DiagnosticLogger } from "./diagnostics";
import { describeShellEnvironment, formatShellEnvironment } from "./env";
import { deleteGeneratedShadowArtifacts } from "./filePythonShadow";
import { NOTEBOOK_TYPE } from "./notebookConstants";
import { DjangoConsoleSerializer } from "./notebookSerializer";
import { RuntimeInspector } from "./runtimeInspector";
import type { DjangoNotebookConsole } from "./notebookConsole";

let deprecatedNotebookRuntime: Promise<DjangoNotebookConsole> | undefined;

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
      vscode.commands.registerCommand("djangoShell.e2eEvaluateOverlay", (expression: string) => customConsole.e2eEvaluateOverlay(expression)),
      vscode.commands.registerCommand("djangoShell.e2eRestartKernel", () => customConsole.e2eRestartKernel()),
      vscode.commands.registerCommand("djangoShell.e2eSetPrelude", (lines: string[]) => customConsole.e2eSetPrelude(lines)),
      vscode.commands.registerCommand("djangoShell.e2eSnapshot", () => customConsole.e2eSnapshot())
    );
    return;
  }
  registerDeprecatedNotebookEntryPoints(context, diagnostics);
  context.subscriptions.push(
    environmentOutput,
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

/** Registers cheap compatibility hooks that load deprecated notebook support only when used. */
function registerDeprecatedNotebookEntryPoints(context: vscode.ExtensionContext, diagnostics: DiagnosticLogger): void {
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new DjangoConsoleSerializer()),
    vscode.commands.registerCommand("djangoShell.openNotebookConsoleDeprecated", async () => {
      await (await ensureDeprecatedNotebookRuntime(context, diagnostics)).openConsole();
    }),
    vscode.commands.registerTextEditorCommand("djangoShell.acceptInput", async (editor) => {
      await (await ensureDeprecatedNotebookRuntime(context, diagnostics)).acceptInput(editor);
    }),
    vscode.commands.registerCommand("djangoShell.focusInput", async (sessionId?: string) => {
      await (await ensureDeprecatedNotebookRuntime(context, diagnostics)).focusInput(sessionId);
    }),
    vscode.workspace.onDidOpenNotebookDocument((notebook) => {
      if (notebook.notebookType === NOTEBOOK_TYPE) {
        void ensureDeprecatedNotebookRuntime(context, diagnostics);
      }
    })
  );
}

/** Loads the deprecated notebook controller, providers, and runtime completion path on demand. */
async function ensureDeprecatedNotebookRuntime(context: vscode.ExtensionContext, diagnostics: DiagnosticLogger): Promise<DjangoNotebookConsole> {
  if (!deprecatedNotebookRuntime) {
    deprecatedNotebookRuntime = loadDeprecatedNotebookRuntime(context, diagnostics);
  }
  return deprecatedNotebookRuntime;
}

/** Imports and activates deprecated notebook support after a notebook-specific trigger. */
async function loadDeprecatedNotebookRuntime(context: vscode.ExtensionContext, diagnostics: DiagnosticLogger): Promise<DjangoNotebookConsole> {
  const [{ DjangoConsoleController }, { DjangoNotebookConsole }, { PythonFeatureBridge }, { PythonShadowDocuments }, { RuntimeCompletionProvider }] = await Promise.all([
    import("./notebookController"),
    import("./notebookConsole"),
    import("./pythonFeatureBridge"),
    import("./pythonShadow"),
    import("./runtimeCompletion")
  ]);
  const consoleController = new DjangoConsoleController(context.extensionPath, diagnostics);
  const pythonShadows = new PythonShadowDocuments(diagnostics);
  const notebookConsole = new DjangoNotebookConsole(consoleController, pythonShadows);
  const pythonFeatureBridge = new PythonFeatureBridge(pythonShadows, diagnostics);
  const runtimeCompletion = new RuntimeCompletionProvider(consoleController, diagnostics);
  pythonShadows.activate(context);
  pythonFeatureBridge.activate(context);
  runtimeCompletion.activate(context);
  context.subscriptions.push(consoleController, notebookConsole);
  return notebookConsole;
}

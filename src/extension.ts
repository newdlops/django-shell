// VS Code extension entrypoint for the Django shell custom console.

import * as vscode from "vscode";
import type { BackendRuntimeChildren, BackendRuntimeInspection, BackendRuntimePathSegment } from "./backendClient";
import type { CustomDjangoConsole } from "./customConsole";
import { DiagnosticLogger } from "./diagnostics";
import { NOTEBOOK_TYPE } from "./notebookConstants";
import { DjangoConsoleSerializer } from "./notebookSerializer";
import { RuntimeInspector } from "./runtimeInspector";
import type { DjangoNotebookConsole } from "./notebookConsole";

type OutputChannelFactory = () => vscode.OutputChannel;

let customConsoleRuntime: Promise<CustomDjangoConsole> | undefined;
let deprecatedNotebookRuntime: Promise<DjangoNotebookConsole> | undefined;

/** Bridges the runtime tree to a custom console that may not be loaded yet. */
class LazyRuntimeSource implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private console: CustomDjangoConsole | undefined;
  private consoleSubscription: vscode.Disposable | undefined;

  readonly onDidChangeRuntime = this.changeEmitter.event;

  /** Binds the source to a lazily-created custom console runtime. */
  bind(console: CustomDjangoConsole): void {
    if (this.console === console) {
      return;
    }
    this.consoleSubscription?.dispose();
    this.console = console;
    this.consoleSubscription = console.onDidChangeRuntime(() => this.changeEmitter.fire());
    this.changeEmitter.fire();
  }

  /** Returns root runtime data or an idle status without starting a shell. */
  inspectActiveRuntime(): Promise<BackendRuntimeInspection> {
    return this.console?.inspectActiveRuntime() ?? Promise.resolve(runtimeUnavailableInspection());
  }

  /** Returns child runtime data or an idle status without starting a shell. */
  inspectRuntimeChildren(pathSegments: BackendRuntimePathSegment[]): Promise<BackendRuntimeChildren> {
    return this.console?.inspectRuntimeChildren(pathSegments) ?? Promise.resolve(runtimeUnavailableChildren());
  }

  /** Releases the active runtime event listener. */
  dispose(): void {
    this.consoleSubscription?.dispose();
    this.changeEmitter.dispose();
  }
}

/** Activates the custom console while retaining deprecated notebook compatibility. */
export function activate(context: vscode.ExtensionContext): void {
  const output = lazyOutputChannel(context);
  const diagnostics = new DiagnosticLogger(output);
  const runtimeSource = new LazyRuntimeSource();
  const runtimeInspector = new RuntimeInspector(runtimeSource, diagnostics);
  context.subscriptions.push(runtimeSource);
  runtimeInspector.activate(context);
  registerCustomConsoleEntryPoints(context, diagnostics, runtimeSource);
  if (process.env.DJANGO_SHELL_E2E === "1") {
    context.subscriptions.push(
      vscode.commands.registerCommand("djangoShell.e2eEvaluateOverlay", async (expression: string) => (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource)).e2eEvaluateOverlay(expression)),
      vscode.commands.registerCommand("djangoShell.e2eRestartKernel", async () => (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource)).e2eRestartKernel()),
      vscode.commands.registerCommand("djangoShell.e2eSetPrelude", async (lines: string[]) => (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource)).e2eSetPrelude(lines)),
      vscode.commands.registerCommand("djangoShell.e2eWriteTerminal", async (data: string) => (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource)).e2eWriteTerminal(data)),
      vscode.commands.registerCommand("djangoShell.e2eSnapshot", async () => (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource)).e2eSnapshot())
    );
    return;
  }
  registerDeprecatedNotebookEntryPoints(context, diagnostics);
  context.subscriptions.push(
    vscode.commands.registerCommand("djangoShell.showEnvironment", () => showEnvironment(output()))
  );
}

/** Removes generated file-backed provider artifacts when VS Code unloads the extension. */
export async function deactivate(): Promise<void> {
  const { deleteGeneratedShadowArtifacts } = await import("./filePythonShadow");
  await deleteGeneratedShadowArtifacts();
}

/** Creates the output channel only after a visible command or enabled diagnostic needs it. */
function lazyOutputChannel(context: vscode.ExtensionContext): OutputChannelFactory {
  let output: vscode.OutputChannel | undefined;
  return () => {
    if (!output) {
      output = vscode.window.createOutputChannel("Django Shell");
      context.subscriptions.push(output);
    }
    return output;
  };
}

/** Registers public custom-console commands without loading PTY or overlay modules. */
function registerCustomConsoleEntryPoints(context: vscode.ExtensionContext, diagnostics: DiagnosticLogger, runtimeSource: LazyRuntimeSource): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("djangoShell.openConsole", async () => {
      await (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource)).openConsole();
    }),
    vscode.commands.registerCommand("djangoShell.showOverlayEditor", async () => {
      await (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource)).showOverlayEditor();
    }),
    vscode.commands.registerCommand("djangoShell.overlayRunCurrentInput", async () => {
      return (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource)).runCurrentOverlayInput();
    }),
    vscode.commands.registerCommand("djangoShell.overlayAcceptInput", async () => {
      await (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource)).acceptOverlayInput();
    }),
    vscode.commands.registerCommand("djangoShell.overlayInsertNewline", async () => {
      await (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource)).insertOverlayNewline();
    })
  );
}

/** Returns the custom console runtime, loading node-pty and overlay code only on demand. */
async function ensureCustomConsoleRuntime(context: vscode.ExtensionContext, diagnostics: DiagnosticLogger, runtimeSource: LazyRuntimeSource): Promise<CustomDjangoConsole> {
  if (!customConsoleRuntime) {
    customConsoleRuntime = loadCustomConsoleRuntime(context, diagnostics, runtimeSource).catch((error) => {
      customConsoleRuntime = undefined;
      throw error;
    });
  }
  return customConsoleRuntime;
}

/** Imports and activates the custom console after a console-specific command. */
async function loadCustomConsoleRuntime(context: vscode.ExtensionContext, diagnostics: DiagnosticLogger, runtimeSource: LazyRuntimeSource): Promise<CustomDjangoConsole> {
  const { CustomDjangoConsole } = await import("./customConsole");
  const customConsole = new CustomDjangoConsole(context.extensionPath, diagnostics);
  customConsole.activate(context, { registerCommands: false });
  runtimeSource.bind(customConsole);
  return customConsole;
}

/** Shows the process environment used by setup terminals. */
async function showEnvironment(output: vscode.OutputChannel): Promise<void> {
  const { describeShellEnvironment, formatShellEnvironment } = await import("./env");
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

/** Returns an idle runtime inspection result for a console that has not been opened. */
function runtimeUnavailableInspection(): BackendRuntimeInspection {
  return { error: "Open the Django Shell console to inspect runtime variables.", modules: [], ok: false, variables: [] };
}

/** Returns an idle child inspection result for a console that has not been opened. */
function runtimeUnavailableChildren(): BackendRuntimeChildren {
  return { children: [], error: "Open the Django Shell console to inspect runtime variables.", ok: false };
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

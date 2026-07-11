// VS Code extension entrypoint for the Django shell custom console.

import * as vscode from "vscode";
import type { BackendClient, BackendRuntimeChildren, BackendRuntimeInspection, BackendRuntimePathSegment, BackendTransport, BackendTransportMode } from "./backendClient";
import type { CustomDjangoConsole } from "./customConsole";
import { DebugAnalysisPanel } from "./debugAnalysisPanel";
import { DebugAnalysisStore } from "./debugAnalysisStore";
import { DEBUG_CONTROL_ACTIONS } from "./debugControls";
import { DiagnosticLogger } from "./diagnostics";
import { type BackendCommitResult, type BackendFilterFieldTree, type BackendModelAggregate, type BackendModelComputed, type BackendModelCount, type BackendModelList, type BackendModelLookup, type BackendModelQuery, type BackendModelRelatedRows, type BackendModelRows, type BackendModelSchema, MODEL_IDLE_MESSAGE, type ModelAggregateQuery, type ModelCommitQuery, type ModelComputedQuery, type ModelCountQuery, type ModelLookupQuery, type ModelQueryRequest, type ModelRelatedQuery, type ModelRowsQuery } from "./modelBackend";
import { ModelBrowser } from "./modelBrowser";
import { ModelQueryConsole } from "./modelQueryConsole";
import { ModelCatalog } from "./modelCatalog";
import { registerDjangoShellNativeDebugAdapter } from "./nativeDebugAdapter";
import { NOTEBOOK_TYPE } from "./notebookConstants";
import { DjangoConsoleSerializer } from "./notebookSerializer";
import { RuntimeInspector } from "./runtimeInspector";
import { runtimePreludeLines } from "./runtimePrelude";
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
  inspectRuntimeChildren(pathSegments: BackendRuntimePathSegment[], kind?: string): Promise<BackendRuntimeChildren> {
    return this.console?.inspectRuntimeChildren(pathSegments, kind) ?? Promise.resolve(runtimeUnavailableChildren());
  }

  /** Returns the model catalog or an idle status without starting a shell. */
  listModels(): Promise<BackendModelList> {
    return this.withParallelModelReads((backend) => backend.models(), { error: MODEL_IDLE_MESSAGE, models: [], ok: false });
  }

  /** Returns model schema or an idle status without starting a shell. */
  modelSchema(app: string, model: string): Promise<BackendModelSchema> {
    return this.withParallelModelReads((backend) => backend.modelSchema(app, model), { columns: [], error: MODEL_IDLE_MESSAGE, ok: false, relations: [] });
  }

  /** Returns the filterable field/relation tree for one model, or an idle status without starting a shell. */
  modelFilterFields(app: string, model: string): Promise<BackendFilterFieldTree> {
    return this.withParallelModelReads((backend) => backend.modelFilterFields(app, model), { error: MODEL_IDLE_MESSAGE, fields: [], ok: false, relations: [] });
  }

  /** Returns a page of model rows or an idle status without starting a shell. */
  modelRows(query: ModelRowsQuery): Promise<BackendModelRows> {
    return this.withParallelModelReads((backend) => backend.modelRows(query), { columns: [], error: MODEL_IDLE_MESSAGE, hasMore: false, nextOffset: null, ok: false, orm: "", rows: [], sql: [] });
  }

  /** Returns related rows or an idle status without starting a shell. */
  modelRelated(query: ModelRelatedQuery): Promise<BackendModelRelatedRows> {
    return this.withParallelModelReads((backend) => backend.modelRelated(query), { columns: [], error: MODEL_IDLE_MESSAGE, hasMore: false, ok: false, orm: "", rows: [], single: false, sql: [] });
  }

  /** Returns one @property column's values for loaded rows, or an idle status without starting a shell. */
  modelComputed(query: ModelComputedQuery): Promise<BackendModelComputed> {
    return this.withParallelModelReads((backend) => backend.modelComputed(query), { error: MODEL_IDLE_MESSAGE, ok: false, values: {} });
  }

  /** Returns foreign-key picker candidates or an idle status without starting a shell. */
  modelLookup(query: ModelLookupQuery): Promise<BackendModelLookup> {
    return this.withParallelModelReads((backend) => backend.modelLookup(query), { error: MODEL_IDLE_MESSAGE, hasMore: false, ok: false, rows: [], sql: [] });
  }

  /** Returns the row count or an idle status without starting a shell. */
  modelCount(query: ModelCountQuery): Promise<BackendModelCount> {
    return this.withParallelModelReads((backend) => backend.modelCount(query), { count: null, error: MODEL_IDLE_MESSAGE, ok: false, orm: "", sql: [] });
  }

  /** Returns grouped/global aggregate results or an idle status without starting a shell. */
  modelAggregate(query: ModelAggregateQuery): Promise<BackendModelAggregate> {
    return this.withParallelModelReads((backend) => backend.modelAggregate(query), { columns: [], error: MODEL_IDLE_MESSAGE, groupBy: [], hasMore: false, ok: false, orm: "", rows: [], sql: [] });
  }

  /** Commits staged edits or returns an idle status without starting a shell. */
  modelCommit(query: ModelCommitQuery): Promise<BackendCommitResult> {
    return this.console?.activeBackend?.modelCommit(query) ?? Promise.resolve({ error: MODEL_IDLE_MESSAGE, ok: false, orm: "", results: [], saved: 0, sql: [] });
  }

  /** Runs a custom ORM query or returns an idle status without starting a shell. */
  modelQuery(query: ModelQueryRequest): Promise<BackendModelQuery> {
    return this.console?.activeBackend?.modelQuery(query) ?? Promise.resolve({ columns: [], editable: false, error: MODEL_IDLE_MESSAGE, hasMore: false, ok: false, orm: "", relations: [], rows: [], sql: [] });
  }

  /** Returns imports/declarations that expose the live shell namespace to query IntelliSense. */
  async modelQueryPrelude(): Promise<string[]> {
    const backend = this.console?.activeBackend;
    if (!backend?.supportsRuntimeInspection() || !backend.supportsHiddenPrelude()) { return []; }
    const inspection = await backend.prelude();
    return inspection.ok ? runtimePreludeLines(inspection.variables) : [];
  }

  /** Sets the model browser transport preference on the active backend. */
  setModelTransport(mode: BackendTransportMode): void {
    this.console?.activeBackend?.setTransportMode(mode);
  }

  /** Returns the active transport and selected mode for the model browser. */
  modelTransportInfo(): { active: BackendTransport; mode: BackendTransportMode } {
    const backend = this.console?.activeBackend;
    return { active: backend?.transport ?? "none", mode: backend?.transportMode ?? "auto" };
  }

  /** Runs read-only model browser work without queueing behind the terminal while a cell is active. */
  private withParallelModelReads<T>(work: (backend: BackendClient) => Promise<T>, fallback: T): Promise<T> {
    const backend = this.console?.activeBackend;
    if (!backend) { return Promise.resolve(fallback); }
    return backend.withParallelModelReads(Boolean(this.console?.pythonBusy), () => work(backend));
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
  registerDjangoShellNativeDebugAdapter(context);
  if (diagnostics.enabled()) {
    const channel = output();
    channel.appendLine(`[${new Date().toISOString()}] diagnostics.active — logging the shell session (shell.out), backend requests, and overlay activity. Set djangoShell.diagnosticLogging=false to disable.`);
    channel.show(true);
  }
  const runtimeSource = new LazyRuntimeSource();
  const debugAnalysis = new DebugAnalysisStore();
  const runtimeInspector = new RuntimeInspector(runtimeSource, diagnostics);
  const debugAnalysisPanel = new DebugAnalysisPanel(debugAnalysis, diagnostics);
  context.subscriptions.push(runtimeSource);
  context.subscriptions.push(debugAnalysis);
  runtimeInspector.activate(context);
  debugAnalysisPanel.activate(context);
  registerCustomConsoleEntryPoints(context, diagnostics, runtimeSource, debugAnalysis);
  const modelBrowser = new ModelBrowser(context.extensionPath, runtimeSource, diagnostics);
  modelBrowser.activate(context);
  const modelQueryConsole = new ModelQueryConsole(context.extensionPath, runtimeSource, diagnostics);
  modelQueryConsole.activate(context);
  const modelCatalog = new ModelCatalog(context.extensionPath, runtimeSource, diagnostics);
  modelCatalog.activate(context);
  if (process.env.DJANGO_SHELL_E2E === "1") {
    context.subscriptions.push(
      vscode.commands.registerCommand("djangoShell.e2eEvaluateOverlay", async (expression: string) => (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).e2eEvaluateOverlay(expression)),
      vscode.commands.registerCommand("djangoShell.e2eRestartKernel", async () => (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).e2eRestartKernel()),
      vscode.commands.registerCommand("djangoShell.e2eSetPrelude", async (lines: string[]) => (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).e2eSetPrelude(lines)),
      vscode.commands.registerCommand("djangoShell.e2eWriteTerminal", async (data: string) => (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).e2eWriteTerminal(data)),
      vscode.commands.registerCommand("djangoShell.e2eSnapshot", async () => (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).e2eSnapshot())
    );
    return;
  }
  registerDeprecatedNotebookEntryPoints(context, diagnostics);
  context.subscriptions.push(
    vscode.commands.registerCommand("djangoShell.showEnvironment", () => showEnvironment(output())),
    vscode.commands.registerCommand("djangoShell.showDiagnostics", () => showDiagnostics(output()))
  );
}

/** Enables diagnostic logging and reveals the Django Shell output channel for troubleshooting. */
async function showDiagnostics(channel: vscode.OutputChannel): Promise<void> {
  await vscode.workspace.getConfiguration("djangoShell").update("diagnosticLogging", true, vscode.ConfigurationTarget.Global);
  channel.appendLine(`[${new Date().toISOString()}] diagnostics.enabled — logging overlay geometry/show, backend requests, and PTY cells (set djangoShell.diagnosticLogging=false to stop)`);
  channel.show(true);
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
function registerCustomConsoleEntryPoints(context: vscode.ExtensionContext, diagnostics: DiagnosticLogger, runtimeSource: LazyRuntimeSource, debugAnalysis: DebugAnalysisStore): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("djangoShell.openConsole", async () => {
      await (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).openConsole();
    }),
    vscode.commands.registerCommand("djangoShell.debugShell", async () => {
      await (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).debugShell();
    }),
    vscode.commands.registerCommand("djangoShell.newOverlayTab", async () => {
      await (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).newOverlayTab();
    }),
    vscode.commands.registerCommand("djangoShell.showOverlayEditor", async () => {
      await (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).showOverlayEditor();
    }),
    vscode.commands.registerCommand("djangoShell.overlayRunCurrentInput", async () => {
      return (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).runCurrentOverlayInput();
    }),
    vscode.commands.registerCommand("djangoShell.overlaySkipCurrentInput", async () => {
      return (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).skipCurrentOverlayInput();
    }),
    vscode.commands.registerCommand("djangoShell.overlayAcceptInput", async () => {
      await (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).acceptOverlayInput();
    }),
    vscode.commands.registerCommand("djangoShell.overlayInsertNewline", async () => {
      await (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).insertOverlayNewline();
    }),
    ...DEBUG_CONTROL_ACTIONS.map((action) => vscode.commands.registerCommand(`djangoShell.debug.${action}`, async () => {
      await (await ensureCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis)).controlDebugger(action);
    }))
  );
}

/** Returns the custom console runtime, loading node-pty and overlay code only on demand. */
async function ensureCustomConsoleRuntime(context: vscode.ExtensionContext, diagnostics: DiagnosticLogger, runtimeSource: LazyRuntimeSource, debugAnalysis: DebugAnalysisStore): Promise<CustomDjangoConsole> {
  if (!customConsoleRuntime) {
    customConsoleRuntime = loadCustomConsoleRuntime(context, diagnostics, runtimeSource, debugAnalysis).catch((error) => {
      customConsoleRuntime = undefined;
      throw error;
    });
  }
  return customConsoleRuntime;
}

/** Imports and activates the custom console after a console-specific command. */
async function loadCustomConsoleRuntime(context: vscode.ExtensionContext, diagnostics: DiagnosticLogger, runtimeSource: LazyRuntimeSource, debugAnalysis: DebugAnalysisStore): Promise<CustomDjangoConsole> {
  const { CustomDjangoConsole } = await import("./customConsole");
  const customConsole = new CustomDjangoConsole(context.extensionPath, diagnostics, debugAnalysis);
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

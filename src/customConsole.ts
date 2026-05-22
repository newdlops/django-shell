// Custom webview frontend that reuses the Django shell backend without notebooks.

import * as path from "path";
import * as vscode from "vscode";
import type { BackendExecutionResult, BackendRuntimeChildren, BackendRuntimeInspection, BackendRuntimePathSegment } from "./backendClient";
import { webviewHtml } from "./customConsoleHtml";
import { DiagnosticLogger } from "./diagnostics";
import { scheduleWorkspaceGeneratedOverlayTabCleanup } from "./generatedOverlayTabs";
import { NotebookPtySession } from "./notebookPtySession";
import { resetOverlayBackingFiles } from "./overlayBackingFiles";
import { runtimePreludeLines } from "./runtimePrelude";
import type { WorkbenchOverlay, WorkbenchOverlayGeometry } from "./workbenchOverlay";

const VIEW_TYPE = "djangoShell.customConsole";

export interface CustomDjangoConsoleActivationOptions {
  registerCommands?: boolean;
}

/** Runs the primary custom Django shell UI backed by the existing backend bridge. */
export class CustomDjangoConsole implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly runtimeEmitter = new vscode.EventEmitter<void>();
  private activationContext: vscode.ExtensionContext | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private inspectionCache: BackendRuntimeInspection | undefined;
  private inspectionInFlight: Promise<BackendRuntimeInspection> | undefined;
  private lastEditorGeometry: WorkbenchOverlayGeometry | undefined;
  private overlay: WorkbenchOverlay | undefined;
  private overlayBackingReset: Promise<void> | undefined;
  private overlayPrelude: string[] = [];
  private overlayPromise: Promise<WorkbenchOverlay> | undefined;
  private registerOverlayCommands = true;
  private runtimeReady = false;
  private runtimeGeneration = 0;
  private runtimeRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private session: NotebookPtySession | undefined;
  private sessionDisposables: vscode.Disposable[] = [];
  private executionCount = 1;

  readonly onDidChangeRuntime = this.runtimeEmitter.event;

  /** Stores the extension path used to locate the Python backend file. */
  constructor(
    private readonly extensionPath: string,
    private readonly logger?: DiagnosticLogger
  ) {}

  /** Registers the command that opens the custom console frontend. */
  activate(context: vscode.ExtensionContext, options: CustomDjangoConsoleActivationOptions = {}): void {
    this.activationContext = context;
    this.registerOverlayCommands = options.registerCommands !== false;
    if (this.registerOverlayCommands) {
      this.disposables.push(vscode.commands.registerCommand("djangoShell.openConsole", () => this.openConsole()));
    }
    context.subscriptions.push(this);
  }

  /** Opens or reveals the custom webview console and starts its backend session. */
  async openConsole(): Promise<void> {
    if (!this.overlay) {
      await this.ensureOverlayBackingFilesReset();
      scheduleWorkspaceGeneratedOverlayTabCleanup();
    }
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.postStatus();
      this.post({ show: this.runtimeReady, type: "measureEditor" });
      return;
    }
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Django Shell", vscode.ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.extensionPath, "media"))],
      retainContextWhenHidden: true
    });
    this.panel.webview.html = webviewHtml(this.panel.webview, this.extensionPath);
    this.panel.onDidDispose(() => this.closePanel(), undefined, this.disposables);
    this.panel.onDidChangeViewState((event) => this.handleViewState(event.webviewPanel.visible), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage((message) => void this.handleMessage(message), undefined, this.disposables);
    this.ensureSession();
  }

  /** Opens the console and shows the overlay editor for command-driven access. */
  async showOverlayEditor(): Promise<void> {
    await this.openConsole();
    await this.showOverlay();
  }

  /** Runs the current overlay input through the renderer-owned editor command. */
  async runCurrentOverlayInput(): Promise<void> {
    const overlay = await this.ensureOverlay();
    await overlay.runCurrentInput();
  }
  /** Accepts Enter from the file-backed overlay command facade. */ async acceptOverlayInput(): Promise<void> { await (await this.ensureOverlay()).acceptInput(); }
  /** Inserts an indented newline from the file-backed overlay command facade. */ async insertOverlayNewline(): Promise<void> { await (await this.ensureOverlay()).insertNewline(); }

  /** Returns safe runtime summaries for the active custom console backend. */
  async inspectActiveRuntime(): Promise<BackendRuntimeInspection> {
    if (!this.session?.backend) {
      return { error: "Open the Django Shell console and enter Django shell first.", modules: [], ok: false, variables: [] };
    }
    if (!this.session.backend.supportsRuntimeInspection()) {
      return remoteRuntimeInspectionDisabled();
    }
    if (this.inspectionCache) {
      return this.inspectionCache;
    }
    if (!this.inspectionInFlight) {
      this.inspectionInFlight = this.session.backend.inspect().then((inspection) => {
        this.inspectionCache = inspection;
        return inspection;
      }).finally(() => {
        this.inspectionInFlight = undefined;
      });
    }
    return this.inspectionInFlight;
  }

  /** Returns safe child summaries for one runtime object path. */
  async inspectRuntimeChildren(pathSegments: BackendRuntimePathSegment[]): Promise<BackendRuntimeChildren> {
    if (!this.session?.backend) {
      return { children: [], error: "Open the Django Shell console and enter Django shell first.", ok: false };
    }
    if (!this.session.backend.supportsRuntimeInspection()) {
      return remoteRuntimeChildrenDisabled();
    }
    return this.session.backend.children(pathSegments);
  }

  /** Returns a compact state snapshot for extension host E2E tests. */
  e2eSnapshot(): Record<string, unknown> {
    const html = this.panel?.webview.html ?? "";
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd()), ".django-shell", "console-cell.py");
    const analysisUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd()), ".django-shell", "analysis.py");
    const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString());
    const analysisDocument = vscode.workspace.textDocuments.find((item) => item.uri.toString() === analysisUri.toString());
    return {
      hasEditorAnchor: html.includes("id=\"editorAnchor\""),
      hasCellResizers: html.includes("data-resize-target=\"terminal\"") && html.includes("data-resize-target=\"editor\""),
      hasNotebookChrome: html.includes("class=\"statusDot\"") && html.includes("class=\"promptMark\""),
      hasPythonDisabledState: html.includes("inputCell disabled") && html.includes("editorLock"),
      hasPythonIcon: html.includes("pythonIcon"),
      hasPythonRunButton: html.includes("id=\"showEditor\"") || html.includes("runGlyph"),
      hasSetupAutoMinimize: html.includes("id=\"setupCell\"") && html.includes("setupCell.minimized"),
      executionCount: this.executionCount,
      lastEditorGeometry: this.lastEditorGeometry,
      overlayAnalysisDocumentHasMarker: analysisDocument?.getText().includes("# --- django shell input ---") ?? false,
      overlayAnalysisDocumentOpen: Boolean(analysisDocument),
      overlayDocumentHasMarker: document?.getText().includes("# --- django shell input ---") ?? false,
      overlayDocumentLanguage: document?.languageId,
      overlayDocumentOpen: Boolean(document),
      panelOpen: Boolean(this.panel),
      panelVisible: Boolean(this.panel?.visible)
    };
  }

  /** Restarts the console through the same path used by the webview restart button. */ async e2eRestartKernel(): Promise<void> { await this.restartSession(); }
  /** Injects hidden overlay prelude lines for extension host E2E tests. */ async e2eSetPrelude(importLines: string[]): Promise<void> { this.overlayPrelude = importLines; (await this.ensureOverlay()).updatePrelude(importLines); }
  /** Evaluates an overlay renderer expression for extension host E2E tests. */ async e2eEvaluateOverlay(expression: string): Promise<string> { return (await this.ensureOverlay()).e2eEvaluate(expression); }

  /** Releases the custom console session and webview resources. */
  dispose(): void {
    const panel = this.panel;
    this.closePanel();
    panel?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.overlay?.dispose();
    this.runtimeEmitter.dispose();
  }

  /** Loads the CDP-backed workbench overlay only when Python editor features are used. */
  private async ensureOverlay(): Promise<WorkbenchOverlay> {
    if (this.overlay) {
      return this.overlay;
    }
    if (!this.activationContext) {
      throw new Error("Django Shell console has not been activated.");
    }
    if (!this.overlayPromise) {
      this.overlayPromise = import("./workbenchOverlay").then(({ WorkbenchOverlay }) => {
        const overlay = new WorkbenchOverlay(this.logger);
        overlay.activate(this.activationContext!, (code) => this.executePython(code), { registerCommands: this.registerOverlayCommands });
        if (this.lastEditorGeometry) {
          overlay.updateGeometry(this.lastEditorGeometry);
        }
        if (this.overlayPrelude.length) {
          overlay.updatePrelude(this.overlayPrelude);
        }
        this.overlay = overlay;
        return overlay;
      }).finally(() => {
        this.overlayPromise = undefined;
      });
    }
    return this.overlayPromise;
  }

  /** Clears stale generated overlay files without loading the workbench overlay. */
  private ensureOverlayBackingFilesReset(): Promise<void> {
    if (!this.overlayBackingReset) {
      this.overlayBackingReset = this.resetOverlayBackingFiles();
    }
    return this.overlayBackingReset;
  }

  /** Forces generated overlay backing files back to an empty shell input. */
  private resetOverlayBackingFiles(): Promise<void> {
    this.overlayBackingReset = resetOverlayBackingFiles();
    return this.overlayBackingReset;
  }

  /** Starts a backend-capable setup terminal session when one is not already running. */
  private ensureSession(): void {
    if (this.session) {
      this.postStatus();
      return;
    }
    this.runtimeReady = false;
    this.session = new NotebookPtySession({
      autoActivateWorkspaceVenv: autoActivateWorkspaceVenv(),
      backendRuntimePath: path.join(this.extensionPath, "python", "django_shell_backend.py"),
      cwd: workspaceCwd(),
      diagnosticLogger: this.logger,
      sessionId: `custom:${workspaceCwd()}`,
      settingsCandidates: []
    });
    this.sessionDisposables.push(
      this.session.onDidData((data) => this.post({ data, type: "terminalData" })),
      this.session.onDidChange((snapshot) => {
        this.post({ snapshot, type: "terminalStatus" });
        if (snapshot.ready && !this.runtimeReady) {
          this.runtimeReady = true;
          this.runtimeGeneration += 1;
          this.runtimeEmitter.fire();
          void this.updateOverlayPrelude(this.runtimeGeneration);
          scheduleWorkspaceGeneratedOverlayTabCleanup();
          this.post({ show: true, type: "measureEditor" });
        }
      })
    );
    this.session.start();
  }

  /** Handles messages sent by the custom console webview. */
  private async handleMessage(message: unknown): Promise<void> {
    const typed = message as { code?: string; cols?: number; data?: string; rect?: unknown; rows?: number; type?: string };
    if (typed.type === "ready") {
      this.postStatus();
      this.post({ show: this.runtimeReady, type: "measureEditor" });
      return;
    }
    if (typed.type === "editorGeometry") {
      if (this.panel?.visible && isOverlayGeometry(typed.rect)) {
        this.updateOverlayGeometry(typed.rect);
      }
      return;
    }
    if (typed.type === "showOverlayEditor") {
      if (!this.panel?.visible || !this.runtimeReady) {
        return;
      }
      if (isOverlayGeometry(typed.rect)) {
        this.updateOverlayGeometry(typed.rect);
      }
      await this.showOverlay();
      return;
    }
    if (typed.type === "terminalInput" && typeof typed.data === "string") {
      this.ensureSession();
      this.session?.write(typed.data);
      return;
    }
    if (typed.type === "terminalResize" && Number.isFinite(typed.cols) && Number.isFinite(typed.rows)) {
      this.session?.resize(Math.max(1, typed.cols ?? 1), Math.max(1, typed.rows ?? 1));
      return;
    }
    if (typed.type === "restart") {
      await this.restartSession();
      return;
    }
    if (typed.type === "runPython" && typeof typed.code === "string") {
      await this.executePython(typed.code);
      return;
    }
  }

  /** Executes Python through the attached backend and posts a textual result. */
  private async executePython(code: string): Promise<boolean> {
    if (!code.trim()) {
      return false;
    }
    const backend = this.session?.backend;
    if (!backend) {
      const execution = this.executionCount++;
      this.post({ execution, type: "pythonStarted" });
      const text = "Backend is not ready. Enter Django shell in the setup terminal first.";
      this.post({ execution, ok: false, text, type: "pythonResult" });
      void this.overlay?.postOutput(text, false);
      return false;
    }
    if (isLikelyIncompletePython(code)) {
      this.logger?.log("python.incomplete", { chars: code.length, lines: lineCount(code) });
      return false;
    }
    const execution = this.executionCount++;
    this.post({ execution, type: "pythonStarted" });
    const result = await backend.execute(code);
    this.clearInspectionCache();
    const text = executionText(result);
    this.post({ execution, ok: result.ok, text, type: "pythonResult" });
    void this.overlay?.postOutput(text, result.ok);
    this.scheduleRuntimeRefresh();
    return true;
  }

  /** Shows the workbench overlay editor without failing the webview flow. */
  private async showOverlay(): Promise<void> {
    if (!this.panel?.visible) {
      return;
    }
    try {
      await (await this.ensureOverlay()).show();
    } catch (error) {
      this.logger?.log("overlay.show.error", { error: error instanceof Error ? error.message : String(error) });
      void vscode.window.showWarningMessage("Django Shell overlay editor could not be opened.");
    } finally {
      scheduleWorkspaceGeneratedOverlayTabCleanup();
    }
  }

  /** Keeps the workbench overlay lifecycle bound to the Django Shell webview tab. */
  private handleViewState(visible: boolean): void {
    if (visible) {
      this.postStatus();
      this.post({ show: this.runtimeReady, type: "measureEditor" });
      if (this.runtimeReady) { void this.updateOverlayPrelude(this.runtimeGeneration); }
      return;
    }
    this.overlay?.hide();
  }

  /** Refreshes hidden runtime imports used by the overlay Python analyzer. */
  private async updateOverlayPrelude(generation = this.runtimeGeneration): Promise<void> {
    const backend = this.session?.backend;
    if (!backend?.supportsRuntimeInspection()) { return; }
    const inspection = await backend.prelude();
    if (!inspection?.ok || !this.runtimeReady || generation !== this.runtimeGeneration) { return; }
    const lines = runtimePreludeLines(inspection.variables);
    this.overlayPrelude = lines;
    this.overlay?.updatePrelude(lines);
  }

  /** Schedules runtime-dependent UI refresh without blocking rapid shell input. */
  private scheduleRuntimeRefresh(): void {
    this.clearRuntimeRefreshTimer();
    this.runtimeRefreshTimer = setTimeout(() => {
      this.runtimeRefreshTimer = undefined;
      this.runtimeEmitter.fire();
      void this.updateOverlayPrelude(this.runtimeGeneration);
    }, 750);
  }

  /** Clears any pending delayed runtime refresh. */
  private clearRuntimeRefreshTimer(): void {
    if (!this.runtimeRefreshTimer) {
      return;
    }
    clearTimeout(this.runtimeRefreshTimer);
    this.runtimeRefreshTimer = undefined;
  }

  /** Clears cached runtime inspection data after code changes the namespace. */
  private clearInspectionCache(): void {
    this.inspectionCache = undefined;
    this.inspectionInFlight = undefined;
  }

  /** Restarts the setup terminal and clears the current backend readiness state. */
  private async restartSession(): Promise<void> {
    this.runtimeReady = false;
    this.runtimeGeneration += 1;
    this.executionCount = 1;
    this.clearInspectionCache();
    this.clearRuntimeRefreshTimer();
    this.post({ type: "resetPythonCell" });
    this.overlayPrelude = [];
    if (this.overlay) {
      await this.overlay.reset();
    } else {
      await this.resetOverlayBackingFiles();
    }
    this.session?.restart();
    this.runtimeEmitter.fire();
  }

  /** Saves the latest webview geometry and forwards it to a loaded overlay. */
  private updateOverlayGeometry(geometry: WorkbenchOverlayGeometry): void {
    this.lastEditorGeometry = geometry;
    this.overlay?.updateGeometry(geometry);
  }

  /** Posts the latest session snapshot to the webview. */
  private postStatus(): void {
    const snapshot = this.session?.snapshot();
    if (snapshot) {
      this.post({ snapshot, type: "terminalStatus" });
    }
  }

  /** Posts one message to the active webview when it is still open. */
  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  /** Closes only the webview panel while keeping dispose idempotent. */
  private closePanel(): void {
    for (const disposable of this.sessionDisposables) {
      disposable.dispose();
    }
    this.sessionDisposables = [];
    this.session?.dispose();
    this.session = undefined;
    this.panel = undefined;
    this.runtimeReady = false;
    this.runtimeGeneration += 1;
    this.overlay?.hide();
    this.clearInspectionCache();
    this.clearRuntimeRefreshTimer();
  }
}

/** Returns whether conventional workspace virtualenvs should be activated. */
function autoActivateWorkspaceVenv(): boolean {
  return vscode.workspace.getConfiguration("djangoShell").get<boolean>("autoActivateWorkspaceVenv", true);
}

/** Returns the workspace root used as the child shell working directory. */
function workspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

/** Returns true for common Python continuations without a backend round trip. */
function isLikelyIncompletePython(source: string): boolean {
  const trimmed = source.trimEnd();
  return trimmed.endsWith(":") || trimmed.endsWith("\\") || hasUnclosedBracket(trimmed);
}

/** Returns whether brackets are still open in simple Python source. */
function hasUnclosedBracket(source: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  for (const char of source) {
    if (pairs[char]) {
      stack.push(pairs[char]);
    } else if ([")", "]", "}"].includes(char) && stack.pop() !== char) {
      return false;
    }
  }
  return stack.length > 0;
}

/** Returns the common remote inspection disabled message. */
function remoteRuntimeMessage(): string {
  return "Remote runtime inspection is disabled because the backend is only reachable through the interactive terminal.";
}

/** Returns a safe inspection response when remote TCP is unreachable. */
function remoteRuntimeInspectionDisabled(): BackendRuntimeInspection {
  return { error: remoteRuntimeMessage(), loadedModuleCount: 0, modules: [], ok: false, variables: [] };
}

/** Returns a safe child response when remote TCP is unreachable. */
function remoteRuntimeChildrenDisabled(): BackendRuntimeChildren {
  return { children: [], error: remoteRuntimeMessage(), ok: false };
}

/** Formats one backend execution result for display in the custom console. */
function executionText(result: BackendExecutionResult): string {
  return [result.stdout, result.stderr, result.result, result.traceback].filter(Boolean).join("\n") || "(no output)";
}

/** Returns a compact line count for diagnostics. */
function lineCount(text: string): number {
  return text ? text.split(/\r?\n/).length : 0;
}

/** Returns whether a webview message contains a usable editor anchor rectangle. */
function isOverlayGeometry(value: unknown): value is WorkbenchOverlayGeometry {
  const rect = value as WorkbenchOverlayGeometry | undefined;
  return !!rect &&
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 40 &&
    rect.height > 40;
}

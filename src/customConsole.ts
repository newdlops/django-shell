// Custom webview frontend that reuses the Django shell backend without notebooks.

import * as path from "path";
import * as vscode from "vscode";
import type { BackendClient, BackendExecutionResult, BackendProgressSnapshot, BackendRuntimeChildren, BackendRuntimeInspection, BackendRuntimePathSegment, BackendTransportMode } from "./backendClient";
import { webviewHtml } from "./customConsoleHtml";
import { DiagnosticLogger } from "./diagnostics";
import { closeWorkspaceGeneratedOverlayTabs, scheduleWorkspaceGeneratedOverlayTabCleanup } from "./generatedOverlayTabs";
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
  private overlayShutdownPromise: Promise<void> | undefined;
  private registerOverlayCommands = true;
  private runtimeReady = false;
  private runtimeGeneration = 0;
  private runtimeRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pythonProgressTimers = new Map<number, ReturnType<typeof setInterval>>();
  private activePythonExecution: number | undefined;
  private session: NotebookPtySession | undefined;
  private sessionDisposables: vscode.Disposable[] = [];
  private executionCount = 1;
  private lastRenderedOutput: Record<string, unknown> | undefined;
  private lastPythonResult: { code: string; execution: number; ok: boolean; text: string } | undefined;
  private panelVisible = false;
  private selectedTransport: BackendTransportMode | undefined;
  private preludeRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private preludeRetryAttempt = 0;

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
    this.panelVisible = this.panel.visible;
    this.panel.webview.html = webviewHtml(this.panel.webview, this.extensionPath);
    this.panel.onDidDispose(() => this.closePanel(), undefined, this.disposables);
    this.panel.onDidChangeViewState((event) => this.handleViewState(event.webviewPanel.visible), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage((message) => void this.handleMessage(message), undefined, this.disposables);
    this.ensureSession();
  }

  /** Opens the console and shows the overlay editor for command-driven access. */
  async showOverlayEditor(): Promise<void> { await this.openConsole(); await this.showOverlay(); }

  /** Runs the current overlay input through the renderer-owned editor command. */
  async runCurrentOverlayInput(): Promise<string> { return (await this.ensureOverlay()).runCurrentInput(); }
  /** Skips the current overlay input through the renderer-owned editor command. */
  async skipCurrentOverlayInput(): Promise<string> { return (await this.ensureOverlay()).skipCurrentInput(); }
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

  /** Returns safe child summaries for one runtime object path (kind routes pure-expression vs helper drill-down in ORM mode). */
  async inspectRuntimeChildren(pathSegments: BackendRuntimePathSegment[], kind?: string): Promise<BackendRuntimeChildren> {
    if (!this.session?.backend) {
      return { children: [], error: "Open the Django Shell console and enter Django shell first.", ok: false };
    }
    if (!this.session.backend.supportsRuntimeInspection()) {
      return remoteRuntimeChildrenDisabled();
    }
    return this.session.backend.children(pathSegments, kind);
  }

  /** Returns the active backend client when a Django shell session is attached. */ get activeBackend(): BackendClient | undefined { return this.session?.backend; }

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
      lastPythonResult: this.lastPythonResult,
      lastRenderedOutput: this.lastRenderedOutput,
      lastEditorGeometry: this.lastEditorGeometry,
      overlayAnalysisDocumentHasMarker: analysisDocument?.getText().includes("# --- django shell input ---") ?? false,
      overlayAnalysisDocumentOpen: Boolean(analysisDocument),
      overlayDocumentHasMarker: document?.getText().includes("# --- django shell input ---") ?? false,
      overlayDocumentLanguage: document?.languageId,
      overlayDocumentOpen: Boolean(document),
      panelOpen: Boolean(this.panel),
      panelVisible: Boolean(this.panel?.visible),
      runtimeReady: this.runtimeReady
    };
  }

  /** Restarts the console through the same path used by the webview restart button. */ async e2eRestartKernel(): Promise<void> { await this.restartSession(); }
  /** Injects hidden overlay prelude lines for extension host E2E tests. */ async e2eSetPrelude(importLines: string[]): Promise<void> { this.overlayPrelude = importLines; await (await this.ensureOverlay()).updatePrelude(importLines); }
  /** Writes setup terminal input for extension host E2E tests. */ e2eWriteTerminal(data: string): void { this.ensureSession(); this.session?.write(data); }
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
    if (this.overlayShutdownPromise) {
      await this.overlayShutdownPromise;
    }
    if (this.overlay) {
      return this.overlay;
    }
    if (!this.activationContext) {
      throw new Error("Django Shell console has not been activated.");
    }
    if (!this.overlayPromise) {
      const panel = this.panel;
      this.overlayPromise = import("./workbenchOverlay").then(async ({ WorkbenchOverlay }) => {
        const overlay = new WorkbenchOverlay(this.logger);
        overlay.activate(this.activationContext!, (code) => this.executePython(code), { registerCommands: this.registerOverlayCommands });
        if (panel && panel !== this.panel) {
          await overlay.shutdown();
          throw new Error("Django Shell console closed before overlay finished loading.");
        }
        if (this.lastEditorGeometry) {
          overlay.updateGeometry(this.lastEditorGeometry);
        }
        if (this.overlayPrelude.length) { await overlay.updatePrelude(this.overlayPrelude); }
        if (panel && panel !== this.panel) {
          await overlay.shutdown();
          throw new Error("Django Shell console closed before overlay finished loading.");
        }
        this.overlay = overlay;
        return overlay;
      }).finally(() => {
        this.overlayPromise = undefined;
      });
    }
    return this.overlayPromise;
  }

  /** Releases the workbench overlay when the owning console webview is gone. */
  private releaseOverlay(): void {
    const overlay = this.overlay;
    const pending = this.overlayPromise;
    this.overlay = undefined;
    this.overlayPromise = undefined;
    this.lastEditorGeometry = undefined;
    this.overlayPrelude = [];
    if (overlay) {
      this.trackOverlayShutdown(overlay.shutdown());
      return;
    }
    if (pending) {
      this.trackOverlayShutdown(pending.then((loaded) => {
        if (this.overlay === loaded) {
          this.overlay = undefined;
        }
        return loaded.shutdown();
      }));
    }
  }

  /** Tracks asynchronous overlay shutdown without leaking unhandled failures. */
  private trackOverlayShutdown(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      this.logger?.log("overlay.shutdown.error", { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      if (this.overlayShutdownPromise === tracked) {
        this.overlayShutdownPromise = undefined;
      }
    });
    this.overlayShutdownPromise = tracked;
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
      this.session.onDidProgress((progress) => this.handleSessionProgress(progress)),
      this.session.onDidChange((snapshot) => this.handleSessionSnapshot(snapshot))
    );
    this.session.start();
  }

  /** Handles backend readiness changes from the setup terminal. */
  private handleSessionSnapshot(snapshot: ReturnType<NotebookPtySession["snapshot"]>): void {
    this.post({ snapshot, type: "terminalStatus" });
    if (!snapshot.ready && this.runtimeReady) {
      this.runtimeReady = false;
      this.runtimeGeneration += 1;
      this.executionCount = 1; this.lastPythonResult = undefined;
      this.clearInspectionCache(); this.clearRuntimeRefreshTimer();
      this.clearPreludeRetryTimer(); this.preludeRetryAttempt = 0;
      this.post({ type: "resetPythonCell" });
      this.overlayPrelude = [];
      void (this.overlay ? this.overlay.reset() : this.resetOverlayBackingFiles());
      this.runtimeEmitter.fire();
      this.postTransport();
      return;
    }
    if (!snapshot.ready || this.runtimeReady) { return; }
    this.runtimeReady = true;
    this.session?.backend?.setTransportMode(this.selectedTransport ?? this.modelTransportSetting());
    this.runtimeGeneration += 1;
    this.preludeRetryAttempt = 0;
    this.runtimeEmitter.fire();
    void this.updateOverlayPrelude(this.runtimeGeneration);
    scheduleWorkspaceGeneratedOverlayTabCleanup();
    this.post({ show: true, type: "measureEditor" });
    this.postTransport();
  }

  /** Handles messages sent by the custom console webview. */
  private async handleMessage(message: unknown): Promise<void> {
    const typed = message as { code?: string; cols?: number; data?: string; execution?: number; mode?: string; ok?: boolean; rect?: unknown; rows?: number; text?: string; type?: string };
    if (typed.type === "ready") {
      this.postStatus();
      this.postTransport();
      this.post({ show: this.runtimeReady, type: "measureEditor" });
      return;
    }
    if (typed.type === "setTransport" && typeof typed.mode === "string") {
      this.applyTransport(typed.mode as BackendTransportMode);
      return;
    }
    if (typed.type === "editorGeometry") {
      if (this.panel?.visible && isOverlayGeometry(typed.rect)) {
        this.updateOverlayGeometry(typed.rect);
      }
      return;
    }
    if (typed.type === "e2eOutputRendered" && typeof typed.text === "string") { this.lastRenderedOutput = { ...typed, execution: Number(typed.execution) || 0, ok: Boolean(typed.ok), text: typed.text }; return; }
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
      const text = "Backend is not ready. Enter Django shell in the setup terminal first.";
      this.lastPythonResult = { code, execution, ok: false, text };
      this.post({ code, execution, type: "pythonStarted" });
      this.post({ code, execution, ok: false, text, type: "pythonResult" });
      void this.overlay?.postOutput(text, false);
      return false;
    }
    if (isLikelyIncompletePython(code)) {
      this.logger?.log("python.incomplete", { chars: code.length, lines: lineCount(code) });
      return false;
    }
    const execution = this.executionCount++;
    this.activePythonExecution = execution;
    this.post({ code, execution, type: "pythonStarted" });
    this.startPythonProgress(execution, backend);
    const result = await this.executeBackendPython(backend, code);
    this.stopPythonProgress(execution);
    if (this.activePythonExecution === execution) {
      this.activePythonExecution = undefined;
    }
    this.clearInspectionCache();
    const text = executionText(result);
    this.lastPythonResult = { code, execution, ok: result.ok, text };
    this.post({ code, execution, ok: result.ok, text, type: "pythonResult" });
    void this.overlay?.postOutput(text, result.ok);
    this.postTransport();
    this.scheduleRuntimeRefresh();
    void closeWorkspaceGeneratedOverlayTabs().catch(() => undefined);
    return true;
  }

  /** Executes backend Python and converts transport failures into a rendered shell error. */
  private async executeBackendPython(backend: BackendClient, code: string): Promise<BackendExecutionResult> {
    try {
      return await backend.execute(code);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.log("python.execute.error", { chars: code.length, error: message, lines: lineCount(code) });
      return { ok: false, stderr: message, stdout: "" };
    }
  }

  /** Starts polling backend loop progress for one running Python execution. */
  private startPythonProgress(execution: number, backend: BackendClient): void {
    this.stopPythonProgress(execution);
    if (!backend.canPollProgress()) {
      return;
    }
    const poll = () => {
      void backend.progress().then((progress) => this.postPythonProgress(execution, progress), () => undefined);
    };
    const timer = setInterval(poll, 700);
    this.pythonProgressTimers.set(execution, timer);
    setTimeout(poll, 300);
  }

  /** Posts one progress snapshot when it still belongs to a running output item. */
  private postPythonProgress(execution: number, progress: BackendProgressSnapshot): void {
    if (!this.pythonProgressTimers.has(execution)) {
      return;
    }
    this.post({ execution, progress, type: "pythonProgress" });
  }

  /** Routes streamed PTY progress to the currently running Python output item. */
  private handleSessionProgress(progress: BackendProgressSnapshot): void {
    if (this.activePythonExecution === undefined) {
      return;
    }
    this.post({ execution: this.activePythonExecution, progress, type: "pythonProgress" });
  }

  /** Stops progress polling for one Python execution. */
  private stopPythonProgress(execution: number): void {
    const timer = this.pythonProgressTimers.get(execution);
    if (!timer) {
      return;
    }
    clearInterval(timer);
    this.pythonProgressTimers.delete(execution);
  }

  /** Stops every in-flight progress poller. */
  private stopAllPythonProgress(): void {
    for (const execution of [...this.pythonProgressTimers.keys()]) {
      this.stopPythonProgress(execution);
    }
  }

  /** Shows the workbench overlay editor without failing the webview flow. */
  private async showOverlay(): Promise<void> {
    if (!this.panel?.visible) {
      return;
    }
    try {
      await (await this.ensureOverlay()).show();
      if (this.runtimeReady && this.overlayPrelude.length === 0) {
        this.preludeRetryAttempt = 0;
        void this.updateOverlayPrelude(this.runtimeGeneration);
      }
    } catch (error) {
      this.logger?.log("overlay.show.error", { error: error instanceof Error ? error.message : String(error) });
      void vscode.window.showWarningMessage("Django Shell overlay editor could not be opened.");
    } finally {
      scheduleWorkspaceGeneratedOverlayTabCleanup();
    }
  }

  /** Keeps the workbench overlay lifecycle bound to the Django Shell webview tab. */
  private handleViewState(visible: boolean): void {
    const wasVisible = this.panelVisible;
    this.panelVisible = visible;
    if (visible) {
      this.postStatus();
      if (wasVisible) { return; }
      this.post({ show: this.runtimeReady, type: "measureEditor" });
      if (this.runtimeReady) { void this.updateOverlayPrelude(this.runtimeGeneration); }
      return;
    }
    this.overlay?.hide();
  }

  /** Refreshes hidden runtime imports used by the overlay Python analyzer. */
  private async updateOverlayPrelude(generation = this.runtimeGeneration): Promise<void> {
    if (generation !== this.runtimeGeneration || !this.runtimeReady) { return; }
    const backend = this.session?.backend;
    if (!backend?.supportsRuntimeInspection()) { return; }
    let inspection;
    try {
      inspection = await backend.prelude();
    } catch (error) {
      this.logger?.log("prelude.error", { error: error instanceof Error ? error.message : String(error) });
      this.schedulePreludeRetry(generation);
      return;
    }
    if (generation !== this.runtimeGeneration || !this.runtimeReady) { return; }
    if (!inspection?.ok) {
      this.schedulePreludeRetry(generation);
      return;
    }
    const lines = runtimePreludeLines(inspection.variables);
    if (lines.length === 0) {
      this.schedulePreludeRetry(generation);
    } else {
      this.preludeRetryAttempt = 0;
      this.clearPreludeRetryTimer();
    }
    this.overlayPrelude = lines;
    void this.overlay?.updatePrelude(lines);
  }

  /** Schedules a bounded prelude retry after an empty or failed runtime inspection. */
  private schedulePreludeRetry(generation: number): void {
    if (this.preludeRetryAttempt >= 4) { return; }
    this.clearPreludeRetryTimer();
    const delay = Math.min(2000, 250 * Math.pow(2, this.preludeRetryAttempt));
    this.preludeRetryAttempt += 1;
    this.preludeRetryTimer = setTimeout(() => {
      this.preludeRetryTimer = undefined;
      if (generation !== this.runtimeGeneration || !this.runtimeReady) { return; }
      void this.updateOverlayPrelude(generation);
    }, delay);
  }

  /** Clears any pending prelude retry. */
  private clearPreludeRetryTimer(): void {
    if (!this.preludeRetryTimer) { return; }
    clearTimeout(this.preludeRetryTimer);
    this.preludeRetryTimer = undefined;
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
    this.clearPreludeRetryTimer();
    this.preludeRetryAttempt = 0;
    this.executionCount = 1; this.lastPythonResult = undefined;
    this.clearInspectionCache();
    this.clearRuntimeRefreshTimer();
    this.stopAllPythonProgress();
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

  /** Posts the active connection transport and selected mode so the Python cell selector stays in sync. */
  private postTransport(): void {
    const backend = this.session?.backend;
    const mode = backend?.transportMode ?? this.selectedTransport ?? this.modelTransportSetting();
    this.post({ active: backend?.transport ?? "none", mode, type: "transport" });
  }

  /** Returns the configured default model-browser transport, validated (defaults to ORM). */
  private modelTransportSetting(): BackendTransportMode {
    const setting = vscode.workspace.getConfiguration("djangoShell").get<string>("modelBrowser.transport", "orm");
    return ["auto", "tcp", "pty", "orm"].includes(setting) ? (setting as BackendTransportMode) : "orm";
  }

  /** Applies a user-selected connection transport to the live backend and remembers it for reattach. */
  private applyTransport(mode: BackendTransportMode): void {
    if (!["auto", "tcp", "pty", "orm"].includes(mode)) {
      return;
    }
    this.selectedTransport = mode;
    this.session?.backend?.setTransportMode(mode);
    this.logger?.log("console.transport", { active: this.session?.backend?.transport ?? "none", mode });
    this.postTransport();
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
    this.panelVisible = false;
    this.runtimeReady = false;
    this.runtimeGeneration += 1;
    this.releaseOverlay();
    this.clearInspectionCache();
    this.clearRuntimeRefreshTimer();
    this.stopAllPythonProgress();
    this.clearPreludeRetryTimer();
    this.preludeRetryAttempt = 0;
  }
}

/** Returns whether conventional workspace virtualenvs should be activated. */
function autoActivateWorkspaceVenv(): boolean {
  return vscode.workspace.getConfiguration("djangoShell").get<boolean>("autoActivateWorkspaceVenv", true);
}

/** Returns the workspace root used as the child shell working directory. */
function workspaceCwd(): string { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(); }

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
function remoteRuntimeMessage(): string { return "Remote runtime inspection is disabled because the backend is only reachable through the interactive terminal."; }

/** Returns a safe inspection response when remote TCP is unreachable. */
function remoteRuntimeInspectionDisabled(): BackendRuntimeInspection { return { error: remoteRuntimeMessage(), loadedModuleCount: 0, modules: [], ok: false, variables: [] }; }

/** Returns a safe child response when remote TCP is unreachable. */
function remoteRuntimeChildrenDisabled(): BackendRuntimeChildren { return { children: [], error: remoteRuntimeMessage(), ok: false }; }

/** Formats one backend execution result for display in the custom console. */
function executionText(result: BackendExecutionResult): string { return [result.stdout, result.stderr, result.result, result.traceback].filter(Boolean).join("\n") || "(no output)"; }

/** Returns a compact line count for diagnostics. */
function lineCount(text: string): number { return text ? text.split(/\r?\n/).length : 0; }

/** Returns whether a webview message contains a usable editor anchor rectangle. */
function isOverlayGeometry(value: unknown): value is WorkbenchOverlayGeometry {
  const rect = value as WorkbenchOverlayGeometry | undefined;
  return !!rect && Number.isFinite(rect.left) && Number.isFinite(rect.top) && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 40 && rect.height > 40;
}

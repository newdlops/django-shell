// Custom webview frontend that reuses the Django shell backend without notebooks.
import * as path from "path";
import * as vscode from "vscode";
import type { BackendClient, BackendExecutionResult, BackendProgressSnapshot, BackendRuntimeChildren, BackendRuntimeInspection, BackendRuntimePathSegment, BackendTransportMode } from "./backendClient";
import { registerCustomConsoleDebugEvents } from "./customConsoleDebugEvents";
import { webviewHtml } from "./customConsoleHtml";
import { type DebugBreakpointLocation, syncDebugBreakpoints } from "./debugBreakpoints";
import { type DebugFrameInfo, inspectDebugThread } from "./debugInspector";
import { DEBUG_CONTROL_ACTIONS, type DebugControlAction, debugControlDetail, debugControlState, isDebugControlAction, runDebugControl } from "./debugControls";
import { DEFAULT_DEBUG_MODE, type DjangoShellDebugMode, debugFileUri, mirrorOverlayBreakpointsToDebugFile, normalizeDebugMode, openDebugFile, readDebugFileText, sourceBreakpointLocations, writeDebugFile } from "./debugFileMode";
import { DEBUGPY_MARKER_PREFIX, buildDebugpyBootstrapCode, buildDjangoShellDebugConfiguration, type DebugpyBootstrapResult, type DebugpyEndpoint, parseDebugpyBootstrapResult, readDjangoShellDebugOptions } from "./debugShell";
import { DirectDebugAdapterSession } from "./directDebugAdapterSession";
import { DiagnosticLogger } from "./diagnostics";
import { closeWorkspaceGeneratedOverlayTabs, scheduleWorkspaceGeneratedOverlayTabCleanup } from "./generatedOverlayTabs";
import { NotebookPtySession } from "./notebookPtySession";
import { overlayEditorUri, resetOverlayBackingFiles } from "./overlayBackingFiles";
import { runtimePreludeLines } from "./runtimePrelude";
import type { WorkbenchOverlay, WorkbenchOverlayGeometry } from "./workbenchOverlay";
const VIEW_TYPE = "djangoShell.customConsole";
const DEBUG_ATTACH_TIMEOUT_MS = 15000;
/** Stores one webview-level overlay tab with its visible Python source. */
interface OverlayTabState { id: string; label: string; text: string }
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
  private debugSession: vscode.DebugSession | undefined; private overlayDebugSession: DirectDebugAdapterSession | undefined; private debugAttachPromise: Promise<void> | undefined; private debugMode: DjangoShellDebugMode = DEFAULT_DEBUG_MODE; private debugpyEndpoint: DebugpyEndpoint | undefined; private runOnNextDebugSessionStart = false;
  private breakpointCount = 0;
  private debugControlOriginOverlay = true; private debugThreadId: number | undefined; private lastDebugControlAction: DebugControlAction | undefined; private lastDebugFrameOverlay = true;
  private activeOverlayTabId = "overlay-1";
  private overlayTabCounter = 1;
  private overlayTabs: OverlayTabState[] = [{ id: "overlay-1", label: "1", text: "" }];
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
      this.disposables.push(
        vscode.commands.registerCommand("djangoShell.openConsole", () => this.openConsole()),
        vscode.commands.registerCommand("djangoShell.debugShell", () => this.debugShell()),
        ...DEBUG_CONTROL_ACTIONS.map((action) => vscode.commands.registerCommand(`djangoShell.debug.${action}`, () => this.controlDebugger(action))),
        vscode.commands.registerCommand("djangoShell.newOverlayTab", () => this.newOverlayTab())
      );
    }
    registerCustomConsoleDebugEvents(this.disposables, { consumeRunOnSessionStart: () => this.consumeRunOnDebugSessionStart(), getSession: () => this.debugSession, interruptExecution: (reason) => this.session?.backend?.interrupt(reason).then(() => undefined) ?? Promise.resolve(), lastControlAction: () => this.lastDebugControlAction, logger: this.logger, postInfo: (info) => this.postDebugInfo(info), postStatus: (state, detail) => this.postDebugStatus(state, detail), refreshBreakpoints: () => this.refreshBreakpointUi(), runCurrentInput: () => this.runCurrentDebugInput(), setPausedThread: (threadId) => { this.debugThreadId = threadId; }, setSession: (session) => { this.debugSession = session; this.debugThreadId = undefined; if (!session) { this.session?.clearDebugpyPortForward(); if (!this.panel?.visible) { this.overlay?.hide(); } } }, shouldRefocusOverlay: () => this.debugMode === "overlay" && this.debugControlOriginOverlay && this.lastDebugControlAction !== "stop", syncBreakpoints: (reason) => this.syncActiveDebugBreakpoints(reason) });
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
      this.postOverlayTabs();
      this.refreshBreakpointUi();
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

  /** Runs one basic debugger control against the active Django shell debug session. */
  async controlDebugger(action: DebugControlAction): Promise<void> {
    let activeSession = this.overlayDebugSession ?? this.debugSession;
    if (!activeSession && this.debugAttachPromise) { this.postDebugStatus("starting", "attaching"); await this.debugAttachPromise; activeSession = this.overlayDebugSession ?? this.debugSession; }
    if (!activeSession) {
      this.postDebugStatus("idle", "not attached");
      void vscode.window.showWarningMessage("Start Django Shell debugging before using debugger controls.");
      return;
    }
    this.lastDebugControlAction = action; this.debugControlOriginOverlay = this.debugMode === "overlay" || this.lastDebugFrameOverlay; this.postDebugStatus(debugControlState(action), debugControlDetail(action));
    try {
      const result = await runDebugControl(action, activeSession, this.debugThreadId, action === "stop" ? () => this.session?.backend?.interrupt("debugControl.stop") ?? Promise.resolve() : undefined);
      if (action === "stop") { this.overlayDebugSession = undefined; this.debugThreadId = undefined; this.debugpyEndpoint = undefined; this.postDebugInfo({ focusVariables: [], scopes: [], state: "idle" }); }
      if (result.threadId) { this.debugThreadId = result.threadId; }
      this.logger?.log("debug.control", { action, originOverlay: this.debugControlOriginOverlay, threadId: result.threadId ?? 0 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.log("debug.control.error", { action, error: message });
      this.postDebugStatus("error", message);
    }
  }

  /** Adds a new custom-console overlay tab and makes its editor visible. */
  async newOverlayTab(): Promise<void> {
    await this.openConsole();
    if (!this.runtimeReady) { return; }
    await this.saveActiveOverlayTab();
    this.overlayTabCounter += 1;
    const tab = createOverlayTab(this.overlayTabCounter);
    this.overlayTabs.push(tab);
    this.activeOverlayTabId = tab.id;
    await this.applyActiveOverlayTab(true);
    this.postOverlayTabs();
  }

  /** Attaches VS Code's Python debugger to the live Django shell process. */
  async debugShell(): Promise<void> {
    this.logger?.log("debug.shell.request", { direct: Boolean(this.overlayDebugSession), hasBackend: Boolean(this.session?.backend), runtimeReady: this.runtimeReady, session: Boolean(this.debugSession) });
    await this.openConsole();
    if (this.overlayDebugSession) { this.logger?.log("debug.shell.alreadyAttached", { sessionId: this.overlayDebugSession.id, threadId: this.debugThreadId ?? 0 }); this.postDebugStatus("attached", "overlay active"); if (!this.debugThreadId) { await this.runCurrentDebugInput(); } return; }
    if (this.debugSession) { this.logger?.log("debug.shell.alreadyAttached", { sessionId: this.debugSession.id }); this.postDebugStatus("attached", "active"); return; }
    if (this.debugAttachPromise) { this.logger?.log("debug.shell.inFlight", {}); this.postDebugStatus("starting", "attaching"); await this.debugAttachPromise; return; }
    this.debugControlOriginOverlay = true; this.lastDebugControlAction = undefined; this.lastDebugFrameOverlay = true; const backend = this.session?.backend;
    if (!backend) { this.logger?.log("debug.shell.noBackend", { runtimeReady: this.runtimeReady, session: Boolean(this.session) }); this.postDebugStatus("error", "setup required"); void vscode.window.showWarningMessage("Enter Django shell in the setup terminal before starting the debugger."); return; }
    if (this.debugMode === "file" && await this.prepareFileDebugInput() === 0) { this.postDebugStatus("idle", "set breakpoints"); void vscode.window.showInformationMessage("Set breakpoints in .django-shell/debug-cell.py, then run Django Shell: Debug Current Shell again."); return; }
    const attach = (async () => {
      this.postDebugStatus("starting", "attaching");
      const cwd = workspaceCwd(), debugOptions = readDjangoShellDebugOptions(vscode.workspace.getConfiguration("djangoShell.debug")); const endpoint = this.debugpyEndpoint ? { endpoint: { ...this.debugpyEndpoint, reused: true }, ok: true } : await this.startDebugpyWithTimeout(backend, debugOptions.listenPort, debugOptions.listenHost);
      if (!endpoint.ok || !endpoint.endpoint) { this.logger?.log("debug.attach.bootstrap.error", { error: endpoint.error ?? "unknown debugpy error", port: 0 }); this.postDebugStatus("error", endpoint.error?.includes("timed out") ? "attach timed out" : "debugpy failed"); void vscode.window.showWarningMessage(`Django Shell debugger could not start: ${endpoint.error ?? "unknown debugpy error"}`); return; }
      const forward = debugOptions.connectHost || debugOptions.connectPort ? undefined : await this.session?.forwardDebugpy(endpoint.endpoint.port); const attachEndpoint = forward ? { ...endpoint.endpoint, host: forward.host, port: forward.port } : endpoint.endpoint; const configuration = buildDjangoShellDebugConfiguration(attachEndpoint, cwd, debugOptions);
      if (this.debugMode === "overlay") { const direct = new DirectDebugAdapterSession({ onContinued: (body) => { if (this.overlayDebugSession !== direct) { return; } this.logger?.log("debug.direct.continued", { all: body.allThreadsContinued ? 1 : 0, currentThreadId: this.debugThreadId ?? 0, threadId: body.threadId ?? 0 }); this.postDebugStatus("running", "continued"); this.postDebugInfo({ focusVariables: [], scopes: [], state: "running" }); }, onStopped: (body) => this.handleDirectDebugStopped(direct, body.threadId, body.reason ?? ""), onTerminated: () => { if (this.overlayDebugSession !== direct) { return; } this.overlayDebugSession = undefined; this.debugThreadId = undefined; this.debugpyEndpoint = undefined; this.postDebugStatus("idle", "ended"); this.postDebugInfo({ focusVariables: [], scopes: [], state: "idle" }); } }, this.logger); try { await direct.attach(attachEndpoint, () => this.syncActiveDebugBreakpoints("sessionStart", undefined, direct)); } catch (error) { direct.dispose(); this.debugpyEndpoint = undefined; const message = error instanceof Error ? error.message : String(error); this.logger?.log("debug.direct.attach.error", { error: message, host: attachEndpoint.host, port: attachEndpoint.port }); this.postDebugStatus("error", "attach failed"); return; } this.overlayDebugSession = direct; this.debugpyEndpoint = endpoint.endpoint; this.clearInspectionCache(); this.scheduleRuntimeRefresh(); this.postTransport(); this.postDebugStatus("attached", `overlay ${attachEndpoint.host}:${attachEndpoint.port}`); this.refreshBreakpointUi(); await this.runCurrentDebugInput(); return; }
      try { this.runOnNextDebugSessionStart = true;
        const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], configuration as vscode.DebugConfiguration);
        if (!started) { this.runOnNextDebugSessionStart = false; this.postDebugStatus("idle", "attach cancelled"); void vscode.window.showWarningMessage("Django Shell debugger attach was cancelled."); return; }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error); this.debugpyEndpoint = undefined; this.runOnNextDebugSessionStart = false;
        this.logger?.log("debug.attach.error", { error: message, host: endpoint.endpoint.host, port: endpoint.endpoint.port }); this.postDebugStatus("error", "attach failed"); void vscode.window.showWarningMessage(`Django Shell debugger attach failed: ${message}`); return;
      }
      this.debugpyEndpoint = endpoint.endpoint;
      this.logger?.log("debug.attach", { host: endpoint.endpoint.host, port: endpoint.endpoint.port, reused: endpoint.endpoint.reused });
      this.clearInspectionCache(); this.scheduleRuntimeRefresh(); this.postTransport(); this.postDebugStatus("attached", `attached ${endpoint.endpoint.host}:${endpoint.endpoint.port}`); this.refreshBreakpointUi();
      void vscode.window.showInformationMessage(`Django Shell debugger attached on ${endpoint.endpoint.host}:${endpoint.endpoint.port}.`);
    })();
    this.debugAttachPromise = attach; try { await attach; } finally { if (this.debugAttachPromise === attach) { this.debugAttachPromise = undefined; } }
  }

  /** Copies the current Python cell into the file-mode debug target and opens it. */ private async prepareFileDebugInput(): Promise<number> { const code = await (await this.ensureOverlay()).currentVisibleText(); const uri = await writeDebugFile(code); mirrorOverlayBreakpointsToDebugFile(); await openDebugFile(uri); const breakpoints = sourceBreakpointLocations(uri).length; this.logger?.log("debug.file.prepare", { breakpoints, chars: code.length, path: uri.fsPath }); return breakpoints; }
  /** Runs the current overlay input through the renderer-owned editor command. */
  async runCurrentOverlayInput(): Promise<string> { return (await this.ensureOverlay()).runCurrentInput(); }
  /** Runs the current debug target according to the selected debugger display mode. */
  async runCurrentDebugInput(): Promise<string> { if (this.debugMode === "overlay") { return this.runCurrentOverlayInput(); } const code = await readDebugFileText(); await this.executePython(code, 0, debugFileUri().fsPath); return "file-requested"; }
  /** Consumes the one-shot flag allowing a newly attached debug session to execute the current cell. */ private consumeRunOnDebugSessionStart(): boolean { const next = this.runOnNextDebugSessionStart; this.runOnNextDebugSessionStart = false; return next; }
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

  /** Returns the active backend client when a Django shell session is attached. */ get activeBackend(): BackendClient | undefined { return this.session?.backend; } /** Returns whether a Python cell is currently executing. */ get pythonBusy(): boolean { return this.activePythonExecution !== undefined; }

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
      hasDebugButton: html.includes("data-action=\"debug-shell\"") && html.includes("codicon-debug-start"),
      hasDebugControls: html.includes("data-debug-control=\"continue\"") && html.includes("data-debug-control=\"stepOver\"") && html.includes("data-debug-control=\"stop\""),
      hasDebugInfoPanel: html.includes("id=\"debugInfo\"") && html.includes("id=\"debugVariables\""),
      hasOverlayTabButton: html.includes("data-action=\"new-overlay-tab\"") && html.includes("id=\"pythonTabs\""),
      hasNotebookChrome: html.includes("class=\"statusDot\"") && html.includes("class=\"promptMark\""),
      hasPythonDisabledState: html.includes("inputCell disabled") && html.includes("editorLock"),
      hasPythonIcon: html.includes("pythonIcon"),
      hasPythonRunButton: html.includes("id=\"showEditor\"") || html.includes("runGlyph"),
      hasSetupAutoMinimize: html.includes("id=\"setupCell\"") && html.includes("setupCell.minimized"),
      executionCount: this.executionCount,
      lastPythonResult: this.lastPythonResult,
      lastRenderedOutput: this.lastRenderedOutput,
      lastEditorGeometry: this.lastEditorGeometry,
      debugSessionActive: Boolean(this.debugSession),
      breakpointCount: this.breakpointCount,
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
        overlay.activate(this.activationContext!, (code, lineOffset) => this.executePython(code, lineOffset), { registerCommands: this.registerOverlayCommands });
        if (panel && panel !== this.panel) {
          await overlay.shutdown();
          throw new Error("Django Shell console closed before overlay finished loading.");
        }
        if (this.lastEditorGeometry) {
          overlay.updateGeometry(this.lastEditorGeometry);
        }
        await overlay.replaceVisibleText(this.activeOverlayTab().text);
        if (this.overlayPrelude.length) { await overlay.updatePrelude(this.overlayPrelude); }
        await overlay.updateBreakpoints(this.overlayBreakpointSourceLocations());
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

  /** Returns the active overlay tab, recovering to the first tab when state is inconsistent. */
  private activeOverlayTab(): OverlayTabState {
    const active = this.overlayTabs.find((tab) => tab.id === this.activeOverlayTabId);
    if (active) {
      return active;
    }
    this.activeOverlayTabId = this.overlayTabs[0]?.id ?? "overlay-1";
    return this.overlayTabs[0] ?? createOverlayTab(1);
  }

  /** Saves the live renderer text into the active overlay tab. */
  private async saveActiveOverlayTab(): Promise<void> {
    const active = this.activeOverlayTab();
    active.text = this.overlay ? await this.overlay.currentVisibleText() : active.text;
  }

  /** Replaces the live overlay editor with the active tab text and optionally shows it. */
  private async applyActiveOverlayTab(show: boolean): Promise<void> {
    const overlay = await this.ensureOverlay();
    await overlay.replaceVisibleText(this.activeOverlayTab().text);
    await overlay.updateBreakpoints(this.overlayBreakpointSourceLocations());
    if (show) {
      await this.showOverlay();
    }
  }

  /** Switches to an existing overlay tab from the custom console tab strip. */
  private async switchOverlayTab(tabId: string): Promise<void> {
    if (!this.overlayTabs.some((tab) => tab.id === tabId)) {
      return;
    }
    if (this.activeOverlayTabId === tabId) {
      await this.showOverlay();
      return;
    }
    await this.saveActiveOverlayTab();
    this.activeOverlayTabId = tabId;
    await this.applyActiveOverlayTab(true);
    this.postOverlayTabs();
  }

  /** Resets overlay tabs to the single empty default tab. */
  private resetOverlayTabs(): void {
    this.activeOverlayTabId = "overlay-1";
    this.overlayTabCounter = 1;
    this.overlayTabs = [createOverlayTab(1)];
    this.postOverlayTabs();
  }

  /** Sends the webview a compact overlay tab model. */
  private postOverlayTabs(): void {
    this.post({ active: this.activeOverlayTabId, tabs: this.overlayTabs.map(({ id, label }) => ({ id, label })), type: "overlayTabs" });
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
      this.resetOverlayTabs();
      this.overlayPrelude = [];
      void (this.overlay ? this.overlay.reset() : this.resetOverlayBackingFiles());
      this.runtimeEmitter.fire();
      this.postTransport();
      this.postDebugStatus("idle");
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
    const typed = message as { action?: unknown; code?: string; column?: unknown; cols?: number; data?: string; debugAttached?: boolean; debugBusy?: boolean; debugMode?: unknown; debugState?: string; execution?: number; inline?: unknown; inputStartLine?: unknown; line?: unknown; lineOffset?: number; mode?: string; ok?: boolean; rawColumn?: unknown; rawLine?: unknown; rect?: unknown; rows?: number; runtimeReady?: boolean; source?: unknown; tabId?: string; text?: string; type?: string };
    if (typed.type === "ready") {
      this.postStatus();
      this.postTransport();
      this.postDebugMode();
      this.postOverlayTabs();
      this.refreshBreakpointUi();
      this.post({ show: this.runtimeReady, type: "measureEditor" });
      return;
    }
    if (typed.type === "setTransport" && typeof typed.mode === "string") {
      this.applyTransport(typed.mode as BackendTransportMode);
      return;
    }
    if (typed.type === "setDebugMode") { this.setDebugMode(typed.debugMode); return; }
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
    if (typed.type === "newOverlayTab") {
      await this.newOverlayTab();
      return;
    }
    if (typed.type === "switchOverlayTab" && typeof typed.tabId === "string") {
      await this.switchOverlayTab(typed.tabId);
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
    if (typed.type === "debugShell") {
      if (typed.debugMode !== undefined) { this.setDebugMode(typed.debugMode); } this.logger?.log("debug.webview.request", { attached: Boolean(typed.debugAttached), busy: Boolean(typed.debugBusy), runtimeReady: Boolean(typed.runtimeReady), state: String(typed.debugState || "") });
      await this.debugShell();
      return;
    }
    if (typed.type === "stopDebugShell") {
      this.logger?.log("debug.webview.stop", { attached: Boolean(typed.debugAttached), busy: Boolean(typed.debugBusy), runtimeReady: Boolean(typed.runtimeReady), state: String(typed.debugState || "") });
      await this.stopDebugShell();
      return;
    }
    if (typed.type === "debugControl" && isDebugControlAction(typed.action)) {
      await this.controlDebugger(typed.action);
      return;
    }
    if (typed.type === "overlayToggleBreakpoint") { this.logger?.log("overlay.webview.toggleBreakpoint", { column: Number(typed.column) || 0, inline: Boolean(typed.inline), inputStartLine: Number(typed.inputStartLine) || 0, line: Number(typed.line) || 0, rawColumn: Number(typed.rawColumn) || 0, rawLine: Number(typed.rawLine) || 0, source: String(typed.source || "") }); await (await this.ensureOverlay()).toggleBreakpointFromVisibleLine(typed.line, typed.column, Boolean(typed.inline)); this.refreshBreakpointUi(); return; }
    if (typed.type === "runPython" && typeof typed.code === "string") {
      const lineOffset = typeof typed.lineOffset === "number" && Number.isInteger(typed.lineOffset) ? this.defaultExecutionLineOffset() + Math.max(0, typed.lineOffset) : undefined;
      if (typeof typed.text === "string") { await this.overlay?.syncVisibleText(typed.text); }
      await this.executePython(typed.code, lineOffset);
      return;
    }
  }

  /** Executes Python through the attached backend and posts a textual result. */
  private async executePython(code: string, lineOffset = this.defaultExecutionLineOffset(), filename = this.executionFilename()): Promise<boolean> {
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
    const sourceText = await this.executionSourceText(filename);
    const activeBreakpointLocations = this.debugBreakpointSourceLocations(filename);
    const activeBreakpointLines = [...new Set(activeBreakpointLocations.map((breakpoint) => breakpoint.line))].sort((left, right) => left - right);
    const hasDebugSession = Boolean(this.overlayDebugSession || this.debugSession);
    const breakpointLines = hasDebugSession || activeBreakpointLines.length ? activeBreakpointLines : undefined;
    this.logger?.log("python.execute.debug", { breakpoints: breakpointLines?.length ?? 0, debugSession: hasDebugSession, filename, lineOffset });
    if (hasDebugSession) { await this.syncActiveDebugBreakpoints("execute", sourceText); }
    const result = await this.executeBackendPython(backend, code, filename, lineOffset, sourceText, breakpointLines);
    this.stopPythonProgress(execution);
    if (this.activePythonExecution === execution) {
      this.activePythonExecution = undefined;
    }
    this.clearInspectionCache();
    const text = executionText(result);
    this.lastPythonResult = { code, execution, ok: result.ok, text };
    this.post({ code, execution, ok: result.ok, text, type: "pythonResult" });
    void this.overlay?.postOutput(text, result.ok);
    if (this.overlayDebugSession) { this.debugThreadId = undefined; this.postDebugStatus("attached", result.ok ? "complete" : "stopped"); this.postDebugInfo({ focusVariables: [], scopes: [], state: "attached" }); }
    this.postTransport();
    this.scheduleRuntimeRefresh();
    void closeWorkspaceGeneratedOverlayTabs().catch(() => undefined);
    return true;
  }

  /** Executes backend Python and converts transport failures into a rendered shell error. */
  private async executeBackendPython(backend: BackendClient, code: string, filename?: string, lineOffset?: number, sourceText?: string, breakpointLines?: number[]): Promise<BackendExecutionResult> {
    try {
      return await backend.execute(code, filename, lineOffset, sourceText, breakpointLines);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.log("python.execute.error", { chars: code.length, error: message, lines: lineCount(code) });
      return { ok: false, stderr: message, stdout: "" };
    }
  }

  /** Returns the generated overlay source snapshot for debugpy linecache binding. */
  private async executionSourceText(filename?: string): Promise<string | undefined> {
    if (filename === debugFileUri().fsPath) { return readDebugFileText().catch(() => undefined); }
    if (!filename || filename !== this.executionFilename() || !this.overlay) { return undefined; }
    return this.overlay.currentSourceText().catch((error: unknown) => {
      this.logger?.log("python.execute.sourceText.error", { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    });
  }

  /** Starts debugpy inside the attached backend and returns its endpoint marker. */
  private async startDebugpy(backend: BackendClient, port: number, host = "127.0.0.1"): Promise<ReturnType<typeof parseDebugpyBootstrapResult>> {
    const code = buildDebugpyBootstrapCode(host, port, DEBUGPY_MARKER_PREFIX, this.debugpySearchPaths());
    const result = await this.executeBackendPython(backend, code);
    const parsed = parseDebugpyBootstrapResult(executionText(result));
    if (parsed.ok) { return parsed; }
    const text = executionText(result);
    return { error: parsed.error ? `${parsed.error}\n${text}` : text, ok: false };
  }

  /** Starts debugpy but releases the debugger UI if the backend request stalls. */
  private startDebugpyWithTimeout(backend: BackendClient, port: number, host = "127.0.0.1"): Promise<DebugpyBootstrapResult> {
    return Promise.race([this.startDebugpy(backend, port, host), new Promise<DebugpyBootstrapResult>((resolve) => setTimeout(() => resolve({ error: `debugpy bootstrap timed out after ${DEBUG_ATTACH_TIMEOUT_MS}ms.`, ok: false }), DEBUG_ATTACH_TIMEOUT_MS))]);
  }

  /** Returns bundled debugpy import roots from the Python Debugger extension when it is installed. */
  private debugpySearchPaths(): string[] {
    const debugpyExtension = vscode.extensions.getExtension("ms-python.debugpy");
    return debugpyExtension ? [path.join(debugpyExtension.extensionPath, "bundled", "libs")] : [];
  }

  /** Returns the filename passed to Python compile() so editor breakpoints bind to the overlay file. */
  private executionFilename(): string { return overlayEditorUri().fsPath; }

  /** Returns the source URI currently controlled by debugger breakpoint synchronization. */
  private debugSourceUri(): vscode.Uri { return this.debugMode === "file" ? debugFileUri() : overlayEditorUri(); }

  /** Returns the default line offset for a full visible console-cell.py execution. */
  private defaultExecutionLineOffset(): number { return 0; }

  /** Refreshes breakpoint count in the webview and visible markers in the overlay editor. */
  private refreshBreakpointUi(): void {
    const locations = this.overlayBreakpointSourceLocations();
    const lines = [...new Set(locations.map((breakpoint) => breakpoint.line))].sort((left, right) => left - right);
    this.breakpointCount = locations.length;
    this.post({ count: this.breakpointCount, lines, locations, type: "breakpoints" });
    void this.overlay?.updateBreakpoints(locations);
  }

  /** Returns one-based enabled breakpoint locations for the generated console-cell.py file. */
  private overlayBreakpointSourceLocations(): DebugBreakpointLocation[] { return sourceBreakpointLocations(overlayEditorUri(), this.defaultExecutionLineOffset()); }

  /** Returns one-based enabled breakpoint locations for the active debug source file. */
  private debugBreakpointSourceLocations(filename = this.debugSourceUri().fsPath): DebugBreakpointLocation[] { return sourceBreakpointLocations(vscode.Uri.file(filename), this.defaultExecutionLineOffset()); }

  /** Synchronizes generated overlay source breakpoints into the active debug adapter session. */
  private async syncActiveDebugBreakpoints(reason: string, sourceText?: string, session = this.overlayDebugSession ?? this.debugSession): Promise<void> { const uri = this.debugSourceUri(), snapshot = sourceText ?? await this.executionSourceText(uri.fsPath); const breakpoints = this.debugBreakpointSourceLocations(uri.fsPath); await syncDebugBreakpoints({ breakpoints, lineOffset: this.defaultExecutionLineOffset(), lines: breakpoints.map((breakpoint) => breakpoint.line), logger: this.logger, reason, session, sourceText: snapshot, uri }); }

  /** Stops the active Django Shell debugger session when one is attached. */
  private async stopDebugShell(): Promise<void> {
    if (this.overlayDebugSession) { const session = this.overlayDebugSession; this.overlayDebugSession = undefined; this.debugpyEndpoint = undefined; await this.session?.backend?.interrupt("debugWebview.stop"); await session.disconnect(); this.debugThreadId = undefined; this.postDebugStatus("idle", "stopped"); this.postDebugInfo({ focusVariables: [], scopes: [], state: "idle" }); return; }
    if (!this.debugSession) {
      this.postDebugStatus("idle");
      return;
    }
    await this.session?.backend?.interrupt("debugWebview.stop");
    await vscode.debug.stopDebugging(this.debugSession);
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
      if (wasVisible || (this.debugMode === "overlay" && (this.debugSession || this.overlayDebugSession))) { return; }
      this.post({ show: this.runtimeReady, type: "measureEditor" });
      if (this.runtimeReady) { void this.updateOverlayPrelude(this.runtimeGeneration); }
      return;
    }
    if (!(this.debugMode === "overlay" && (this.debugSession || this.overlayDebugSession))) { this.overlay?.hide(); }
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
    this.runtimeReady = false; this.runtimeGeneration += 1; this.debugpyEndpoint = undefined;
    this.clearPreludeRetryTimer();
    this.preludeRetryAttempt = 0;
    this.executionCount = 1; this.lastPythonResult = undefined;
    this.clearInspectionCache();
    this.clearRuntimeRefreshTimer();
    this.stopAllPythonProgress();
    this.post({ type: "resetPythonCell" });
    this.resetOverlayTabs();
    this.overlayPrelude = [];
    if (this.overlay) {
      await this.overlay.reset();
    } else {
      await this.resetOverlayBackingFiles();
    }
    this.session?.restart();
    this.runtimeEmitter.fire();
    this.postDebugStatus("idle");
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

  /** Stores the selected debugger display mode and mirrors it back to the webview. */
  private setDebugMode(mode: unknown): void { this.debugMode = normalizeDebugMode(mode); this.logger?.log("debug.mode", { mode: this.debugMode }); this.postDebugMode(); }

  /** Posts the selected debugger display mode to the custom console webview. */
  private postDebugMode(): void { this.post({ mode: this.debugMode, type: "debugMode" }); }

  /** Posts debugger attach state to the custom console webview. */
  private postDebugStatus(state: "attached" | "error" | "idle" | "paused" | "running" | "starting", detail = ""): void {
    this.post({ detail, state, type: "debugStatus" });
  }

  /** Posts paused debugger frame details and mirrors the current line into the overlay editor. */
  private postDebugInfo(info: DebugFrameInfo): void {
    this.post({ info, type: "debugInfo" });
    void this.overlay?.updateDebugFrame(info.frame);
    if (info.state === "paused") {
      const path = info.frame?.path?.replace(/\\/g, "/") ?? ""; this.lastDebugFrameOverlay = path === "console-cell.py" || path.endsWith("/.django-shell/console-cell.py");
      void closeWorkspaceGeneratedOverlayTabs(this.debugMode === "overlay").catch(() => undefined);
    }
  }

  /** Handles stopped events from the direct overlay DAP client without touching VS Code's debug UI. */
  private handleDirectDebugStopped(session: DirectDebugAdapterSession, threadId: number | undefined, reason: string): void { if (session !== this.overlayDebugSession) { return; } this.debugThreadId = threadId; this.logger?.log("debug.direct.stopped", { reason, threadId: threadId ?? 0 }); this.postDebugStatus("paused", reason || "stopped"); void inspectDebugThread(session, threadId, { preferOverlay: true }).then((info) => { this.logger?.log("debug.direct.frame", { frameLine: info.frame?.line ?? 0, frames: info.frames?.length ?? 0, scopes: info.scopes.length, variables: info.focusVariables.length }); this.postDebugInfo(info); }).catch((error: unknown) => this.postDebugInfo({ error: error instanceof Error ? error.message : String(error), focusVariables: [], scopes: [], state: "error" })); }

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
    this.overlayDebugSession?.dispose(); this.overlayDebugSession = undefined;
    this.debugpyEndpoint = undefined;
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
    this.resetOverlayTabs();
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

/** Creates one numbered overlay tab model for the custom console. */
function createOverlayTab(index: number): OverlayTabState {
  const normalized = Math.max(1, Math.floor(index));
  return { id: `overlay-${normalized}`, label: String(normalized), text: "" };
}

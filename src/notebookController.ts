// Deprecated notebook controller retained while the custom frontend takes over.

import * as path from "path";
import * as vscode from "vscode";
import {
  BackendExecutionResult,
  BackendRuntimeEnvironment,
  BackendRuntimeChildren,
  BackendRuntimeInspection,
  BackendRuntimePathSegment
} from "./backendClient";
import { DiagnosticLogger } from "./diagnostics";
import {
  NOTEBOOK_CONTROLLER_ID,
  NOTEBOOK_RENDERER_ID,
  NOTEBOOK_TYPE,
  PRELUDE_CELL_ROLE,
  PYTHON_HISTORY_MIME,
  SETUP_CELL_ROLE,
  TERMINAL_MIME
} from "./notebookConstants";
import { notebookDjangoSettingsModule, updateNotebookDjangoSettingsModule } from "./notebookSettings";
import { NotebookPtySession, NotebookTerminalSnapshot } from "./notebookPtySession";

const REMOTE_RUNTIME_INSPECTION_DISABLED = "Remote runtime inspection is disabled because the backend is only reachable through the interactive terminal.";

/** Owns the Django shell console notebook kernel and embedded setup sessions. */
export class DjangoConsoleController implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  private readonly disposables: vscode.Disposable[] = [];
  private executionOrder = 0;
  private readonly focusedSessions = new Set<string>();
  private readonly pythonHistories = new Map<string, string[]>();
  private readonly readySessions = new Set<string>();
  private readonly rendererMessaging = vscode.notebooks.createRendererMessaging(NOTEBOOK_RENDERER_ID);
  private readonly runtimeEmitter = new vscode.EventEmitter<void>();
  private readonly setupRuns = new Map<string, { ended: boolean; execution: vscode.NotebookCellExecution; listeners: vscode.Disposable[] }>();
  private readonly sessions = new Map<string, NotebookPtySession>();

  readonly onDidChangeRuntime = this.runtimeEmitter.event;

  /** Creates the notebook controller and renderer message bridge. */
  constructor(private readonly extensionPath: string, private readonly logger?: DiagnosticLogger) {
    this.controller = vscode.notebooks.createNotebookController(
      NOTEBOOK_CONTROLLER_ID,
      NOTEBOOK_TYPE,
      "Django Shell Console"
    );
    this.controller.supportedLanguages = ["python", "shellscript"];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells) => this.executeCells(cells);
    this.disposables.push(
      this.rendererMessaging.onDidReceiveMessage((event) => this.handleRendererMessage(event.message)),
      vscode.workspace.onDidOpenNotebookDocument((notebook) => this.prepareNotebook(notebook))
    );
    for (const notebook of vscode.workspace.notebookDocuments) {
      this.prepareNotebook(notebook);
    }
  }

  /** Selects this controller for Django console notebooks and starts setup output. */
  prepareNotebook(notebook: vscode.NotebookDocument): void {
    if (notebook.notebookType !== NOTEBOOK_TYPE) {
      return;
    }
    this.controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
    const setup = notebook.getCells().find((cell) => cell.metadata?.role === SETUP_CELL_ROLE);
    if (setup && !this.sessions.has(notebook.uri.toString())) {
      void this.executeSetupCell(setup);
    }
  }

  /** Releases controller and session resources. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    for (const run of this.setupRuns.values()) {
      for (const listener of run.listeners) {
        listener.dispose();
      }
      if (!run.ended) {
        run.execution.end(undefined, Date.now());
      }
    }
    this.runtimeEmitter.dispose();
    this.controller.dispose();
  }

  /** Executes setup or Python cells according to their metadata and language. */
  async executeConsoleCell(cell: vscode.NotebookCell): Promise<void> {
    if (cell.metadata?.role === SETUP_CELL_ROLE) {
      await this.executeSetupCell(cell);
      return;
    }
    if (cell.metadata?.role === PRELUDE_CELL_ROLE) {
      return;
    }
    if (cell.document.languageId === "python") {
      await this.executePythonHistoryInput(cell, cell.document.getText());
      return;
    }
    await this.executePythonCell(cell, cell.document.getText(), false);
  }

  /** Executes shell-style Python input and refreshes the scrollable output history. */
  async executeConsoleInput(cell: vscode.NotebookCell, source: string): Promise<boolean> {
    return this.executePythonHistoryInput(cell, source);
  }

  /** Returns whether source looks complete enough to execute without a backend round trip. */
  async isConsoleInputComplete(cell: vscode.NotebookCell, source: string): Promise<boolean> {
    return !isLikelyIncompletePython(source);
  }

  /** Returns safe variable and module summaries for the active Django shell runtime. */
  async inspectActiveRuntime(): Promise<BackendRuntimeInspection> {
    const session = this.activeSession();
    if (!session?.backend) {
      return { error: "Run the setup cell and enter Django shell first.", modules: [], ok: false, variables: [] };
    }
    if (!session.backend.supportsRuntimeInspection()) {
      return { error: REMOTE_RUNTIME_INSPECTION_DISABLED, loadedModuleCount: 0, modules: [], ok: false, variables: [] };
    }
    return session.backend.inspect();
  }

  /** Returns safe runtime summaries for the Django shell session attached to a notebook. */
  async inspectRuntime(notebookUri: vscode.Uri): Promise<BackendRuntimeInspection> {
    const session = this.sessions.get(notebookUri.toString());
    if (!session?.backend) {
      return { error: "Run the setup cell and enter Django shell first.", modules: [], ok: false, variables: [] };
    }
    if (!session.backend.supportsRuntimeInspection()) {
      return { error: REMOTE_RUNTIME_INSPECTION_DISABLED, loadedModuleCount: 0, modules: [], ok: false, variables: [] };
    }
    return session.backend.inspect();
  }

  /** Returns lightweight Python and Django environment details for one attached runtime. */
  async runtimeEnvironment(notebookUri: vscode.Uri): Promise<BackendRuntimeEnvironment> {
    const session = this.sessions.get(notebookUri.toString());
    if (!session?.backend) {
      return { error: "Run the setup cell and enter Django shell first.", ok: false, path: [] };
    }
    return session.backend.environment();
  }

  /** Returns safe child summaries for one active runtime object path. */
  async inspectRuntimeChildren(path: BackendRuntimePathSegment[]): Promise<BackendRuntimeChildren> {
    const session = this.activeSession();
    if (!session?.backend) {
      return { children: [], error: "Run the setup cell and enter Django shell first.", ok: false };
    }
    if (!session.backend.supportsRuntimeInspection()) {
      return { children: [], error: REMOTE_RUNTIME_INSPECTION_DISABLED, ok: false };
    }
    return session.backend.children(path);
  }

  /** Dispatches notebook execution requests from VS Code. */
  private executeCells(cells: vscode.NotebookCell[]): void {
    for (const cell of cells) {
      void this.executeConsoleCell(cell);
    }
  }

  /** Starts an embedded PTY for the setup cell and keeps its output interactive. */
  private async executeSetupCell(cell: vscode.NotebookCell): Promise<void> {
    const execution = this.startExecution(cell);
    const key = cell.notebook.uri.toString();
    this.focusedSessions.delete(key);
    this.readySessions.delete(key);
    for (const listener of this.setupRuns.get(key)?.listeners ?? []) {
      listener.dispose();
    }
    const previous = this.setupRuns.get(key);
    if (previous && !previous.ended) {
      this.endSetupExecution(key, undefined);
    }
    this.sessions.get(key)?.dispose();
    const session = new NotebookPtySession({
      autoActivateWorkspaceVenv: this.autoActivateWorkspaceVenv(),
      backendRuntimePath: this.backendRuntimePath(),
      cwd: this.workspaceCwd(),
      diagnosticLogger: this.logger,
      djangoSettingsModule: this.selectedDjangoSettingsModule(cell.notebook),
      sessionId: key,
      settingsCandidates: []
    });
    this.sessions.set(key, session);
    const dataListener = session.onDidData((data) => {
      void this.rendererMessaging.postMessage({ data, sessionId: key, type: "terminalData" });
    });
    const statusListener = session.onDidChange((snapshot) => {
      void this.rendererMessaging.postMessage({ sessionId: key, snapshot, type: "terminalStatus" });
      if ((snapshot.ready || snapshot.mode === "django") && !this.focusedSessions.has(key)) {
        this.focusedSessions.add(key);
        void vscode.commands.executeCommand("djangoShell.focusInput", key);
      }
      if (snapshot.ready && !this.readySessions.has(key)) {
        this.readySessions.add(key);
        this.runtimeEmitter.fire();
        const run = this.setupRuns.get(key);
        if (run) {
          run.ended = true;
        }
        return;
      }
      if (snapshot.state === "failed" || snapshot.state === "closed") {
        dataListener.dispose();
        statusListener.dispose();
        this.setupRuns.delete(key);
      }
    });
    this.setupRuns.set(key, { ended: false, execution, listeners: [dataListener, statusListener] });
    execution.token.onCancellationRequested(() => {
      session.dispose();
      dataListener.dispose();
      statusListener.dispose();
      this.endSetupExecution(key, false);
      this.setupRuns.delete(key);
    });
    await this.renderSetupOutput(key, execution, session);
  }

  /** Executes a Python notebook cell through the attached Django backend. */
  private async executePythonCell(cell: vscode.NotebookCell, source: string, append: boolean): Promise<boolean> {
    const execution = this.startExecution(cell);
    const session = this.sessions.get(cell.notebook.uri.toString());
    try {
      if (!session?.backend) {
        await this.writePythonOutput(execution, textOutput("Run the setup cell and enter Django shell first."), append);
        execution.end(false, Date.now());
        return false;
      }
      const result = await session.backend.execute(source);
      await this.writePythonOutput(execution, resultOutput(result, append ? source : undefined), append);
      this.runtimeEmitter.fire();
      execution.end(result.ok, Date.now());
      return true;
    } catch (error) {
      await this.writePythonOutput(execution, textOutput(append ? transcriptText(source, String(error)) : String(error)), append);
      this.runtimeEmitter.fire();
      execution.end(false, Date.now());
      return true;
    }
  }

  /** Executes Python input and renders the full shell transcript in one scrollable output. */
  private async executePythonHistoryInput(cell: vscode.NotebookCell, source: string): Promise<boolean> {
    const execution = this.startExecution(cell);
    const session = this.sessions.get(cell.notebook.uri.toString());
    try {
      if (!session?.backend) {
        await execution.replaceOutput(textOutput("Run the setup cell and enter Django shell first."));
        execution.end(false, Date.now());
        return false;
      }
      const result = await session.backend.execute(source);
      const history = this.appendPythonHistory(cell, transcriptText(source, resultTextOutput(result)));
      await execution.replaceOutput(pythonHistoryOutput(history));
      this.runtimeEmitter.fire();
      execution.end(result.ok, Date.now());
      return true;
    } catch (error) {
      const history = this.appendPythonHistory(cell, transcriptText(source, String(error)));
      await execution.replaceOutput(pythonHistoryOutput(history));
      this.runtimeEmitter.fire();
      execution.end(false, Date.now());
      return true;
    }
  }

  /** Appends or replaces Python output according to the active execution style. */
  private async writePythonOutput(
    execution: vscode.NotebookCellExecution,
    output: vscode.NotebookCellOutput[],
    append: boolean
  ): Promise<void> {
    if (append) {
      await execution.appendOutput(output);
      return;
    }
    await execution.replaceOutput(output);
  }

  /** Appends one shell transcript entry and returns the full display history. */
  private appendPythonHistory(cell: vscode.NotebookCell, entry: string): string {
    const key = this.pythonHistoryKey(cell);
    const entries = [...(this.pythonHistories.get(key) ?? []), entry];
    this.pythonHistories.set(key, entries);
    return entries.join("\n\n");
  }

  /** Builds a stable per-cell key for shell transcript storage. */
  private pythonHistoryKey(cell: vscode.NotebookCell): string {
    return cell.document.uri.toString();
  }

  /** Starts a VS Code notebook cell execution with monotonically increasing order. */
  private startExecution(cell: vscode.NotebookCell): vscode.NotebookCellExecution {
    const existing = this.setupRuns.get(cell.notebook.uri.toString());
    if (cell.metadata?.role === SETUP_CELL_ROLE && existing && !existing.ended) {
      return existing.execution;
    }
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());
    return execution;
  }

  /** Renders the setup terminal output and ends the transient notebook execution. */
  private async renderSetupOutput(
    key: string,
    execution: vscode.NotebookCellExecution,
    session: NotebookPtySession
  ): Promise<void> {
    try {
      await execution.replaceOutput(terminalOutput(session.snapshot()));
      this.endSetupExecution(key, true);
    } catch {
      this.endSetupExecution(key, false);
    }
  }

  /** Ends a setup cell execution once without stopping the terminal session. */
  private endSetupExecution(key: string, success: boolean | undefined): void {
    const run = this.setupRuns.get(key);
    if (!run || run.ended) {
      return;
    }
    run.ended = true;
    run.execution.end(success, Date.now());
  }

  /** Sends renderer terminal input into the matching setup PTY. */
  private handleRendererMessage(message: unknown): void {
    const typed = message as { cols?: number; data?: string; rows?: number; sessionId?: string; type?: string; value?: string };
    if (!typed.sessionId) {
      return;
    }
    if (typed.type === "terminalReady") {
      const session = this.sessions.get(typed.sessionId);
      session?.start();
      void this.rendererMessaging.postMessage({
        sessionId: typed.sessionId,
        snapshot: session?.snapshot(),
        type: "terminalStatus"
      });
    }
    if (typed.type === "terminalInput" && typeof typed.data === "string") {
      this.sessions.get(typed.sessionId)?.write(typed.data);
    }
    if (typed.type === "terminalResize" && typed.cols && typed.rows) {
      this.sessions.get(typed.sessionId)?.resize(typed.cols, typed.rows);
    }
    if (typed.type === "settingsSelect" && typeof typed.value === "string") {
      void this.updateDjangoSettingsSelection(typed.sessionId, typed.value);
    }
  }

  /** Stores a notebook-selected settings module and updates the rendered setup state. */
  private async updateDjangoSettingsSelection(sessionId: string, value: string): Promise<void> {
    await updateNotebookDjangoSettingsModule(vscode.Uri.parse(sessionId), value);
    const session = this.sessions.get(sessionId);
    session?.setDjangoSettingsModule(value || undefined);
    if (session) {
      this.focusedSessions.delete(sessionId);
      this.readySessions.delete(sessionId);
      session.restart();
    }
    this.logger?.log("settings.selected", { selected: value || "auto", source: "notebook" });
    void this.rendererMessaging.postMessage({ sessionId, snapshot: session?.snapshot(), type: "terminalStatus" });
  }

  /** Returns the current workspace root for launching setup shells. */
  private workspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  /** Returns whether conventional workspace virtualenvs should be activated. */
  private autoActivateWorkspaceVenv(): boolean {
    return vscode.workspace.getConfiguration("djangoShell").get<boolean>("autoActivateWorkspaceVenv", true);
  }

  /** Returns the user-selected Django settings module for new setup terminals. */
  private selectedDjangoSettingsModule(notebook: vscode.NotebookDocument): string | undefined {
    return notebookDjangoSettingsModule(notebook);
  }

  /** Returns the Python backend file loaded into detected Django shells. */
  private backendRuntimePath(): string {
    return path.join(this.extensionPath, "python", "django_shell_backend.py");
  }

  /** Returns the runtime session that matches the visible or active console. */
  private activeSession(): NotebookPtySession | undefined {
    const active = vscode.window.activeNotebookEditor;
    if (active?.notebook.notebookType === NOTEBOOK_TYPE) {
      return this.sessions.get(active.notebook.uri.toString());
    }
    const visible = vscode.window.visibleNotebookEditors.find((editor) => editor.notebook.notebookType === NOTEBOOK_TYPE);
    if (visible) {
      return this.sessions.get(visible.notebook.uri.toString());
    }
    return this.sessions.values().next().value;
  }
}

/** Builds a custom renderer output for the embedded setup terminal. */
function terminalOutput(snapshot: NotebookTerminalSnapshot): vscode.NotebookCellOutput[] {
  return [new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.json(snapshot, TERMINAL_MIME)])];
}

/** Builds a plain text notebook output. */
function textOutput(text: string): vscode.NotebookCellOutput[] {
  return [new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(text)])];
}

/** Builds a custom renderer output for scrollable Python shell history. */
function pythonHistoryOutput(text: string): vscode.NotebookCellOutput[] {
  return [new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.json({ text }, PYTHON_HISTORY_MIME)])];
}

/** Converts a backend execution result into notebook output. */
function resultOutput(result: BackendExecutionResult, source?: string): vscode.NotebookCellOutput[] {
  const resultText = resultTextOutput(result);
  return textOutput(source ? transcriptText(source, resultText) : resultText);
}

/** Converts captured backend streams into display text. */
function resultTextOutput(result: BackendExecutionResult): string {
  const text = [
    result.stdout.trimEnd(),
    result.result,
    result.stderr.trimEnd(),
    result.traceback?.trimEnd()
  ].filter(Boolean).join("\n");
  return text || "ok";
}

/** Formats one submitted Python input and its result as shell-like history. */
function transcriptText(source: string, resultText: string): string {
  return [promptText(source), resultText].filter(Boolean).join("\n");
}

/** Formats submitted Python source with REPL-style prompts. */
function promptText(source: string): string {
  return source.split(/\r?\n/).map((line, index) => `${index === 0 ? ">>>" : "..."} ${line}`).join("\n");
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

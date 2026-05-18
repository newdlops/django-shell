// Deprecated Python shadow sync for notebook cells retained for compatibility.

import * as vscode from "vscode";
import { DiagnosticLogger } from "./diagnostics";
import { discoverDjangoPrelude } from "./djangoProject";
import { deleteOldShadowArtifacts, openSyncedShadowDocument, writeShadowFile } from "./filePythonShadow";
import { NOTEBOOK_TYPE, PRELUDE_CELL_ROLE, SETUP_CELL_ROLE } from "./notebookConstants";
import { notebookDjangoSettingsModule } from "./notebookSettings";

export interface PythonShadowDocument {
  document: vscode.TextDocument;
  lineOffset: number;
}

interface PythonPrelude {
  lineOffset: number;
  moduleBytes: number;
  moduleChanged: boolean;
  modulePath: string | undefined;
  text: string;
}

const INPUT_MARKER = "# Django shell input starts below.";

/** Keeps Python analysis shadow documents in sync with Django shell notebook inputs. */
export class PythonShadowDocuments implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly preludeCache = new Map<string, Promise<PythonPrelude>>();
  private readonly shadowTextCache = new Map<string, string>();
  private readonly shadowWriteLocks = new Map<string, Promise<void>>();

  /** Creates the shadow synchronizer with per-workspace prelude caches. */
  constructor(private readonly logger?: DiagnosticLogger) {}

  /** Registers cache invalidation and cleanup without starting source analysis work. */
  activate(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("djangoShell")) {
          this.clearCaches();
          void deleteOldShadowArtifacts(true);
        }
      })
    );
    context.subscriptions.push(this);
    void deleteOldShadowArtifacts(true);
  }

  /** Clears cached shadow content and workspace discovery results. */
  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.clearCaches();
  }

  /** Clears cached shadow text and source prelude data. */
  private clearCaches(): void {
    this.preludeCache.clear();
    this.shadowTextCache.clear();
  }

  /** Returns a lazily synchronized Python analysis document for one notebook cell document. */
  async shadowDocument(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken,
    log = true
  ): Promise<PythonShadowDocument | undefined> {
    const cell = djangoPythonCell(document);
    if (!cell || token?.isCancellationRequested) {
      return undefined;
    }
    const result = await this.writeCellShadow(cell, true, log);
    return token?.isCancellationRequested ? undefined : result;
  }

  /** Synchronizes one notebook input cell to a file-backed Python document when needed. */
  async syncCell(cell: vscode.NotebookCell, log = true): Promise<void> {
    if (isPythonInputCell(cell)) {
      await this.writeCellShadow(cell, false, log);
    }
  }

  /** Writes one notebook input cell to its workspace Python backing file. */
  private async writeCellShadow(cell: vscode.NotebookCell, openDocument: true, log: boolean): Promise<PythonShadowDocument>;
  private async writeCellShadow(cell: vscode.NotebookCell, openDocument: false, log: boolean): Promise<undefined>;
  private async writeCellShadow(
    cell: vscode.NotebookCell,
    openDocument: boolean,
    log: boolean
  ): Promise<PythonShadowDocument | undefined> {
    const started = Date.now();
    const prelude = await this.preludeText(cell);
    const text = shadowText(prelude.text, cell.document.getText());
    const uri = await this.fileShadowUri(cell);
    return this.withShadowWriteLock(uri, async () => {
      const writeStarted = Date.now();
      const writeResult = await writeShadowFile(uri, text, this.shadowTextCache);
      const writeMs = Date.now() - writeStarted;
      const openStarted = openDocument ? Date.now() : undefined;
      const shadow = openDocument ? await openSyncedShadowDocument(uri, text) : undefined;
      const openMs = openStarted ? Date.now() - openStarted : undefined;
      if (log) {
        this.logger?.log("editor.shadow", {
          cell: cell.document.uri.toString(),
          lineOffset: prelude.lineOffset,
          mode: "file",
          moduleBytes: prelude.moduleBytes,
          moduleChanged: prelude.moduleChanged,
          modulePath: prelude.modulePath,
          ms: Date.now() - started,
          openMs,
          shadow: uri.fsPath,
          shadowChanged: writeResult.changed,
          shadowCacheHit: writeResult.skippedByCache,
          sourceLines: cell.document.lineCount,
          textBytes: Buffer.byteLength(text, "utf8"),
          workspace: workspaceRoot(cell).fsPath,
          writeMs
        });
      }
      return openDocument && shadow ? { document: shadow, lineOffset: prelude.lineOffset } : undefined;
    });
  }

  /** Returns the workspace-local file URI used by the Python bridge. */
  private async fileShadowUri(cell: vscode.NotebookCell): Promise<vscode.Uri> {
    return shadowUri(cell);
  }

  /** Serializes writes for one shadow file so concurrent provider requests coalesce through the cache. */
  private async withShadowWriteLock<T>(uri: vscode.Uri, task: () => Promise<T>): Promise<T> {
    const key = uri.toString();
    const previous = this.shadowWriteLocks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    this.shadowWriteLocks.set(key, next);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.shadowWriteLocks.get(key) === next) {
        this.shadowWriteLocks.delete(key);
      }
    }
  }

  /** Builds hidden import statements from workspace Django discovery for static analyzers. */
  private preludeText(cell: vscode.NotebookCell): Promise<PythonPrelude> {
    const key = preludeCacheKey(cell);
    const cached = this.preludeCache.get(key);
    if (cached) {
      return cached;
    }
    const promise = this.loadPreludeText(cell);
    this.preludeCache.set(key, promise);
    return promise;
  }

  /** Loads source-only imports without querying the attached runtime backend. */
  private async loadPreludeText(cell: vscode.NotebookCell): Promise<PythonPrelude> {
    try {
      const started = Date.now();
      const selectedSettings = selectedDjangoSettingsModule(cell);
      const discovery = await discoverDjangoPrelude(workspaceRoot(cell).fsPath, {
        includeModelImports: modelPreludeImportsEnabled(),
        includeSettingsCandidates: false,
        settingsModule: selectedSettings
      });
      this.logPrelude(cell, discovery, Date.now() - started, selectedSettings);
      const imports = uniquePreludeImports(discovery.imports);
      if (!imports.length) {
        return emptyPrelude();
      }
      const text = inlinePreludeText(imports);
      return {
        lineOffset: lineOffsetForText(text),
        moduleBytes: 0,
        moduleChanged: false,
        modulePath: undefined,
        text
      };
    } catch {
      return emptyPrelude();
    }
  }

  /** Writes one combined runtime and source-analysis diagnostic for the hidden prelude. */
  private logPrelude(
    cell: vscode.NotebookCell,
    discovery: Awaited<ReturnType<typeof discoverDjangoPrelude>>,
    totalMs: number,
    selectedSettings: string | undefined
  ): void {
    const pythonConfig = vscode.workspace.getConfiguration("python", cell.notebook.uri);
    const extraPaths = pythonConfig.get<string[]>("analysis.extraPaths", []);
    this.logger?.log("editor.prelude", {
      imports: discovery.imports.length,
      managePy: discovery.managePy,
      modelFiles: discovery.diagnostics.modelFiles,
      modelImports: discovery.diagnostics.modelImports,
      modelScanMs: discovery.diagnostics.modelScanMs,
      settingsImportFiles: discovery.diagnostics.settingsImportFiles,
      settingsImportMs: discovery.diagnostics.settingsImportMs,
      settingsImports: discovery.diagnostics.settingsImports,
      pythonDefaultInterpreter: pythonConfig.get<string>("defaultInterpreterPath"),
      pythonExtraPathHead: extraPaths[0],
      pythonExtraPaths: extraPaths.length,
      selectedSettingsModule: selectedSettings,
      settingsCandidates: discovery.settingsCandidates.length,
      settingsMs: discovery.diagnostics.settingsMs,
      settingsMismatch: false,
      settingsModule: discovery.settingsModule,
      sourceRoot: discovery.sourceRoot,
      sourceMs: discovery.diagnostics.durationMs,
      totalMs,
      virtualEnv: discovery.virtualEnv,
      workspace: workspaceRoot(cell).fsPath
    });
  }
}

/** Returns the editable Django shell Python cell for a text document. */
function djangoPythonCell(document: vscode.TextDocument): vscode.NotebookCell | undefined {
  if (document.uri.scheme !== "vscode-notebook-cell" || document.languageId !== "python") {
    return undefined;
  }
  for (const notebook of vscode.workspace.notebookDocuments) {
    if (notebook.notebookType !== NOTEBOOK_TYPE) {
      continue;
    }
    const cell = notebook.getCells().find((candidate) => candidate.document.uri.toString() === document.uri.toString());
    if (cell && isPythonInputCell(cell)) {
      return cell;
    }
  }
  return undefined;
}

/** Returns true for notebook cells that should be mirrored as Python input. */
function isPythonInputCell(cell: vscode.NotebookCell): boolean {
  return cell.document.languageId === "python" && ![PRELUDE_CELL_ROLE, SETUP_CELL_ROLE].includes(cell.metadata?.role);
}

/** Returns an empty hidden prelude result when discovery fails or finds no imports. */
function emptyPrelude(): PythonPrelude {
  return { lineOffset: 0, moduleBytes: 0, moduleChanged: false, modulePath: undefined, text: "" };
}

/** Builds an in-cell prelude so Python extensions only analyze one generated file. */
function inlinePreludeText(imports: string[]): string {
  const lines = ["# Django workspace imports for editor analysis.\n# ruff: noqa\n# flake8: noqa\n# isort: skip_file\n# pyright: reportUnusedImport=false, reportWildcardImportFromLibrary=false, reportUndefinedVariable=false", ...imports, "", INPUT_MARKER, ""];
  return lines.join("\n");
}

/** Removes duplicate prelude imports while preserving discovery order. */
function uniquePreludeImports(sourceImports: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const line of sourceImports) {
    if (line && !seen.has(line)) {
      merged.push(line);
      seen.add(line);
    }
  }
  return merged;
}

/** Counts how many source lines the hidden prelude adds before user code. */
function lineOffsetForText(text: string): number {
  return text.split("\n").length - 1;
}

/** Combines hidden editor-analysis imports and visible user source text. */
function shadowText(prelude: string, source: string): string {
  return prelude ? `${prelude}${source}` : source;
}

/** Returns the Django settings module selected in notebook metadata. */
function selectedDjangoSettingsModule(cell: vscode.NotebookCell): string | undefined {
  return notebookDjangoSettingsModule(cell.notebook);
}

/** Returns a cache key for static prelude discovery in one notebook workspace. */
function preludeCacheKey(cell: vscode.NotebookCell): string {
  return `${workspaceRoot(cell).toString()}:${selectedDjangoSettingsModule(cell) ?? ""}`;
}

/** Returns whether cold-start prelude generation should scan and import all model classes. */
function modelPreludeImportsEnabled(): boolean {
  return vscode.workspace.getConfiguration("djangoShell").get<boolean>("enableModelPreludeImports", false);
}

/** Returns the workspace-local Python shadow URI for one notebook cell. */
async function shadowUri(cell: vscode.NotebookCell): Promise<vscode.Uri> {
  return vscode.Uri.joinPath(workspaceShadowRoot(cell), `django_shell_console_cell_${cell.index}.py`);
}

/** Returns the ignored workspace directory that stores generated analysis files. */
function workspaceShadowRoot(cell: vscode.NotebookCell): vscode.Uri {
  return vscode.Uri.joinPath(workspaceRoot(cell), ".django-shell");
}

/** Returns the workspace folder that owns a notebook cell. */
function workspaceRoot(cell: vscode.NotebookCell): vscode.Uri {
  return vscode.workspace.getWorkspaceFolder(cell.notebook.uri)?.uri
    ?? vscode.workspace.workspaceFolders?.[0]?.uri
    ?? vscode.Uri.file(process.cwd());
}

// File-backed Python document identity for the Django shell overlay editor.

import * as vscode from "vscode";
import * as path from "path";
import { DiagnosticLogger } from "./diagnostics";
import { ensureIgnoredShadowDirectory } from "./filePythonShadow";

export const INPUT_MARKER = "# --- django shell input ---";

/** Captures user-relative text and focus after removing a legacy generated prefix. */
interface OverlayUserSnapshot {
  focusLine: number | undefined;
  text: string;
}

/** Maintains a Python TextDocument whose edits stay in memory after creation. */
export class OverlayMemoryDocument implements vscode.Disposable {
  private analysisDirty = false;
  private editorDirty = false;
  private installedAnalysisText: string | undefined;
  private prelude = "";
  private text = "";
  private writeQueue: Promise<void> = Promise.resolve();
  readonly analysisUri: vscode.Uri;
  readonly editorUri: vscode.Uri;

  /** Stores the logger and resolves backing-file URIs (default base names match the console overlay). */
  constructor(private readonly logger?: DiagnosticLogger, editorName = "console-cell", analysisName = "analysis") {
    this.editorUri = overlayFileUri(editorName);
    this.analysisUri = overlayFileUri(analysisName);
  }

  /** Opens the file document so file-only language extensions can attach to it. */
  activate(): void {
    void this.enqueueWrite(async () => { await Promise.all([this.writeEditor(), this.writeAnalysis()]); });
  }

  /** Returns the user-visible editor-to-analysis line delta. */
  lineOffset(): number {
    return preludeLineCount(this.prelude);
  }

  /** Returns the one-based first user-editable source line in console-cell.py. */
  inputStartLine(): number {
    return 1;
  }

  /** Returns the editor backing text used for debugpy source binding. */
  fullText(): string {
    return this.editorText();
  }

  /** Returns the user-visible source text written to console-cell.py. */
  editorText(): string {
    return this.text;
  }

  /** Returns only user-visible Python cell text for the overlay model. */
  visibleText(): string {
    return this.text;
  }

  /** Returns runtime declarations plus the complete visible source used by workspace language analysis. */
  analysisText(): string {
    return analysisText(this.prelude, this.text);
  }

  /** Returns generated runtime import text kept out of the analysis file. */
  preludeText(): string {
    return this.prelude;
  }

  /** Synchronizes editor text into the in-memory TextDocument. */
  async sync(text: string, focusLine?: number): Promise<void> {
    const snapshot = extractUserSnapshot(text, this.prelude, focusLine);
    const userText = snapshot.text;
    const previousAnalysis = this.analysisText();
    const changed = userText !== this.text;
    const nextFocus = snapshot.focusLine;
    if (changed) { this.text = userText; }
    this.logger?.log("overlay.memory.sync", { ...textFields(userText), changed, focusLine: nextFocus ?? -1, fullLines: textFields(text).lines });
    const needsAnalysis = previousAnalysis !== this.analysisText() || this.analysisDirty;
    const needsEditor = changed || this.editorDirty;
    if (!needsAnalysis && !needsEditor) {
      return;
    }
    await this.enqueueWrite(async () => { await Promise.all([needsEditor ? this.writeEditor() : undefined, needsAnalysis ? this.writeAnalysis() : undefined].filter((item): item is Promise<void> => !!item)); });
  }

  /** Records live typing without touching generated files before execution. */
  async syncVolatile(text: string): Promise<void> {
    const userText = extractUserText(text, this.prelude);
    const changed = userText !== this.text;
    this.logger?.log("overlay.memory.syncVolatile", { ...textFields(userText), changed, fullLines: textFields(text).lines });
    if (!changed) {
      return;
    }
    this.text = userText;
    this.editorDirty = true;
    this.analysisDirty = true;
  }

  /** Synchronizes only the hidden analysis document in memory for latency-sensitive providers. */
  async syncAnalysis(text: string, focusLine?: number): Promise<void> {
    const snapshot = extractUserSnapshot(text, this.prelude, focusLine);
    const userText = snapshot.text;
    const previousAnalysis = this.analysisText();
    const changed = userText !== this.text;
    if (changed) {
      this.text = userText;
      this.editorDirty = true;
    }
    const nextFocus = snapshot.focusLine;
    this.logger?.log("overlay.memory.syncAnalysis", { ...textFields(userText), changed, focusLine: nextFocus ?? -1, fullLines: textFields(text).lines });
    const needsAnalysis = previousAnalysis !== this.analysisText() || this.analysisDirty;
    if (!needsAnalysis) { return; }
    await this.enqueueWrite(async () => { await this.writeAnalysis(); });
  }

  /** Keeps one exact analysis snapshot installed until its language provider completes. */
  async withAnalysisSnapshot<T>(text: string, focusLine: number | undefined, request: () => PromiseLike<T>): Promise<T> {
    const snapshotPrelude = this.prelude;
    const snapshot = extractUserSnapshot(text, snapshotPrelude, focusLine);
    const changed = snapshot.text !== this.text;
    if (changed) {
      this.text = snapshot.text;
      this.editorDirty = true;
    }
    const analysisSnapshot = analysisText(snapshotPrelude, snapshot.text);
    this.logger?.log("overlay.memory.lease", { ...textFields(snapshot.text), changed, focusLine: snapshot.focusLine ?? -1, fullLines: textFields(text).lines });
    return this.enqueueWrite(async () => {
      await this.writeAnalysisText(analysisSnapshot);
      return await request();
    });
  }

  /** Installs a provider-only analysis snapshot and restores the latest canonical source afterward. */
  async withTransientAnalysisSnapshot<T>(text: string, focusLine: number | undefined, request: () => PromiseLike<T>): Promise<T> {
    const snapshotPrelude = this.prelude;
    const snapshot = extractUserSnapshot(text, snapshotPrelude, focusLine);
    const analysisSnapshot = analysisText(snapshotPrelude, snapshot.text);
    this.logger?.log("overlay.memory.transientLease", { ...textFields(snapshot.text), focusLine: snapshot.focusLine ?? -1, fullLines: textFields(text).lines });
    return this.enqueueWrite(async () => {
      await this.writeAnalysisText(analysisSnapshot);
      try {
        return await request();
      } finally {
        await this.writeAnalysisText(this.analysisText());
      }
    });
  }

  /** Updates editor-only hidden import text while analysis stays on user code. */
  async updatePrelude(prelude: string): Promise<void> {
    const changed = prelude !== this.prelude;
    this.logger?.log("overlay.memory.prelude", { ...textFields(prelude), changed, offset: preludeLineCount(prelude) });
    if (prelude === this.prelude) {
      return;
    }
    this.prelude = prelude;
    await this.enqueueWrite(async () => { await this.writeEditor(); await this.writeAnalysis(); });
  }

  /** Clears user input and generated imports for a fresh shell session. */
  async reset(): Promise<void> {
    const changed = this.text !== "" || this.prelude !== "";
    this.logger?.log("overlay.memory.reset", { changed });
    this.text = "";
    this.prelude = "";
    await this.enqueueWrite(async () => { await Promise.all([this.writeEditor(), this.writeAnalysis()]); });
  }

  /** Serializes generated file edits so reset, prelude, and sync updates cannot race. */
  private enqueueWrite<T>(action: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.catch(() => undefined).then(action);
    this.writeQueue = next.then(() => undefined, (error: unknown) => this.logger?.log("overlay.memory.write.error", { error: error instanceof Error ? error.message : String(error) }));
    return next;
  }

  /** Writes generated analysis text into the dirty editor document without saving it. */
  private async writeEditor(): Promise<void> {
    const text = this.editorText();
    this.logger?.log("overlay.memory.write", { ...textFields(text), kind: "editor", offset: this.lineOffset() });
    await ensureBackingFile(this.editorUri, text);
    this.editorDirty = this.editorText() !== text;
  }

  /** Writes only user Python cell text into the hidden analysis file without opening a dirty editor document. */
  private async writeAnalysis(): Promise<void> {
    const text = this.analysisText();
    await this.writeAnalysisText(text);
  }

  /** Writes an immutable analysis snapshot and records whether canonical state changed meanwhile. */
  private async writeAnalysisText(text: string): Promise<void> {
    if (text === this.installedAnalysisText) { this.analysisDirty = this.analysisText() !== text; return; }
    this.logger?.log("overlay.memory.write", { ...textFields(text), kind: "analysis", offset: this.lineOffset() });
    await ensureBackingFile(this.analysisUri, text);
    this.installedAnalysisText = text;
    this.analysisDirty = this.analysisText() !== text;
  }

  /** Releases provider event resources. */
  dispose(): void {}
}

/** Returns a workspace-local file URI for generated editor identity. */
function overlayFileUri(name: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd());
  return vscode.Uri.joinPath(root, ".django-shell", `${name}.py`);
}

/** Returns compact size fields for text diagnostics. */
function textFields(text: string): { chars: number; lines: number } {
  return { chars: text.length, lines: text ? text.split(/\r?\n/).length : 0 };
}

/** Returns analysis source with hidden imports but without the shell input marker. */
function analysisText(prelude: string, userText: string): string {
  return `${prelude}${userText}`;
}

/** Returns the number of generated prelude lines before user code in analysis.py. */
function preludeLineCount(prelude: string): number {
  return prelude ? prelude.split(/\r?\n/).length - 1 : 0;
}

/** Normalizes an optional zero-based analysis focus line. */
function normalizedFocusLine(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

/** Returns user text and converts a full legacy-document focus to its user-relative line. */
function extractUserSnapshot(text: string, prelude = "", focusLine?: number): OverlayUserSnapshot {
  const userStart = legacyUserStart(text, prelude);
  const normalizedFocus = normalizedFocusLine(focusLine);
  if (userStart <= 0) {
    return { focusLine: normalizedFocus, text };
  }
  const removedLines = lineBreakCount(text.slice(0, userStart));
  const relativeFocus = normalizedFocus === undefined || normalizedFocus < removedLines ? undefined : normalizedFocus - removedLines;
  return { focusLine: relativeFocus, text: text.slice(userStart) };
}

/** Returns the user-editable text after the generated marker. */
function extractUserText(text: string, prelude = ""): string {
  return extractUserSnapshot(text, prelude).text;
}

/** Returns the first user byte after a legacy marker or generated prelude. */
function legacyUserStart(text: string, prelude: string): number {
  const pattern = /(^|\r\n|\n|\r)[ \t]*# --- django shell input ---[ \t]*(?:\r\n|\n|\r|$)/g;
  let start = -1;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    start = match.index + match[0].length;
  }
  if (start >= 0) {
    return start;
  }
  return prelude && text.startsWith(prelude) ? prelude.length : 0;
}

/** Counts logical line breaks in one text prefix. */
function lineBreakCount(text: string): number {
  return text.match(/\r\n|\n|\r/g)?.length ?? 0;
}

/** Creates the backing file once so file-only extensions receive a file URI. */
async function ensureBackingFile(uri: vscode.Uri, text: string): Promise<void> {
  const directory = path.dirname(uri.fsPath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory));
  await ensureIgnoredShadowDirectory(directory);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

export const __test = { extractUserText };

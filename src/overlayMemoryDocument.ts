// File-backed Python document identity for the Django shell overlay editor.

import * as vscode from "vscode";
import * as path from "path";
import { DiagnosticLogger } from "./diagnostics";
import { ensureIgnoredShadowDirectory } from "./filePythonShadow";

export const INPUT_MARKER = "# --- django shell input ---";

/** Maintains a Python TextDocument whose edits stay in memory after creation. */
export class OverlayMemoryDocument implements vscode.Disposable {
  private analysisDirty = false;
  private editorDirty = false;
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
  activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this);
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

  /** Returns hidden imports plus Python cell text used by language analysis. */
  analysisText(): string {
    return analysisText(this.prelude, this.text);
  }

  /** Returns generated runtime import text kept out of the analysis file. */
  preludeText(): string {
    return this.prelude;
  }

  /** Synchronizes editor text into the in-memory TextDocument. */
  async sync(text: string): Promise<void> {
    const userText = extractUserText(text, this.prelude);
    const changed = userText !== this.text;
    this.logger?.log("overlay.memory.sync", { ...textFields(userText), changed, fullLines: textFields(text).lines });
    const needsAnalysis = changed || this.analysisDirty;
    const needsEditor = changed || this.editorDirty;
    if (!needsAnalysis && !needsEditor) {
      return;
    }
    if (changed) {
      this.text = userText;
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
  async syncAnalysis(text: string): Promise<void> {
    const userText = extractUserText(text, this.prelude);
    const changed = userText !== this.text;
    this.logger?.log("overlay.memory.syncAnalysis", { ...textFields(userText), changed, fullLines: textFields(text).lines });
    const needsAnalysis = changed || this.analysisDirty;
    if (!needsAnalysis) {
      return;
    }
    if (changed) {
      this.text = userText;
      this.editorDirty = true;
    }
    await this.enqueueWrite(async () => { await this.writeAnalysis(); });
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
  private enqueueWrite(action: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.catch(() => undefined).then(action);
    this.writeQueue = next.catch((error: unknown) => this.logger?.log("overlay.memory.write.error", { error: error instanceof Error ? error.message : String(error) }));
    return next;
  }

  /** Writes generated analysis text into the dirty editor document without saving it. */
  private async writeEditor(): Promise<void> {
    const text = this.editorText();
    this.logger?.log("overlay.memory.write", { ...textFields(text), kind: "editor", offset: this.lineOffset() });
    await ensureBackingFile(this.editorUri, text);
    this.editorDirty = false;
  }

  /** Writes only user Python cell text into the hidden analysis file without opening a dirty editor document. */
  private async writeAnalysis(): Promise<void> {
    const text = this.analysisText();
    this.logger?.log("overlay.memory.write", { ...textFields(text), kind: "analysis", offset: this.lineOffset() });
    await ensureBackingFile(this.analysisUri, text);
    this.analysisDirty = false;
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

/** Returns the user-editable text after the generated marker. */
function extractUserText(text: string, prelude = ""): string {
  const marker = `${INPUT_MARKER}\n`;
  const index = text.lastIndexOf(marker);
  let userText = index >= 0 ? text.slice(index + marker.length) : prelude && text.startsWith(prelude) ? text.slice(prelude.length) : text;
  const prefix = `${prelude}${marker}`;
  while (prelude && userText.startsWith(prefix)) {
    userText = userText.slice(prefix.length);
  }
  return userText;
}

/** Creates the backing file once so file-only extensions receive a file URI. */
async function ensureBackingFile(uri: vscode.Uri, text: string): Promise<void> {
  const directory = path.dirname(uri.fsPath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory));
  await ensureIgnoredShadowDirectory(directory);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

export const __test = { extractUserText };

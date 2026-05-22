// File-backed Python document identity for the Django shell overlay editor.

import * as vscode from "vscode";
import * as path from "path";
import { DiagnosticLogger } from "./diagnostics";
import { ensureIgnoredShadowDirectory } from "./filePythonShadow";

export const INPUT_MARKER = "# --- django shell input ---";

/** Maintains a Python TextDocument whose edits stay in memory after creation. */
export class OverlayMemoryDocument implements vscode.Disposable {
  private analysisPromise: Promise<vscode.TextDocument> | undefined;
  private prelude = "";
  private text = "";
  private writeQueue: Promise<void> = Promise.resolve();
  readonly analysisUri = overlayFileUri("analysis");
  readonly editorUri = overlayFileUri("console-cell");

  /** Stores the diagnostic logger used for in-memory document sync tracing. */
  constructor(private readonly logger?: DiagnosticLogger) {}

  /** Opens the file document so file-only language extensions can attach to it. */
  activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this);
    void this.enqueueWrite(async () => { await Promise.all([this.writeEditor(), this.writeAnalysis(true)]); await this.saveOpenDocuments(); await this.persistGeneratedFiles(); });
  }

  /** Returns the user-visible editor-to-analysis line delta. */
  lineOffset(): number {
    return prefixLineCount(this.prelude) - 2;
  }

  /** Returns the zero-based first user-editable line. */
  inputStartLine(): number {
    return prefixLineCount(this.prelude);
  }

  /** Returns the editor backing text including the protected input marker. */
  fullText(): string {
    return this.editorText();
  }

  /** Returns the editor model text that preserves the shell input boundary. */
  editorText(): string {
    return backingText(this.prelude, this.text);
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
    if (!changed) {
      return;
    }
    this.text = userText;
    await this.enqueueWrite(async () => { await Promise.all([this.writeEditor(), this.writeAnalysis(true)]); await this.saveOpenDocuments(); await this.persistGeneratedFiles(); });
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
  }

  /** Synchronizes only the hidden analysis document in memory for latency-sensitive providers. */
  async syncAnalysis(text: string): Promise<void> {
    const userText = extractUserText(text, this.prelude);
    const changed = userText !== this.text;
    this.logger?.log("overlay.memory.syncAnalysis", { ...textFields(userText), changed, fullLines: textFields(text).lines });
    if (!changed) {
      return;
    }
    this.text = userText;
    await this.enqueueWrite(async () => { await this.writeAnalysis(); });
  }

  /** Updates editor-only hidden import text while analysis stays on user code. */
  async updatePrelude(prelude: string): Promise<void> {
    const changed = prelude !== this.prelude;
    this.logger?.log("overlay.memory.prelude", { ...textFields(prelude), changed, offset: prefixLineCount(prelude) });
    if (prelude === this.prelude) {
      return;
    }
    this.prelude = prelude;
    await this.enqueueWrite(async () => { await this.writeEditor(); await this.writeAnalysis(true); await this.saveOpenDocuments(); await this.persistGeneratedFiles(); });
  }

  /** Clears user input and generated imports for a fresh shell session. */
  async reset(): Promise<void> {
    const changed = this.text !== "" || this.prelude !== "";
    this.logger?.log("overlay.memory.reset", { changed });
    this.text = "";
    this.prelude = "";
    await this.enqueueWrite(async () => { await Promise.all([this.writeEditor(), this.writeAnalysis(true)]); await this.saveOpenDocuments(); await this.persistGeneratedFiles(); });
  }

  /** Serializes generated file edits so reset, prelude, and sync updates cannot race. */
  private enqueueWrite(action: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.catch(() => undefined).then(action);
    this.writeQueue = next.catch((error: unknown) => this.logger?.log("overlay.memory.write.error", { error: error instanceof Error ? error.message : String(error) }));
    return next;
  }

  /** Saves generated documents after session-boundary rewrites so later disk resets do not conflict. */
  private async saveOpenDocuments(): Promise<void> {
    const document = await this.analysisPromise;
    if (document?.isDirty) { await document.save(); }
  }

  /** Persists the current generated document state without depending on visible editor tabs. */
  private async persistGeneratedFiles(): Promise<void> {
    await Promise.all([
      vscode.workspace.fs.writeFile(this.editorUri, Buffer.from(this.editorText(), "utf8")),
      vscode.workspace.fs.writeFile(this.analysisUri, Buffer.from(this.analysisText(), "utf8"))
    ]);
  }

  /** Writes generated analysis text into the dirty editor document without saving it. */
  private async writeEditor(): Promise<void> {
    const text = this.editorText();
    this.logger?.log("overlay.memory.write", { ...textFields(text), kind: "editor", offset: this.lineOffset() });
    await ensureBackingFile(this.editorUri, text);
  }

  /** Writes only user Python cell text into the hidden analysis document. */
  private async writeAnalysis(persistOnFailure = false): Promise<void> {
    const document = await this.ensureAnalysisOpen();
    const text = this.analysisText();
    this.logger?.log("overlay.memory.write", { ...textFields(text), kind: "analysis", offset: this.lineOffset() });
    await writeDocument(document, this.analysisUri, text, persistOnFailure);
  }

  /** Releases provider event resources. */
  dispose(): void {}

  /** Opens the generated analysis file document once for language providers. */
  private async ensureAnalysisOpen(): Promise<vscode.TextDocument> {
    if (!this.analysisPromise) {
      await ensureBackingFile(this.analysisUri, this.analysisText());
      this.analysisPromise = openPythonDocument(this.analysisUri);
    }
    return this.analysisPromise;
  }

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

/** Returns a full generated Python document from hidden imports and user text. */
function backingText(prelude: string, userText: string): string {
  return `${prelude}${INPUT_MARKER}\n${userText}`;
}

/** Returns analysis source with hidden imports but without the shell input marker. */
function analysisText(prelude: string, userText: string): string {
  return `${prelude}${userText}`;
}

/** Returns the first user line for a generated document prefix. */
function prefixLineCount(prelude: string): number {
  return backingText(prelude, "").split(/\r?\n/).length - 1;
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

/** Opens one Python document. */
function openPythonDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
  return Promise.resolve(vscode.workspace.openTextDocument(uri)).then((document) => {
    return document.languageId === "python" ? document : Promise.resolve(vscode.languages.setTextDocumentLanguage(document, "python"));
  });
}

/** Creates the backing file once so file-only extensions receive a file URI. */
async function ensureBackingFile(uri: vscode.Uri, text: string): Promise<void> {
  const directory = path.dirname(uri.fsPath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory));
  await ensureIgnoredShadowDirectory(directory);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

/** Replaces an open document's contents, optionally forcing disk persistence. */
async function writeDocument(document: vscode.TextDocument, uri: vscode.Uri, text: string, persistOnFailure = false): Promise<void> {
  if (await replaceDocumentText(document, uri, text)) {
    return;
  }
  try {
    if (await replaceDocumentText(await openPythonDocument(uri), uri, text)) {
      return;
    }
  } catch (error) {
    if (!persistOnFailure) {
      throw error;
    }
  }
  if (persistOnFailure) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
  }
}

/** Applies one whole-document replacement and reports whether VS Code accepted it. */
async function replaceDocumentText(document: vscode.TextDocument, uri: vscode.Uri, text: string): Promise<boolean> {
  const current = document.getText();
  if (current === text) {
    return true;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(current.length)), text);
  try {
    return await vscode.workspace.applyEdit(edit);
  } catch {
    return false;
  }
}

export const __test = { extractUserText };

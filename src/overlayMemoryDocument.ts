// File-backed Python document identity for the Django shell overlay editor.

import * as vscode from "vscode";
import * as path from "path";
import { DiagnosticLogger } from "./diagnostics";
import { ensureIgnoredShadowDirectory } from "./filePythonShadow";

export const INPUT_MARKER = "# --- django shell input ---";

/** Maintains a Python TextDocument whose edits stay in memory after creation. */
export class OverlayMemoryDocument implements vscode.Disposable {
  private analysisPromise: Promise<vscode.TextDocument> | undefined;
  private editorPromise: Promise<vscode.TextDocument> | undefined;
  private prelude = "";
  private text = "";
  readonly analysisUri = overlayFileUri("analysis");
  readonly editorUri = overlayFileUri("console-cell");

  /** Stores the diagnostic logger used for in-memory document sync tracing. */
  constructor(private readonly logger?: DiagnosticLogger) {}

  /** Opens the file document so file-only language extensions can attach to it. */
  activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this);
    void this.writeEditor(false);
    void this.writeAnalysis(false);
  }

  /** Returns how many generated lines are inserted before user code in the analysis document. */
  lineOffset(): number {
    return prefixLineCount(this.prelude);
  }

  /** Returns the zero-based first user-editable line. */
  inputStartLine(): number {
    return prefixLineCount(this.prelude);
  }

  /** Returns the full backing document text including hidden imports. */
  fullText(): string {
    return this.analysisText();
  }

  /** Returns the real editor model text that language extensions analyze. */
  editorText(): string {
    return this.fullText();
  }

  /** Returns the generated analysis text including hidden imports. */
  analysisText(): string {
    return backingText(this.prelude, this.text);
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
    await Promise.all([this.writeEditor(false), this.writeAnalysis(false)]);
  }

  /** Updates hidden import text used for file-scheme language analysis. */
  updatePrelude(prelude: string): void {
    const changed = prelude !== this.prelude;
    this.logger?.log("overlay.memory.prelude", { ...textFields(prelude), changed, offset: prefixLineCount(prelude) });
    if (prelude === this.prelude) {
      return;
    }
    this.prelude = prelude;
    void this.writeEditor();
    void this.writeAnalysis();
  }

  /** Clears user input and generated imports for a fresh shell session. */
  async reset(): Promise<void> {
    const changed = this.text !== "" || this.prelude !== "";
    this.logger?.log("overlay.memory.reset", { changed });
    this.text = "";
    this.prelude = "";
    await Promise.all([this.writeEditor(false), this.writeAnalysis(false)]);
  }

  /** Writes generated analysis text into the dirty editor document without saving it. */
  private async writeEditor(mergeLive = true): Promise<void> {
    const document = await this.ensureEditorOpen();
    if (mergeLive) {
      this.mergeLiveUserText(document);
    }
    const text = this.editorText();
    this.logger?.log("overlay.memory.write", { ...textFields(text), kind: "editor", offset: this.lineOffset() });
    await writeDocument(document, this.editorUri, text);
  }

  /** Writes generated prelude plus user text into the hidden analysis document. */
  private async writeAnalysis(mergeLive = true): Promise<void> {
    if (mergeLive && this.editorPromise) {
      this.mergeLiveUserText(await this.editorPromise);
    }
    const document = await this.ensureAnalysisOpen();
    const text = this.analysisText();
    this.logger?.log("overlay.memory.write", { ...textFields(text), kind: "analysis", offset: this.lineOffset() });
    await writeDocument(document, this.analysisUri, text);
  }

  /** Releases provider event resources. */
  dispose(): void {}

  /** Opens the visible file document once so VS Code can identify its URI. */
  private async ensureEditorOpen(): Promise<vscode.TextDocument> {
    if (!this.editorPromise) {
      await ensureBackingFile(this.editorUri, this.editorText());
      this.editorPromise = openPythonDocument(this.editorUri);
    }
    return this.editorPromise;
  }

  /** Opens the generated analysis file document once for language providers. */
  private async ensureAnalysisOpen(): Promise<vscode.TextDocument> {
    if (!this.analysisPromise) {
      await ensureBackingFile(this.analysisUri, this.analysisText());
      this.analysisPromise = openPythonDocument(this.analysisUri);
    }
    return this.analysisPromise;
  }

  /** Preserves unsynced editor input before writing generated prelude changes. */
  private mergeLiveUserText(document: vscode.TextDocument): void {
    const fullText = document.getText();
    const userText = extractUserText(fullText, this.prelude);
    if (userText === this.text) {
      return;
    }
    this.logger?.log("overlay.memory.mergeLive", { ...textFields(userText) });
    this.text = userText;
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

/** Replaces an open document's contents without saving it to disk. */
async function writeDocument(document: vscode.TextDocument, uri: vscode.Uri, text: string): Promise<void> {
  const current = document.getText();
  if (current === text) {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(current.length)), text);
  await vscode.workspace.applyEdit(edit);
}

export const __test = { extractUserText };

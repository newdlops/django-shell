// Deprecated notebook console lifecycle retained for compatibility.

import * as vscode from "vscode";
import { NOTEBOOK_TYPE, PRELUDE_CELL_ROLE, SETUP_CELL_ROLE } from "./notebookConstants";
import { DjangoConsoleController } from "./notebookController";
import { pythonCellMetadata } from "./notebookMetadata";
import { defaultCells, DjangoConsoleSerializer } from "./notebookSerializer";
import { PythonShadowDocuments } from "./pythonShadow";

interface ActivePythonInput {
  cell: vscode.NotebookCell;
  document: vscode.TextDocument;
  editor: vscode.NotebookEditor;
  index: number;
}

/** Registers the deprecated notebook serializer and compatibility commands. */
export class DjangoNotebookConsole implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly executedOffsets = new Map<string, number>();

  /** Stores the controller used to prepare opened console notebooks. */
  constructor(private readonly controller: DjangoConsoleController, private readonly shadows: PythonShadowDocuments) {}

  /** Adds deprecated notebook contributions from extension activation. */
  activate(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new DjangoConsoleSerializer()),
      vscode.commands.registerCommand("djangoShell.openNotebookConsoleDeprecated", () => this.openConsole()),
      vscode.commands.registerTextEditorCommand("djangoShell.acceptInput", (editor) => void this.acceptInput(editor)),
      vscode.commands.registerCommand("djangoShell.focusInput", (sessionId?: string) => this.focusInput(sessionId))
    );
    context.subscriptions.push(this);
  }

  /** Releases notebook command and serializer registrations. */
  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Creates the deprecated workspace console file when needed and opens it as a notebook. */
  async openConsole(): Promise<void> {
    const uri = await this.consoleUri();
    await this.ensureConsoleFile(uri);
    const document = await vscode.workspace.openNotebookDocument(uri);
    this.controller.prepareNotebook(document);
    const editor = await vscode.window.showNotebookDocument(document, { preview: false });
    await this.normalizeConsoleCells(editor);
    await this.removePreludeCells(editor);
    await this.ensurePythonLanguageModes(editor);
    await this.collapseSetupInput(editor);
  }

  /** Returns the workspace-local .djshell console URI. */
  private async consoleUri(): Promise<vscode.Uri> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd());
    const dir = vscode.Uri.joinPath(root, ".django-shell");
    await vscode.workspace.fs.createDirectory(dir);
    return vscode.Uri.joinPath(dir, "console.djshell");
  }

  /** Writes the default notebook JSON when the console file does not exist yet. */
  private async ensureConsoleFile(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      const raw = {
        cells: defaultCells().map((cell) => ({
          languageId: cell.languageId,
          metadata: cell.metadata,
          source: cell.value
        }))
      };
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(raw, undefined, 2), "utf8"));
    }
  }

  /** Removes generated prelude cells so analysis code never appears as user code. */
  private async removePreludeCells(editor: vscode.NotebookEditor): Promise<void> {
    const edits = editor.notebook.getCells()
      .map((cell, index) => ({ cell, index }))
      .filter((entry) => entry.cell.metadata?.role === PRELUDE_CELL_ROLE)
      .map((entry) => vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(entry.index, entry.index + 1)));
    if (!edits.length) {
      return;
    }
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(editor.notebook.uri, edits);
    await vscode.workspace.applyEdit(workspaceEdit);
  }

  /** Rewrites stale input cells so the notebook editor treats them as Python code. */
  private async normalizeConsoleCells(editor: vscode.NotebookEditor): Promise<void> {
    const edits: vscode.NotebookEdit[] = [];
    for (const cell of editor.notebook.getCells()) {
      if (!shouldBePythonInput(cell)) {
        continue;
      }
      if (cell.document.languageId !== "python") {
        edits.push(vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(cell.index, cell.index + 1), [pythonCellData(cell)]));
        continue;
      }
      if (!hasPythonMetadata(cell.metadata)) {
        edits.push(vscode.NotebookEdit.updateCellMetadata(cell.index, pythonCellMetadata(cell.metadata)));
      }
    }
    if (!edits.length) {
      return;
    }
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(editor.notebook.uri, edits);
    await vscode.workspace.applyEdit(workspaceEdit);
  }

  /** Forces active Python input documents into VS Code's Python language mode. */
  private async ensurePythonLanguageModes(editor: vscode.NotebookEditor): Promise<void> {
    for (const cell of editor.notebook.getCells()) {
      if (shouldBePythonInput(cell) && cell.document.languageId !== "python") {
        await vscode.languages.setTextDocumentLanguage(cell.document, "python");
      }
    }
  }

  /** Collapses the internal setup cell input so users only see the terminal output. */
  private async collapseSetupInput(editor: vscode.NotebookEditor): Promise<void> {
    const setupIndex = editor.notebook.getCells().findIndex((cell) => cell.metadata?.role === SETUP_CELL_ROLE);
    if (setupIndex < 0) {
      return;
    }
    const setupRange = new vscode.NotebookRange(setupIndex, setupIndex + 1);
    editor.selection = setupRange;
    editor.selections = [setupRange];
    try {
      await vscode.commands.executeCommand("notebook.cell.collapseCellInput");
    } catch {
      // Older VS Code builds can omit the command; the empty setup source still keeps the cell compact.
    }
    await this.focusPythonInput(editor, this.preferredPythonInputIndex(editor));
  }

  /** Moves notebook focus back to the first editable Python input cell. */
  private async focusPythonInput(editor: vscode.NotebookEditor, preferredIndex: number): Promise<void> {
    const index = Math.min(preferredIndex, editor.notebook.cellCount - 1);
    if (index < 0) {
      return;
    }
    const focusRange = new vscode.NotebookRange(index, index + 1);
    const focusedEditor = await vscode.window.showNotebookDocument(editor.notebook, {
      preview: false,
      preserveFocus: false,
      selections: [focusRange]
    });
    focusedEditor.selection = focusRange;
    focusedEditor.selections = [focusRange];
    focusedEditor.revealRange(new vscode.NotebookRange(0, index + 1), vscode.NotebookEditorRevealType.AtTop);
    try {
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
      await vscode.commands.executeCommand("notebook.cell.edit");
      await vscode.commands.executeCommand("cursorBottom");
    } catch {
      // The selected cell is still visible if this VS Code build cannot enter notebook edit mode.
    }
  }

  /** Executes only newly entered Python code and leaves prior editor text intact. */
  private async acceptInput(textEditor?: vscode.TextEditor): Promise<void> {
    const active = this.activePythonInput(textEditor);
    const source = active ? this.pendingSource(active) : "";
    if (!active || !source.trim()) {
      return;
    }
    if (!(await this.controller.isConsoleInputComplete(active.cell, source))) {
      await this.insertContinuationLine(active, source, textEditor);
      await this.restoreInputFocus(active, textEditor);
      return;
    }
    await this.syncShadowToCell(active);
    const submitted = await this.controller.executeConsoleInput(active.cell, source);
    if (submitted) {
      await this.markExecutedBoundary(active);
    }
    await this.restoreInputFocus(active, textEditor);
  }

  /** Inserts a continuation newline instead of executing incomplete Python input. */
  private async insertContinuationLine(
    input: ActivePythonInput,
    source: string,
    textEditor?: vscode.TextEditor
  ): Promise<void> {
    const insertion = `\n${continuationIndent(source)}`;
    const editor = textEditor?.document.uri.toString() === input.document.uri.toString()
      ? textEditor
      : vscode.window.activeTextEditor;
    if (editor?.document.uri.toString() === input.document.uri.toString()) {
      await editor.edit((edit) => edit.insert(editor.selection.active, insertion));
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.insert(input.document.uri, documentEnd(input.document), insertion);
    await vscode.workspace.applyEdit(edit);
  }

  /** Restores cursor focus to the active Python cell after notebook output updates settle. */
  private async restoreInputFocus(
    input: ActivePythonInput,
    textEditor?: vscode.TextEditor
  ): Promise<void> {
    await this.focusPythonInput(input.editor, input.index);
    this.focusTextEditorEnd(input.document, textEditor);
    await delay(0);
    await this.focusPythonInput(input.editor, input.index);
    this.focusTextEditorEnd(input.document, textEditor);
  }

  /** Returns text entered after the last submitted boundary in this Python cell. */
  private pendingSource(input: ActivePythonInput): string {
    const text = this.inputText(input);
    return text.slice(this.pendingOffset(input.cell, text));
  }

  /** Returns the document offset where the current unexecuted input starts. */
  private pendingOffset(cell: vscode.NotebookCell, text: string): number {
    const offset = this.executedOffsets.get(cell.document.uri.toString()) ?? 0;
    return offset > text.length ? 0 : offset;
  }

  /** Marks this Python cell's current document end as executed while keeping text intact. */
  private async markExecutedBoundary(input: ActivePythonInput): Promise<void> {
    if (!input.document.getText().endsWith("\n")) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(input.document.uri, documentEnd(input.document), "\n");
      await vscode.workspace.applyEdit(edit);
    }
    await this.syncShadowToCell(input);
    this.executedOffsets.set(input.cell.document.uri.toString(), this.inputText(input).length);
  }

  /** Places the text cursor at the end of the active Python cell editor. */
  private focusTextEditorEnd(document: vscode.TextDocument, preferred?: vscode.TextEditor): void {
    const editor = preferred?.document.uri.toString() === document.uri.toString()
      ? preferred
      : vscode.window.activeTextEditor;
    if (editor?.document.uri.toString() !== document.uri.toString()) {
      return;
    }
    const end = documentEnd(document);
    editor.selection = new vscode.Selection(end, end);
    editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.AtTop);
  }

  /** Focuses the active Python input or creates one for a ready Django shell. */
  private async focusInput(sessionId?: string): Promise<void> {
    const editor = this.consoleEditor(sessionId);
    if (!editor) {
      return;
    }
    await this.ensurePythonInput(editor, this.preferredPythonInputIndex(editor));
  }

  /** Returns the active Python input from either a notebook cell or its workspace shadow file. */
  private activePythonInput(textEditor?: vscode.TextEditor): ActivePythonInput | undefined {
    const editor = this.consoleEditor();
    const activeDocument = vscode.window.activeTextEditor?.document.uri.toString();
    const cells = editor?.notebook.getCells() ?? [];
    const index = activeDocument
      ? cells.findIndex((cell) => cell.document.uri.toString() === activeDocument)
      : editor?.selection.start ?? -1;
    const cell = index >= 0 ? cells[index] : undefined;
    return editor && cell && isPythonInput(cell) ? { cell, document: cell.document, editor, index } : undefined;
  }

  /** Returns the user-editable source text for one active input. */
  private inputText(input: ActivePythonInput): string {
    return input.document.getText();
  }

  /** Copies real workspace shadow source back into the matching notebook cell. */
  private async syncShadowToCell(_input: ActivePythonInput): Promise<void> {}

  /** Returns the visible console editor that matches a session or the active notebook. */
  private consoleEditor(sessionId?: string): vscode.NotebookEditor | undefined {
    const active = vscode.window.activeNotebookEditor;
    if (active?.notebook.notebookType === NOTEBOOK_TYPE && (!sessionId || active.notebook.uri.toString() === sessionId)) {
      return active;
    }
    return vscode.window.visibleNotebookEditors.find((editor) => {
      return editor.notebook.notebookType === NOTEBOOK_TYPE && (!sessionId || editor.notebook.uri.toString() === sessionId);
    });
  }

  /** Creates or focuses a Python input cell without collapsing other Python cells. */
  private async ensurePythonInput(editor: vscode.NotebookEditor, index: number): Promise<void> {
    if (index < editor.notebook.cellCount && isPythonInput(editor.notebook.cellAt(index))) {
      await this.focusPythonInput(editor, index);
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.set(editor.notebook.uri, [vscode.NotebookEdit.insertCells(index, [pythonInputCell()])]);
    if (await vscode.workspace.applyEdit(edit)) {
      await this.focusPythonInput(editor, index);
    }
  }

  /** Chooses the Python cell that should receive focus when a shell becomes ready. */
  private preferredPythonInputIndex(editor: vscode.NotebookEditor): number {
    const cells = editor.notebook.getCells();
    const activeDocument = vscode.window.activeTextEditor?.document.uri.toString();
    const activeIndex = activeDocument
      ? cells.findIndex((cell) => cell.document.uri.toString() === activeDocument)
      : -1;
    if (activeIndex >= 0 && isPythonInput(cells[activeIndex])) {
      return activeIndex;
    }
    if (editor.selection.start < cells.length && isPythonInput(cells[editor.selection.start])) {
      return editor.selection.start;
    }
    const setupIndex = cells.findIndex((cell) => cell.metadata?.role === SETUP_CELL_ROLE);
    const nextIndex = setupIndex + 1;
    if (nextIndex >= 0 && nextIndex < cells.length && isPythonInput(cells[nextIndex])) {
      return nextIndex;
    }
    const firstPythonIndex = cells.findIndex((cell) => isPythonInput(cell));
    return firstPythonIndex >= 0 ? firstPythonIndex : Math.max(0, nextIndex);
  }

}

/** Creates a blank Python cell used as the next shell prompt. */
function pythonInputCell(): vscode.NotebookCellData {
  const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "", "python");
  cell.metadata = pythonCellMetadata();
  return cell;
}

/** Creates Python cell data from an existing stale notebook cell. */
function pythonCellData(cell: vscode.NotebookCell): vscode.NotebookCellData {
  const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, cell.document.getText(), "python");
  data.metadata = pythonCellMetadata(cell.metadata);
  data.outputs = [...cell.outputs];
  data.executionSummary = cell.executionSummary;
  return data;
}

/** Returns true for editable Python console input cells. */
function isPythonInput(cell: vscode.NotebookCell): boolean {
  return shouldBePythonInput(cell);
}

/** Returns true for code cells that should behave as Python shell inputs. */
function shouldBePythonInput(cell: vscode.NotebookCell): boolean {
  return cell.kind === vscode.NotebookCellKind.Code && ![PRELUDE_CELL_ROLE, SETUP_CELL_ROLE].includes(cell.metadata?.role);
}

/** Returns whether a cell already carries Python editor metadata. */
function hasPythonMetadata(metadata: { readonly [key: string]: unknown }): boolean {
  const typed = metadata as { custom?: { vscode?: { languageId?: unknown } }; languageId?: unknown; vscode?: { languageId?: unknown } };
  return typed.languageId === "python" && typed.vscode?.languageId === "python" && typed.custom?.vscode?.languageId === "python";
}

/** Returns the end position of a text document. */
function documentEnd(document: vscode.TextDocument): vscode.Position {
  const lastLine = document.lineAt(Math.max(0, document.lineCount - 1));
  return new vscode.Position(lastLine.lineNumber, lastLine.text.length);
}

/** Returns indentation for the next line of incomplete Python input. */
function continuationIndent(source: string): string {
  const line = lastSourceLine(source);
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const trimmed = line.trim();
  if (!trimmed) {
    return indent;
  }
  if (trimmed.endsWith(":")) {
    return `${indent}${indentUnit(indent)}`;
  }
  if (/^(break|continue|pass|raise|return)\b/.test(trimmed)) {
    return dedent(indent);
  }
  return indent;
}

/** Returns the final physical line from a Python input string. */
function lastSourceLine(source: string): string {
  return source.split(/\r?\n/).at(-1) ?? "";
}

/** Chooses the indentation unit that matches the current line. */
function indentUnit(indent: string): string {
  return indent.includes("\t") && !indent.includes(" ") ? "\t" : "    ";
}

/** Removes one conventional Python indentation level. */
function dedent(indent: string): string {
  if (indent.endsWith("\t")) {
    return indent.slice(0, -1);
  }
  return indent.slice(0, Math.max(0, indent.length - 4));
}

/** Waits for VS Code notebook focus updates to finish a UI turn. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

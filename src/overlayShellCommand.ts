// Shell execution command for the in-memory Django shell overlay editor.
import * as vscode from "vscode";
import { DiagnosticLogger } from "./diagnostics";
import { lintOverlayRange } from "./overlayLint";
import { INPUT_MARKER, OverlayMemoryDocument } from "./overlayMemoryDocument";

type RunHandler = (code: string) => Promise<boolean>;

export interface OverlayShellCommandOptions {
  registerCommands?: boolean;
}

/** Owns shell Enter commands and the newline fallback for the overlay document. */
export class OverlayShellCommandController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private inputStartLine: number;

  /** Registers optional shell editor commands. */
  constructor(private readonly documents: OverlayMemoryDocument, private readonly runHandler: RunHandler, private readonly logger?: DiagnosticLogger, options: OverlayShellCommandOptions = {}) {
    this.inputStartLine = documents.inputStartLine();
    if (options.registerCommands !== false) {
      this.disposables.push(vscode.commands.registerCommand("djangoShell.overlayAcceptInput", () => this.acceptInput()));
      this.disposables.push(vscode.commands.registerCommand("djangoShell.overlayInsertNewline", () => this.insertNewline()));
    }
  }

  /** Runs the active file-backed overlay input through the backend when Enter is pressed. */
  async acceptInput(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== this.documents.editorUri.toString()) {
      this.logger?.log("overlay.command.enter.miss", { active: editor?.document.uri.toString() ?? "" });
      await vscode.commands.executeCommand("type", { text: "\n" });
      return;
    }
    await this.documents.sync(editor.document.getText());
    this.inputStartLine = documentInputStartLine(editor.document, this.documents.inputStartLine());
    let payload = executionPayload(editor.document, editor.selection, this.inputStartLine);
    if (!payload.code.trim()) {
      this.logger?.log("overlay.command.enter.empty", { inputStartLine: this.inputStartLine + 1, line: editor.selection.active.line + 1 });
      await vscode.commands.executeCommand("type", { text: "\n" });
      return;
    }
    if (await lintOverlayRange(editor.document, payload.range, this.logger)) {
      await this.documents.sync(editor.document.getText());
      this.inputStartLine = documentInputStartLine(editor.document, this.documents.inputStartLine());
      payload = executionPayload(editor.document, editor.selection, this.inputStartLine);
    }
    this.logger?.log("overlay.command.enter", { chars: payload.code.length, end: payload.end + 1, inputStartLine: this.inputStartLine + 1, lines: lineCount(payload.code), start: payload.start + 1 });
    if (!await this.runHandler(payload.code)) {
      this.logger?.log("overlay.command.enter.incomplete", { end: payload.end + 1, inputStartLine: this.inputStartLine + 1, lines: lineCount(payload.code), start: payload.start + 1 });
      await vscode.commands.executeCommand("type", { text: `\n${nextIndent(editor.document, payload.end)}` });
      return;
    }
    await advanceAfterRun(editor);
  }

  /** Inserts an indented continuation line in the active file-backed overlay editor. */
  async insertNewline(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    this.inputStartLine = editor ? documentInputStartLine(editor.document, this.documents.inputStartLine()) : this.documents.inputStartLine();
    this.logger?.log("overlay.command.newline", { active: editor?.document.uri.toString() ?? "", inputStartLine: this.inputStartLine + 1 });
    const indent = editor?.document.uri.toString() === this.documents.editorUri.toString() ? nextIndent(editor.document, editor.selection.active.line) : "";
    await vscode.commands.executeCommand("type", { text: `\n${indent}` });
  }

  /** Releases command and document listeners. */
  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

/** Registers the command that turns the overlay Python editor into a shell input. */
export function registerOverlayShellCommand(documents: OverlayMemoryDocument, runHandler: RunHandler, logger?: DiagnosticLogger, options: OverlayShellCommandOptions = {}): OverlayShellCommandController {
  return new OverlayShellCommandController(documents, runHandler, logger, options);
}

/** Returns selected source or the logical Python block at the cursor. */
function executionPayload(document: vscode.TextDocument, selection: vscode.Selection, inputStartLine: number): { code: string; end: number; range: vscode.Range; start: number } {
  if (!selection.isEmpty) {
    return {
      code: document.getText(selection).trimEnd(),
      end: selection.end.line,
      range: selection,
      start: selection.start.line
    };
  }
  const range = executionRange(document, selection.active.line, inputStartLine);
  const codeRange = new vscode.Range(range.start, 0, range.end, document.lineAt(range.end).text.length);
  return { code: document.getText(codeRange).trimEnd(), end: range.end, range: codeRange, start: range.start };
}

/** Returns the live editable line from the open document marker when possible. */
function documentInputStartLine(document: vscode.TextDocument, fallback: number): number {
  for (let line = 0; line < document.lineCount; line += 1) {
    if (document.lineAt(line).text.trim() === INPUT_MARKER) {
      return Math.min(line + 1, document.lineCount - 1);
    }
  }
  return Math.min(fallback, Math.max(0, document.lineCount - 1));
}

/** Returns the logical Python statement or block around the cursor. */
function executionRange(document: vscode.TextDocument, lineNumber: number, inputStartLine: number): { end: number; start: number } {
  const floor = Math.max(0, inputStartLine);
  const cursor = nonBlankCursorLine(document, Math.max(floor, lineNumber), floor);
  const start = statementStart(document, cursor, floor);
  let end = statementEnd(document, start, cursor);
  while (end > start && !document.lineAt(end).text.trim()) {
    end -= 1;
  }
  return { end, start };
}

/** Returns the closest non-empty cursor line without crossing the prelude boundary. */
function nonBlankCursorLine(document: vscode.TextDocument, lineNumber: number, floor: number): number {
  let line = Math.min(lineNumber, document.lineCount - 1);
  while (line > floor && !document.lineAt(line).text.trim()) {
    line -= 1;
  }
  return line;
}

/** Returns the first line of the Python statement containing the cursor. */
function statementStart(document: vscode.TextDocument, lineNumber: number, floor: number): number {
  const bracketStart = bracketStatementStart(document, lineNumber, floor);
  const line = document.lineAt(bracketStart).text;
  let start = bracketStart;
  let indent = indentation(line);
  if (indent > 0 || isCompoundFollower(line)) {
    for (let index = bracketStart - 1; index >= floor; index -= 1) {
      const candidate = document.lineAt(index).text;
      if (!candidate.trim()) {
        continue;
      }
      const candidateIndent = indentation(candidate);
      if (candidateIndent >= indent) {
        continue;
      }
      if (isBlockHeader(candidate)) {
        start = index;
        indent = candidateIndent;
        if (indent === 0) {
          break;
        }
        continue;
      }
      break;
    }
  }
  return compoundPrefixStart(document, start, floor);
}

/** Includes preceding if/try siblings for else, elif, except, and finally blocks. */
function compoundPrefixStart(document: vscode.TextDocument, start: number, floor: number): number {
  if (!isCompoundFollower(document.lineAt(start).text)) {
    return start;
  }
  const baseIndent = indentation(document.lineAt(start).text);
  for (let index = start - 1; index >= floor; index -= 1) {
    const text = document.lineAt(index).text;
    if (!text.trim()) {
      continue;
    }
    if (indentation(text) < baseIndent) {
      break;
    }
    if (indentation(text) === baseIndent && isBlockHeader(text)) {
      start = index;
      if (!isCompoundFollower(text)) {
        break;
      }
    }
  }
  return start;
}

/** Returns the last line of the Python statement containing the cursor. */
function statementEnd(document: vscode.TextDocument, start: number, cursor: number): number {
  const bracketEnd = bracketStatementEnd(document, start, cursor);
  if (!isBlockHeader(document.lineAt(start).text)) {
    return bracketEnd;
  }
  const baseIndent = indentation(document.lineAt(start).text);
  let end = Math.max(start, bracketEnd);
  for (let index = start + 1; index < document.lineCount; index += 1) {
    const text = document.lineAt(index).text;
    if (!text.trim()) {
      if (index <= cursor) {
        end = index;
      }
      continue;
    }
    const indent = indentation(text);
    if (indent <= baseIndent && index > start + 1 && !isCompoundFollower(text)) {
      break;
    }
    end = Math.max(end, index);
  }
  return end;
}

/** Returns whether a line starts a Python block suite. */
function isBlockHeader(line: string): boolean {
  return /:\s*(?:#.*)?$/.test(line.trimEnd());
}

/** Returns whether a line continues a prior compound statement at the same indentation. */
function isCompoundFollower(line: string): boolean {
  return /^(?:elif|else|except|finally)\b/.test(line.trimStart());
}

/** Returns the leading whitespace width for one source line. */
function indentation(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

/** Moves the cursor to the next shell input line after execution. */
async function advanceAfterRun(editor: vscode.TextEditor): Promise<void> {
  let target = editor.document.lineCount - 1;
  const last = editor.document.lineAt(target);
  if (last.text.trim()) {
    await editor.edit((edit) => edit.insert(last.range.end, "\n"));
    target = editor.document.lineCount - 1;
  }
  const position = new vscode.Position(target, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Returns the indentation that should be used after one Python line. */
function nextIndent(document: vscode.TextDocument, lineNumber: number): string {
  const text = document.lineAt(Math.min(lineNumber, document.lineCount - 1)).text;
  const base = text.match(/^\s*/)?.[0] ?? "";
  return isBlockHeader(text) || bracketDelta(text) > 0 ? `${base}    ` : base;
}

/** Returns the top-level statement start for bracketed continuation lines. */
function bracketStatementStart(document: vscode.TextDocument, lineNumber: number, floor: number): number {
  let depth = 0;
  let start = lineNumber;
  for (let index = floor; index <= lineNumber; index += 1) {
    const text = document.lineAt(index).text;
    if (text.trim() && depth === 0) {
      start = index;
    }
    depth = Math.max(0, depth + bracketDelta(text, depth));
  }
  return start;
}

/** Returns the statement end after bracketed continuations close. */
function bracketStatementEnd(document: vscode.TextDocument, start: number, cursor: number): number {
  let depth = 0;
  let end = Math.max(start, cursor);
  for (let index = start; index < document.lineCount; index += 1) {
    const text = document.lineAt(index).text;
    if (text.trim()) {
      end = index;
    }
    depth = Math.max(0, depth + bracketDelta(text, depth));
    if (index >= cursor && depth <= 0) {
      break;
    }
  }
  return end;
}

/** Returns bracket balance change for one Python line, ignoring simple strings and comments. */
function bracketDelta(line: string, depth = 0): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const closes = new Set([")", "]", "}"]);
  let quote = "";
  let delta = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const previous = index > 0 ? line[index - 1] : "";
    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = "";
      }
      continue;
    }
    if (char === "#") {
      break;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (pairs[char]) {
      delta += 1;
    }
    if (closes.has(char)) {
      delta -= 1;
    }
  }
  return delta;
}

/** Returns a compact line count for diagnostics. */
function lineCount(text: string): number {
  return text ? text.split(/\r?\n/).length : 0;
}

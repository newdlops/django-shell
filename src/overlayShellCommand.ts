// Shell execution command for the in-memory Django shell overlay editor.
import * as vscode from "vscode";
import { DiagnosticLogger } from "./diagnostics";
import { lintOverlayRange } from "./overlayLint";
import { INPUT_MARKER, OverlayMemoryDocument } from "./overlayMemoryDocument";

type RunHandler = (code: string) => Promise<boolean>;

/** Registers the command that turns the overlay Python editor into a shell input. */
export function registerOverlayShellCommand(documents: OverlayMemoryDocument, runHandler: RunHandler, logger?: DiagnosticLogger): vscode.Disposable {
  let inputStartLine = documents.inputStartLine();
  let suppressUntil = 0;
  const command = vscode.commands.registerCommand("djangoShell.overlayAcceptInput", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== documents.editorUri.toString()) {
      logger?.log("overlay.command.enter.miss", { active: editor?.document.uri.toString() ?? "" });
      await vscode.commands.executeCommand("type", { text: "\n" });
      return;
    }
    await documents.sync(editor.document.getText());
    inputStartLine = documentInputStartLine(editor.document, documents.inputStartLine());
    let payload = executionPayload(editor.document, editor.selection, inputStartLine);
    if (!payload.code.trim()) {
      logger?.log("overlay.command.enter.empty", { inputStartLine: inputStartLine + 1, line: editor.selection.active.line + 1 });
      await vscode.commands.executeCommand("type", { text: "\n" });
      return;
    }
    if (await lintOverlayRange(editor.document, payload.range, logger)) {
      await documents.sync(editor.document.getText());
      inputStartLine = documentInputStartLine(editor.document, documents.inputStartLine());
      payload = executionPayload(editor.document, editor.selection, inputStartLine);
    }
    logger?.log("overlay.command.enter", { chars: payload.code.length, end: payload.end + 1, inputStartLine: inputStartLine + 1, lines: lineCount(payload.code), start: payload.start + 1 });
    if (!await runHandler(payload.code)) {
      logger?.log("overlay.command.enter.incomplete", { end: payload.end + 1, inputStartLine: inputStartLine + 1, lines: lineCount(payload.code), start: payload.start + 1 });
      suppressUntil = Date.now() + 250;
      await vscode.commands.executeCommand("type", { text: `\n${nextIndent(editor.document, payload.end)}` });
      return;
    }
    suppressUntil = Date.now() + 250;
    await advanceAfterRun(editor);
  });
  const newline = vscode.commands.registerCommand("djangoShell.overlayInsertNewline", async () => {
    suppressUntil = Date.now() + 250;
    const editor = vscode.window.activeTextEditor;
    inputStartLine = editor ? documentInputStartLine(editor.document, documents.inputStartLine()) : documents.inputStartLine();
    logger?.log("overlay.command.newline", { active: editor?.document.uri.toString() ?? "", inputStartLine: inputStartLine + 1 });
    const indent = editor?.document.uri.toString() === documents.editorUri.toString() ? nextIndent(editor.document, editor.selection.active.line) : "";
    await vscode.commands.executeCommand("type", { text: `\n${indent}` });
  });
  const documentChange = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.toString() !== documents.editorUri.toString()) {
      return;
    }
    const change = event.contentChanges.find((item) => item.text === "\n" || item.text === "\r\n");
    if (!change) {
      return;
    }
    inputStartLine = documentInputStartLine(event.document, documents.inputStartLine());
    logger?.log("overlay.document.newline", { inputStartLine: inputStartLine + 1, line: change.range.start.line + 1, suppressed: Date.now() < suppressUntil });
    if (Date.now() < suppressUntil) {
      return;
    }
    void runFromDocumentChange(event.document, change.range.start.line, inputStartLine, runHandler, logger).then((result) => {
      if (result.executed) {
        suppressUntil = Date.now() + 120;
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.toString() === documents.editorUri.toString()) {
          void advanceAfterRun(editor);
        }
      } else if (result.incomplete) {
        void indentInsertedLine(event.document, change.range.start.line);
      }
    });
  });
  return vscode.Disposable.from(command, newline, documentChange);
}

/** Executes the logical shell block before a newline inserted into the overlay document. */
async function runFromDocumentChange(document: vscode.TextDocument, line: number, inputStartLine: number, runHandler: RunHandler, logger?: DiagnosticLogger): Promise<{ executed: boolean; incomplete: boolean }> {
  let payload = executionPayload(document, new vscode.Selection(line, 0, line, 0), inputStartLine);
  if (!payload.code.trim()) {
    logger?.log("overlay.document.enter.empty", { inputStartLine: inputStartLine + 1, line: line + 1 });
    return { executed: false, incomplete: false };
  }
  if (await lintOverlayRange(document, payload.range, logger)) {
    payload = executionPayload(document, new vscode.Selection(line, 0, line, 0), inputStartLine);
  }
  logger?.log("overlay.document.enter", { chars: payload.code.length, end: payload.end + 1, inputStartLine: inputStartLine + 1, lines: lineCount(payload.code), start: payload.start + 1 });
  if (!await runHandler(payload.code)) {
    logger?.log("overlay.document.enter.incomplete", { end: payload.end + 1, inputStartLine: inputStartLine + 1, lines: lineCount(payload.code), start: payload.start + 1 });
    return { executed: false, incomplete: true };
  }
  return { executed: true, incomplete: false };
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
  const indent = indentation(line);
  let start = bracketStart;
  if (indent > 0 || isCompoundFollower(line)) {
    for (let index = bracketStart - 1; index >= floor; index -= 1) {
      const candidate = document.lineAt(index).text;
      if (candidate.trim() && indentation(candidate) < indent && isBlockHeader(candidate)) {
        start = index;
        break;
      }
      if (candidate.trim() && indent === 0 && indentation(candidate) === 0 && isBlockHeader(candidate)) {
        start = index;
        break;
      }
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

/** Inserts Python block indentation into a newline that VS Code already created. */
async function indentInsertedLine(document: vscode.TextDocument, sourceLine: number): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const targetLine = sourceLine + 1;
  if (!editor || editor.document.uri.toString() !== document.uri.toString() || targetLine >= document.lineCount || document.lineAt(targetLine).text.trim()) {
    return;
  }
  const indent = nextIndent(document, sourceLine);
  if (indent) {
    await editor.edit((edit) => edit.insert(new vscode.Position(targetLine, 0), indent));
  }
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

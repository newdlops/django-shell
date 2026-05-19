// Safe lint helpers for the Django shell overlay input range.

import * as vscode from "vscode";
import { DiagnosticLogger } from "./diagnostics";

/** Applies safe formatting and whitespace cleanup to the visible shell input range. */
export async function lintOverlayRange(document: vscode.TextDocument, range: vscode.Range, logger?: DiagnosticLogger): Promise<boolean> {
  const started = Date.now();
  const changed = await trimTrailingWhitespace(document, range);
  logger?.log("overlay.lint", { changed, edits: 0, end: range.end.line + 1, ms: Date.now() - started, start: range.start.line + 1 });
  return changed;
}

/** Removes trailing spaces inside the current shell input range. */
async function trimTrailingWhitespace(document: vscode.TextDocument, range: vscode.Range): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  const end = Math.min(range.end.line, document.lineCount - 1);
  for (let line = range.start.line; line <= end; line += 1) {
    const text = document.lineAt(line).text;
    const trimmed = text.replace(/[ \t]+$/u, "");
    if (trimmed.length !== text.length) {
      edit.replace(document.uri, new vscode.Range(line, trimmed.length, line, text.length), "");
    }
  }
  return edit.size ? vscode.workspace.applyEdit(edit) : false;
}

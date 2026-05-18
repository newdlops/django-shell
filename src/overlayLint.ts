// Safe lint helpers for the Django shell overlay input range.

import * as vscode from "vscode";
import { DiagnosticLogger } from "./diagnostics";

/** Applies safe formatting and whitespace cleanup to the visible shell input range. */
export async function lintOverlayRange(document: vscode.TextDocument, range: vscode.Range, logger?: DiagnosticLogger): Promise<boolean> {
  const started = Date.now();
  let changed = false;
  const formatEdits = await formatRangeEdits(document, range);
  if (formatEdits.length && await applySafeEdits(document, range, formatEdits)) {
    changed = true;
    document = await vscode.workspace.openTextDocument(document.uri);
  }
  if (await trimTrailingWhitespace(document, range)) {
    changed = true;
  }
  logger?.log("overlay.lint", { changed, edits: formatEdits.length, end: range.end.line + 1, ms: Date.now() - started, start: range.start.line + 1 });
  return changed;
}

/** Returns formatter edits for one range without throwing into Enter handling. */
async function formatRangeEdits(document: vscode.TextDocument, range: vscode.Range): Promise<vscode.TextEdit[]> {
  try {
    return await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatRangeProvider",
      document.uri,
      range,
      { insertSpaces: true, tabSize: 4 }
    ) ?? [];
  } catch {
    return [];
  }
}

/** Applies only formatter edits that stay inside the user input range. */
async function applySafeEdits(document: vscode.TextDocument, range: vscode.Range, edits: vscode.TextEdit[]): Promise<boolean> {
  const safe = edits.filter((edit) => containsRange(range, edit.range));
  if (!safe.length || safe.length !== edits.length) {
    return false;
  }
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const edit of safe) {
    workspaceEdit.replace(document.uri, edit.range, edit.newText);
  }
  return vscode.workspace.applyEdit(workspaceEdit);
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

/** Returns true when a candidate range is fully inside a containing range. */
function containsRange(container: vscode.Range, candidate: vscode.Range): boolean {
  return !candidate.start.isBefore(container.start) && !candidate.end.isAfter(container.end);
}

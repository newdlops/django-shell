// Caches repeated completion bridge requests while a user extends one token.

import * as vscode from "vscode";

export type CompletionResult = vscode.CompletionList | vscode.CompletionItem[];

export interface CompletionRequestShape {
  key: string;
  replacementRange: vscode.Range;
}

/** Builds a stable key that ignores only the currently typed identifier token. */
export function completionRequestShape(document: vscode.TextDocument, position: vscode.Position): CompletionRequestShape {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const start = activeTokenStart(text, offset);
  return {
    key: `${document.uri.toString()}:${text.slice(0, start)}:${text.slice(offset)}`,
    replacementRange: new vscode.Range(document.positionAt(start), position)
  };
}

/** Returns a completion result cloned for the current active token range. */
export function cloneCompletionResult(result: CompletionResult, range: vscode.Range): CompletionResult {
  if (Array.isArray(result)) {
    return result.map((item) => cloneCompletionItem(item, range));
  }
  return new vscode.CompletionList(result.items.map((item) => cloneCompletionItem(item, range)), result.isIncomplete);
}

/** Counts completion items without depending on the result container shape. */
export function completionResultCount(result: CompletionResult): number {
  return Array.isArray(result) ? result.length : result.items.length;
}

/** Finds the start offset of the identifier immediately before the cursor. */
function activeTokenStart(text: string, offset: number): number {
  let index = offset;
  while (index > 0 && /[A-Za-z0-9_]/.test(text[index - 1] ?? "")) {
    index -= 1;
  }
  return index;
}

/** Clones one completion item and retargets its primary replacement range. */
function cloneCompletionItem(item: vscode.CompletionItem, range: vscode.Range): vscode.CompletionItem {
  const clone = new vscode.CompletionItem(item.label, item.kind);
  Object.assign(clone, item);
  clone.range = range;
  clone.textEdit = cloneTextEdit(item.textEdit, range);
  return clone;
}

/** Clones a completion text edit for the current active token when possible. */
function cloneTextEdit(edit: vscode.TextEdit | undefined, range: vscode.Range): vscode.TextEdit | undefined {
  return edit instanceof vscode.TextEdit ? new vscode.TextEdit(range, edit.newText) : edit;
}

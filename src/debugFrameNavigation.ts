// Paused debug-frame source navigation helpers for overlay-owned debugging.

import * as vscode from "vscode";
import type { DebugFrameInfo } from "./debugInspector";
import type { DiagnosticLogger } from "./diagnostics";

const OVERLAY_SOURCE_SUFFIX = "/.django-shell/console-cell.py";
let externalDebugFrameDecoration: vscode.TextEditorDecorationType | undefined;
let externalDebugFrameEditor: vscode.TextEditor | undefined;

/** Returns whether a debug frame path points at the generated overlay source. */
export function isOverlayDebugFramePath(pathOrUri: string | undefined): boolean {
  const normalized = normalizeDebugFramePath(pathOrUri).replace(/\\/g, "/");
  return !!normalized && (normalized === "console-cell.py" || normalized.endsWith(OVERLAY_SOURCE_SUFFIX));
}

/** Opens the paused non-overlay source frame in the active editor group. */
export async function revealExternalDebugFrame(info: Pick<DebugFrameInfo, "frame" | "state">, logger?: DiagnosticLogger): Promise<boolean> {
  if (info.state !== "paused" || !info.frame?.path || isOverlayDebugFramePath(info.frame.path)) {
    return false;
  }
  const path = normalizeDebugFramePath(info.frame.path);
  if (!path || path.startsWith("<")) {
    return false;
  }
  try {
    const position = new vscode.Position(Math.max(0, info.frame.line - 1), Math.max(0, (info.frame.column ?? 1) - 1));
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false, selection: new vscode.Selection(position, position), viewColumn: vscode.ViewColumn.Active });
    decorateExternalDebugFrame(editor, position);
    return true;
  } catch (error) {
    logger?.log("debug.frame.reveal.error", { error: error instanceof Error ? error.message : String(error), path });
    return false;
  }
}

/** Clears the current external debug-frame line marker. */
export function clearExternalDebugFrameDecoration(): void {
  if (externalDebugFrameDecoration && externalDebugFrameEditor) {
    externalDebugFrameEditor.setDecorations(externalDebugFrameDecoration, []);
  }
  externalDebugFrameEditor = undefined;
}

/** Marks the currently paused external frame in its native editor. */
function decorateExternalDebugFrame(editor: vscode.TextEditor, position: vscode.Position): void {
  clearExternalDebugFrameDecoration();
  externalDebugFrameDecoration ??= vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.stackFrameHighlightBackground"),
    borderColor: new vscode.ThemeColor("debugIcon.breakpointCurrentStackframeForeground"),
    borderStyle: "solid",
    borderWidth: "0 0 0 4px",
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor("debugIcon.breakpointCurrentStackframeForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Center
  });
  externalDebugFrameEditor = editor;
  editor.setDecorations(externalDebugFrameDecoration, [new vscode.Range(position, position)]);
}

/** Converts file URIs to filesystem paths while preserving debugpy source names. */
function normalizeDebugFramePath(value: string | undefined): string {
  if (!value) {
    return "";
  }
  if (/^file:\/\//i.test(value)) {
    try {
      return vscode.Uri.parse(value).fsPath;
    } catch {
      return value;
    }
  }
  return value;
}

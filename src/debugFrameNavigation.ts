// Paused debug-frame source navigation helpers for overlay-owned debugging.

import * as vscode from "vscode";
import { debugInlineValueText } from "./debugInlineValues";
import type { DebugFrameInfo } from "./debugInspector";
import { isPseudoDebugSourcePath } from "./debugSourceFrames";
import type { DiagnosticLogger } from "./diagnostics";

const OVERLAY_SOURCE_SUFFIX = "/.django-shell/console-cell.py";
type ExternalDebugFrameInfo = Pick<DebugFrameInfo, "frame" | "scopes" | "state">;
let externalDebugFrameDecoration: vscode.TextEditorDecorationType | undefined;
let externalDebugFrameEditor: vscode.TextEditor | undefined;
let externalDebugFrameInfo: ExternalDebugFrameInfo | undefined;
let externalDebugFramePath = "";

/** Returns whether a debug frame path points at the generated overlay source. */
export function isOverlayDebugFramePath(pathOrUri: string | undefined): boolean {
  const normalized = normalizeDebugFramePath(pathOrUri).replace(/\\/g, "/");
  return !!normalized && (normalized === "console-cell.py" || normalized.endsWith(OVERLAY_SOURCE_SUFFIX));
}

/** Opens the paused non-overlay source frame in the active editor group. */
export async function revealExternalDebugFrame(info: ExternalDebugFrameInfo, logger?: DiagnosticLogger): Promise<boolean> {
  if (info.state !== "paused" || !info.frame?.path || isOverlayDebugFramePath(info.frame.path) || isPseudoDebugSourcePath(info.frame.path)) {
    return false;
  }
  const path = normalizeDebugFramePath(info.frame.path);
  if (!path || isPseudoDebugSourcePath(path)) {
    return false;
  }
  externalDebugFrameInfo = info;
  try {
    const position = debugFramePosition(info);
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false, selection: new vscode.Selection(position, position), viewColumn: vscode.ViewColumn.Active });
    const latest = externalDebugFrameInfo;
    if (!latest?.frame?.path || latest.state !== "paused" || normalizeDebugFramePath(latest.frame.path) !== path) {
      return false;
    }
    decorateExternalDebugFrame(editor, path, debugFramePosition(latest), debugInlineValueText(latest.scopes));
    return true;
  } catch (error) {
    logger?.log("debug.frame.reveal.error", { error: error instanceof Error ? error.message : String(error), path });
    return false;
  }
}

/** Replaces inline values on an already-open external frame without reopening or refocusing its file. */
export function refreshExternalDebugFrameDecoration(info: ExternalDebugFrameInfo): boolean {
  if (info.state !== "paused" || !info.frame?.path || isOverlayDebugFramePath(info.frame.path) || isPseudoDebugSourcePath(info.frame.path)) {
    if (info.state === "paused") { externalDebugFrameInfo = undefined; }
    return false;
  }
  const path = normalizeDebugFramePath(info.frame.path);
  externalDebugFrameInfo = info;
  if (!externalDebugFrameEditor || path !== externalDebugFramePath) {
    return false;
  }
  try {
    decorateExternalDebugFrame(externalDebugFrameEditor, path, debugFramePosition(info), debugInlineValueText(info.scopes));
    return true;
  } catch {
    externalDebugFrameEditor = undefined; externalDebugFramePath = "";
    return false;
  }
}

/** Clears the current external debug-frame line marker. */
export function clearExternalDebugFrameDecoration(): void {
  if (externalDebugFrameDecoration && externalDebugFrameEditor) {
    try { externalDebugFrameEditor.setDecorations(externalDebugFrameDecoration, []); } catch { /* The source editor may already be closed. */ }
  }
  externalDebugFrameEditor = undefined;
  externalDebugFrameInfo = undefined;
  externalDebugFramePath = "";
}

/** Marks the currently paused external frame in its native editor. */
function decorateExternalDebugFrame(editor: vscode.TextEditor, path: string, position: vscode.Position, inlineText: string): void {
  externalDebugFrameDecoration ??= vscode.window.createTextEditorDecorationType({
    after: { backgroundColor: new vscode.ThemeColor("editor.inlineValuesBackground"), color: new vscode.ThemeColor("editor.inlineValuesForeground"), fontStyle: "italic", margin: "0 0 0 1ch" },
    backgroundColor: new vscode.ThemeColor("editor.stackFrameHighlightBackground"),
    borderColor: new vscode.ThemeColor("debugIcon.breakpointCurrentStackframeForeground"),
    borderStyle: "solid",
    borderWidth: "0 0 0 4px",
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor("debugIcon.breakpointCurrentStackframeForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Center
  });
  if (externalDebugFrameEditor && externalDebugFrameEditor !== editor) {
    externalDebugFrameEditor.setDecorations(externalDebugFrameDecoration, []);
  }
  externalDebugFrameEditor = editor;
  externalDebugFramePath = path;
  const range = externalDebugFrameLineRange(editor, position);
  const decoration: vscode.DecorationOptions = { range };
  if (inlineText) { decoration.renderOptions = { after: { contentText: `  ${inlineText}` } }; }
  editor.setDecorations(externalDebugFrameDecoration, [decoration]);
}

/** Returns a zero-based VS Code position for one paused frame. */
function debugFramePosition(info: ExternalDebugFrameInfo): vscode.Position {
  return new vscode.Position(Math.max(0, (info.frame?.line ?? 1) - 1), Math.max(0, (info.frame?.column ?? 1) - 1));
}

/** Returns a zero-width source-line-end range for the inline attachment. */
function externalDebugFrameLineRange(editor: vscode.TextEditor, position: vscode.Position): vscode.Range {
  try {
    const end = editor.document.lineAt(position.line).range.end;
    return new vscode.Range(end, end);
  } catch {
    return new vscode.Range(position, position);
  }
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

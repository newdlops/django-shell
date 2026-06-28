// Paused debug-frame source navigation helpers for overlay-owned debugging.

import * as vscode from "vscode";
import type { DebugFrameInfo } from "./debugInspector";
import type { DiagnosticLogger } from "./diagnostics";

const OVERLAY_SOURCE_SUFFIX = "/.django-shell/console-cell.py";

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
    await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false, selection: new vscode.Selection(position, position), viewColumn: vscode.ViewColumn.Active });
    return true;
  } catch (error) {
    logger?.log("debug.frame.reveal.error", { error: error instanceof Error ? error.message : String(error), path });
    return false;
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

// File-backed debug helpers for the Django shell Python cell.

import * as path from "path";
import * as vscode from "vscode";
import { normalizeOverlayBreakpointLine } from "./debugBreakpoints";
import { debugBreakpointKey, type DebugBreakpointLocation } from "./debugBreakpointPayload";
import { overlayEditorUri } from "./overlayBackingFiles";

export type DjangoShellDebugMode = "file" | "overlay";

export const DEFAULT_DEBUG_MODE: DjangoShellDebugMode = "overlay";

/** Returns a supported debug display mode, defaulting to the overlay path. */
export function normalizeDebugMode(value: unknown): DjangoShellDebugMode {
  return value === "file" ? "file" : DEFAULT_DEBUG_MODE;
}

/** Returns the workspace-local file used for the easy file-backed debug mode. */
export function debugFileUri(): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd());
  return vscode.Uri.joinPath(root, ".django-shell", "debug-cell.py");
}

/** Writes the current Python cell code into the file debug target. */
export async function writeDebugFile(code: string): Promise<vscode.Uri> {
  const uri = debugFileUri();
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(code, "utf8"));
  return uri;
}

/** Opens the file debug target as the user's normal VS Code debugging surface. */
export async function openDebugFile(uri = debugFileUri()): Promise<void> {
  await vscode.window.showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.One });
}

/** Reads the current file debug target, including unsaved editor edits when present. */
export async function readDebugFileText(uri = debugFileUri()): Promise<string> {
  const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString()) ?? await vscode.workspace.openTextDocument(uri);
  return document.getText();
}

/** Returns one-based enabled breakpoint locations for one source file URI. */
export function sourceBreakpointLocations(uri: vscode.Uri, lineOffset = 0): DebugBreakpointLocation[] {
  const target = uri.toString(), locations = new Map<string, DebugBreakpointLocation>();
  for (const breakpoint of vscode.debug.breakpoints) {
    if (!(breakpoint instanceof vscode.SourceBreakpoint) || !breakpoint.enabled || breakpoint.location.uri.toString() !== target) { continue; }
    const line = normalizeOverlayBreakpointLine(breakpoint.location.range.start.line + 1, lineOffset);
    const column = breakpoint.location.range.start.character > 0 ? breakpoint.location.range.start.character + 1 : 0;
    const location: DebugBreakpointLocation = { column: column || undefined, condition: breakpoint.condition, hitCondition: breakpoint.hitCondition, line, logMessage: breakpoint.logMessage };
    locations.set(debugBreakpointKey(location), location);
  }
  return [...locations.values()].sort((left, right) => left.line - right.line || (left.column ?? 0) - (right.column ?? 0));
}

/** Copies current overlay breakpoints onto the file debug target without removing file breakpoints. */
export function mirrorOverlayBreakpointsToDebugFile(): void {
  const source = sourceBreakpointLocations(overlayEditorUri()), target = debugFileUri();
  const existingKeys = new Set(sourceBreakpointLocations(target).map(debugBreakpointKey));
  const additions = source.filter((breakpoint) => !existingKeys.has(debugBreakpointKey(breakpoint)));
  if (additions.length) { vscode.debug.addBreakpoints(additions.map((breakpoint) => new vscode.SourceBreakpoint(new vscode.Location(target, new vscode.Position(breakpoint.line - 1, Math.max(0, (breakpoint.column ?? 0) - 1))), true, breakpoint.condition, breakpoint.hitCondition, breakpoint.logMessage))); }
}

// Debug adapter inspection helpers for paused Django shell frames.

import * as vscode from "vscode";
import type { DebugRequestSession } from "./debugAdapterTypes";

export type DebugPanelState = "attached" | "error" | "idle" | "paused" | "running";

export interface DebugVariableInfo {
  name: string;
  type?: string;
  value: string;
  variablesReference?: number;
}

export interface DebugScopeInfo {
  name: string;
  total?: number;
  variables: DebugVariableInfo[];
}

export interface DebugStackFrameInfo {
  line: number;
  name: string;
  path?: string;
}

export interface DebugFrameInfo {
  error?: string;
  frame?: { column?: number; line: number; name: string; path?: string; sourceLine?: string };
  frames?: DebugStackFrameInfo[];
  scopes?: DebugScopeInfo[];
  state: DebugPanelState;
}

interface DapStackFrame { column?: number; id: number; line: number; name: string; source?: { name?: string; path?: string } }
interface DapScope { expensive?: boolean; indexedVariables?: number; name: string; namedVariables?: number; variablesReference: number }
interface DapThread { id: number; name: string }
interface DapVariable { indexedVariables?: number; name: string; namedVariables?: number; type?: string; value: string; variablesReference?: number }
interface DebugFrameRef { frameId?: number; threadId: number }
export interface DebugInspectOptions { preferOverlay?: boolean }

const OVERLAY_SOURCE_SUFFIX = "/.django-shell/console-cell.py";
const MAX_SCOPE_VARIABLES = 80;

/** Reads the active paused stack frame through DAP requests. */
export async function inspectDebugFrame(session: DebugRequestSession, item: vscode.DebugStackFrame, options: DebugInspectOptions = {}): Promise<DebugFrameInfo> {
  return inspectDebugFrameRef(session, item, options);
}

/** Reads the top paused stack frame for one stopped DAP thread. */
export async function inspectDebugThread(session: DebugRequestSession, threadId?: number, options: DebugInspectOptions = {}): Promise<DebugFrameInfo> {
  const resolvedThreadId = threadId ?? await firstThreadId(session);
  if (!resolvedThreadId) {
    return { error: "No stopped debug thread was reported.", state: "error" };
  }
  return inspectDebugFrameRef(session, { threadId: resolvedThreadId }, options);
}

/** Reads a paused stack frame and source line through DAP requests. */
async function inspectDebugFrameRef(session: DebugRequestSession, item: DebugFrameRef, options: DebugInspectOptions = {}): Promise<DebugFrameInfo> {
  const frames = await stackFramesFor(session, item.threadId);
  const frame = stackFrameFor(frames, item, options);
  const sourceLine = frame ? await sourceLineFor(frame) : "";
  const frameId = frame?.id ?? item.frameId;
  const scopes = frameId ? await scopeVariables(session, frameId) : [];
  return { frame: frame && { column: frame.column, line: frame.line, name: frame.name, path: sourcePathFor(frame), sourceLine }, frames: frames.slice(0, 8).map(stackFrameInfo), scopes, state: "paused" };
}

/** Reads child variables for one expandable DAP variablesReference. */
export async function inspectDebugVariables(session: DebugRequestSession, variablesReference: number): Promise<DebugVariableInfo[]> {
  return variablesForReference(session, variablesReference, 120);
}

/** Returns the current DAP stack frames for a stopped thread. */
async function stackFramesFor(session: DebugRequestSession, threadId: number): Promise<DapStackFrame[]> {
  const response = await session.customRequest("stackTrace", { levels: 30, startFrame: 0, threadId }) as { stackFrames?: DapStackFrame[] };
  return response.stackFrames ?? [];
}

/** Returns the DAP stack frame matching VS Code's active frame id. */
function stackFrameFor(frames: DapStackFrame[], item: DebugFrameRef, options: DebugInspectOptions): DapStackFrame | undefined {
  if (item.frameId && options.preferOverlay !== false) {
    const overlay = frames.find(isOverlayStackFrame);
    if (overlay) { return overlay; }
  }
  return item.frameId ? frames.find((frame) => frame.id === item.frameId) ?? preferredStackFrame(frames, options) : preferredStackFrame(frames, options);
}

/** Returns the best user-code frame from a DAP stack, preferring the overlay backing file. */
function preferredStackFrame(frames: DapStackFrame[], options: DebugInspectOptions): DapStackFrame | undefined {
  if (options.preferOverlay === false) { return frames[0]; }
  return frames.find(isOverlayStackFrame) ?? frames[0];
}

/** Returns whether a DAP frame points at the generated overlay console file. */
function isOverlayStackFrame(frame: DapStackFrame): boolean {
  const normalized = sourcePathFor(frame).replace(/\\/g, "/");
  return normalized === "console-cell.py" || normalized.endsWith(OVERLAY_SOURCE_SUFFIX);
}

/** Returns a serializable stack frame preview for the custom console webview. */
function stackFrameInfo(frame: DapStackFrame): DebugStackFrameInfo {
  return { line: frame.line, name: frame.name, path: sourcePathFor(frame) };
}

/** Returns the first DAP thread id when a stopped event omits one. */
async function firstThreadId(session: DebugRequestSession): Promise<number | undefined> {
  const response = await session.customRequest("threads", {}) as { threads?: DapThread[] };
  return response.threads?.[0]?.id;
}

/** Reads the paused source line for compact debug display. */
async function sourceLineFor(frame: DapStackFrame): Promise<string> {
  const sourcePath = sourcePathFor(frame);
  if (!sourcePath || sourcePath.startsWith("<") || frame.line <= 0) {
    return "";
  }
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
    return document.lineAt(Math.max(0, frame.line - 1)).text.trim();
  } catch {
    return "";
  }
}

/** Returns a normalized filesystem path or source name for a DAP frame. */
function sourcePathFor(frame: DapStackFrame): string {
  return normalizeSourcePath(frame.source?.path ?? frame.source?.name ?? "");
}

/** Converts DAP file URIs to filesystem paths while preserving ordinary source names. */
function normalizeSourcePath(value: string): string {
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

/** Returns compact variables for the current frame scopes. */
async function scopeVariables(session: DebugRequestSession, frameId: number): Promise<DebugScopeInfo[]> {
  const response = await session.customRequest("scopes", { frameId }) as { scopes?: DapScope[] };
  const scopes: DebugScopeInfo[] = [];
  for (const scope of (response.scopes ?? []).filter((item) => !item.expensive).slice(0, 4)) {
    scopes.push({ name: scope.name, total: scope.namedVariables ?? scope.indexedVariables, variables: await variablesForReference(session, scope.variablesReference, MAX_SCOPE_VARIABLES) });
  }
  return scopes;
}

/** Reads one DAP variablesReference with a bounded count. */
async function variablesForReference(session: DebugRequestSession, variablesReference: number, count: number): Promise<DebugVariableInfo[]> {
  if (!variablesReference) {
    return [];
  }
  const response = await session.customRequest("variables", { count, start: 0, variablesReference }) as { variables?: DapVariable[] };
  return (response.variables ?? []).filter((variable) => !variable.name.startsWith("__")).map(normalizeVariable);
}

/** Normalizes and truncates one DAP variable for webview display. */
function normalizeVariable(variable: DapVariable): DebugVariableInfo {
  return { name: variable.name, type: variable.type, value: truncateValue(variable.value), variablesReference: variable.variablesReference };
}

/** Truncates multiline debug adapter values for compact tree rendering. */
function truncateValue(value: string): string {
  const singleLine = String(value).replace(/\s+/g, " ").trim();
  return singleLine.length > 500 ? `${singleLine.slice(0, 497)}...` : singleLine;
}

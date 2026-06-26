// Debug adapter inspection helpers for paused Django shell frames.

import * as vscode from "vscode";

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

export interface DebugFrameInfo {
  error?: string;
  focusVariables: DebugVariableInfo[];
  frame?: { column?: number; line: number; name: string; path?: string; sourceLine?: string };
  scopes: DebugScopeInfo[];
  state: DebugPanelState;
}

interface DapStackFrame { column?: number; id: number; line: number; name: string; source?: { name?: string; path?: string } }
interface DapScope { expensive?: boolean; indexedVariables?: number; name: string; namedVariables?: number; variablesReference: number }
interface DapThread { id: number; name: string }
interface DapVariable { evaluateName?: string; indexedVariables?: number; name: string; namedVariables?: number; type?: string; value: string; variablesReference?: number }
interface DebugFrameRef { frameId?: number; threadId: number }
export interface DebugInspectOptions { preferOverlay?: boolean }

const MAX_SCOPE_VARIABLES = 40;
const MAX_FOCUS_VARIABLES = 8;
const OVERLAY_SOURCE_SUFFIX = "/.django-shell/console-cell.py";
const PYTHON_KEYWORDS = new Set(["and", "as", "assert", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield"]);

/** Reads the active paused stack frame and visible variables through DAP requests. */
export async function inspectDebugFrame(session: vscode.DebugSession, item: vscode.DebugStackFrame): Promise<DebugFrameInfo> {
  return inspectDebugFrameRef(session, item);
}

/** Reads the top paused stack frame for one stopped DAP thread. */
export async function inspectDebugThread(session: vscode.DebugSession, threadId?: number, options: DebugInspectOptions = {}): Promise<DebugFrameInfo> {
  const resolvedThreadId = threadId ?? await firstThreadId(session);
  if (!resolvedThreadId) {
    return { error: "No stopped debug thread was reported.", focusVariables: [], scopes: [], state: "error" };
  }
  return inspectDebugFrameRef(session, { threadId: resolvedThreadId }, options);
}

/** Reads a paused stack frame and visible variables through DAP requests. */
async function inspectDebugFrameRef(session: vscode.DebugSession, item: DebugFrameRef, options: DebugInspectOptions = {}): Promise<DebugFrameInfo> {
  const frame = await stackFrameFor(session, item, options);
  const sourceLine = frame ? await sourceLineFor(frame) : "";
  const frameId = frame?.id ?? item.frameId;
  const focusVariables = frameId ? await evaluateLineVariables(session, frameId, lineExpressions(sourceLine)) : [];
  const scopes = frameId ? await scopeVariables(session, frameId, new Set(focusVariables.map((variable) => variable.name))) : [];
  return { focusVariables, frame: frame && { column: frame.column, line: frame.line, name: frame.name, path: sourcePathFor(frame), sourceLine }, scopes, state: "paused" };
}

/** Returns the DAP stack frame matching VS Code's active frame id. */
async function stackFrameFor(session: vscode.DebugSession, item: DebugFrameRef, options: DebugInspectOptions): Promise<DapStackFrame | undefined> {
  const response = await session.customRequest("stackTrace", { levels: 30, startFrame: 0, threadId: item.threadId }) as { stackFrames?: DapStackFrame[] };
  const frames = response.stackFrames ?? [];
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

/** Returns the first DAP thread id when a stopped event omits one. */
async function firstThreadId(session: vscode.DebugSession): Promise<number | undefined> {
  const response = await session.customRequest("threads", {}) as { threads?: DapThread[] };
  return response.threads?.[0]?.id;
}

/** Reads the paused source line for variable prioritization and display. */
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

/** Evaluates variables referenced by the current source line in the paused frame. */
async function evaluateLineVariables(session: vscode.DebugSession, frameId: number, expressions: string[]): Promise<DebugVariableInfo[]> {
  const variables: DebugVariableInfo[] = [];
  for (const expression of expressions.slice(0, MAX_FOCUS_VARIABLES)) {
    try {
      const result = await session.customRequest("evaluate", { context: "watch", expression, frameId }) as DapVariable;
      variables.push(normalizeVariable({ ...result, name: expression }));
    } catch {
      // Some identifiers on a line are attributes, keywords, or names outside the frame.
    }
  }
  return variables;
}

/** Returns compact variables for the current frame scopes. */
async function scopeVariables(session: vscode.DebugSession, frameId: number, focusedNames: Set<string>): Promise<DebugScopeInfo[]> {
  const response = await session.customRequest("scopes", { frameId }) as { scopes?: DapScope[] };
  const scopes: DebugScopeInfo[] = [];
  for (const scope of (response.scopes ?? []).filter((item) => !item.expensive).slice(0, 3)) {
    const variables = await variablesForReference(session, scope.variablesReference);
    scopes.push({ name: scope.name, total: scope.namedVariables ?? scope.indexedVariables, variables: prioritizeVariables(variables, focusedNames).slice(0, MAX_SCOPE_VARIABLES) });
  }
  return scopes;
}

/** Reads one DAP variablesReference with a bounded count. */
async function variablesForReference(session: vscode.DebugSession, variablesReference: number): Promise<DebugVariableInfo[]> {
  if (!variablesReference) {
    return [];
  }
  const response = await session.customRequest("variables", { count: 200, start: 0, variablesReference }) as { variables?: DapVariable[] };
  return (response.variables ?? []).filter((variable) => !variable.name.startsWith("__")).map(normalizeVariable);
}

/** Sorts variables used on the current line before the rest of the scope. */
function prioritizeVariables(variables: DebugVariableInfo[], focusedNames: Set<string>): DebugVariableInfo[] {
  return [...variables].sort((left, right) => Number(focusedNames.has(right.name)) - Number(focusedNames.has(left.name)) || left.name.localeCompare(right.name));
}

/** Extracts safe identifier expressions from one Python source line. */
function lineExpressions(sourceLine: string): string[] {
  const matches = sourceLine.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/g) ?? [];
  const names = matches.flatMap((match) => match.includes(".") ? [match.split(".")[0], match] : [match]);
  return [...new Set(names.filter((name) => !PYTHON_KEYWORDS.has(name) && !name.startsWith("__")))];
}

/** Normalizes and truncates one DAP variable for webview display. */
function normalizeVariable(variable: DapVariable): DebugVariableInfo {
  return { name: variable.name, type: variable.type, value: truncateValue(variable.value), variablesReference: variable.variablesReference };
}

/** Truncates multiline debug adapter values for compact inline rendering. */
function truncateValue(value: string): string {
  const singleLine = String(value).replace(/\s+/g, " ").trim();
  return singleLine.length > 240 ? `${singleLine.slice(0, 237)}...` : singleLine;
}

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
interface DapVariable { evaluateName?: string; indexedVariables?: number; name: string; namedVariables?: number; type?: string; value: string; variablesReference?: number }

const MAX_SCOPE_VARIABLES = 40;
const MAX_FOCUS_VARIABLES = 8;
const PYTHON_KEYWORDS = new Set(["and", "as", "assert", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield"]);

/** Reads the active paused stack frame and visible variables through DAP requests. */
export async function inspectDebugFrame(session: vscode.DebugSession, item: vscode.DebugStackFrame): Promise<DebugFrameInfo> {
  const frame = await stackFrameFor(session, item);
  const sourceLine = frame ? await sourceLineFor(frame) : "";
  const focusVariables = await evaluateLineVariables(session, item.frameId, lineExpressions(sourceLine));
  const scopes = await scopeVariables(session, item.frameId, new Set(focusVariables.map((variable) => variable.name)));
  return { focusVariables, frame: frame && { column: frame.column, line: frame.line, name: frame.name, path: frame.source?.path ?? frame.source?.name, sourceLine }, scopes, state: "paused" };
}

/** Returns the DAP stack frame matching VS Code's active frame id. */
async function stackFrameFor(session: vscode.DebugSession, item: vscode.DebugStackFrame): Promise<DapStackFrame | undefined> {
  const response = await session.customRequest("stackTrace", { levels: 30, startFrame: 0, threadId: item.threadId }) as { stackFrames?: DapStackFrame[] };
  return response.stackFrames?.find((frame) => frame.id === item.frameId) ?? response.stackFrames?.[0];
}

/** Reads the paused source line for variable prioritization and display. */
async function sourceLineFor(frame: DapStackFrame): Promise<string> {
  if (!frame.source?.path || frame.line <= 0) {
    return "";
  }
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(frame.source.path));
    return document.lineAt(Math.max(0, frame.line - 1)).text.trim();
  } catch {
    return "";
  }
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

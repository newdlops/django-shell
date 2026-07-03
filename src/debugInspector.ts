// Debug adapter inspection helpers for paused Django shell frames.

import * as vscode from "vscode";
import type { DebugRequestSession } from "./debugAdapterTypes";
import { choosePreferredDebugSourceFrame, isUserDebugSourceFrame, sourcePathForDebugSourceFrame, type DebugSourceFrame } from "./debugSourceFrames";

export type DebugPanelState = "attached" | "error" | "idle" | "paused" | "running";

export interface DebugVariableInfo {
  evaluateName?: string;
  name: string;
  querysetPreview?: boolean;
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

interface DapStackFrame extends DebugSourceFrame { column?: number; id: number; line: number; name: string; source?: { name?: string; path?: string } }
interface DapScope { expensive?: boolean; indexedVariables?: number; name: string; namedVariables?: number; variablesReference: number }
interface DapThread { id: number; name: string }
interface DapVariable { evaluateName?: string; indexedVariables?: number; name: string; namedVariables?: number; type?: string; value: string; variablesReference?: number }
interface DapEvaluateResponse { result?: string; type?: string; variablesReference?: number }
interface DebugFrameRef { frameId?: number; threadId: number }
export interface DebugInspectOptions { preferOverlay?: boolean; preferUserSource?: boolean }

const MAX_SCOPE_VARIABLES = 80;
const MAX_EVALUATED_LOCAL_CANDIDATES = 24;
const DISPLAY_DEBUG_VARIABLE_NAMES = new Map([["__m", "receiver"]]);
const GLOBAL_SCOPE = /^globals?$/i;
const LOCAL_SCOPE = /^locals?$/i;
const RETURN_VALUE_NAME = /^\(return\)\s+(.+)$/;
const VISIBLE_DEBUG_INTERNAL_VARIABLES = new Set(["__m"]);

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
  const scopes = frameId ? await scopeVariables(session, frameId, frame) : [];
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
  if (item.frameId) {
    const selected = frames.find((frame) => frame.id === item.frameId);
    if (selected && (!options.preferUserSource || isUserDebugSourceFrame(selected))) { return selected; }
  }
  return preferredStackFrame(frames, options);
}

/** Returns the best current execution frame from a DAP stack. */
function preferredStackFrame(frames: DapStackFrame[], options: DebugInspectOptions): DapStackFrame | undefined {
  return choosePreferredDebugSourceFrame(frames, { preferOverlay: options.preferOverlay, preferUserSource: options.preferUserSource, workspaceRoots: workspaceRootPaths() });
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
  return sourcePathForDebugSourceFrame(frame);
}

/** Returns active workspace root paths for user-frame selection. */
function workspaceRootPaths(): string[] {
  return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).filter(Boolean) ?? [];
}

/** Returns compact variables for the current frame scopes. */
async function scopeVariables(session: DebugRequestSession, frameId: number, frame?: DapStackFrame): Promise<DebugScopeInfo[]> {
  const response = await session.customRequest("scopes", { frameId }) as { scopes?: DapScope[] };
  const scopes: DebugScopeInfo[] = [];
  const localCandidates = await localCandidateNamesForFrame(frame);
  for (const scope of debugScopeCandidates(response.scopes ?? []).slice(0, 4)) {
    const variables = await variablesForReference(session, scope.variablesReference, MAX_SCOPE_VARIABLES);
    const visibleVariables = LOCAL_SCOPE.test(scope.name) ? await variablesWithLocalCandidates(session, frameId, variables, localCandidates) : variables;
    scopes.push({ name: scope.name, total: scope.namedVariables ?? scope.indexedVariables, variables: await variablesWithQuerySetPreviews(session, frameId, visibleVariables) });
  }
  return scopes;
}

/** Returns scopes worth showing, including debugpy Globals where shell variables live. */
function debugScopeCandidates(scopes: DapScope[]): DapScope[] {
  const selected: DapScope[] = [];
  for (const scope of scopes) {
    if (!scope.expensive || GLOBAL_SCOPE.test(scope.name)) {
      selected.push(scope);
    }
  }
  if (!selected.length && scopes.length) {
    selected.push(scopes[0]);
  }
  return uniqueScopes(selected);
}

/** Removes duplicate scope references while preserving debugpy order. */
function uniqueScopes(scopes: DapScope[]): DapScope[] {
  const seen = new Set<number>();
  const selected: DapScope[] = [];
  for (const scope of scopes) {
    if (!scope.variablesReference || seen.has(scope.variablesReference)) {
      continue;
    }
    seen.add(scope.variablesReference);
    selected.push(scope);
  }
  return selected;
}

/** Returns probable local names from user source up to the current paused line. */
async function localCandidateNamesForFrame(frame: DapStackFrame | undefined): Promise<string[]> {
  const sourcePath = frame ? sourcePathFor(frame) : "";
  if (!sourcePath || sourcePath.startsWith("<") || !frame || frame.line <= 0) {
    return [];
  }
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
    const lines: string[] = [];
    const end = Math.min(document.lineCount, frame.line);
    for (let index = 0; index < end; index += 1) {
      lines.push(document.lineAt(index).text);
    }
    return collectLocalCandidateNames(lines.join("\n"));
  } catch {
    return [];
  }
}

/** Collects simple Python binding names that users expect to see while paused. */
function collectLocalCandidateNames(source: string): string[] {
  const names = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    collectDefinitionName(line, names);
    collectForTargetNames(line, names);
    collectAssignmentTargetNames(line, names);
    collectAsTargetNames(line, names);
  }
  return [...names].slice(0, MAX_EVALUATED_LOCAL_CANDIDATES);
}

/** Adds function and class definition names to a local candidate set. */
function collectDefinitionName(line: string, names: Set<string>): void {
  const match = /^\s*(?:async\s+def|def|class)\s+([A-Za-z_]\w*)\b/.exec(line);
  if (match) {
    names.add(match[1]);
  }
}

/** Adds for-loop target names to a local candidate set. */
function collectForTargetNames(line: string, names: Set<string>): void {
  const match = /^\s*(?:async\s+)?for\s+(.+?)\s+in\b/.exec(line);
  if (match) {
    collectTargetNames(match[1], names);
  }
}

/** Adds assignment target names to a local candidate set. */
function collectAssignmentTargetNames(line: string, names: Set<string>): void {
  const match = /^\s*([^#:=<>!]+?)\s*(?::[^=]+)?=(?!=)/.exec(line);
  if (match) {
    collectTargetNames(match[1], names);
  }
}

/** Adds exception and context-manager alias names to a local candidate set. */
function collectAsTargetNames(line: string, names: Set<string>): void {
  for (const match of line.matchAll(/\bas\s+([A-Za-z_]\w*)\b/g)) {
    names.add(match[1]);
  }
}

/** Adds plain identifier targets, skipping attributes and indexed assignments. */
function collectTargetNames(target: string, names: Set<string>): void {
  for (const part of target.split(",")) {
    const name = part.trim();
    if (/^[A-Za-z_]\w*$/.test(name)) {
      names.add(name);
    }
  }
}

/** Appends evaluated shell-global bindings that debugpy omits from Locals in wrapped cells. */
async function variablesWithLocalCandidates(session: DebugRequestSession, frameId: number, variables: DebugVariableInfo[], candidates: string[]): Promise<DebugVariableInfo[]> {
  if (!candidates.length) {
    return variables;
  }
  const existing = new Set(variables.flatMap((variable) => [variable.name, variable.evaluateName].filter((name): name is string => Boolean(name))));
  const extra: DebugVariableInfo[] = [];
  for (const name of candidates) {
    if (existing.has(name) || isHiddenDebugVariable(name)) {
      continue;
    }
    const evaluated = await evaluateLocalCandidate(session, frameId, name);
    if (evaluated) {
      existing.add(name);
      extra.push(evaluated);
    }
  }
  return extra.length ? [...variables, ...extra] : variables;
}

/** Evaluates one plain name in the paused frame without failing the whole inspection. */
async function evaluateLocalCandidate(session: DebugRequestSession, frameId: number, name: string): Promise<DebugVariableInfo | undefined> {
  try {
    const response = await session.customRequest("evaluate", { context: "watch", expression: name, frameId }) as DapEvaluateResponse;
    if (!response.result) {
      return undefined;
    }
    return normalizeVariable({ evaluateName: name, name, type: response.type, value: response.result, variablesReference: response.variablesReference });
  } catch {
    return undefined;
  }
}

/** Reads one DAP variablesReference with a bounded count. */
async function variablesForReference(session: DebugRequestSession, variablesReference: number, count: number): Promise<DebugVariableInfo[]> {
  if (!variablesReference) {
    return [];
  }
  const response = await session.customRequest("variables", { count, start: 0, variablesReference }) as { variables?: DapVariable[] };
  return (response.variables ?? []).filter((variable) => !isHiddenDebugVariable(variable.name)).map(normalizeVariable);
}

/** Returns whether one debug variable is extension/debugpy plumbing rather than user state. */
function isHiddenDebugVariable(name: string): boolean {
  if (VISIBLE_DEBUG_INTERNAL_VARIABLES.has(name)) {
    return false;
  }
  return name.startsWith("__") || name.startsWith("_djs_") || name.startsWith("_django_shell_debugpy_");
}

/** Normalizes and truncates one DAP variable for webview display. */
function normalizeVariable(variable: DapVariable): DebugVariableInfo {
  return { evaluateName: variable.evaluateName || returnValueEvaluateExpression(variable.name), name: displayVariableName(variable), type: variable.type, value: displayVariableValue(variable.value, variable.variablesReference), variablesReference: variable.variablesReference };
}

/** Renames pydevd "(return) Class.method" step results into chain-friendly receiver/result labels. */
function displayVariableName(variable: DapVariable): string {
  const mapped = DISPLAY_DEBUG_VARIABLE_NAMES.get(variable.name);
  if (mapped) {
    return mapped;
  }
  const returnValue = RETURN_VALUE_NAME.exec(variable.name);
  if (!returnValue) {
    return variable.name;
  }
  const method = returnValue[1].split(".").pop() || returnValue[1];
  const looksLikeQuerySet = /QuerySet\b/.test(`${variable.type ?? ""} ${variable.value}`);
  return looksLikeQuerySet ? `${method}() receiver` : `${method}() result`;
}

/** Returns the paused-frame expression for one pydevd step return value when debugpy omits its evaluateName. */
function returnValueEvaluateExpression(name: string): string | undefined {
  // pydevd stores step return values in the paused frame's locals under this dict.
  const returnValue = RETURN_VALUE_NAME.exec(name);
  return returnValue ? `__pydevd_ret_val_dict[${JSON.stringify(returnValue[1])}]` : undefined;
}

/** Formats one debug variable value with its DAP reference when it can be expanded. */
function displayVariableValue(value: string, variablesReference?: number): string {
  const ref = Number(variablesReference) || 0;
  const text = truncateValue(value);
  return ref ? `${text}<${ref}>` : text;
}

/** Truncates multiline debug adapter values for compact tree rendering. */
function truncateValue(value: string): string {
  const singleLine = String(value).replace(/\s+/g, " ").trim();
  return singleLine.length > 500 ? `${singleLine.slice(0, 497)}...` : singleLine;
}

/** Adds bounded QuerySet result previews next to paused-frame variables. */
async function variablesWithQuerySetPreviews(session: DebugRequestSession, frameId: number, variables: DebugVariableInfo[]): Promise<DebugVariableInfo[]> {
  const expanded: DebugVariableInfo[] = [];
  for (const variable of variables) {
    expanded.push(variable);
    const modelExpression = djangoModelPreviewExpression(variable);
    if (modelExpression) {
      const preview = await evaluateDjangoModelPreview(session, frameId, variable.name, modelExpression);
      if (preview) {
        expanded.push(preview);
      }
    }
    const expression = querySetPreviewExpression(variable);
    if (expression) {
      const preview = await evaluateQuerySetPreview(session, frameId, variable.name, expression);
      if (preview) {
        expanded.push(preview);
      }
    }
  }
  return expanded;
}

/** Returns a frame expression that reads one panel variable; step-result expressions arrive pre-synthesized as evaluateName. */
function debugVariableExpression(variable: DebugVariableInfo): string {
  if (variable.evaluateName) {
    return variable.evaluateName;
  }
  return /^[A-Za-z_]\w*$/.test(variable.name) ? variable.name : "";
}

/** Returns a safe expression for a Django model value map, or undefined for non-evaluable variables. */
function djangoModelPreviewExpression(variable: DebugVariableInfo): string | undefined {
  const expression = debugVariableExpression(variable);
  if (!expression || !variable.variablesReference || /QuerySet\b|\b(list|dict|tuple|set|str|int|float|bool|NoneType|function|module|type)\b/i.test(`${variable.type ?? ""} ${variable.value}`)) {
    return undefined;
  }
  return `_djs_backend_module._debug_model_value_map(${expression})`;
}

/** Evaluates one Django model value map in the paused frame. */
async function evaluateDjangoModelPreview(session: DebugRequestSession, frameId: number, name: string, expression: string): Promise<DebugVariableInfo | undefined> {
  try {
    const response = await session.customRequest("evaluate", { context: "watch", expression, frameId }) as DapEvaluateResponse;
    if (!response.result || response.result === "{}") {
      return undefined;
    }
    return { name: `${name} model values`, type: response.type || "dict", value: displayVariableValue(response.result, response.variablesReference), variablesReference: response.variablesReference };
  } catch {
    return undefined;
  }
}

/** Returns a safe expression for a QuerySet variable preview, or undefined for non-QuerySet values. */
function querySetPreviewExpression(variable: DebugVariableInfo): string | undefined {
  // Suffix match: custom queryset classes (Manager.from_queryset) repr as e.g. <OrderQuerySet [...]> with no word boundary.
  const looksLikeQuerySet = /QuerySet\b/.test(`${variable.type ?? ""} ${variable.value}`);
  if (!looksLikeQuerySet) {
    return undefined;
  }
  const expression = debugVariableExpression(variable);
  return expression ? `__import__('builtins').list((${expression})[:10])` : undefined;
}

/** Evaluates one bounded QuerySet preview in the paused frame. */
async function evaluateQuerySetPreview(session: DebugRequestSession, frameId: number, name: string, expression: string): Promise<DebugVariableInfo | undefined> {
  try {
    const response = await session.customRequest("evaluate", { context: "watch", expression, frameId }) as DapEvaluateResponse;
    if (!response.result) {
      return undefined;
    }
    return { name: `${name}[:10]`, querysetPreview: true, type: response.type || "list", value: displayVariableValue(response.result, response.variablesReference), variablesReference: response.variablesReference };
  } catch {
    return undefined;
  }
}

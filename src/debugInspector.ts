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
const MAX_QUERYSET_PREVIEW_CACHE = 256;
const DISPLAY_DEBUG_VARIABLE_NAMES = new Map([["__m", "receiver"]]);
const GLOBAL_SCOPE = /^globals?$/i;
const LOCAL_SCOPE = /^locals?$/i;
const RETURN_VALUE_NAME = /^\(return\)\s+(.+)$/;
const VISIBLE_DEBUG_INTERNAL_VARIABLES = new Set(["__m"]);

type DebugVariableLevel = "children" | "scope";

interface DebugInspectionMemo {
  querysetPreviews: Map<string, { type?: string; value: string } | undefined>;
  scopes: Map<number, Promise<DebugScopeInfo[]>>;
  stacks: Map<number, Promise<DapStackFrame[]>>;
}

// Session-scoped inspection caches. stacks/scopes share one DAP read per pause across the stopped-event chain, the
// active-stack-item chain, and diagnostics logging; querysetPreviews persists across steps keyed by the variable repr so
// unchanged QuerySets skip their per-step database re-query. The WeakMap releases everything with the session object.
const INSPECTION_MEMO = new WeakMap<DebugRequestSession, DebugInspectionMemo>();

/** Drops the per-pause stack/scope memos so the next stopped or continued event re-reads live debugger state. */
export function invalidateDebugInspection(session: DebugRequestSession | undefined): void {
  if (!session) {
    return;
  }
  const memo = INSPECTION_MEMO.get(session);
  if (memo) {
    memo.scopes.clear();
    memo.stacks.clear();
  }
}

/** Returns the per-session inspection memo, creating it on first use. */
function inspectionMemoFor(session: DebugRequestSession): DebugInspectionMemo {
  let memo = INSPECTION_MEMO.get(session);
  if (!memo) {
    memo = { querysetPreviews: new Map(), scopes: new Map(), stacks: new Map() };
    INSPECTION_MEMO.set(session, memo);
  }
  return memo;
}

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
  return variablesForReference(session, variablesReference, 120, "children");
}

/** Returns compact stack rows for diagnostics, reusing the same-pause stack memo instead of a second stackTrace request. */
export async function debugStackSummary(session: DebugRequestSession, threadId: number): Promise<Array<{ id: number; line: number; name: string; path: string }>> {
  return (await stackFramesFor(session, threadId)).map((frame) => ({ id: frame.id, line: frame.line, name: frame.name, path: sourcePathFor(frame) }));
}

/** Returns the current DAP stack frames for a stopped thread, shared per pause across concurrent inspections. */
function stackFramesFor(session: DebugRequestSession, threadId: number): Promise<DapStackFrame[]> {
  const memo = inspectionMemoFor(session);
  const cached = memo.stacks.get(threadId);
  if (cached) {
    return cached;
  }
  const request = Promise.resolve(session.customRequest("stackTrace", { levels: 30, startFrame: 0, threadId })).then((response) => (response as { stackFrames?: DapStackFrame[] }).stackFrames ?? []);
  memo.stacks.set(threadId, request);
  request.catch(() => memo.stacks.delete(threadId));
  return request;
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

/** Returns compact variables for the current frame scopes, shared per pause so parallel inspection chains reuse one read. */
function scopeVariables(session: DebugRequestSession, frameId: number, frame?: DapStackFrame): Promise<DebugScopeInfo[]> {
  const memo = inspectionMemoFor(session);
  const cached = memo.scopes.get(frameId);
  if (cached) {
    return cached;
  }
  const request = readScopeVariables(session, frameId, frame);
  memo.scopes.set(frameId, request);
  request.catch(() => memo.scopes.delete(frameId));
  return request;
}

/** Reads frame scopes concurrently; only Locals get candidate/preview enrichment — the Django shell's Globals hold every accumulated ORM object, and per-variable evaluates plus QuerySet re-queries there made each ORM-mode step crawl. */
async function readScopeVariables(session: DebugRequestSession, frameId: number, frame?: DapStackFrame): Promise<DebugScopeInfo[]> {
  const response = await session.customRequest("scopes", { frameId }) as { scopes?: DapScope[] };
  const localCandidates = await localCandidateNamesForFrame(frame);
  return Promise.all(debugScopeCandidates(response.scopes ?? []).slice(0, 4).map(async (scope) => {
    const variables = await variablesForReference(session, scope.variablesReference, MAX_SCOPE_VARIABLES);
    const local = LOCAL_SCOPE.test(scope.name);
    const visibleVariables = local ? await variablesWithLocalCandidates(session, frameId, variables, localCandidates) : variables;
    return { name: scope.name, total: scope.namedVariables ?? scope.indexedVariables, variables: local ? await variablesWithQuerySetPreviews(session, frameId, visibleVariables) : visibleVariables };
  }));
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

/** Appends evaluated shell-global bindings that debugpy omits from Locals in wrapped cells, evaluating candidates concurrently so remote round trips overlap. */
async function variablesWithLocalCandidates(session: DebugRequestSession, frameId: number, variables: DebugVariableInfo[], candidates: string[]): Promise<DebugVariableInfo[]> {
  if (!candidates.length) {
    return variables;
  }
  const existing = new Set(variables.flatMap((variable) => [variable.name, variable.evaluateName].filter((name): name is string => Boolean(name))));
  const missing = candidates.filter((name) => !existing.has(name) && !isHiddenDebugVariable(name));
  const evaluated = await Promise.all(missing.map((name) => evaluateLocalCandidate(session, frameId, name)));
  const extra = evaluated.filter((variable): variable is DebugVariableInfo => Boolean(variable));
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
async function variablesForReference(session: DebugRequestSession, variablesReference: number, count: number, level: DebugVariableLevel = "scope"): Promise<DebugVariableInfo[]> {
  if (!variablesReference) {
    return [];
  }
  const response = await session.customRequest("variables", { count, start: 0, variablesReference }) as { variables?: DapVariable[] };
  return (response.variables ?? []).filter((variable) => !isHiddenDebugVariable(variable.name, level)).map(normalizeVariable);
}

/** Returns whether one debug variable is extension/debugpy plumbing rather than user state. Dunder members stay visible under an explicitly expanded node ("children"), otherwise debugpy groups like "special variables" expand to nothing. */
function isHiddenDebugVariable(name: string, level: DebugVariableLevel = "scope"): boolean {
  if (VISIBLE_DEBUG_INTERNAL_VARIABLES.has(name)) {
    return false;
  }
  if (name.startsWith("_djs_") || name.startsWith("_django_shell_debugpy_")) {
    return true;
  }
  return level === "scope" && name.startsWith("__");
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

/** Adds bounded QuerySet and model previews next to paused-frame variables, evaluating variables concurrently. */
async function variablesWithQuerySetPreviews(session: DebugRequestSession, frameId: number, variables: DebugVariableInfo[]): Promise<DebugVariableInfo[]> {
  const rows = await Promise.all(variables.map(async (variable) => {
    const entry: DebugVariableInfo[] = [variable];
    const modelExpression = djangoModelPreviewExpression(variable);
    if (modelExpression) {
      const preview = await evaluateDjangoModelPreview(session, frameId, variable.name, modelExpression);
      if (preview) {
        entry.push(preview);
      }
    }
    const expression = querySetPreviewExpression(variable);
    if (expression) {
      const preview = await cachedQuerySetPreview(session, frameId, variable, expression);
      if (preview) {
        entry.push(preview);
      }
    }
    return entry;
  }));
  return rows.flat();
}

/** Returns a QuerySet preview from the per-session cache while the variable repr is unchanged, else evaluates it live. A QuerySet slice runs a fresh database query, so reuse turns one query per QuerySet per step into one per QuerySet; cached previews carry repr text only (no variablesReference). */
async function cachedQuerySetPreview(session: DebugRequestSession, frameId: number, variable: DebugVariableInfo, expression: string): Promise<DebugVariableInfo | undefined> {
  const memo = inspectionMemoFor(session);
  const key = `${expression}|${stripReferenceSuffix(variable.value)}`;
  if (memo.querysetPreviews.has(key)) {
    const cached = memo.querysetPreviews.get(key);
    return cached && { name: `${variable.name}[:10]`, querysetPreview: true, type: cached.type, value: cached.value };
  }
  const preview = await evaluateQuerySetPreview(session, frameId, variable.name, expression);
  if (memo.querysetPreviews.size >= MAX_QUERYSET_PREVIEW_CACHE) {
    memo.querysetPreviews.clear();
  }
  memo.querysetPreviews.set(key, preview && { type: preview.type, value: stripReferenceSuffix(preview.value) });
  return preview;
}

/** Removes the trailing `<ref>` decoration so cache keys and cached texts survive per-pause reference churn. */
function stripReferenceSuffix(value: string): string {
  return value.replace(/<\d+>$/, "");
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

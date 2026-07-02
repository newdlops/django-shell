// DAP step-in target resolution for Django shell debugger controls.

import * as vscode from "vscode";
import type { DisposableDebugRequestSession } from "./debugAdapterTypes";
import type { DiagnosticLogger } from "./diagnostics";
import { isUserDebugSourcePath, sourcePathForDebugSourceFrame, type DebugSourceFrame } from "./debugSourceFrames";
import { chooseStepInTarget, pythonDirectCallIdentifierSpans, pythonIdentifierSpans, pythonImportedOrDefinedNames, type DebugStepInTarget, type DebugSourceNameSpan } from "./debugStepTargetSelection";
import { overlayAnalysisUri, overlayEditorUri } from "./overlayBackingFiles";

interface DapStackFrame extends DebugSourceFrame {
  id: number;
  line: number;
  source?: { name?: string; path?: string };
}

interface StepTargetSource {
  analysis: boolean;
  callNames: string[];
  definitionNames: string[];
  line: string;
  names: string[];
}

interface StepTargetProviderSource {
  analysis: boolean;
  document: vscode.TextDocument;
  providerLine: number;
  visibleLine: string;
  visibleLineCount: number;
  visibleText: string;
}

export interface StepInArguments {
  targetId?: number;
  threadId: number;
}

/** Builds a DAP stepIn request, targeting a user-source function when debugpy exposes one. */
export async function buildStepInArguments(session: DisposableDebugRequestSession | vscode.DebugSession, threadId: number, logger?: DiagnosticLogger): Promise<StepInArguments> {
  const frame = await currentStackFrame(session, threadId);
  if (!frame) { return { threadId }; }
  const targetId = await preferredUserStepInTargetId(session, frame, logger);
  return targetId !== undefined ? { targetId, threadId } : { threadId };
}

/** Reads the top stack frame for the stopped thread. */
async function currentStackFrame(session: DisposableDebugRequestSession | vscode.DebugSession, threadId: number): Promise<DapStackFrame | undefined> {
  try {
    const response = await session.customRequest("stackTrace", { levels: 1, startFrame: 0, threadId }) as { stackFrames?: DapStackFrame[] };
    return response.stackFrames?.[0];
  } catch {
    return undefined;
  }
}

/** Returns a step-in target id whose label or source range matches a user definition. */
async function preferredUserStepInTargetId(session: DisposableDebugRequestSession | vscode.DebugSession, frame: DapStackFrame, logger?: DiagnosticLogger): Promise<number | undefined> {
  const targets = await stepInTargetsForFrame(session, frame.id);
  if (!targets.length) { logger?.log("debug.stepTargets", { frameId: frame.id, frameLine: frame.line, reason: "no-targets" }); return undefined; }
  const source = await userDefinitionTargetNamesForFrame(frame);
  const selectionNames = source.callNames.length ? source.callNames : source.names;
  const selected = chooseStepInTarget(targets, selectionNames, frame.line, source.line);
  logger?.log("debug.stepTargets", { analysis: source.analysis, callCandidates: JSON.stringify(source.callNames), candidates: JSON.stringify(source.names), definitionCandidates: JSON.stringify(source.definitionNames), frameId: frame.id, frameLine: frame.line, selected: selected ? selected.id : "none", selectionCandidates: JSON.stringify(selectionNames), targets: JSON.stringify(targets.map(targetFields)) });
  return selected?.id;
}

/** Reads DAP step-in targets for the current frame. */
async function stepInTargetsForFrame(session: DisposableDebugRequestSession | vscode.DebugSession, frameId: number): Promise<DebugStepInTarget[]> {
  try {
    const response = await session.customRequest("stepInTargets", { frameId }) as { targets?: DebugStepInTarget[] };
    return response.targets ?? [];
  } catch {
    return [];
  }
}

/** Returns source-line symbol names that resolve to user source definitions. */
async function userDefinitionTargetNamesForFrame(frame: DapStackFrame): Promise<StepTargetSource> {
  const sourcePath = sourcePathForDebugSourceFrame(frame);
  if (!sourcePath || sourcePath.startsWith("<") || frame.line <= 0) { return emptyStepTargetSource(false); }
  try {
    const source = await providerSourceForFrame(sourcePath, frame.line);
    const document = source.document;
    const lineIndex = Math.max(0, frame.line - 1);
    if (lineIndex >= source.visibleLineCount || source.providerLine >= document.lineCount) { return emptyStepTargetSource(source.analysis); }
    const line = source.visibleLine;
    const definitionNames = await userDefinitionNamesForLine(document, source.providerLine, line);
    const callNames = fallbackDirectCallNames(line, source.visibleText, definitionNames);
    return { analysis: source.analysis, callNames, definitionNames, line, names: uniqueNames([...definitionNames, ...callNames]) };
  } catch {
    return emptyStepTargetSource(false);
  }
}

/** Returns the document and line used for definition lookup from one paused frame. */
async function providerSourceForFrame(sourcePath: string, visibleLine: number): Promise<StepTargetProviderSource> {
  const editor = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
  const visibleLineIndex = Math.max(0, visibleLine - 1);
  const visibleText = visibleLineIndex < editor.lineCount ? editor.lineAt(visibleLineIndex).text : "";
  const editorText = editor.getText();
  if (samePath(sourcePath, overlayEditorUri().fsPath)) {
    const analysis = await vscode.workspace.openTextDocument(overlayAnalysisUri());
    const offset = Math.max(0, analysis.lineCount - editor.lineCount);
    return { analysis: true, document: analysis, providerLine: visibleLineIndex + offset, visibleLine: visibleText, visibleLineCount: editor.lineCount, visibleText: editorText };
  }
  return { analysis: false, document: editor, providerLine: visibleLineIndex, visibleLine: visibleText, visibleLineCount: editor.lineCount, visibleText: editorText };
}

/** Finds source-line identifiers whose definitions point at user source files. */
async function userDefinitionNamesForLine(document: vscode.TextDocument, lineIndex: number, line: string): Promise<string[]> {
  const names = new Set<string>();
  for (const span of pythonIdentifierSpans(line).slice(0, 40)) {
    if (await spanHasUserDefinition(document, lineIndex, span)) { names.add(span.name); }
  }
  return [...names];
}

/** Returns direct call names imported or defined by the visible source. */
function fallbackDirectCallNames(line: string, visibleText: string, definitionNames: string[]): string[] {
  const knownNames = pythonImportedOrDefinedNames(visibleText);
  for (const name of definitionNames) { knownNames.add(name); }
  return pythonDirectCallIdentifierSpans(line)
    .map((span) => span.name)
    .filter((name) => knownNames.has(name));
}

/** Returns whether any position inside an identifier resolves to a user source file. */
async function spanHasUserDefinition(document: vscode.TextDocument, lineIndex: number, span: DebugSourceNameSpan): Promise<boolean> {
  const columns = uniqueNumbers([span.start, Math.min(span.end - 1, span.start + 1), Math.floor((span.start + span.end - 1) / 2)]);
  for (const column of columns) {
    const definitions = await definitionLocations(document, new vscode.Position(lineIndex, column));
    if (definitions.some((definition) => isUserDebugSourcePath(definition.uri.fsPath))) { return true; }
  }
  return false;
}

/** Reads VS Code definition locations at one source position. */
async function definitionLocations(document: vscode.TextDocument, position: vscode.Position): Promise<Array<{ uri: vscode.Uri }>> {
  try {
    const result = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDefinitionProvider", document.uri, position);
    return (result ?? []).map(definitionUri).filter((item): item is { uri: vscode.Uri } => !!item);
  } catch {
    return [];
  }
}

/** Normalizes Location and LocationLink responses to a URI holder. */
function definitionUri(item: vscode.Location | vscode.LocationLink): { uri: vscode.Uri } | undefined {
  if ("uri" in item) { return { uri: item.uri }; }
  if ("targetUri" in item) { return { uri: item.targetUri }; }
  return undefined;
}

/** Returns compact fields for one DAP step-in target. */
function targetFields(target: DebugStepInTarget): Record<string, unknown> {
  return { column: target.column ?? 0, id: target.id, label: target.label, line: target.line ?? 0 };
}

/** Returns an empty step target source summary. */
function emptyStepTargetSource(analysis: boolean): StepTargetSource {
  return { analysis, callNames: [], definitionNames: [], line: "", names: [] };
}

/** Returns names without duplicates while preserving order. */
function uniqueNames(names: string[]): string[] {
  return [...new Set(names)];
}

/** Returns numbers without duplicates while preserving order. */
function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

/** Returns whether two filesystem paths are equal after platform-neutral normalization. */
function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase();
}

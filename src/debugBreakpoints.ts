// Debug adapter breakpoint synchronization for generated Django shell sources.

import * as path from "path";
import * as vscode from "vscode";
import type { DebugRequestSession } from "./debugAdapterTypes";
import type { DiagnosticLogger } from "./diagnostics";

interface DapBreakpoint {
  column?: number;
  id?: number;
  line?: number;
  message?: string;
  verified?: boolean;
}

interface DapSetBreakpointsResponse {
  breakpoints?: DapBreakpoint[];
}

export interface DebugBreakpointSyncRequest {
  breakpoints?: DebugBreakpointLocation[];
  lineOffset: number;
  lines: number[];
  logger?: DiagnosticLogger;
  reason: string;
  session?: DebugRequestSession;
  sourceText?: string;
  uri: vscode.Uri;
}

export interface DebugBreakpointLocation {
  column?: number;
  line: number;
}

/** Converts stale relative overlay breakpoint lines into generated source lines. */
export function normalizeOverlayBreakpointLine(line: number, lineOffset: number): number {
  return line > 0 && line <= lineOffset ? line + lineOffset : line;
}

/** Pushes generated-source breakpoints into debugpy and writes a parseable diagnostic summary. */
export async function syncDebugBreakpoints(request: DebugBreakpointSyncRequest): Promise<void> {
  const sourceLines = lineCount(request.sourceText);
  const requestedBreakpoints = normalizeBreakpointLocations(request.breakpoints ?? request.lines.map((line) => ({ line })));
  const breakpoints = sourceLines ? requestedBreakpoints.filter((breakpoint) => breakpoint.line <= sourceLines) : requestedBreakpoints;
  const lines = [...new Set(breakpoints.map((breakpoint) => breakpoint.line))].sort((left, right) => left - right);
  if (!request.session) {
    request.logger?.log("debug.breakpoints.skip", { breakpoints: JSON.stringify(breakpoints), lines: JSON.stringify(lines), path: request.uri.fsPath, reason: request.reason, session: false });
    return;
  }
  const payload = { breakpoints: breakpoints.map((breakpoint) => breakpoint.column ? { column: breakpoint.column, line: breakpoint.line } : { line: breakpoint.line }), lines, source: { name: path.basename(request.uri.fsPath), path: request.uri.fsPath }, sourceModified: true };
  request.logger?.log("debug.breakpoints.request", { breakpoints: JSON.stringify(breakpoints), dropped: requestedBreakpoints.length - breakpoints.length, lineOffset: request.lineOffset, lines: JSON.stringify(lines), path: request.uri.fsPath, reason: request.reason, requested: JSON.stringify(requestedBreakpoints), sessionId: request.session.id, sourceChars: request.sourceText?.length ?? 0, sourceLines });
  try {
    const response = await request.session.customRequest("setBreakpoints", payload) as DapSetBreakpointsResponse;
    const breakpoints = response.breakpoints ?? [];
    request.logger?.log("debug.breakpoints.response", { reason: request.reason, response: JSON.stringify(breakpoints.map(breakpointFields)), sessionId: request.session.id, unverified: JSON.stringify(breakpoints.filter((breakpoint) => !breakpoint.verified).map(breakpointFields)), verified: breakpoints.filter((breakpoint) => breakpoint.verified).length });
  } catch (error) {
    request.logger?.log("debug.breakpoints.error", { error: error instanceof Error ? error.message : String(error), reason: request.reason, sessionId: request.session.id });
  }
}

/** Returns compact primitive fields for one adapter breakpoint response. */
function breakpointFields(breakpoint: DapBreakpoint): { column: number; id: number; line: number; message: string; verified: boolean } {
  return { column: breakpoint.column ?? 0, id: breakpoint.id ?? 0, line: breakpoint.line ?? 0, message: breakpoint.message ?? "", verified: Boolean(breakpoint.verified) };
}

/** Returns unique positive source breakpoint locations sorted by line and column. */
function normalizeBreakpointLocations(items: DebugBreakpointLocation[]): DebugBreakpointLocation[] {
  const seen = new Set<string>();
  const result: DebugBreakpointLocation[] = [];
  for (const item of items) {
    const line = Math.floor(Number(item.line));
    const column = Math.max(0, Math.floor(Number(item.column) || 0));
    const key = `${line}:${column}`;
    if (!Number.isFinite(line) || line <= 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(column ? { column, line } : { line });
  }
  return result.sort((left, right) => left.line - right.line || (left.column ?? 0) - (right.column ?? 0));
}

/** Counts one-based text lines for diagnostics. */
function lineCount(text: string | undefined): number {
  return text ? text.split(/\r?\n/).length : 0;
}

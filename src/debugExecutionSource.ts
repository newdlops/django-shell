// Builds line-stable debugger source snapshots for one independently executed shell unit.

/** Describes the one-based source span and parseable text owned by one debug execution. */
export interface DebugExecutionScope {
  endLine: number;
  sourceText: string;
  startLine: number;
}

/** Builds a source snapshot containing only the selected unit at its original line numbers. */
export function debugExecutionScope(code: string, lineOffset = 0): DebugExecutionScope {
  const offset = Number.isFinite(lineOffset) ? Math.max(0, Math.floor(lineOffset)) : 0;
  const lineCount = Math.max(1, code.split(/\r\n|\n|\r/).length);
  return {
    endLine: offset + lineCount,
    sourceText: `${"\n".repeat(offset)}${code}${/\r\n$|[\n\r]$/.test(code) ? "" : "\n"}`,
    startLine: offset + 1
  };
}

/** Keeps only breakpoints that belong to the independently executed source unit. */
export function debugExecutionBreakpoints<T extends { line: number }>(breakpoints: T[], scope: DebugExecutionScope | undefined): T[] {
  if (!scope) { return breakpoints; }
  return breakpoints.filter((breakpoint) => breakpoint.line >= scope.startLine && breakpoint.line <= scope.endLine);
}

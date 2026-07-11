// Pure helpers for preserving conditional, hit-count, and logpoint DAP metadata.

export interface DebugBreakpointLocation {
  column?: number;
  condition?: string;
  hitCondition?: string;
  line: number;
  logMessage?: string;
}

/** Returns a stable identity for one source breakpoint including behavior metadata. */
export function debugBreakpointKey(breakpoint: DebugBreakpointLocation): string {
  return JSON.stringify([breakpoint.line, breakpoint.column ?? 0, breakpoint.condition ?? "", breakpoint.hitCondition ?? "", breakpoint.logMessage ?? ""]);
}

/** Converts a normalized location into a standard DAP setBreakpoints entry. */
export function debugBreakpointPayload(breakpoint: DebugBreakpointLocation): Record<string, unknown> {
  const payload: Record<string, unknown> = { line: breakpoint.line };
  if (breakpoint.column) { payload.column = breakpoint.column; }
  if (breakpoint.condition) { payload.condition = breakpoint.condition; }
  if (breakpoint.hitCondition) { payload.hitCondition = breakpoint.hitCondition; }
  if (breakpoint.logMessage) { payload.logMessage = breakpoint.logMessage; }
  return payload;
}

// Pure execution-unit range detection shared by overlay language features.

/** Describes one zero-based shell execution-unit range. */
export interface OverlayExecutionUnitRange {
  end: number;
  start: number;
}

/** Returns the strict two-blank-delimited execution unit containing one source line. */
export function overlayExecutionUnitRange(text: string, focusLine: number, floorLine = 0): OverlayExecutionUnitRange | undefined {
  const lines = text.split(/\r\n|\n|\r/);
  if (!lines.length || !Number.isFinite(focusLine)) { return undefined; }
  const floor = Math.min(lines.length - 1, Math.max(0, Math.floor(floorLine)));
  const focus = Math.min(lines.length - 1, Math.max(floor, Math.floor(focusLine)));
  if (!lines[focus].trim() || blankSeparatorAt(lines, focus, floor)) { return undefined; }
  let start = cellStart(lines, focus, floor), end = cellEnd(lines, focus);
  while (start <= end && !lines[start].trim()) { start += 1; }
  while (end > start && !lines[end].trim()) { end -= 1; }
  return { end, start };
}

/** Returns whether one blank line belongs to a strict separator. */
function blankSeparatorAt(lines: string[], line: number, floor: number): boolean {
  if (lines[line]?.trim()) { return false; }
  let count = 1;
  for (let index = line - 1; index >= floor && !lines[index].trim(); index -= 1) { count += 1; }
  for (let index = line + 1; index < lines.length && !lines[index].trim(); index += 1) { count += 1; }
  return count >= 2;
}

/** Returns the first line after the nearest strict separator. */
function cellStart(lines: string[], line: number, floor: number): number {
  let blanks = 0;
  for (let index = line - 1; index >= floor; index -= 1) {
    if (!lines[index].trim()) { blanks += 1; if (blanks >= 2) { return index + 2; } } else { blanks = 0; }
  }
  return floor;
}

/** Returns the last line before the nearest strict separator. */
function cellEnd(lines: string[], line: number): number {
  let blanks = 0;
  for (let index = line + 1; index < lines.length; index += 1) {
    if (!lines[index].trim()) { blanks += 1; if (blanks >= 2) { return index - 2; } } else { blanks = 0; }
  }
  return lines.length - 1;
}

// Focused execution-unit projection for shell-aware Python language analysis.

/** Describes one zero-based execution-unit range in visible overlay text. */
export interface OverlayExecutionUnitRange {
  end: number;
  start: number;
}

/** Returns the strict two-blank-delimited execution unit containing one line. */
export function overlayExecutionUnitRange(text: string, focusLine: number | undefined): OverlayExecutionUnitRange | undefined {
  const lines = sourceLines(text);
  if (!lines.length || typeof focusLine !== "number" || !Number.isFinite(focusLine)) {
    return undefined;
  }
  let probe = Math.min(lines.length - 1, Math.max(0, Math.floor(focusLine)));
  if (blankSeparatorAt(lines, probe)) {
    return undefined;
  }
  while (probe > 0 && !lines[probe].trim()) {
    probe -= 1;
  }
  if (!lines[probe].trim()) {
    return undefined;
  }
  let start = cellStart(lines, probe);
  let end = cellEnd(lines, probe);
  while (start <= end && !lines[start].trim()) { start += 1; }
  while (end > start && !lines[end].trim()) { end -= 1; }
  return { end, start };
}

/** Keeps only the focused shell unit while preserving every original line ending and line number. */
export function projectOverlayAnalysisText(text: string, focusLine: number | undefined): string {
  const range = overlayExecutionUnitRange(text, focusLine);
  const parts = text.split(/(\r\n|\n|\r)/);
  for (let line = 0, index = 0; index < parts.length; index += 2, line += 1) {
    if (!range || line < range.start || line > range.end) {
      parts[index] = "";
    }
  }
  return parts.join("");
}

/** Splits source into logical lines without retaining newline characters. */
function sourceLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** Returns whether one blank line belongs to a run of at least two separator lines. */
function blankSeparatorAt(lines: string[], line: number): boolean {
  if (lines[line]?.trim()) { return false; }
  let count = 1;
  for (let index = line - 1; index >= 0 && !lines[index].trim(); index -= 1) { count += 1; }
  for (let index = line + 1; index < lines.length && !lines[index].trim(); index += 1) { count += 1; }
  return count >= 2;
}

/** Returns the first line after the nearest strict two-blank separator. */
function cellStart(lines: string[], line: number): number {
  let blanks = 0;
  for (let index = line - 1; index >= 0; index -= 1) {
    if (!lines[index].trim()) {
      blanks += 1;
      if (blanks >= 2) { return index + 2; }
    } else {
      blanks = 0;
    }
  }
  return 0;
}

/** Returns the last line before the nearest strict two-blank separator. */
function cellEnd(lines: string[], line: number): number {
  let blanks = 0;
  for (let index = line + 1; index < lines.length; index += 1) {
    if (!lines[index].trim()) {
      blanks += 1;
      if (blanks >= 2) { return index - 2; }
    } else {
      blanks = 0;
    }
  }
  return lines.length - 1;
}

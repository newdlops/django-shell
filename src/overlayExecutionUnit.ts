// Pure execution-unit range detection shared by overlay language features.

/** Describes one zero-based shell execution-unit range. */
export interface OverlayExecutionUnitRange {
  end: number;
  start: number;
}

/** Returns the execution unit containing one source line. */
export function overlayExecutionUnitRange(text: string, focusLine: number, floorLine = 0): OverlayExecutionUnitRange | undefined {
  const lines = text.split(/\r\n|\n|\r/);
  if (!lines.length || !Number.isFinite(focusLine)) { return undefined; }
  const floor = Math.min(lines.length - 1, Math.max(0, Math.floor(floorLine)));
  const focus = Math.min(lines.length - 1, Math.max(floor, Math.floor(focusLine)));
  if (blankSeparatorAt(lines, focus, floor)) { return undefined; }
  let probe = focus;
  while (probe >= floor && !lines[probe].trim()) { probe -= 1; }
  if (probe < floor) { return undefined; }
  let start = cellStart(lines, probe, floor), end = cellEnd(lines, probe, floor);
  while (start <= end && !lines[start].trim()) { start += 1; }
  while (end > start && !lines[end].trim()) { end -= 1; }
  return { end, start };
}

/** Returns the number of blank lines needed after one completed source line. */
export function overlayExecutionUnitSeparatorBlankLines(text: string, endLine: number, floorLine = 0): number {
  const lines = text.split(/\r\n|\n|\r/);
  if (!lines.length) { return 2; }
  const floor = Math.min(lines.length - 1, Math.max(0, Math.floor(floorLine)));
  const end = Math.min(lines.length - 1, Math.max(floor, Math.floor(endLine)));
  return importStatementEndsAt(lines, end, floor) ? 3 : 2;
}

/** Returns whether one blank line belongs to an execution-unit separator. */
function blankSeparatorAt(lines: string[], line: number, floor: number): boolean {
  if (lines[line]?.trim()) { return false; }
  const run = blankRunAt(lines, line, floor);
  return run.end - run.start + 1 >= separatorBlankLinesBefore(lines, run.start, floor);
}

/** Returns the first line after the nearest execution-unit separator. */
function cellStart(lines: string[], line: number, floor: number): number {
  for (let index = line - 1; index >= floor; index -= 1) {
    if (lines[index].trim()) { continue; }
    const run = blankRunAt(lines, index, floor);
    if (run.end - run.start + 1 >= separatorBlankLinesBefore(lines, run.start, floor)) { return run.end + 1; }
    index = run.start;
  }
  return floor;
}

/** Returns the last line before the nearest execution-unit separator. */
function cellEnd(lines: string[], line: number, floor: number): number {
  for (let index = line + 1; index < lines.length; index += 1) {
    if (lines[index].trim()) { continue; }
    const run = blankRunAt(lines, index, floor);
    if (run.end - run.start + 1 >= separatorBlankLinesBefore(lines, run.start, floor)) { return run.start - 1; }
    index = run.end;
  }
  return lines.length - 1;
}

/** Returns the complete blank run surrounding one line. */
function blankRunAt(lines: string[], line: number, floor: number): OverlayExecutionUnitRange {
  let start = line, end = line;
  while (start > floor && !lines[start - 1].trim()) { start -= 1; }
  while (end + 1 < lines.length && !lines[end + 1].trim()) { end += 1; }
  return { end, start };
}

/** Returns the separator width required after the statement before a blank run. */
function separatorBlankLinesBefore(lines: string[], blankStart: number, floor: number): number {
  return importStatementEndsAt(lines, blankStart - 1, floor) ? 3 : 2;
}

/** Returns whether a top-level import statement ends on the supplied line. */
function importStatementEndsAt(lines: string[], endLine: number, floor: number): boolean {
  if (endLine < floor || endLine >= lines.length || !lines[endLine].trim()) { return false; }
  while (endLine >= floor && /^\s*#/.test(lines[endLine])) { endLine -= 1; }
  if (endLine < floor || !lines[endLine].trim()) { return false; }
  let outstandingBrackets = 0;
  let hasSemicolon = false;
  let start = endLine;
  for (let line = endLine; line >= floor; line -= 1) {
    const code = pythonCode(lines[line]);
    hasSemicolon ||= code.includes(";");
    outstandingBrackets -= bracketDelta(code);
    start = line;
    const previousContinues = line > floor && /\\\s*$/.test(pythonCode(lines[line - 1]));
    if (outstandingBrackets <= 0 && !previousContinues) { break; }
  }
  return !hasSemicolon && /^(?:import\s+|from\s+\S+\s+import\b)/.test(pythonCode(lines[start]));
}

/** Removes simple strings and comments before structural Python inspection. */
function pythonCode(line: string): string {
  let quote = "", result = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index], previous = index > 0 ? line[index - 1] : "";
    if (quote) { if (character === quote && previous !== "\\") { quote = ""; } continue; }
    if (character === "#") { break; }
    if (character === "'" || character === '"') { quote = character; continue; }
    result += character;
  }
  return result.trimEnd();
}

/** Returns bracket balance for one string-and-comment-free Python line. */
function bracketDelta(line: string): number {
  let delta = 0;
  for (const character of line) {
    if (character === "(" || character === "[" || character === "{") { delta += 1; }
    if (character === ")" || character === "]" || character === "}") { delta -= 1; }
  }
  return delta;
}

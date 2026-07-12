// Renderer-side execution-unit boundaries shared by overlay editor features.

/** Builds JavaScript helpers for import-aware execution-unit boundaries. */
export function overlayExecutionUnitRendererSource(): string {
  return `
    /** Returns the execution unit at one model line. */
    function __dsoExecutionUnitRange(model, focusLine, floorLine) {
      if (!model || !model.getLineContent || !model.getLineCount) { return null; }
      const floor = Math.max(1, Math.min(model.getLineCount(), Number(floorLine) || 1));
      const focus = Math.max(floor, Math.min(model.getLineCount(), Number(focusLine) || floor));
      if (__dsoExecutionUnitSeparatorAt(model, focus, floor)) { return null; }
      let probe = focus;
      while (probe >= floor && !String(model.getLineContent(probe) || "").trim()) { probe--; }
      if (probe < floor) { return null; }
      let start = floor;
      for (let line = probe - 1; line >= floor; line--) {
        if (String(model.getLineContent(line) || "").trim()) { continue; }
        const run = __dsoExecutionUnitBlankRun(model, line, floor);
        if (__dsoExecutionUnitRunSeparates(model, run, floor)) { start = run.end + 1; break; }
        line = run.start;
      }
      let end = model.getLineCount();
      for (let line = probe + 1; line <= model.getLineCount(); line++) {
        if (String(model.getLineContent(line) || "").trim()) { continue; }
        const run = __dsoExecutionUnitBlankRun(model, line, floor);
        if (__dsoExecutionUnitRunSeparates(model, run, floor)) { end = run.start - 1; break; }
        line = run.end;
      }
      while (start <= end && !String(model.getLineContent(start) || "").trim()) { start++; }
      while (end > start && !String(model.getLineContent(end) || "").trim()) { end--; }
      return start <= end ? { end: end, start: start } : null;
    }

    /** Returns whether one blank model line belongs to a unit separator. */
    function __dsoExecutionUnitSeparatorAt(model, lineNumber, floor) {
      if (String(model.getLineContent(lineNumber) || "").trim()) { return false; }
      return __dsoExecutionUnitRunSeparates(model, __dsoExecutionUnitBlankRun(model, lineNumber, floor), floor);
    }

    /** Returns the complete blank run surrounding one model line. */
    function __dsoExecutionUnitBlankRun(model, lineNumber, floor) {
      let start = lineNumber, end = lineNumber;
      while (start > floor && !String(model.getLineContent(start - 1) || "").trim()) { start--; }
      while (end < model.getLineCount() && !String(model.getLineContent(end + 1) || "").trim()) { end++; }
      return { end: end, start: start };
    }

    /** Returns whether a blank run is wide enough to separate execution units. */
    function __dsoExecutionUnitRunSeparates(model, run, floor) {
      return run.end - run.start + 1 >= __dsoExecutionUnitSeparatorBlankLines(model, run.start - 1, floor);
    }

    /** Returns the blank-line separator width required after one source line. */
    function __dsoExecutionUnitSeparatorBlankLines(model, endLine, floor) {
      return __dsoExecutionUnitImportEndsAt(model, endLine, floor) ? 3 : 2;
    }

    /** Returns whether a top-level import statement ends on one model line. */
    function __dsoExecutionUnitImportEndsAt(model, endLine, floor) {
      if (endLine < floor || endLine > model.getLineCount() || !String(model.getLineContent(endLine) || "").trim()) { return false; }
      while (endLine >= floor && /^\\s*#/.test(String(model.getLineContent(endLine) || ""))) { endLine--; }
      if (endLine < floor || !String(model.getLineContent(endLine) || "").trim()) { return false; }
      let outstandingBrackets = 0;
      let hasSemicolon = false;
      let start = endLine;
      for (let line = endLine; line >= floor; line--) {
        const code = __dsoExecutionUnitPythonCode(model.getLineContent(line));
        hasSemicolon = hasSemicolon || code.indexOf(";") >= 0;
        outstandingBrackets -= __dsoExecutionUnitBracketDelta(code);
        start = line;
        const previousCode = line > floor ? __dsoExecutionUnitPythonCode(model.getLineContent(line - 1)).trimEnd() : "";
        const previousContinues = previousCode.charAt(previousCode.length - 1) === "\\\\";
        if (outstandingBrackets <= 0 && !previousContinues) { break; }
      }
      return !hasSemicolon && /^(?:import\\s+|from\\s+\\S+\\s+import\\b)/.test(__dsoExecutionUnitPythonCode(model.getLineContent(start)));
    }

    /** Removes simple Python strings and comments for structural inspection. */
    function __dsoExecutionUnitPythonCode(line) {
      const source = String(line || "");
      let quote = "", result = "";
      for (let index = 0; index < source.length; index++) {
        const character = source[index], previous = index > 0 ? source[index - 1] : "";
        if (quote) { if (character === quote && previous !== "\\\\") { quote = ""; } continue; }
        if (character === "#") { break; }
        if (character === "'" || character === '"') { quote = character; continue; }
        result += character;
      }
      return result.trimEnd();
    }

    /** Returns bracket balance for string-and-comment-free Python source. */
    function __dsoExecutionUnitBracketDelta(line) {
      let delta = 0;
      for (let index = 0; index < String(line || "").length; index++) {
        const character = line[index];
        if (character === "(" || character === "[" || character === "{") { delta++; }
        if (character === ")" || character === "]" || character === "}") { delta--; }
      }
      return delta;
    }
  `;
}

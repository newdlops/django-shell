// Renderer-side Python statement range helpers for the Django shell overlay.
import { overlayExecutionUnitRendererSource } from "./workbenchOverlayExecutionUnitRenderer";

/** Builds JavaScript helpers that find shell-style Python execution ranges. */
export function overlayPythonRangeRendererSource(): string {
  return `
    ${overlayExecutionUnitRendererSource()}

    /** Returns a shell-style prompt label for one visible input line. */
    function __dsoPromptForLine(model, startLine, line, root) {
      if (line < startLine) { return ""; }
      if (!model || !model.getLineContent) { return ">>>"; }
      const preview = root && root.__dsoExecutionRangePreview;
      if (preview && line >= preview.start && line <= preview.end) {
        return line === preview.start ? ">>>" : "...";
      }
      const text = model.getLineContent(line);
      const cellStart = __dsoPromptCellStartLine(model, line, startLine);
      if (!text.trim()) {
        if (__dsoIndent(text) > 0) { return "..."; }
        if (__dsoPromptBlankInsideCell(model, line, startLine)) { return "..."; }
        if (line < model.getLineCount()) { return ""; }
        return root && root.__dsoMultilineMode ? "..." : ">>>";
      }
      return line > cellStart ? "..." : ">>>";
    }

    /** Returns the first prompt line for the current import-aware execution unit. */
    function __dsoPromptCellStartLine(model, lineNumber, floor) {
      const unit = __dsoExecutionUnitRange(model, lineNumber, floor);
      return unit ? unit.start : lineNumber;
    }

    /** Returns whether one blank line sits inside a pasted multiline input unit. */
    function __dsoPromptBlankInsideCell(model, lineNumber, floor) {
      const unit = __dsoExecutionUnitRange(model, lineNumber, floor);
      return !!(unit && lineNumber > unit.start && lineNumber < unit.end);
    }

    /** Returns the first line of the current statement, scoped to the input region. */
    function __dsoStatementFloor(model, startLine, line) {
      for (let index = line - 1; index > startLine; index--) {
        if (!model.getLineContent(index).trim()) { return index + 1; }
      }
      return startLine;
    }

    /** Returns the first user-editable line after the generated prelude. */
    function __dsoInputStartLine(root, model, lineNumber) {
      const stored = root && root.__dsoUserStartLine ? root.__dsoUserStartLine : __dsoFindInputStartLine(model);
      return Math.min(Math.max(1, stored), Math.max(1, Math.min(lineNumber, model.getLineCount())));
    }

    /** Returns the logical Python statement or block around the cursor. */
    function __dsoExecutionRange(root, model, lineNumber) {
      const floor = __dsoInputStartLine(root, model, lineNumber);
      const cursor = __dsoNonBlankCursorLine(model, Math.max(floor, lineNumber), floor);
      const start = __dsoStatementStart(model, cursor, floor);
      let end = __dsoStatementEnd(model, start, cursor);
      while (end > start && !model.getLineContent(end).trim()) { end--; }
      return { end: end, start: start };
    }

    /** Returns the closest non-empty cursor line without crossing the prelude boundary. */
    function __dsoNonBlankCursorLine(model, lineNumber, floor) {
      let line = Math.min(lineNumber, model.getLineCount());
      while (line > floor && !model.getLineContent(line).trim()) { line--; }
      return line;
    }

    /** Returns the leading whitespace width for one source line. */
    function __dsoIndent(line) {
      const match = String(line || "").match(/^\\s*/);
      return match ? match[0].length : 0;
    }

    /** Returns the indentation that should be used after one Python line. */
    function __dsoNextIndent(model, lineNumber) {
      const text = model && model.getLineContent ? model.getLineContent(Math.min(lineNumber, model.getLineCount())) : "";
      const match = String(text || "").match(/^\\s*/);
      const base = match ? match[0] : "";
      return __dsoBlockHeader(text) || __dsoBracketDelta(text, 0) > 0 ? base + "    " : base;
    }

    /** Returns whether a line starts a Python block suite. */
    function __dsoBlockHeader(line) {
      return /:\\s*(?:#.*)?$/.test(String(line || "").trimEnd());
    }

    /** Returns whether a line continues a prior compound statement. */
    function __dsoCompoundFollower(line) {
      return /^(?:elif|else|except|finally)\\b/.test(String(line || "").trimStart());
    }

    /** Returns the first line of the Python statement containing the cursor. */
    function __dsoStatementStart(model, lineNumber, floor) {
      const bracketStart = __dsoBracketStatementStart(model, lineNumber, floor);
      const line = model.getLineContent(bracketStart);
      let start = bracketStart;
      let indent = __dsoIndent(line);
      if (indent > 0 || __dsoCompoundFollower(line)) {
        for (let index = bracketStart - 1; index >= floor; index--) {
          const candidate = model.getLineContent(index);
          if (!candidate.trim()) { continue; }
          const candidateIndent = __dsoIndent(candidate);
          if (candidateIndent >= indent) { continue; }
          if (__dsoBlockHeader(candidate)) {
            start = index;
            indent = candidateIndent;
            if (indent === 0) { break; }
            continue;
          }
          break;
        }
      }
      return __dsoCompoundPrefixStart(model, start, floor);
    }

    /** Includes preceding if/try siblings for else, elif, except, and finally blocks. */
    function __dsoCompoundPrefixStart(model, start, floor) {
      if (!__dsoCompoundFollower(model.getLineContent(start))) { return start; }
      const baseIndent = __dsoIndent(model.getLineContent(start));
      for (let index = start - 1; index >= floor; index--) {
        const text = model.getLineContent(index);
        if (!text.trim()) { continue; }
        if (__dsoIndent(text) < baseIndent) { break; }
        if (__dsoIndent(text) === baseIndent && __dsoBlockHeader(text)) {
          start = index;
          if (!__dsoCompoundFollower(text)) { break; }
        }
      }
      return start;
    }

    /** Returns the last line of the Python statement containing the cursor. */
    function __dsoStatementEnd(model, start, cursor) {
      const bracketEnd = __dsoBracketStatementEnd(model, start, cursor);
      if (!__dsoBlockHeader(model.getLineContent(start))) { return bracketEnd; }
      const baseIndent = __dsoIndent(model.getLineContent(start));
      let end = Math.max(start, bracketEnd);
      for (let index = start + 1; index <= model.getLineCount(); index++) {
        const text = model.getLineContent(index);
        if (!text.trim()) { if (index <= cursor) { end = index; } continue; }
        const indent = __dsoIndent(text);
        if (indent <= baseIndent && index > start + 1 && !__dsoCompoundFollower(text)) { break; }
        end = Math.max(end, index);
      }
      return end;
    }

    /** Returns the top-level statement start for bracketed continuation lines. */
    function __dsoBracketStatementStart(model, lineNumber, floor) {
      let depth = 0;
      let start = lineNumber;
      for (let index = floor; index <= lineNumber; index++) {
        const text = model.getLineContent(index);
        if (text.trim() && depth === 0) { start = index; }
        depth = Math.max(0, depth + __dsoBracketDelta(text, depth));
      }
      return start;
    }

    /** Returns the statement end after bracketed continuations close. */
    function __dsoBracketStatementEnd(model, start, cursor) {
      let depth = 0;
      let end = Math.max(start, cursor);
      for (let index = start; index <= model.getLineCount(); index++) {
        const text = model.getLineContent(index);
        if (text.trim()) { end = index; }
        depth = Math.max(0, depth + __dsoBracketDelta(text, depth));
        if (index >= cursor && depth <= 0) { break; }
      }
      return end;
    }

    /** Returns the bracket depth before one line starts. */
    function __dsoBracketDepthBefore(model, floor, lineNumber) {
      let depth = 0;
      for (let index = floor; index < lineNumber; index++) {
        depth = Math.max(0, depth + __dsoBracketDelta(model.getLineContent(index), depth));
      }
      return depth;
    }

    /** Returns bracket balance change for one Python line, ignoring simple strings and comments. */
    function __dsoBracketDelta(line, depth) {
      const pairs = { "(": ")", "[": "]", "{": "}" };
      const closes = { ")": "(", "]": "[", "}": "{" };
      let quote = "";
      let delta = 0;
      for (let index = 0; index < String(line || "").length; index++) {
        const char = line[index];
        const prev = index > 0 ? line[index - 1] : "";
        if (quote) { if (char === quote && prev !== "\\\\") { quote = ""; } continue; }
        if (char === "#") { break; }
        if (char === "'" || char === '"') { quote = char; continue; }
        if (pairs[char]) { delta++; }
        if (closes[char]) { delta--; }
      }
      return delta;
    }
  `;
}

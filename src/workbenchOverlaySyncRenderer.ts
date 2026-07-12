// Renderer-side editor text synchronization for the Django shell overlay.
import { overlayPreludeViewRendererSource } from "./workbenchOverlayPreludeViewRenderer";
import { overlayPythonRangeRendererSource } from "./workbenchOverlayPythonRangeRenderer";
/** Builds JavaScript that mirrors overlay Monaco text into the extension host. */
export function overlaySyncRendererSource(): string {
  return `
    /** Returns a compact line count for renderer diagnostics. */
    function __dsoLineCount(text) {
      return text ? String(text).split(/\\r?\\n/).length : 0;
    }

    const __DSO_INPUT_MARKER = "# --- django shell input ---";

    /** Reads the full Monaco model text for source-backed debug binding. */
    function __dsoFullEditorText(editor) {
      try {
        const model = editor && editor.getModel && editor.getModel();
        return model && model.getValue ? String(model.getValue() || "") : "";
      } catch (eFullText) {}
      return "";
    }

    /** Posts one renderer diagnostic event through the extension bridge. */
    function __dsoLog(post, event, fields) {
      try { post(Object.assign({ type: "log", event: event }, fields || {})); } catch (eLog) {}
    }

    /** Reveals the active cursor position only when it has left Monaco's visible viewport. */
    function __dsoRevealCursorLine(editor) {
      const position = editor && editor.getPosition && editor.getPosition();
      if (!position || !Number.isFinite(Number(position.lineNumber))) { return; }
      try {
        if (editor.revealPositionInCenterIfOutsideViewport) {
          editor.revealPositionInCenterIfOutsideViewport(position);
          return;
        }
        if (editor.revealLineInCenterIfOutsideViewport) { editor.revealLineInCenterIfOutsideViewport(position.lineNumber); }
      } catch (eRevealCursor) {}
    }

    /** Coalesces cursor reveal requests caused by typing, cursor movement, and decoration refreshes. */
    function __dsoScheduleCursorReveal(root, editor) {
      if (!root || !editor) { return; }
      try { if (root.__dsoCursorRevealTimer) { window.clearTimeout(root.__dsoCursorRevealTimer); } } catch (eClearCursorReveal) {}
      root.__dsoCursorRevealTimer = window.setTimeout(function () {
        root.__dsoCursorRevealTimer = 0;
        __dsoRevealCursorLine(editor);
      }, 0);
    }

    /** Sends the latest overlay editor text after a short idle window. */
    function __dsoScheduleModelSync(root, editor, readValue, post) {
      window.clearTimeout(root.__dsoSyncTimer);
      if (root.__dsoSuppressModelSync || root.__dsoPreludeRepairing) { return; }
      __dsoScheduleCursorReveal(root, editor);
      root.__dsoSyncTimer = window.setTimeout(function () {
        if (root.__dsoSuppressModelSync || root.__dsoPreludeRepairing) { return; }
        const code = String(readValue(editor) || "");
        root.__dsoLastSyncText = code;
        try { const request = post({ type: "change", code: code }); if (request && request.then) { request.then(function (response) { root.__dsoLastSyncStatus = response && response.status; }).catch(function (error) { root.__dsoLastSyncError = String(error && error.message || error); }); } } catch (error) { root.__dsoLastSyncError = String(error && error.message || error); }
      }, 80);
    }

    /** Hooks one Monaco model so other extensions can read its in-memory text. */
    window.__dsoInstallModelSync = function (root, editor, readValue, post) {
      if (!root || !editor) {
        __dsoLog(post, "model.install.skip", { hasEditor: !!editor, hasRoot: !!root });
        return;
      }
      const model = editor.getModel && editor.getModel();
      if (root.__dsoSyncEditor === editor && root.__dsoSyncModel === model) {
        return;
      }
      try { root.__dsoSyncDisposable && root.__dsoSyncDisposable.dispose && root.__dsoSyncDisposable.dispose(); } catch (eDisposeSync) {}
      root.__dsoSyncEditor = editor;
      root.__dsoSyncModel = model;
      if (model && model.onDidChangeContent) {
        root.__dsoSyncDisposable = model.onDidChangeContent(function () {
          __dsoScheduleModelSync(root, editor, readValue, post);
        });
      }
      __dsoLog(post, "model.install", {
        hasModel: !!model,
        language: model && model.getLanguageId ? model.getLanguageId() : "",
        lineCount: model && model.getLineCount ? model.getLineCount() : 0,
        uri: model && model.uri ? String(model.uri) : ""
      });
      __dsoScheduleModelSync(root, editor, readValue, post);
    };

    /** Returns the initial visible model text without generated analysis imports. */
    window.__dsoInitialModelText = function () {
      return String(window.__djangoShellOverlayInitialText || "");
    };

    /** Returns the one-based first user input line in the generated document. */
    function __dsoFindInputStartLine(model) {
      if (!model) { return 1; }
      for (let line = 1; line <= model.getLineCount(); line++) {
        if (model.getLineContent(line).trim() === __DSO_INPUT_MARKER) { return Math.min(line + 1, model.getLineCount()); }
      }
      return 1;
    }

    /** Returns the protected generated prefix from the canonical prelude text. */
    function __dsoCanonicalPrefix(root) {
      return "";
    }

    /** Returns user text, stripping legacy generated prefixes if an older overlay left one behind. */
    function __dsoUserText(text, root) {
      const value = String(text || "");
      const index = value.lastIndexOf(__DSO_INPUT_MARKER);
      if (index >= 0) {
        const after = value.slice(index + __DSO_INPUT_MARKER.length);
        return after.startsWith("\\r\\n") ? after.slice(2) : (after.startsWith("\\n") ? after.slice(1) : after);
      }
      const prelude = String(root && root.__dsoPreludeText !== undefined ? root.__dsoPreludeText : window.__djangoShellOverlayPrelude || "");
      return prelude && value.startsWith(prelude) ? value.slice(prelude.length) : value;
    }

    /** Returns only user-visible source from the active overlay editor. */
    window.__dsoGetOverlayVisibleText = function (ownerToken) {
      const root = document.getElementById("django-shell-overlay");
      if (ownerToken && root && root.__dsoOwnerToken !== ownerToken) { return ""; }
      const editor = root && root.__djangoShellEditor;
      const model = editor && editor.getModel && editor.getModel();
      return model ? __dsoUserText(model.getValue(), root) : String(window.__djangoShellOverlayInitialText || "");
    };

    /** Replaces only user-visible source while preserving hidden generated prefix state. */
    window.__dsoSetOverlayVisibleText = function (text, ownerToken) {
      const userText = String(text || "");
      const root = document.getElementById("django-shell-overlay");
      if (ownerToken && (root ? root.__dsoOwnerToken !== ownerToken : window.__djangoShellOverlayOwnerToken !== ownerToken)) { return "owner-mismatch"; }
      window.__djangoShellOverlayInitialText = userText;
      const editor = root && root.__djangoShellEditor;
      const model = editor && editor.getModel && editor.getModel();
      window.__dsoPendingOverlayVisibleText = userText;
      window.__dsoPendingOverlayOwnerToken = ownerToken || window.__djangoShellOverlayOwnerToken || "";
      if (!root || !editor || !model) { return "queued"; }
      const oldVisibility = root.style.visibility;
      __dsoSetMultilineMode(root, editor, false);
      root.__dsoLastEnterRunAt = 0;
      root.style.visibility = "hidden";
      try { if (window.__dsoSetOverlayWidgetVisibility) { window.__dsoSetOverlayWidgetVisibility(root, false, false); } } catch (eHideVisibleTextWidgets) {}
      root.__dsoSuppressModelSync = true;
      root.__dsoPreludeRepairing = true;
      try {
        root.__dsoPreludeText = root.__dsoPreludeText !== undefined ? root.__dsoPreludeText : String(window.__djangoShellOverlayPrelude || "");
        root.__dsoProtectedPrefix = "";
        model.setValue(userText);
      } finally {
        root.__dsoPreludeRepairing = false;
        root.__dsoSuppressModelSync = false;
      }
      try { window.__dsoApplyPreludeHiddenArea && window.__dsoApplyPreludeHiddenArea(root, editor); } catch (eApplyVisibleText) {}
      try {
        const startLine = root.__dsoUserStartLine || 1;
        editor.setPosition && editor.setPosition({ column: 1, lineNumber: startLine });
        editor.revealLineInCenterIfOutsideViewport && editor.revealLineInCenterIfOutsideViewport(startLine);
      } catch (eVisibleCursor) {}
      delete window.__dsoPendingOverlayVisibleText;
      delete window.__dsoPendingOverlayOwnerToken;
      root.__dsoHasAppliedInitialText = true;
      root.__dsoDebugRenderModelLine = -1; try { window.__dsoApplyOverlayDebugLine && window.__dsoApplyOverlayDebugLine(root, editor); } catch (eVisibleTextDebugLine) {}
      try { window.__dsoApplyOverlayBreakpoints && window.__dsoApplyOverlayBreakpoints(root, editor); } catch (eVisibleTextBreakpoints) {}
      root.style.visibility = oldVisibility || "visible";
      try { if (window.__dsoSetOverlayWidgetVisibility && root.style.display !== "none" && root.style.visibility !== "hidden") { window.__dsoSetOverlayWidgetVisibility(root, true, false); } } catch (eRestoreVisibleTextWidgets) {}
      return "ok";
    };

    /** Restores the generated prefix if an edit crosses the hidden boundary. */
    function __dsoRepairPrefix(root, editor, post) {
      const model = editor && editor.getModel && editor.getModel();
      if (!root || !model || root.__dsoPreludeRepairing) { return false; }
      const text = model.getValue();
      const userText = __dsoUserText(text, root);
      const changed = text !== userText;
      const oldStartLine = root.__dsoUserStartLine || 1;
      const position = editor && editor.getPosition && editor.getPosition();
      const relativeLine = position ? Math.max(0, position.lineNumber - oldStartLine) : 0;
      const relativeColumn = position ? position.column : 1;
      root.__dsoProtectedPrefix = "";
      if (changed) {
        root.__dsoPreludeRepairing = true;
        try { model.setValue(userText); __dsoLog(post, "prelude.guard.strip", { prefixLines: __dsoLineCount(text) - __dsoLineCount(userText) }); } catch (eStrip) {}
        root.__dsoPreludeRepairing = false;
      }
      const startLine = 1;
      __dsoApplyPreludeView(root, editor, model, startLine);
      if (changed && position) {
        const targetLine = Math.min(model.getLineCount(), startLine + relativeLine);
        const targetColumn = Math.min(model.getLineMaxColumn(targetLine), Math.max(1, relativeColumn));
        try { editor.setPosition({ column: targetColumn, lineNumber: targetLine }); } catch (eRestorePosition) {}
      }
      return changed;
    }

    /** Reapplies hidden prelude state after editor transactions settle. */
    function __dsoSchedulePreludeGuard(root, editor) {
      if (!root) { return; }
      if (root.__dsoPreludeGuardTimer) { window.clearTimeout(root.__dsoPreludeGuardTimer); }
      const apply = function () {
        root.__dsoPreludeGuardTimer = 0;
        try { window.__dsoApplyPreludeHiddenArea && window.__dsoApplyPreludeHiddenArea(root, editor); } catch (ePreludeLater) {}
      };
      root.__dsoPreludeGuardTimer = window.setTimeout(apply, 0);
      window.setTimeout(apply, 32);
      window.setTimeout(apply, 96);
    }

    /** Keeps the cursor and edits out of the generated prelude area. */
    function __dsoInstallPreludeGuard(root, editor, post) {
      if (!root || !editor || root.__dsoPreludeGuardEditor === editor) { return; }
      const model = editor.getModel && editor.getModel();
      if (!model) { return; }
      const clampCursor = function () {
        const startLine = root.__dsoUserStartLine || __dsoFindInputStartLine(model);
        const pos = editor.getPosition && editor.getPosition();
        if (pos && pos.lineNumber < startLine) { try { editor.setPosition({ column: 1, lineNumber: startLine }); } catch (eSet) {} }
      };
      const repairPrefix = function () {
        if (__dsoRepairPrefix(root, editor, post)) { clampCursor(); }
        __dsoSchedulePreludeGuard(root, editor);
      };
      root.__dsoPreludeGuardEditor = editor;
      try { root.__dsoPreludeCursorDisposable = editor.onDidChangeCursorPosition(clampCursor); } catch (eCursorGuard) {}
      try { root.__dsoPreludeModelDisposable = model.onDidChangeContent(repairPrefix); } catch (eModelGuard) {}
      try { root.__dsoPreludeKeyDisposable = editor.onKeyDown(function (event) {
        const raw = event.browserEvent || event;
        const pos = editor.getPosition && editor.getPosition();
        if (pos && pos.lineNumber <= (root.__dsoUserStartLine || 1) && pos.column <= 1 && (raw.key === "Backspace" || raw.keyCode === 8)) {
          if (event.preventDefault) { event.preventDefault(); } if (event.stopPropagation) { event.stopPropagation(); } if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
          if (raw.preventDefault) { raw.preventDefault(); } if (raw.stopPropagation) { raw.stopPropagation(); } if (raw.stopImmediatePropagation) { raw.stopImmediatePropagation(); }
        }
      }); } catch (eKeyGuard) {}
    }

    ${overlayPreludeViewRendererSource()}

    /** Hides generated prelude lines from the shell editor when the API exists. */
    window.__dsoApplyPreludeHiddenArea = function (root, editor) {
      const model = editor && editor.getModel && editor.getModel();
      if (root) { root.__dsoPreludeText = root.__dsoPreludeText !== undefined ? root.__dsoPreludeText : String(window.__djangoShellOverlayPrelude || ""); }
      __dsoRepairPrefix(root, editor, __dsoPost);
      const startLine = 1;
      __dsoApplyPreludeView(root, editor, model, startLine);
      try { const pos = editor && editor.getPosition && editor.getPosition(); if (editor && editor.setPosition && (!pos || pos.lineNumber < startLine)) { editor.setPosition({ column: 1, lineNumber: startLine }); } } catch (ePos) {}
      __dsoInstallPreludeGuard(root, editor, __dsoPost);
    };

    ${overlayPythonRangeRendererSource()}

    /** Returns the selected source or current logical Python block with its source range. */
    function __dsoEnterPayload(root, editor) {
      const model = editor.getModel && editor.getModel();
      if (!model) { return { code: "", range: null }; }
      const selection = editor.getSelection && editor.getSelection();
      if (selection && (selection.startLineNumber !== selection.endLineNumber || selection.startColumn !== selection.endColumn)) {
        return {
          code: model.getValueInRange(selection).trimEnd(),
          range: { end: selection.endLineNumber, start: selection.startLineNumber }
        };
      }
      return __dsoMultilinePayload(root, editor);
    }

    /** Returns the entire visible document as one submit-style execution payload. */
    function __dsoSubmitPayload(root, editor) {
      const model = editor.getModel && editor.getModel();
      if (!model) { return { code: "", range: null }; }
      const startLine = Math.max(1, Number(root && root.__dsoInputStartLine) || 1);
      const endLine = model.getLineCount();
      return {
        code: model.getValueInRange({ startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: model.getLineMaxColumn(endLine) }).trimEnd(),
        range: { end: endLine, start: startLine }
      };
    }

    /** Returns the contiguous non-blank block at the cursor as one execution unit. */
    function __dsoMultilinePayload(root, editor) {
      const model = editor.getModel && editor.getModel();
      if (!model) { return { code: "", range: null }; }
      const inputStartLine = (root && root.__dsoInputStartLine) || 1;
      const position = editor.getPosition && editor.getPosition();
      const cursorLine = position ? position.lineNumber : model.getLineCount();
      let probeLine = Math.min(Math.max(inputStartLine, cursorLine), model.getLineCount());
      if (__dsoCellBlankSeparatorAt(model, probeLine, inputStartLine)) { return { code: "", range: null }; }
      let blankRun = 0;
      while (probeLine > inputStartLine && !model.getLineContent(probeLine).trim()) {
        blankRun++;
        if (blankRun >= 2) { return { code: "", range: null }; }
        probeLine--;
      }
      if (probeLine < inputStartLine || !model.getLineContent(probeLine).trim()) { return { code: "", range: null }; }
      let startLine = __dsoCellStartLine(model, probeLine, inputStartLine);
      let endLine = __dsoCellEndLine(model, probeLine, inputStartLine);
      while (startLine <= endLine && !model.getLineContent(startLine).trim()) { startLine++; }
      while (endLine > startLine && !model.getLineContent(endLine).trim()) { endLine--; }
      return {
        code: model.getValueInRange({ startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: model.getLineMaxColumn(endLine) }).trimEnd(),
        range: { end: endLine, start: startLine }
      };
    }

    /** Enables continuation only for the execution unit under the current cursor. */
    function __dsoSetMultilineMode(root, editor, enabled, range) {
      if (!root) { return; }
      const model = editor && editor.getModel && editor.getModel();
      const payload = enabled && !range ? __dsoMultilinePayload(root, editor) : null;
      const unitRange = range || (payload && payload.range);
      root.__dsoMultilineMode = !!(enabled && model && unitRange);
      root.__dsoMultilineModel = root.__dsoMultilineMode ? model : null;
      root.__dsoMultilineUnitStart = root.__dsoMultilineMode ? unitRange.start : 0;
    }

    /** Returns scoped continuation state, clearing it after the cursor enters another execution unit. */
    function __dsoMultilineModeForCursor(root, editor) {
      if (!root || !root.__dsoMultilineMode) { return false; }
      const model = editor && editor.getModel && editor.getModel();
      const payload = model ? __dsoMultilinePayload(root, editor) : null;
      const start = payload && payload.range ? payload.range.start : 0;
      if (!start || root.__dsoMultilineModel !== model || Number(root.__dsoMultilineUnitStart) !== start) {
        __dsoSetMultilineMode(root, editor, false);
        return false;
      }
      return true;
    }

    /** Returns whether one blank cursor line belongs to a strict two-line separator. */
    function __dsoCellBlankSeparatorAt(model, lineNumber, floor) {
      if (model.getLineContent(lineNumber).trim()) { return false; }
      let count = 1;
      for (let index = lineNumber - 1; index >= floor && !model.getLineContent(index).trim(); index--) { count++; }
      for (let index = lineNumber + 1; index <= model.getLineCount() && !model.getLineContent(index).trim(); index++) { count++; }
      return count >= 2;
    }

    /** Returns the first line of the current shell input unit, preserving single blank lines inside pasted source. */
    function __dsoCellStartLine(model, lineNumber, floor) {
      let blankRun = 0;
      for (let index = lineNumber - 1; index >= floor; index--) {
        if (!model.getLineContent(index).trim()) {
          blankRun++;
          if (blankRun >= 2) {
            return index + 2;
          }
        } else {
          blankRun = 0;
        }
      }
      return floor;
    }

    /** Returns the last line of the current shell input unit, preserving single blank lines inside pasted source. */
    function __dsoCellEndLine(model, lineNumber, floor) {
      let blankRun = 0;
      for (let index = lineNumber + 1; index <= model.getLineCount(); index++) {
        if (!model.getLineContent(index).trim()) {
          blankRun++;
          if (blankRun >= 2) {
            return index - 2;
          }
        } else {
          blankRun = 0;
        }
      }
      return model.getLineCount();
    }

    /** Preserves the executed cell, then drops the cursor on a fresh prompt below it. */
    function __dsoAdvanceAfterRun(editor, range, post, source) {
      const model = editor.getModel && editor.getModel();
      if (!model || !range) { return; }
      const nextLine = __dsoNextInputUnitLine(model, range.end);
      if (nextLine) {
        try { editor.setPosition({ column: __dsoFirstTextColumn(model, nextLine), lineNumber: nextLine }); } catch (eNextPosition) {}
        try { editor.revealLineInCenterIfOutsideViewport && editor.revealLineInCenterIfOutsideViewport(nextLine); } catch (eNextReveal) {}
        __dsoLog(post, "cursor.advance", { cellEnd: range.end, end: range.end, source: source, start: range.start, targetLine: nextLine });
        return;
      }
      let last = model.getLineCount();
      while (last > 1 && !model.getLineContent(last).trim()) { last--; }
      if (!model.getLineContent(last).trim()) {
        try { editor.setPosition({ column: 1, lineNumber: model.getLineCount() }); } catch (eEmpty) {}
        return;
      }
      const toLine = model.getLineCount();
      let edited = false;
      try {
        editor.executeEdits("django-shell-enter", [{
          forceMoveMarkers: true,
          range: { endColumn: model.getLineMaxColumn(toLine), endLineNumber: toLine, startColumn: model.getLineMaxColumn(last), startLineNumber: last },
          text: "\\n\\n\\n"
        }]);
        edited = model.getLineCount() > toLine;
      } catch (eEdit) {}
      if (!edited && model.getValue && model.setValue) {
        try {
          const lines = String(model.getValue() || "").split(/\\r?\\n/);
          model.setValue(lines.slice(0, last).join("\\n") + "\\n\\n\\n");
          edited = true;
          __dsoLog(post, "cursor.advance.fallback", { cellEnd: last, source: source });
        } catch (eFallbackEdit) {}
      }
      const target = model.getLineCount();
      try { editor.setPosition({ column: 1, lineNumber: target }); } catch (eSetPosition) {}
      try { editor.revealLineInCenterIfOutsideViewport && editor.revealLineInCenterIfOutsideViewport(target); } catch (eReveal) {}
      __dsoLog(post, "cursor.advance", { cellEnd: last, end: range.end, source: source, start: range.start, targetLine: target });
    }

    /** Returns the first non-empty source line after one execution unit. */
    function __dsoNextInputUnitLine(model, endLine) {
      for (let line = endLine + 1; line <= model.getLineCount(); line++) {
        if (model.getLineContent(line).trim()) { return line; }
      }
      return 0;
    }

    /** Returns the column for the first non-whitespace character on a line. */
    function __dsoFirstTextColumn(model, lineNumber) {
      const match = String(model.getLineContent(lineNumber) || "").match(/^\\s*/);
      return (match ? match[0].length : 0) + 1;
    }

    /** Moves the cursor past the current execution unit without running Python. */
    function __dsoSkipCurrentInput(root, editor, post, source) {
      const model = editor && editor.getModel && editor.getModel();
      const payload = model ? __dsoPreviewPayload(root, editor) : null;
      if (!model || !payload || !payload.range) { return "empty"; }
      const end = Math.max(1, Math.min(model.getLineCount(), payload.range.end || 1));
      const nextLine = __dsoNextInputUnitLine(model, end);
      if (nextLine) {
        try { editor.setPosition && editor.setPosition({ column: __dsoFirstTextColumn(model, nextLine), lineNumber: nextLine }); } catch (eNextPosition) {}
        try { editor.revealLineInCenterIfOutsideViewport && editor.revealLineInCenterIfOutsideViewport(nextLine); } catch (eNextReveal) {}
        __dsoSetMultilineMode(root, editor, false);
        __dsoUpdateExecutionRangePreview(root, editor);
        __dsoLog(post, "enter.skip", { end: end, source: source, targetLine: nextLine });
        return "skipped";
      }
      try {
        const toLine = model.getLineCount();
        editor.executeEdits("django-shell-skip", [{
          forceMoveMarkers: true,
          range: { endColumn: model.getLineMaxColumn(toLine), endLineNumber: toLine, startColumn: model.getLineMaxColumn(end), startLineNumber: end },
          text: "\\n\\n\\n"
        }]);
      } catch (eEdit) {}
      const target = Math.min(model.getLineCount(), end + 3);
      try { editor.setPosition && editor.setPosition({ column: 1, lineNumber: target }); } catch (eSetPosition) {}
      try { editor.revealLineInCenterIfOutsideViewport && editor.revealLineInCenterIfOutsideViewport(target); } catch (eReveal) {}
      __dsoSetMultilineMode(root, editor, false);
      __dsoUpdateExecutionRangePreview(root, editor);
      __dsoLog(post, "enter.skip", { end: end, source: source, targetLine: target });
      return "skipped";
    }

    /** Inserts a newline inside the overlay editor without invoking VS Code global commands. */
    function __dsoInsertNewline(editor, post, source) {
      const model = editor.getModel && editor.getModel();
      const selection = editor.getSelection && editor.getSelection();
      if (!model || !selection) { return; }
      const indent = __dsoNextIndent(model, selection.startLineNumber);
      try {
        editor.executeEdits("django-shell-shift-enter", [{ forceMoveMarkers: true, range: selection, text: "\\n" + indent }]);
        editor.setPosition({ column: indent.length + 1, lineNumber: selection.startLineNumber + 1 });
        __dsoRevealCursorLine(editor);
        __dsoLog(post, "shiftEnter.newline", { method: "edit", source: source });
      } catch (eEdit) {}
    }

    /** Returns true when local Python syntax clearly needs a continuation line. */
    function __dsoLikelyIncompletePython(code) {
      const lines = String(code || "").split(/\\r?\\n/);
      let depth = 0;
      let last = "";
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.trim()) { last = line; }
        depth = Math.max(0, depth + __dsoBracketDelta(line, depth));
      }
      const trimmed = String(last || "").trimEnd();
      return !!trimmed && (__dsoBlockHeader(trimmed) || /\\\\$/.test(trimmed) || depth > 0);
    }

    /** Returns true while a REPL-style multi-line block is still being entered. */
    function __dsoIsBlockBuffering(code) {
      const lines = String(code || "").split(/\\r?\\n/);
      let blockOpen = false;
      let depth = 0;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.trim() && __dsoBlockHeader(line)) { blockOpen = true; }
        depth = Math.max(0, depth + __dsoBracketDelta(line, depth));
      }
      return blockOpen || depth > 0;
    }

    /** Posts one execution request and returns the extension host decision. */
    function __dsoRunCode(post, code, root, editor, range) {
      window.__dsoLastRunOutcome = { chars: String(code || "").length, pending: true };
      const hostRange = __dsoHostRange(root, range);
      const text = __dsoFullEditorText(editor);
      return Promise.resolve(post({ type: "run", code: code, range: hostRange, text: text })).then(function (response) {
        if (response && response.type === "opaque") { window.__dsoLastRunOutcome = { executed: true, opaque: true }; return { executed: true }; }
        if (!response || !response.json || response.ok === false) { window.__dsoLastRunOutcome = { executed: false, status: response && response.status }; return __dsoRunWebviewFallback(code, range); }
        return response.json().then(function (outcome) { window.__dsoLastRunOutcome = outcome || { executed: false }; return window.__dsoLastRunOutcome; }).catch(function (error) { window.__dsoLastRunOutcome = { error: String(error && error.message || error), executed: false }; return window.__dsoLastRunOutcome; });
      }).catch(function (error) { window.__dsoLastRunOutcome = { error: String(error && error.message || error), executed: false }; return __dsoRunWebviewFallback(code, range); });
    }
    /** Converts raw Monaco model lines to user-input relative lines for extension-host source mapping. */
    function __dsoHostRange(root, range) {
      if (!range) { return null; }
      return { end: __dsoRelativeUserLine(root, range.end || range.start || 1), start: __dsoRelativeUserLine(root, range.start || 1) };
    }
    /** Converts one raw Monaco model line to a one-based user-input relative line. */
    function __dsoRelativeUserLine(root, line) {
      const startLine = Number(root && root.__dsoInputStartLine) || 1;
      return Math.max(1, Math.floor(Number(line) || 1) - startLine + 1);
    }
    /** Posts one overlay fallback message to the owning custom console webview frames. */
    function __dsoPostWebviewFallback(message) {
      const frame = typeof __dsoFindWebviewFrame === "function" ? __dsoFindWebviewFrame() : null;
      let sent = 0;
      const postTo = function (target) { if (!target || sent > 16) { return; } try { target.postMessage(message, "*"); sent++; } catch (ePost) {} try { for (let index = 0; target.frames && index < target.frames.length; index++) { postTo(target.frames[index]); } } catch (eFrames) {} };
      postTo(frame && frame.contentWindow); postTo(frame);
      return sent;
    }
    /** Uses the custom console webview bridge when localhost fetch is unavailable. */
    function __dsoRunWebviewFallback(code, range) {
      const root = document.getElementById("django-shell-overlay");
      const message = { code: code, range: __dsoHostRange(root, range), text: root && root.__djangoShellEditor ? __dsoFullEditorText(root.__djangoShellEditor) : "", type: "overlayRunPython" };
      const sent = __dsoPostWebviewFallback(message);
      if (!sent) { return Promise.resolve(window.__dsoLastRunOutcome = Object.assign({ executed: false, webview: "missing" }, window.__dsoLastRunOutcome || {})); }
      return Promise.resolve(window.__dsoLastRunOutcome = { executed: true, sent: sent, webview: "postMessage" });
    }
    /** Returns whether one Monaco or DOM key event is Enter. */
    function __dsoIsEnter(event, raw) {
      return raw.key === "Enter" || raw.code === "Enter" || raw.keyCode === 13 || event.keyCode === 3;
    }

    /** Returns whether one IntelliSense popup node is currently visible. */
    function __dsoPopupVisible(node) {
      if (!node || (node.classList && node.classList.contains("hidden"))) { return false; }
      const ariaHidden = node.getAttribute && node.getAttribute("aria-hidden");
      if (ariaHidden === "true") { return false; }
      const needsVisibleClass = node.classList && (node.classList.contains("suggest-widget") || node.classList.contains("parameter-hints-widget"));
      if (needsVisibleClass && !node.classList.contains("visible") && ariaHidden !== "false") { return false; }
      const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
      if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) { return false; }
      const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      return !rect || rect.width > 0 || rect.height > 0;
    }

    /** Returns whether any IntelliSense popup is currently visible. */
    function __dsoHasVisiblePopup(selector) {
      const nodes = document.querySelectorAll(selector);
      for (let i = 0; i < nodes.length; i++) {
        if (__dsoPopupVisible(nodes[i])) { return true; }
      }
      return false;
    }

    /** Returns whether the editor currently renders an inline completion. */
    function __dsoInlineSuggestionVisible(editor) {
      const node = editor && editor.getDomNode && editor.getDomNode();
      if (!node || !node.querySelectorAll) { return false; }
      const ghosts = node.querySelectorAll(".ghost-text,.ghost-text-decoration,.inline-completion-text-to-replace");
      for (let index = 0; index < ghosts.length; index++) {
        const ghost = ghosts[index];
        if (ghost.classList && ghost.classList.contains("ghost-text-hidden")) { continue; }
        if (__dsoPopupVisible(ghost)) { return true; }
      }
      return false;
    }

    /** Returns whether Enter currently belongs to completion or parameter UI. */
    function __dsoSuggestOpen(editor) {
      return __dsoHasVisiblePopup(".suggest-widget,.parameter-hints-widget") || __dsoInlineSuggestionVisible(editor);
    }

    /** Returns the payload that Enter would run from the current editor state. */
    function __dsoPreviewPayload(root, editor) {
      if (root && root.__dsoExecutionMode === "submit") { return __dsoSubmitPayload(root, editor); }
      return __dsoMultilineModeForCursor(root, editor) ? __dsoMultilinePayload(root, editor) : __dsoEnterPayload(root, editor);
    }

    /** Draws the current paused debugger line for a one-based user-input line. */
    window.__dsoApplyOverlayDebugLine = function (root, editor) {
      const model = editor && editor.getModel && editor.getModel();
      if (!root || !editor || !model || !editor.deltaDecorations) { return "missing-editor"; }
      const visibleLine = root.__dsoExecutionMode === "submit" ? 0 : Math.floor(Number(root.__dsoDebugLine || window.__dsoOverlayDebugLine || 0));
      const modelLine = visibleLine > 0 ? (Number(root.__dsoInputStartLine) || 1) + visibleLine - 1 : 0;
      const renderedLine = modelLine >= 1 && modelLine <= model.getLineCount() ? visibleLine : 0;
      const inlineText = renderedLine ? String(root.__dsoDebugInlineText || window.__dsoOverlayDebugInlineText || "").slice(0, 240) : "";
      if (root.__dsoDebugRenderEditor === editor && root.__dsoDebugRenderModel === model && root.__dsoDebugRenderModelLine === modelLine && root.__dsoDebugRenderInlineText === inlineText) {
        return "debug-line:" + renderedLine;
      }
      // Refresh the Enter-preview band first so it hides while paused and the stopped line stays the only highlighted row.
      try { __dsoUpdateExecutionRangePreview(root, editor); } catch (eExecRangeRefresh) {}
      const decorations = renderedLine ? [{
        options: { after: { content: inlineText ? "\u00a0\u00a0" + inlineText : "", cursorStops: 3, inlineClassName: "dso-debug-inline-value", inlineClassNameAffectsLetterSpacing: true }, className: "dso-debug-line", glyphMarginClassName: "dso-debug-indicator", isWholeLine: true, showIfCollapsed: true },
        range: { endColumn: model.getLineMaxColumn ? model.getLineMaxColumn(modelLine) : 1, endLineNumber: modelLine, startColumn: 1, startLineNumber: modelLine }
      }] : [];
      try {
        const previous = root.__dsoDebugRenderEditor === editor && root.__dsoDebugRenderModel === model ? (root.__dsoDebugLineDecorationIds || []) : [];
        root.__dsoDebugLineDecorationIds = editor.deltaDecorations(previous, decorations);
        root.__dsoDebugRenderEditor = editor;
        root.__dsoDebugRenderModel = model;
        root.__dsoDebugRenderModelLine = modelLine;
        root.__dsoDebugRenderInlineText = inlineText;
      } catch (eDebugDecorations) {
        root.__dsoDebugLineDecorationIds = [];
        root.__dsoDebugRenderEditor = null;
        root.__dsoDebugRenderModel = null;
        root.__dsoDebugRenderModelLine = -1;
        root.__dsoDebugRenderInlineText = "";
      }
      try { if (modelLine && editor.revealLineInCenterIfOutsideViewport) { editor.revealLineInCenterIfOutsideViewport(modelLine); } } catch (eRevealDebugLine) {}
      return "debug-line:" + (decorations.length ? visibleLine : 0);
    };

    /** Stores the current paused debugger line and applies it to the live editor. */
    window.__dsoSetOverlayDebugLine = function (line, inline, ownerToken) {
      const root = document.getElementById("django-shell-overlay");
      if (ownerToken && (root ? root.__dsoOwnerToken !== ownerToken : window.__djangoShellOverlayOwnerToken !== ownerToken)) { return "owner-mismatch"; }
      window.__dsoOverlayDebugLine = Math.max(0, Math.floor(Number(line) || 0));
      window.__dsoOverlayDebugInlineText = window.__dsoOverlayDebugLine ? String(inline || "").slice(0, 240) : "";
      if (!root) { return "debug-line:" + window.__dsoOverlayDebugLine; }
      root.__dsoDebugLine = window.__dsoOverlayDebugLine;
      root.__dsoDebugInlineText = window.__dsoOverlayDebugInlineText;
      const editor = root.__djangoShellEditor;
      return editor ? window.__dsoApplyOverlayDebugLine(root, editor) : "debug-line:" + root.__dsoDebugLine;
    };

    /** Reveals every user-input line that has a breakpoint with a whole-line marker (a colored left edge), so the breakpoint LINE is visible in the overlay without adding a second gutter dot. */
    window.__dsoApplyOverlayBreakpoints = function (root, editor) {
      const model = editor && editor.getModel && editor.getModel();
      if (!root || !editor || !model || !editor.deltaDecorations) { return "missing-editor"; }
      const startLine = Number(root.__dsoInputStartLine) || 1;
      const lines = root.__dsoExecutionMode === "submit" ? [] : (root.__dsoBreakpointLines || window.__dsoOverlayBreakpointLines || []);
      const seen = {};
      const decorations = [];
      for (let i = 0; i < lines.length; i += 1) {
        const modelLine = startLine + Math.floor(Number(lines[i]) || 0) - 1;
        if (modelLine >= 1 && modelLine <= model.getLineCount() && !seen[modelLine]) {
          seen[modelLine] = true;
          decorations.push({ options: { className: "dso-breakpoint-line", isWholeLine: true }, range: { endColumn: 1, endLineNumber: modelLine, startColumn: 1, startLineNumber: modelLine } });
        }
      }
      try { root.__dsoBreakpointDecorationIds = editor.deltaDecorations(root.__dsoBreakpointDecorationIds || [], decorations); } catch (eBreakpointDecorations) { root.__dsoBreakpointDecorationIds = []; }
      return "breakpoints:" + decorations.length;
    };

    /** Stores the breakpoint lines (one-based user-input lines) and renders their glyphs on the live editor. */
    window.__dsoSetOverlayBreakpoints = function (lines, ownerToken) {
      const root = document.getElementById("django-shell-overlay");
      if (ownerToken && (root ? root.__dsoOwnerToken !== ownerToken : window.__djangoShellOverlayOwnerToken !== ownerToken)) { return "owner-mismatch"; }
      window.__dsoOverlayBreakpointLines = Array.isArray(lines) ? lines : [];
      if (!root) { return "breakpoints:queued"; }
      root.__dsoBreakpointLines = window.__dsoOverlayBreakpointLines;
      const editor = root.__djangoShellEditor;
      return editor ? window.__dsoApplyOverlayBreakpoints(root, editor) : "breakpoints:" + root.__dsoBreakpointLines.length;
    };

    /** Returns Monaco decorations for the currently executable Python input range. */
    function __dsoExecutionRangeDecorations(model, payload) {
      if (!model || !payload || !payload.range || !String(payload.code || "").trim()) { return []; }
      const start = Math.max(1, payload.range.start || 1);
      const end = Math.max(start, payload.range.end || start);
      const endColumn = model.getLineMaxColumn ? model.getLineMaxColumn(end) : 1;
      const decorations = [{
        options: { className: "dso-exec-range", isWholeLine: true },
        range: { endColumn: endColumn, endLineNumber: end, startColumn: 1, startLineNumber: start }
      }, {
        options: { className: "dso-exec-range-start", isWholeLine: true },
        range: { endColumn: model.getLineMaxColumn ? model.getLineMaxColumn(start) : 1, endLineNumber: start, startColumn: 1, startLineNumber: start }
      }];
      if (end > start) {
        decorations.push({
          options: { className: "dso-exec-range-end", isWholeLine: true },
          range: { endColumn: endColumn, endLineNumber: end, startColumn: 1, startLineNumber: end }
        });
      }
      return decorations;
    }

    /** Refreshes the visible preview of the range Enter will execute. */
    function __dsoUpdateExecutionRangePreview(root, editor) {
      const model = editor && editor.getModel && editor.getModel();
      if (!root || !editor || !model || !editor.deltaDecorations) { return; }
      // Hide the Enter-preview band while the debugger is paused so the stopped line stays the only highlighted row.
      const pausedLine = Math.floor(Number(root.__dsoDebugLine || window.__dsoOverlayDebugLine || 0));
      const submitMode = root.__dsoExecutionMode === "submit";
      const inactiveKey = pausedLine > 0 ? "paused" : (submitMode ? "submit" : "");
      if (inactiveKey && root.__dsoExecutionRangeRenderEditor === editor && root.__dsoExecutionRangeRenderModel === model && root.__dsoExecutionRangeRenderKey === inactiveKey) { return; }
      const payload = inactiveKey ? null : __dsoPreviewPayload(root, editor);
      const hasCode = !!(payload && String(payload.code || "").trim());
      const decorations = inactiveKey ? [] : __dsoExecutionRangeDecorations(model, payload);
      const preview = !submitMode && payload && payload.range ? { end: payload.range.end, start: payload.range.start } : (pausedLine > 0 ? root.__dsoExecutionRangePreview || null : null);
      const previewKey = preview ? preview.start + ":" + preview.end : "";
      const renderKey = inactiveKey || ("active:" + previewKey + ":" + (hasCode ? "code" : "empty"));
      if (root.__dsoExecutionRangeRenderEditor === editor && root.__dsoExecutionRangeRenderModel === model && root.__dsoExecutionRangeRenderKey === renderKey) { return; }
      try {
        const previous = root.__dsoExecutionRangeRenderEditor === editor && root.__dsoExecutionRangeRenderModel === model ? (root.__dsoExecutionRangeDecorationIds || []) : [];
        root.__dsoExecutionRangeDecorationIds = editor.deltaDecorations(previous, decorations);
        root.__dsoExecutionRangeRenderEditor = editor;
        root.__dsoExecutionRangeRenderModel = model;
        root.__dsoExecutionRangeRenderKey = renderKey;
        root.__dsoExecutionRangePreview = preview;
        if (root.__dsoExecutionRangePreviewKey !== previewKey) {
          root.__dsoExecutionRangePreviewKey = previewKey;
          if (editor.updateOptions) {
            editor.updateOptions(submitMode
              ? { glyphMargin: false, lineDecorationsWidth: 0, lineNumbers: "on", lineNumbersMinChars: 3 }
              : { glyphMargin: true, lineDecorationsWidth: 0, lineNumbers: function (line) { return __dsoPromptForLine(model, root.__dsoInputStartLine || __dsoFindInputStartLine(model), line, root); }, lineNumbersMinChars: 1 });
          }
        }
      } catch (eDecorations) {
        root.__dsoExecutionRangeDecorationIds = [];
        root.__dsoExecutionRangeRenderEditor = null;
        root.__dsoExecutionRangeRenderModel = null;
        root.__dsoExecutionRangeRenderKey = "";
      }
    }

    /** Installs live execution-range preview decorations on the overlay editor. */
    function __dsoInstallExecutionRangePreview(root, editor) {
      const model = editor && editor.getModel && editor.getModel();
      if (!root || !editor || !model || !editor.deltaDecorations) { return function () {}; }
      const update = function () { __dsoUpdateExecutionRangePreview(root, editor); __dsoScheduleCursorReveal(root, editor); };
      const cursorDisposable = editor.onDidChangeCursorPosition ? editor.onDidChangeCursorPosition(update) : null;
      const modelDisposable = model.onDidChangeContent ? model.onDidChangeContent(update) : null;
      update();
      return function () {
        try { cursorDisposable && cursorDisposable.dispose && cursorDisposable.dispose(); } catch (eCursorDispose) {}
        try { modelDisposable && modelDisposable.dispose && modelDisposable.dispose(); } catch (eModelDispose) {}
        try { root.__dsoExecutionRangeDecorationIds = editor.deltaDecorations(root.__dsoExecutionRangeDecorationIds || [], []); } catch (eClearDecorations) {}
        root.__dsoExecutionRangePreview = null;
        root.__dsoExecutionRangePreviewKey = "";
        root.__dsoExecutionRangeRenderEditor = null;
        root.__dsoExecutionRangeRenderModel = null;
        root.__dsoExecutionRangeRenderKey = "";
      };
    }

    /** Returns a compact DOM label for key-event diagnostics. */
    function __dsoNodeLabel(node) {
      if (!node) { return ""; }
      const tag = String(node.tagName || node.nodeName || "").toLowerCase();
      const cls = String(node.className || "").replace(/\\s+/g, ".").slice(0, 80);
      return cls ? tag + "." + cls : tag;
    }

    /** Returns whether a key event originated in a nested editor widget that owns Enter. */
    function __dsoAuxiliaryWidgetOwnsEvent(event) {
      const selector = ".breakpoint-widget,.rename-box,.rename-input,.find-widget";
      const raw = event && event.browserEvent ? event.browserEvent : event;
      const target = raw && raw.target ? raw.target : (event && event.target);
      try { if (target && target.closest && target.closest(selector)) { return true; } } catch (eClosestAuxiliaryWidget) {}
      try {
        const path = raw && raw.composedPath ? raw.composedPath() : (event && event.composedPath ? event.composedPath() : []);
        for (let index = 0; path && index < path.length; index++) {
          const node = path[index];
          if (node && node.matches && node.matches(selector)) { return true; }
        }
      } catch (eAuxiliaryWidgetPath) {}
      return false;
    }

    /** Returns whether a key event belongs to the overlay editor. */
    function __dsoTouchesEditor(node, event, editor) {
      const target = event && event.target;
      if (target && node.contains && node.contains(target)) { return true; }
      try {
        const path = event && event.composedPath ? event.composedPath() : [];
        if (path && path.indexOf(node) >= 0) { return true; }
      } catch (ePath) {}
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement && node.contains && !node.contains(active)) { return false; }
      if (active && node.contains && node.contains(active)) { return true; }
      try { if (editor && editor.hasTextFocus && editor.hasTextFocus()) { return true; } } catch (eFocus) {}
      return false;
    }

    /** Installs Django shell Enter execution semantics on the overlay editor. */
    window.__dsoInstallEnterRunner = function (root, editor, post) {
      if (!root || !editor) {
        __dsoLog(post, "enter.install.skip", { hasEditor: !!editor, hasRoot: !!root });
        return;
      }
      if (root.__dsoEnterEditor === editor && root.__dsoEnterCleanup) {
        return;
      }
      try { root.__dsoEnterCleanup && root.__dsoEnterCleanup(); } catch (eCleanupEnter) {}
      const node = editor.getDomNode && editor.getDomNode();
      if (!node) {
        __dsoLog(post, "enter.install.skip", { hasNode: false });
        return;
      }
      __dsoLog(post, "enter.install", { hasNode: true, sameEditor: root.__dsoEnterEditor === editor });
      const execute = function (event, source, allowContinuation) {
        const inputStartLine = root.__dsoInputStartLine || 1;
        const submitMode = root.__dsoExecutionMode === "submit";
        const multilineMode = __dsoMultilineModeForCursor(root, editor);
        const payload = submitMode ? __dsoSubmitPayload(root, editor) : (multilineMode ? __dsoMultilinePayload(root, editor) : __dsoEnterPayload(root, editor));
        if (!payload.code.trim()) {
          __dsoLog(post, "enter.empty", { multiline: multilineMode, source: source });
          return false;
        }
        const now = Date.now();
        if (root.__dsoLastEnterRunAt && now - root.__dsoLastEnterRunAt < 80) {
          __dsoLog(post, "enter.duplicate", { source: source, sinceMs: now - root.__dsoLastEnterRunAt });
          return true;
        }
        root.__dsoLastEnterRunAt = now;
        if (event && event.preventDefault) { event.preventDefault(); }
        if (event && event.stopPropagation) { event.stopPropagation(); }
        if (event && event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
        const raw = event && event.browserEvent ? event.browserEvent : event;
        if (raw && raw.preventDefault) { raw.preventDefault(); }
        if (raw && raw.stopPropagation) { raw.stopPropagation(); }
        if (raw && raw.stopImmediatePropagation) { raw.stopImmediatePropagation(); }
        if (allowContinuation !== false) {
          const model = editor.getModel && editor.getModel();
          const position = editor.getPosition && editor.getPosition();
          const cursorLine = model && position ? model.getLineContent(position.lineNumber) : "";
          const buffering = multilineMode || __dsoIsBlockBuffering(payload.code);
          if (buffering && cursorLine.trim()) {
            __dsoSetMultilineMode(root, editor, true, payload.range);
            __dsoLog(post, "enter.block.buffer", { chars: payload.code.length, cursor: position ? position.lineNumber : 0, inputStartLine: inputStartLine, multiline: multilineMode, source: source });
            __dsoInsertNewline(editor, post, source + "-block-buffer");
            return true;
          }
        }
        if (!submitMode && __dsoLikelyIncompletePython(payload.code)) {
          __dsoLog(post, "enter.incomplete.local", { chars: payload.code.length, inputStartLine: inputStartLine, multiline: multilineMode, source: source });
          if (allowContinuation !== false) {
            __dsoSetMultilineMode(root, editor, true, payload.range);
            __dsoInsertNewline(editor, post, source + "-local-incomplete");
          }
          return true;
        }
        __dsoLog(post, "enter.execute.request", { chars: payload.code.length, end: payload.range ? payload.range.end : 0, inputStartLine: inputStartLine, lines: __dsoLineCount(payload.code), multiline: multilineMode, source: source, start: payload.range ? payload.range.start : 0 });
        __dsoRunCode(post, payload.code, root, editor, payload.range).then(function (outcome) {
          if (outcome && outcome.cancelled) { __dsoLog(post, "enter.cancelled", { chars: payload.code.length, inputStartLine: inputStartLine, source: source }); return; }
          if (outcome && outcome.executed === false) {
            __dsoLog(post, "enter.incomplete", { chars: payload.code.length, inputStartLine: inputStartLine, source: source });
            if (allowContinuation !== false) { __dsoInsertNewline(editor, post, source + "-incomplete"); }
            return;
          }
          __dsoSetMultilineMode(root, editor, false);
          __dsoLog(post, "enter.execute", { end: payload.range ? payload.range.end : 0, inputStartLine: inputStartLine, source: source, start: payload.range ? payload.range.start : 0 });
          if (!submitMode) { __dsoAdvanceAfterRun(editor, payload.range, post, source); }
        });
        return true;
      };
      const run = function (event, source) {
        const raw = event.browserEvent || event;
        if (!__dsoIsEnter(event, raw)) { return; }
        if (__dsoAuxiliaryWidgetOwnsEvent(event)) { __dsoLog(post, "key.enter.auxiliaryWidget", { source: source }); return; }
        const suggest = __dsoSuggestOpen(editor);
        __dsoLog(post, "key.enter", { alt: !!raw.altKey, composing: !!raw.isComposing, ctrl: !!raw.ctrlKey, meta: !!raw.metaKey, shift: !!raw.shiftKey, source: source, suggest: suggest });
        if (root.__dsoExecutionMode === "submit") {
          if ((raw.ctrlKey || raw.metaKey) && !raw.altKey && !raw.shiftKey && !raw.isComposing && !suggest) { execute(event, source + "-submit", false); }
          return;
        }
        if (raw.shiftKey && !raw.metaKey) {
          if (event.preventDefault) { event.preventDefault(); }
          if (event.stopPropagation) { event.stopPropagation(); }
          if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
          if (raw.preventDefault) { raw.preventDefault(); }
          if (raw.stopPropagation) { raw.stopPropagation(); }
          if (raw.stopImmediatePropagation) { raw.stopImmediatePropagation(); }
          __dsoSetMultilineMode(root, editor, true);
          __dsoInsertNewline(editor, post, source);
          return;
        }
        if (raw.altKey && !raw.ctrlKey && !raw.metaKey && !raw.shiftKey && !raw.isComposing) {
          if (event.preventDefault) { event.preventDefault(); }
          if (event.stopPropagation) { event.stopPropagation(); }
          if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
          if (raw.preventDefault) { raw.preventDefault(); }
          if (raw.stopPropagation) { raw.stopPropagation(); }
          if (raw.stopImmediatePropagation) { raw.stopImmediatePropagation(); }
          __dsoSkipCurrentInput(root, editor, post, source + "-skip");
          return;
        }
        if (raw.metaKey) {
          execute(event, source + "-cmd", false);
          return;
        }
        if (raw.ctrlKey || raw.altKey || raw.isComposing || suggest) { return; }
        execute(event, source, true);
      };
      root.__dsoCurrentInputPayload = function () { return __dsoPreviewPayload(root, editor); };
      root.__dsoRunCurrentInput = function () { return execute(null, "host-command-cmd", false) ? "requested" : "empty"; };
      root.__dsoSkipCurrentInput = function () { return __dsoSkipCurrentInput(root, editor, post, "host-command-skip"); };
      window.__dsoRunCurrentOverlayInput = function () { const activeRoot = document.getElementById("django-shell-overlay"); return activeRoot && activeRoot.__dsoRunCurrentInput ? activeRoot.__dsoRunCurrentInput() : "missing-root"; };
      window.__dsoSkipCurrentOverlayInput = function () { const activeRoot = document.getElementById("django-shell-overlay"); return activeRoot && activeRoot.__dsoSkipCurrentInput ? activeRoot.__dsoSkipCurrentInput() : "missing-root"; };
      const previewCleanup = __dsoInstallExecutionRangePreview(root, editor);
      try {
        if (typeof editor.addCommand === "function") {
          const monacoApi = (globalThis.monaco && globalThis.monaco.KeyMod && globalThis.monaco.KeyCode) ? globalThis.monaco : ((window.monaco && window.monaco.KeyMod && window.monaco.KeyCode) ? window.monaco : null);
          const shiftMask = monacoApi ? monacoApi.KeyMod.Shift : 1024;
          const enterKey = monacoApi ? monacoApi.KeyCode.Enter : 3;
          editor.addCommand(shiftMask | enterKey, function () {
            __dsoSetMultilineMode(root, editor, true);
            __dsoInsertNewline(editor, post, "monaco-command");
          });
          __dsoLog(post, "enter.addCommand", { shiftMask: shiftMask, enterKey: enterKey, hasApi: !!monacoApi });
        }
      } catch (eAddCommand) { __dsoLog(post, "enter.addCommand.error", { error: String(eAddCommand && eAddCommand.message || eAddCommand) }); }
      const keyDisposable = editor.onKeyDown ? editor.onKeyDown(function (event) { run(event, "monaco"); }) : null;
      const docListener = function (event) { if (node.contains(event.target)) { run(event, "document"); } };
      const nodeListener = function (event) { run(event, "node"); };
      const windowListener = function (event) {
        const raw = event.browserEvent || event;
        if (!__dsoIsEnter(event, raw)) { return; }
        if (__dsoTouchesEditor(node, event, editor)) {
          run(event, "window");
          return;
        }
        __dsoLog(post, "key.enter.miss", { active: __dsoNodeLabel(document.activeElement), source: "window", target: __dsoNodeLabel(event.target) });
      };
      window.addEventListener("keydown", windowListener, true);
      document.addEventListener("keydown", docListener, true);
      node.addEventListener("keydown", nodeListener, true);
      root.__dsoEnterEditor = editor;
      root.__dsoEnterCleanup = function () {
        try { keyDisposable && keyDisposable.dispose && keyDisposable.dispose(); } catch (eKeyDispose) {}
        window.removeEventListener("keydown", windowListener, true);
        document.removeEventListener("keydown", docListener, true);
        node.removeEventListener("keydown", nodeListener, true);
        try { previewCleanup && previewCleanup(); } catch (ePreviewCleanup) {}
      };
    };
    window.__djangoShellOverlaySetPrelude = function (text, ownerToken) {
      const root = document.getElementById("django-shell-overlay");
      if (ownerToken && (root ? root.__dsoOwnerToken !== ownerToken : window.__djangoShellOverlayOwnerToken !== ownerToken)) { return "owner-mismatch"; }
      window.__djangoShellOverlayPrelude = String(text || "");
      const editor = root && root.__djangoShellEditor;
      const model = editor && editor.getModel && editor.getModel();
      if (model) {
        root.__dsoPreludeText = String(text || "");
        window.__dsoApplyPreludeHiddenArea(root, editor);
        try { window.__dsoSchedulePreludeSemanticDecorations && window.__dsoSchedulePreludeSemanticDecorations(root); } catch (eVisiblePreludeSemantic) {}
        try { window.__dsoApplyOverlayDebugLine && window.__dsoApplyOverlayDebugLine(root, editor); } catch (eVisiblePreludeDebugLine) {}
        try { window.__dsoApplyOverlayBreakpoints && window.__dsoApplyOverlayBreakpoints(root, editor); } catch (eVisiblePreludeBreakpoints) {}
      }
      return "ok";
    };
  `;
}

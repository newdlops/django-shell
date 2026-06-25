// Renderer-side editor text synchronization for the Django shell overlay.
import { overlayDiagnosticPrefixRendererSource } from "./workbenchOverlayDiagnosticPrefixRenderer";
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

    /** Posts one renderer diagnostic event through the extension bridge. */
    function __dsoLog(post, event, fields) {
      try { post(Object.assign({ type: "log", event: event }, fields || {})); } catch (eLog) {}
    }

    /** Sends the latest overlay editor text after a short idle window. */
    function __dsoScheduleModelSync(root, editor, readValue, post) {
      window.clearTimeout(root.__dsoSyncTimer);
      if (root.__dsoSuppressModelSync || root.__dsoPreludeRepairing) { return; }
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
        __dsoLog(post, "model.install.skip", { reason: "same-editor-model" });
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
      const marker = __DSO_INPUT_MARKER + "\\n";
      if (root && !root.__dsoUseVisiblePrelude) { return String(root.__dsoProtectedPrefix || __dsoDiagnosticPrefix(root, "")); }
      const prelude = root && root.__dsoPreludeText !== undefined ? root.__dsoPreludeText : window.__djangoShellOverlayPrelude;
      return String(prelude || "") + marker;
    }

    /** Returns user text even when backspace merges it into the marker line. */
    function __dsoUserText(text, root) {
      const value = String(text || "");
      if (root && !root.__dsoUseVisiblePrelude) {
        const marker = __DSO_INPUT_MARKER, fullMarker = marker + "\\n", index = value.lastIndexOf(marker), prefix = __dsoCanonicalPrefix(root);
        let userText = index >= 0 ? value.slice(index + marker.length) : "";
        if (index >= 0) { userText = userText.startsWith("\\r\\n") ? userText.slice(2) : (userText.startsWith("\\n") ? userText.slice(1) : userText); while (userText.startsWith(prefix)) { userText = userText.slice(prefix.length); } return userText; }
        const prelude = prefix.slice(0, -fullMarker.length);
        return prelude && value.startsWith(prelude) ? value.slice(prelude.length) : value;
      }
      const index = value.lastIndexOf(__DSO_INPUT_MARKER);
      if (index < 0) {
        const prefix = __dsoCanonicalPrefix(root);
        const prelude = prefix.slice(0, -(__DSO_INPUT_MARKER.length + 1));
        return value.startsWith(prelude) ? value.slice(prelude.length) : "";
      }
      const after = value.slice(index + __DSO_INPUT_MARKER.length);
      let userText = after.startsWith("\\r\\n") ? after.slice(2) : (after.startsWith("\\n") ? after.slice(1) : after);
      const prefix = __dsoCanonicalPrefix(root);
      while (userText.startsWith(prefix)) { userText = userText.slice(prefix.length); }
      return userText;
    }

    /** Restores the generated prefix if an edit crosses the hidden boundary. */
    function __dsoRepairPrefix(root, editor, post) {
      const model = editor && editor.getModel && editor.getModel();
      if (!root || !model || root.__dsoPreludeRepairing) { return false; }
      if (!root.__dsoUseVisiblePrelude) { const text = model.getValue(); const userText = __dsoUserText(text, root); const prefix = __dsoDiagnosticPrefix(root, userText); const nextText = prefix + userText; const oldStartLine = root.__dsoUserStartLine || __dsoFindInputStartLine(model); const position = editor && editor.getPosition && editor.getPosition(); const relativeLine = position ? Math.max(0, position.lineNumber - oldStartLine) : 0; const relativeColumn = position ? position.column : 1; const changed = text !== nextText, oldVisibility = root.style.visibility; root.__dsoProtectedPrefix = prefix; if (changed) { root.style.visibility = "hidden"; root.__dsoPreludeRepairing = true; try { model.setValue(nextText); __dsoLog(post, "prelude.guard.diagnostics", { prefixLines: __dsoLineCount(prefix) }); } catch (eVisible) {} root.__dsoPreludeRepairing = false; } root.__dsoProtectedPrefix = prefix; const startLine = __dsoFindInputStartLine(model); __dsoApplyPreludeView(root, editor, model, startLine); if (changed && position) { const targetLine = Math.min(model.getLineCount(), startLine + relativeLine); const targetColumn = Math.min(model.getLineMaxColumn(targetLine), Math.max(1, relativeColumn)); try { editor.setPosition({ column: targetColumn, lineNumber: targetLine }); } catch (eDiagnosticPosition) {} } if (changed) { root.style.visibility = oldVisibility || "visible"; } return changed; }
      const prefix = __dsoCanonicalPrefix(root);
      const text = model.getValue();
      if (text.startsWith(prefix)) {
        const normalizedText = prefix + __dsoUserText(text, root);
        if (normalizedText !== text) {
          root.__dsoPreludeRepairing = true;
          try { model.setValue(normalizedText); __dsoLog(post, "prelude.guard.dedupe", { prefixLines: __dsoLineCount(prefix) }); } catch (eDedupe) {}
          root.__dsoPreludeRepairing = false;
        }
        root.__dsoProtectedPrefix = prefix;
        __dsoApplyPreludeView(root, editor, model, __dsoFindInputStartLine(model));
        return false;
      }
      const userText = __dsoUserText(text, root);
      const oldStartLine = root.__dsoUserStartLine || __dsoFindInputStartLine(model);
      const position = editor && editor.getPosition && editor.getPosition();
      const relativeLine = position ? Math.max(0, position.lineNumber - oldStartLine) : 0;
      const relativeColumn = position ? position.column : 1;
      root.__dsoPreludeRepairing = true;
      try { model.setValue(prefix + userText); __dsoLog(post, "prelude.guard.restore", { prefixLines: __dsoLineCount(prefix) }); } catch (eRestore) {}
      root.__dsoPreludeRepairing = false;
      root.__dsoProtectedPrefix = prefix;
      const startLine = __dsoFindInputStartLine(model);
      __dsoApplyPreludeView(root, editor, model, startLine);
      const targetLine = Math.min(model.getLineCount(), startLine + relativeLine);
      const targetColumn = Math.min(model.getLineMaxColumn(targetLine), Math.max(1, relativeColumn));
      try { editor.setPosition({ column: targetColumn, lineNumber: targetLine }); } catch (eRestorePosition) {}
      return true;
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
      const startLine = __dsoFindInputStartLine(model);
      __dsoApplyPreludeView(root, editor, model, startLine);
      try { const pos = editor && editor.getPosition && editor.getPosition(); if (editor && editor.setPosition && (!pos || pos.lineNumber < startLine)) { editor.setPosition({ column: 1, lineNumber: startLine }); } } catch (ePos) {}
      __dsoInstallPreludeGuard(root, editor, __dsoPost);
    };

    ${overlayDiagnosticPrefixRendererSource()}
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

    /** Returns the contiguous non-blank block at the cursor as one execution unit. */
    function __dsoMultilinePayload(root, editor) {
      const model = editor.getModel && editor.getModel();
      if (!model) { return { code: "", range: null }; }
      const inputStartLine = (root && root.__dsoInputStartLine) || 1;
      const position = editor.getPosition && editor.getPosition();
      const cursorLine = position ? position.lineNumber : model.getLineCount();
      let probeLine = Math.min(Math.max(inputStartLine, cursorLine), model.getLineCount());
      while (probeLine > inputStartLine && !model.getLineContent(probeLine).trim()) { probeLine--; }
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

    /** Returns the first line of the current shell input unit, preserving single blank lines inside pasted source. */
    function __dsoCellStartLine(model, lineNumber, floor) {
      let blankRun = 0;
      for (let index = lineNumber - 1; index >= floor; index--) {
        if (!model.getLineContent(index).trim()) {
          blankRun++;
          if (blankRun >= 2) {
            if (__dsoCellImportBlockGap(model, floor, index)) {
              blankRun = 0;
              continue;
            }
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
            if (__dsoCellImportBlockGap(model, floor, index)) {
              blankRun = 0;
              continue;
            }
            return index - 2;
          }
        } else {
          blankRun = 0;
        }
      }
      return model.getLineCount();
    }

    /** Returns true when a two-blank gap follows the leading import block. */
    function __dsoCellImportBlockGap(model, floor, blankLine) {
      const previous = __dsoCellPreviousNonBlankLine(model, blankLine - 1, floor);
      const blockFloor = __dsoCellPreviousCellFloor(model, floor, previous);
      return previous >= blockFloor && __dsoCellImportBlockPrefix(model, blockFloor, previous);
    }

    /** Returns the nearest non-empty line at or above one line. */
    function __dsoCellPreviousNonBlankLine(model, lineNumber, floor) {
      for (let index = lineNumber; index >= floor; index--) {
        if (model.getLineContent(index).trim()) { return index; }
      }
      return floor - 1;
    }

    /** Returns the line after the nearest prior two-blank cell separator. */
    function __dsoCellPreviousCellFloor(model, floor, lineNumber) {
      let blankRun = 0;
      for (let index = lineNumber - 1; index >= floor; index--) {
        if (!model.getLineContent(index).trim()) {
          blankRun++;
          if (blankRun >= 2) { return index + 2; }
        } else {
          blankRun = 0;
        }
      }
      return floor;
    }

    /** Returns true when all leading non-comment code through one line is Python imports. */
    function __dsoCellImportBlockPrefix(model, floor, endLine) {
      let sawImport = false;
      let importContinuation = false;
      let depth = 0;
      for (let index = floor; index <= endLine; index++) {
        const text = model.getLineContent(index);
        const trimmed = text.trim();
        if (!trimmed || trimmed.indexOf("#") === 0) { continue; }
        if (!importContinuation && !__dsoCellImportStart(trimmed)) { return false; }
        sawImport = true;
        depth = Math.max(0, depth + __dsoBracketDelta(text, depth));
        importContinuation = depth > 0 || /\\\\\\s*$/.test(text.trimEnd());
      }
      return sawImport && depth === 0;
    }

    /** Returns true when a trimmed Python line starts an import statement. */
    function __dsoCellImportStart(line) {
      return /^(?:import\\s+\\S|from\\s+\\S+\\s+import\\b)/.test(line);
    }

    /** Preserves the executed cell, then drops the cursor on a fresh prompt below it. */
    function __dsoAdvanceAfterRun(editor, range, post, source) {
      const model = editor.getModel && editor.getModel();
      if (!model || !range) { return; }
      let last = model.getLineCount();
      while (last > 1 && !model.getLineContent(last).trim()) { last--; }
      if (!model.getLineContent(last).trim()) {
        try { editor.setPosition({ column: 1, lineNumber: model.getLineCount() }); } catch (eEmpty) {}
        return;
      }
      const toLine = model.getLineCount();
      try {
        editor.executeEdits("django-shell-enter", [{
          forceMoveMarkers: true,
          range: { endColumn: model.getLineMaxColumn(toLine), endLineNumber: toLine, startColumn: model.getLineMaxColumn(last), startLineNumber: last },
          text: "\\n\\n"
        }]);
      } catch (eEdit) {}
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
        root.__dsoMultilineMode = false;
        __dsoUpdateExecutionRangePreview(root, editor);
        __dsoLog(post, "enter.skip", { end: end, source: source, targetLine: nextLine });
        return "skipped";
      }
      try {
        const toLine = model.getLineCount();
        editor.executeEdits("django-shell-skip", [{
          forceMoveMarkers: true,
          range: { endColumn: model.getLineMaxColumn(toLine), endLineNumber: toLine, startColumn: model.getLineMaxColumn(end), startLineNumber: end },
          text: "\\n\\n"
        }]);
      } catch (eEdit) {}
      const target = Math.min(model.getLineCount(), end + 2);
      try { editor.setPosition && editor.setPosition({ column: 1, lineNumber: target }); } catch (eSetPosition) {}
      try { editor.revealLineInCenterIfOutsideViewport && editor.revealLineInCenterIfOutsideViewport(target); } catch (eReveal) {}
      root.__dsoMultilineMode = false;
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
    function __dsoRunCode(post, code, root, editor) {
      window.__dsoLastRunOutcome = { chars: String(code || "").length, pending: true };
      return Promise.resolve(post({ type: "run", code: code })).then(function (response) {
        if (response && response.type === "opaque") { window.__dsoLastRunOutcome = { executed: true, opaque: true }; return { executed: true }; }
        if (!response || !response.json || response.ok === false) { window.__dsoLastRunOutcome = { executed: false, status: response && response.status }; return __dsoRunWebviewFallback(code); }
        return response.json().then(function (outcome) { window.__dsoLastRunOutcome = outcome || { executed: false }; return window.__dsoLastRunOutcome; }).catch(function (error) { window.__dsoLastRunOutcome = { error: String(error && error.message || error), executed: false }; return window.__dsoLastRunOutcome; });
      }).catch(function (error) { window.__dsoLastRunOutcome = { error: String(error && error.message || error), executed: false }; return __dsoRunWebviewFallback(code); });
    }
    /** Uses the custom console webview bridge when localhost fetch is unavailable. */
    function __dsoRunWebviewFallback(code) {
      const frame = typeof __dsoFindWebviewFrame === "function" ? __dsoFindWebviewFrame() : null;
      const message = { code: code, type: "overlayRunPython" };
      let sent = 0;
      const postTo = function (target) { if (!target || sent > 16) { return; } try { target.postMessage(message, "*"); sent++; } catch (ePost) {} try { for (let index = 0; target.frames && index < target.frames.length; index++) { postTo(target.frames[index]); } } catch (eFrames) {} };
      postTo(frame && frame.contentWindow); postTo(frame);
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

    /** Returns whether Enter currently belongs to IntelliSense UI. */
    function __dsoSuggestOpen() {
      return __dsoHasVisiblePopup(".suggest-widget,.parameter-hints-widget");
    }

    /** Returns the payload that Enter would run from the current editor state. */
    function __dsoPreviewPayload(root, editor) {
      return root && root.__dsoMultilineMode ? __dsoMultilinePayload(root, editor) : __dsoEnterPayload(root, editor);
    }

    /** Returns Monaco decorations for the currently executable Python input range. */
    function __dsoExecutionRangeDecorations(model, payload) {
      if (!model || !payload || !payload.range || !String(payload.code || "").trim()) { return []; }
      const start = Math.max(1, payload.range.start || 1);
      const end = Math.max(start, payload.range.end || start);
      const endColumn = model.getLineMaxColumn ? model.getLineMaxColumn(end) : 1;
      const decorations = [{
        options: { className: "dso-exec-range", isWholeLine: true, linesDecorationsClassName: "dso-exec-range-rail" },
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
      const payload = __dsoPreviewPayload(root, editor);
      const decorations = __dsoExecutionRangeDecorations(model, payload);
      const preview = payload && payload.range ? { end: payload.range.end, start: payload.range.start } : null;
      const previewKey = preview ? preview.start + ":" + preview.end : "";
      try {
        root.__dsoExecutionRangeDecorationIds = editor.deltaDecorations(root.__dsoExecutionRangeDecorationIds || [], decorations);
        root.__dsoExecutionRangePreview = preview;
        if (root.__dsoExecutionRangePreviewKey !== previewKey) {
          root.__dsoExecutionRangePreviewKey = previewKey;
          if (editor.updateOptions) {
            editor.updateOptions({ lineNumbers: function (line) { return __dsoPromptForLine(model, root.__dsoInputStartLine || __dsoFindInputStartLine(model), line, root); } });
          }
        }
      } catch (eDecorations) {
        root.__dsoExecutionRangeDecorationIds = [];
      }
    }

    /** Installs live execution-range preview decorations on the overlay editor. */
    function __dsoInstallExecutionRangePreview(root, editor) {
      const model = editor && editor.getModel && editor.getModel();
      if (!root || !editor || !model || !editor.deltaDecorations) { return function () {}; }
      const update = function () { __dsoUpdateExecutionRangePreview(root, editor); };
      const cursorDisposable = editor.onDidChangeCursorPosition ? editor.onDidChangeCursorPosition(update) : null;
      const modelDisposable = model.onDidChangeContent ? model.onDidChangeContent(update) : null;
      update();
      return function () {
        try { cursorDisposable && cursorDisposable.dispose && cursorDisposable.dispose(); } catch (eCursorDispose) {}
        try { modelDisposable && modelDisposable.dispose && modelDisposable.dispose(); } catch (eModelDispose) {}
        try { root.__dsoExecutionRangeDecorationIds = editor.deltaDecorations(root.__dsoExecutionRangeDecorationIds || [], []); } catch (eClearDecorations) {}
        root.__dsoExecutionRangePreview = null;
        root.__dsoExecutionRangePreviewKey = "";
      };
    }

    /** Returns a compact DOM label for key-event diagnostics. */
    function __dsoNodeLabel(node) {
      if (!node) { return ""; }
      const tag = String(node.tagName || node.nodeName || "").toLowerCase();
      const cls = String(node.className || "").replace(/\\s+/g, ".").slice(0, 80);
      return cls ? tag + "." + cls : tag;
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
      try { root.__dsoEnterCleanup && root.__dsoEnterCleanup(); } catch (eCleanupEnter) {}
      const node = editor.getDomNode && editor.getDomNode();
      if (!node) {
        __dsoLog(post, "enter.install.skip", { hasNode: false });
        return;
      }
      __dsoLog(post, "enter.install", { hasNode: true, sameEditor: root.__dsoEnterEditor === editor });
      const execute = function (event, source, allowContinuation) {
        const inputStartLine = root.__dsoInputStartLine || 1;
        const multilineMode = !!root.__dsoMultilineMode;
        const payload = multilineMode ? __dsoMultilinePayload(root, editor) : __dsoEnterPayload(root, editor);
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
            root.__dsoMultilineMode = true;
            __dsoLog(post, "enter.block.buffer", { chars: payload.code.length, cursor: position ? position.lineNumber : 0, inputStartLine: inputStartLine, multiline: multilineMode, source: source });
            __dsoInsertNewline(editor, post, source + "-block-buffer");
            return true;
          }
        }
        if (__dsoLikelyIncompletePython(payload.code)) {
          __dsoLog(post, "enter.incomplete.local", { chars: payload.code.length, inputStartLine: inputStartLine, multiline: multilineMode, source: source });
          if (allowContinuation !== false) {
            root.__dsoMultilineMode = true;
            __dsoInsertNewline(editor, post, source + "-local-incomplete");
          }
          return true;
        }
        __dsoLog(post, "enter.execute.request", { chars: payload.code.length, end: payload.range ? payload.range.end : 0, inputStartLine: inputStartLine, lines: __dsoLineCount(payload.code), multiline: multilineMode, source: source, start: payload.range ? payload.range.start : 0 });
        __dsoRunCode(post, payload.code, root, editor).then(function (outcome) {
          if (outcome && outcome.executed === false) {
            __dsoLog(post, "enter.incomplete", { chars: payload.code.length, inputStartLine: inputStartLine, source: source });
            if (allowContinuation !== false) { __dsoInsertNewline(editor, post, source + "-incomplete"); }
            return;
          }
          root.__dsoMultilineMode = false;
          __dsoLog(post, "enter.execute", { end: payload.range ? payload.range.end : 0, inputStartLine: inputStartLine, source: source, start: payload.range ? payload.range.start : 0 });
          __dsoAdvanceAfterRun(editor, payload.range, post, source);
        });
        return true;
      };
      const run = function (event, source) {
        const raw = event.browserEvent || event;
        if (!__dsoIsEnter(event, raw)) { return; }
        const suggest = __dsoSuggestOpen();
        __dsoLog(post, "key.enter", { alt: !!raw.altKey, composing: !!raw.isComposing, ctrl: !!raw.ctrlKey, meta: !!raw.metaKey, shift: !!raw.shiftKey, source: source, suggest: suggest });
        if (raw.shiftKey && !raw.metaKey) {
          if (event.preventDefault) { event.preventDefault(); }
          if (event.stopPropagation) { event.stopPropagation(); }
          if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
          if (raw.preventDefault) { raw.preventDefault(); }
          if (raw.stopPropagation) { raw.stopPropagation(); }
          if (raw.stopImmediatePropagation) { raw.stopImmediatePropagation(); }
          root.__dsoMultilineMode = true;
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
            root.__dsoMultilineMode = true;
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
    window.__djangoShellOverlaySetPrelude = function (text) {
      window.__djangoShellOverlayPrelude = String(text || "");
      const root = document.getElementById("django-shell-overlay");
      const editor = root && root.__djangoShellEditor;
      const model = editor && editor.getModel && editor.getModel();
      if (model) {
        const oldVisibility = root.style.visibility;
        root.style.visibility = "hidden";
        try {
          if (!root.__dsoUseVisiblePrelude) { root.__dsoPreludeText = String(text || ""); window.__dsoApplyPreludeHiddenArea(root, editor); return "ok"; }
          __dsoRepairPrefix(root, editor, __dsoPost);
          const current = model.getValue();
          const userText = __dsoUserText(current, root);
          const oldStartLine = root.__dsoUserStartLine || __dsoFindInputStartLine(model);
          const position = editor && editor.getPosition && editor.getPosition();
          const relativeLine = position ? Math.max(0, position.lineNumber - oldStartLine) : 0;
          root.__dsoPreludeText = String(text || "");
          root.__dsoProtectedPrefix = __dsoCanonicalPrefix(root);
          const nextValue = root.__dsoProtectedPrefix + userText;
          if (current !== nextValue) {
            root.__dsoPreludeRepairing = true;
            model.setValue(nextValue);
            root.__dsoPreludeRepairing = false;
          }
          window.__dsoApplyPreludeHiddenArea(root, editor);
          const targetLine = Math.min(model.getLineCount(), (root.__dsoUserStartLine || 1) + relativeLine);
          const targetColumn = Math.min(model.getLineMaxColumn(targetLine), Math.max(1, position ? position.column : 1));
          try { editor.setPosition({ column: targetColumn, lineNumber: targetLine }); } catch (ePreludeCursor) {}
        } finally {
          root.style.visibility = oldVisibility || "visible";
        }
      }
      return "ok";
    };
  `;
}

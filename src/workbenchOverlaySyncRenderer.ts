// Renderer-side editor text synchronization for the Django shell overlay.

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
      root.__dsoSyncTimer = window.setTimeout(function () {
        const code = String(readValue(editor) || "");
        post({ type: "change", code: code });
      }, 80);
    }

    /** Hooks one Monaco model so other extensions can read its in-memory text. */
    window.__dsoInstallModelSync = function (root, editor, readValue, post) {
      if (!root || !editor) {
        __dsoLog(post, "model.install.skip", { hasEditor: !!editor, hasRoot: !!root });
        return;
      }
      if (root.__dsoSyncEditor === editor) {
        __dsoLog(post, "model.install.skip", { reason: "same-editor" });
        return;
      }
      try { root.__dsoSyncDisposable && root.__dsoSyncDisposable.dispose && root.__dsoSyncDisposable.dispose(); } catch (eDisposeSync) {}
      root.__dsoSyncEditor = editor;
      const model = editor.getModel && editor.getModel();
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
      const prelude = root && root.__dsoPreludeText !== undefined ? root.__dsoPreludeText : window.__djangoShellOverlayPrelude;
      return String(prelude || "") + marker;
    }

    /** Returns user text even when backspace merges it into the marker line. */
    function __dsoUserText(text, root) {
      const value = String(text || "");
      const index = value.indexOf(__DSO_INPUT_MARKER);
      if (index < 0) {
        const prefix = __dsoCanonicalPrefix(root);
        const prelude = prefix.slice(0, -(__DSO_INPUT_MARKER.length + 1));
        return value.startsWith(prelude) ? value.slice(prelude.length) : "";
      }
      const after = value.slice(index + __DSO_INPUT_MARKER.length);
      return after.startsWith("\\r\\n") ? after.slice(2) : (after.startsWith("\\n") ? after.slice(1) : after);
    }

    /** Restores the generated prefix if an edit crosses the hidden boundary. */
    function __dsoRepairPrefix(root, editor, post) {
      const model = editor && editor.getModel && editor.getModel();
      if (!root || !model || root.__dsoPreludeRepairing) { return false; }
      if (!root.__dsoUseVisiblePrelude) { root.__dsoUserStartLine = 1; root.__dsoInputStartLine = 1; root.__dsoProtectedPrefix = ""; return false; }
      const prefix = __dsoCanonicalPrefix(root);
      const text = model.getValue();
      if (text.startsWith(prefix)) {
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
      if (!root || root.__dsoPreludeGuardTimer) { return; }
      root.__dsoPreludeGuardTimer = window.setTimeout(function () {
        root.__dsoPreludeGuardTimer = 0;
        try { window.__dsoApplyPreludeHiddenArea && window.__dsoApplyPreludeHiddenArea(root, editor); } catch (ePreludeLater) {}
      }, 0);
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
          if (event.preventDefault) { event.preventDefault(); }
          if (raw.preventDefault) { raw.preventDefault(); }
        }
      }); } catch (eKeyGuard) {}
    }

    /** Applies hidden prelude lines, shell prompts, and protected line metadata. */
    function __dsoApplyPreludeView(root, editor, model, startLine) {
      if (root) { root.__dsoUserStartLine = startLine; root.__dsoInputStartLine = startLine; root.__dsoProtectedPrefix = __dsoCanonicalPrefix(root); }
      try { if (editor && editor.setHiddenAreas) { editor.setHiddenAreas(startLine > 1 ? [{ startLineNumber: 1, endLineNumber: startLine - 1 }] : [], "django-shell-prelude"); } } catch (eHide) {}
      try { if (editor && editor.updateOptions) { editor.updateOptions({ lineNumbers: function (line) { return __dsoPromptForLine(model, startLine, line); } }); } } catch (eLineNumbers) {}
      try { window.__dsoSchedulePreludeSemanticDecorations ? window.__dsoSchedulePreludeSemanticDecorations(root) : (window.__dsoRefreshPreludeSemanticDecorations && window.__dsoRefreshPreludeSemanticDecorations(root)); } catch (eSemanticRefresh) {}
    }

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

    /** Returns a shell-style prompt label for one visible input line. */
    function __dsoPromptForLine(model, startLine, line) {
      if (line < startLine) { return ""; }
      const text = model && model.getLineContent ? model.getLineContent(line) : "";
      const previous = line > startLine && model && model.getLineContent ? model.getLineContent(line - 1) : "";
      return __dsoIndent(text) > 0 || __dsoBlockHeader(previous) ? "..." : ">>>";
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
      return __dsoBlockHeader(text) ? base + "    " : base;
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
      const line = model.getLineContent(lineNumber);
      const indent = __dsoIndent(line);
      let start = lineNumber;
      if (indent > 0 || __dsoCompoundFollower(line)) {
        for (let index = lineNumber - 1; index >= floor; index--) {
          const candidate = model.getLineContent(index);
          if (candidate.trim() && __dsoIndent(candidate) < indent && __dsoBlockHeader(candidate)) { start = index; break; }
          if (candidate.trim() && indent === 0 && __dsoIndent(candidate) === 0 && __dsoBlockHeader(candidate)) { start = index; break; }
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
      if (!__dsoBlockHeader(model.getLineContent(start))) { return cursor; }
      const baseIndent = __dsoIndent(model.getLineContent(start));
      let end = Math.max(start, cursor);
      for (let index = start + 1; index <= model.getLineCount(); index++) {
        const text = model.getLineContent(index);
        if (!text.trim()) { if (index <= cursor) { end = index; } continue; }
        const indent = __dsoIndent(text);
        if (indent <= baseIndent && index > start + 1 && !__dsoCompoundFollower(text)) { break; }
        end = index;
      }
      return end;
    }

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
      const position = editor.getPosition && editor.getPosition();
      const range = __dsoExecutionRange(root, model, position ? position.lineNumber : 1);
      return {
        code: model.getValueInRange({ endColumn: model.getLineMaxColumn(range.end), endLineNumber: range.end, startColumn: 1, startLineNumber: range.start }).trimEnd(),
        range: range
      };
    }

    /** Advances the cursor to the next editable shell line after execution. */
    function __dsoAdvanceAfterRun(editor, range, post, source) {
      const model = editor.getModel && editor.getModel();
      if (!model || !range) { return; }
      let lineNumber = model.getLineCount();
      let insertedLine = false;
      if (model.getLineContent(lineNumber).trim()) {
        const endColumn = model.getLineMaxColumn(lineNumber);
        try {
          editor.executeEdits("django-shell-enter", [{
            forceMoveMarkers: true,
            range: { endColumn: endColumn, endLineNumber: lineNumber, startColumn: endColumn, startLineNumber: lineNumber },
            text: "\\n"
          }]);
          insertedLine = true;
        } catch (eEdit) {}
        lineNumber = model.getLineCount();
      }
      try { editor.setPosition({ column: 1, lineNumber: lineNumber }); } catch (eSetPosition) {}
      try { editor.revealLineInCenterIfOutsideViewport && editor.revealLineInCenterIfOutsideViewport(lineNumber); } catch (eReveal) {}
      __dsoLog(post, "cursor.advance", { end: range.end, insertedLine: insertedLine, source: source, start: range.start, targetLine: lineNumber });
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

    /** Posts one execution request and returns the extension host decision. */
    function __dsoRunCode(post, code) {
      return Promise.resolve(post({ type: "run", code: code })).then(function (response) {
        if (!response || !response.json) { return { executed: true }; }
        return response.json().catch(function () { return { executed: true }; });
      }).catch(function () { return { executed: false }; });
    }

    /** Returns whether one Monaco or DOM key event is Enter. */
    function __dsoIsEnter(event, raw) {
      return raw.key === "Enter" || raw.code === "Enter" || raw.keyCode === 13 || event.keyCode === 3;
    }

    /** Returns whether any IntelliSense popup is currently visible. */
    function __dsoHasVisiblePopup(selector) {
      const nodes = document.querySelectorAll(selector);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.classList && node.classList.contains("hidden")) { continue; }
        const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
        if (!rect || rect.width > 0 || rect.height > 0) { return true; }
      }
      return false;
    }

    /** Returns whether Enter currently belongs to IntelliSense UI. */
    function __dsoSuggestOpen() {
      return __dsoHasVisiblePopup(".suggest-widget,.parameter-hints-widget");
    }

    /** Returns a compact DOM label for key-event diagnostics. */
    function __dsoNodeLabel(node) {
      if (!node) { return ""; }
      const tag = String(node.tagName || node.nodeName || "").toLowerCase();
      const cls = String(node.className || "").replace(/\\s+/g, ".").slice(0, 80);
      return cls ? tag + "." + cls : tag;
    }

    /** Returns whether a key event belongs to the overlay editor. */
    function __dsoTouchesEditor(node, event) {
      const target = event && event.target;
      if (target && node.contains && node.contains(target)) { return true; }
      try {
        const path = event && event.composedPath ? event.composedPath() : [];
        if (path && path.indexOf(node) >= 0) { return true; }
      } catch (ePath) {}
      const active = document.activeElement;
      if (active && node.contains && node.contains(active)) { return true; }
      return !!(node.classList && node.classList.contains("focused"));
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
      const execute = function (event, source) {
        const inputStartLine = root.__dsoInputStartLine || 1;
        const payload = __dsoEnterPayload(root, editor);
        if (!payload.code.trim()) {
          __dsoLog(post, "enter.empty", { source: source });
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
        __dsoLog(post, "enter.execute.request", { chars: payload.code.length, end: payload.range ? payload.range.end : 0, inputStartLine: inputStartLine, lines: __dsoLineCount(payload.code), source: source, start: payload.range ? payload.range.start : 0 });
        __dsoRunCode(post, payload.code).then(function (outcome) {
          if (outcome && outcome.executed === false) {
            __dsoLog(post, "enter.incomplete", { chars: payload.code.length, inputStartLine: inputStartLine, source: source });
            __dsoInsertNewline(editor, post, source + "-incomplete");
            return;
          }
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
        if (raw.metaKey || raw.ctrlKey || raw.altKey || raw.isComposing || suggest) { return; }
        if (raw.shiftKey) {
          if (event.preventDefault) { event.preventDefault(); }
          if (event.stopPropagation) { event.stopPropagation(); }
          if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
          if (raw.preventDefault) { raw.preventDefault(); }
          if (raw.stopPropagation) { raw.stopPropagation(); }
          if (raw.stopImmediatePropagation) { raw.stopImmediatePropagation(); }
          __dsoInsertNewline(editor, post, source);
          return;
        }
        execute(event, source);
      };
      const command = editor.addCommand ? editor.addCommand(3, function () { __dsoLog(post, "command.enter", { source: "command" }); execute(null, "command"); }) : null;
      const shiftCommand = editor.addCommand ? editor.addCommand(1027, function () { __dsoLog(post, "command.shiftEnter", { source: "command" }); __dsoInsertNewline(editor, post, "command"); }) : null;
      const keyDisposable = editor.onKeyDown ? editor.onKeyDown(function (event) { run(event, "monaco"); }) : null;
      const docListener = function (event) { if (node.contains(event.target)) { run(event, "document"); } };
      const nodeListener = function (event) { run(event, "node"); };
      const windowListener = function (event) {
        const raw = event.browserEvent || event;
        if (!__dsoIsEnter(event, raw)) { return; }
        if (__dsoTouchesEditor(node, event)) {
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
        try { command && editor._standaloneKeybindingService && editor._standaloneKeybindingService.removeDynamicKeybinding && editor._standaloneKeybindingService.removeDynamicKeybinding(command); } catch (eCommandDispose) {}
        try { shiftCommand && editor._standaloneKeybindingService && editor._standaloneKeybindingService.removeDynamicKeybinding && editor._standaloneKeybindingService.removeDynamicKeybinding(shiftCommand); } catch (eShiftDispose) {}
        window.removeEventListener("keydown", windowListener, true);
        document.removeEventListener("keydown", docListener, true);
        node.removeEventListener("keydown", nodeListener, true);
      };
    };
    window.__djangoShellOverlaySetPrelude = function (text) {
      window.__djangoShellOverlayPrelude = String(text || "");
      const root = document.getElementById("django-shell-overlay");
      const editor = root && root.__djangoShellEditor;
      const model = editor && editor.getModel && editor.getModel();
      if (model) {
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
      }
      return "ok";
    };
  `;
}

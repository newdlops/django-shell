// Renderer-side breakpoint controls for the Django shell overlay editor.

/** Builds JavaScript that owns overlay line and inline breakpoint UI. */
export function overlayBreakpointRendererSource(): string {
  return `
    /** Normalizes one host breakpoint item into a one-based source location. */
    function __dsoBreakpointLocation(item) {
      const value = typeof item === "number" ? { line: item } : (item || {});
      const line = Math.floor(Number(value.line));
      const column = Math.max(0, Math.floor(Number(value.column) || 0));
      return Number.isFinite(line) && line >= 1 ? { column: column, line: line } : null;
    }

    /** Returns normalized one-based breakpoint locations relative to user input. */
    function __dsoRelativeBreakpointLocations(items) {
      const seen = Object.create(null);
      return (Array.isArray(items) ? items : []).map(__dsoBreakpointLocation).filter(function (item) {
        if (!item) { return false; }
        const key = item.line + ":" + item.column;
        if (seen[key]) { return false; }
        seen[key] = true;
        return true;
      });
    }

    /** Returns normalized one-based breakpoint lines relative to user input. */
    function __dsoRelativeBreakpointLines(lines) {
      const seen = Object.create(null);
      return __dsoRelativeBreakpointLocations(lines).map(function (item) { return item.line; }).filter(function (line) {
        if (seen[line]) { return false; }
        seen[line] = true;
        return true;
      });
    }

    /** Optimistically toggles one visible breakpoint marker before the host reply arrives. */
    function __dsoToggleLocalBreakpoint(root, line, column) {
      if (!root || !line) { return; }
      const locations = __dsoRelativeBreakpointLocations(root.__dsoBreakpointLocations || window.__dsoOverlayBreakpointLocations || []);
      const targetColumn = Math.max(0, Math.floor(Number(column) || 0));
      let removed = false;
      const next = locations.filter(function (item) {
        const same = item.line === line && item.column === targetColumn;
        if (same) { removed = true; }
        return !same;
      });
      if (!removed) { next.push({ column: targetColumn, line: line }); }
      next.sort(function (left, right) { return left.line - right.line || left.column - right.column; });
      root.__dsoBreakpointLocations = next;
      root.__dsoBreakpointLines = __dsoRelativeBreakpointLines(next);
      window.__dsoOverlayBreakpointLocations = next;
      window.__dsoOverlayBreakpointLines = root.__dsoBreakpointLines;
      try { if (root.__dsoBreakpointToggleEditor) { window.__dsoApplyOverlayBreakpoints(root, root.__dsoBreakpointToggleEditor); } } catch (eLocalBreakpoint) {}
    }

    /** Maps user-input relative breakpoint locations to raw Monaco model locations. */
    function __dsoModelBreakpointLocations(root, items, model) {
      const limit = model && model.getLineCount ? model.getLineCount() : Number.MAX_SAFE_INTEGER;
      const startLine = Number(root && root.__dsoInputStartLine) || 1;
      return __dsoRelativeBreakpointLocations(items).map(function (item) {
        return { column: item.column, line: startLine + item.line - 1, sourceLine: item.line };
      }).filter(function (item) {
        return item.line >= 1 && item.line <= limit;
      });
    }

    /** Builds Monaco decorations for one source breakpoint location. */
    function __dsoBreakpointDecorations(model, item) {
      if (!item.column) {
        return [{ options: { className: "dso-breakpoint-line", isWholeLine: true }, range: { endColumn: model.getLineMaxColumn ? model.getLineMaxColumn(item.line) : 1, endLineNumber: item.line, startColumn: 1, startLineNumber: item.line } }];
      }
      const maxColumn = model.getLineMaxColumn ? model.getLineMaxColumn(item.line) : item.column + 1;
      const startColumn = Math.max(1, Math.min(item.column, Math.max(1, maxColumn - 1)));
      const endColumn = Math.max(startColumn + 1, Math.min(maxColumn, startColumn + 1));
      return [
        { options: { inlineClassName: "dso-inline-breakpoint" }, range: { endColumn: endColumn, endLineNumber: item.line, startColumn: startColumn, startLineNumber: item.line } }
      ];
    }

    /** Draws breakpoint markers for the latest VS Code breakpoint state. */
    window.__dsoApplyOverlayBreakpoints = function (root, editor) {
      const model = editor && editor.getModel && editor.getModel();
      if (!root || !editor || !model || !editor.deltaDecorations) { return "missing-editor"; }
      const locations = __dsoModelBreakpointLocations(root, root.__dsoBreakpointLocations || window.__dsoOverlayBreakpointLocations || [], model);
      const decorations = [];
      locations.forEach(function (item) { Array.prototype.push.apply(decorations, __dsoBreakpointDecorations(model, item)); });
      try { if (editor.updateOptions) { editor.updateOptions({ glyphMargin: false, lineDecorationsWidth: 0, lineNumbersMinChars: 1 }); } } catch (eGlyphOptions) {}
      try {
        root.__dsoBreakpointDecorationIds = editor.deltaDecorations(root.__dsoBreakpointDecorationIds || [], decorations);
      } catch (eBreakpointDecorations) {
        root.__dsoBreakpointDecorationIds = [];
      }
      root.__dsoBreakpointModelLines = locations.map(function (item) { return item.line; });
      root.__dsoBreakpointModelLocations = locations;
      try { __dsoRefreshBreakpointLayer(root, editor); } catch (eRefreshBreakpointLayer) {}
      return "breakpoints:" + locations.length;
    };

    /** Stores breakpoint locations from the extension host and applies them to the live editor. */
    window.__dsoSetOverlayBreakpoints = function (items) {
      const root = document.getElementById("django-shell-overlay");
      window.__dsoOverlayBreakpointLocations = __dsoRelativeBreakpointLocations(items);
      window.__dsoOverlayBreakpointLines = __dsoRelativeBreakpointLines(items);
      if (!root) { return "breakpoints:" + window.__dsoOverlayBreakpointLocations.length; }
      root.__dsoBreakpointLocations = window.__dsoOverlayBreakpointLocations;
      root.__dsoBreakpointLines = window.__dsoOverlayBreakpointLines;
      const editor = root.__djangoShellEditor;
      return editor ? window.__dsoApplyOverlayBreakpoints(root, editor) : "breakpoints:" + root.__dsoBreakpointLocations.length;
    };

    /** Returns a model line from a Monaco mouse event when it targets a gutter-like area. */
    function __dsoBreakpointMouseLine(event) {
      const target = event && event.target;
      const position = target && target.position;
      const type = target && target.type;
      const detail = String(target && target.detail || "");
      if (!position || !Number.isFinite(position.lineNumber)) { return 0; }
      return type === 2 || type === 3 || type === 4 || /glyph|margin|line/i.test(detail) ? position.lineNumber : 0;
    }

    /** Returns the editor-left X offset for a captured DOM mouse event. */
    function __dsoBreakpointLaneOffset(editor, event) {
      const node = editor && editor.getDomNode && editor.getDomNode();
      const rect = node && node.getBoundingClientRect && node.getBoundingClientRect();
      const x = rect && event ? Number(event.clientX) - Number(rect.left) : Number.NaN;
      return Number.isFinite(x) ? x : Number.NaN;
    }

    /** Returns the overlay gutter width that should accept breakpoint clicks. */
    function __dsoBreakpointLaneLimit(editor) {
      const layout = editor && editor.getLayoutInfo && editor.getLayoutInfo();
      const contentLeft = Math.floor(Number(layout && layout.contentLeft));
      if (Number.isFinite(contentLeft) && contentLeft > 0) { return Math.max(48, contentLeft); }
      const lineNumbersRight = (Number(layout && layout.lineNumbersLeft) || 0) + (Number(layout && layout.lineNumbersWidth) || 0);
      const decorationsRight = (Number(layout && layout.decorationsLeft) || 0) + (Number(layout && layout.decorationsWidth) || 0);
      const glyphRight = (Number(layout && layout.glyphMarginLeft) || 0) + (Number(layout && layout.glyphMarginWidth) || 0);
      return Math.max(72, lineNumbersRight, decorationsRight, glyphRight, 24);
    }

    /** Returns whether a DOM mouse event lands in the overlay breakpoint lane. */
    function __dsoBreakpointLaneHit(editor, event) {
      const x = __dsoBreakpointLaneOffset(editor, event);
      return Number.isFinite(x) && x >= 0 && x <= __dsoBreakpointLaneLimit(editor);
    }

    /** Returns a reusable overlay layer for breakpoint dots in the prompt gutter. */
    function __dsoBreakpointLayer(root) {
      if (!root || !root.appendChild || !document.createElement) { return null; }
      const current = root.__dsoBreakpointLayer;
      if (current && current.parentElement) { return current; }
      const layer = document.createElement("div");
      layer.className = "dso-breakpoint-layer";
      layer.style.position = "absolute";
      layer.style.inset = "0 auto auto 0";
      layer.style.background = "transparent";
      layer.style.pointerEvents = "none";
      layer.style.zIndex = "80";
      root.appendChild(layer);
      root.__dsoBreakpointLayer = layer;
      return layer;
    }

    /** Returns the visible pixel height for one Monaco editor line. */
    function __dsoBreakpointLineHeight(editor, line) {
      if (editor && editor.getTopForLineNumber) {
        const top = Number(editor.getTopForLineNumber(line));
        const next = Number(editor.getTopForLineNumber(line + 1));
        if (Number.isFinite(top) && Number.isFinite(next) && next > top) { return next - top; }
      }
      return 19;
    }

    /** Returns a breakpoint dot top coordinate relative to the overlay root. */
    function __dsoBreakpointDotTop(root, editor, line) {
      const rootRect = root && root.getBoundingClientRect ? root.getBoundingClientRect() : { top: 0 };
      const node = editor && editor.getDomNode && editor.getDomNode();
      const editorRect = node && node.getBoundingClientRect ? node.getBoundingClientRect() : { top: 0 };
      const scrollTop = Number(editor && editor.getScrollTop && editor.getScrollTop()) || 0;
      const lineTop = editor && editor.getTopForLineNumber ? Number(editor.getTopForLineNumber(line)) - scrollTop : (line - 1) * 19;
      return (Number(editorRect.top) || 0) - (Number(rootRect.top) || 0) + (Number.isFinite(lineTop) ? lineTop : 0);
    }

    /** Styles one breakpoint dot rendered outside Monaco's decoration lane. */
    function __dsoStyleBreakpointDot(dot, top, height, inline) {
      dot.className = inline ? "dso-breakpoint-dot inline" : "dso-breakpoint-dot";
      dot.style.position = "absolute";
      dot.style.left = inline ? "13px" : "4px";
      dot.style.top = Math.round(top + Math.max(2, (height - 8) / 2)) + "px";
      dot.style.width = inline ? "6px" : "8px";
      dot.style.height = inline ? "6px" : "8px";
      dot.style.borderRadius = "50%";
      dot.style.background = "var(--vscode-debugIcon-breakpointForeground,#e51400)";
      dot.style.boxShadow = "0 0 0 1px var(--vscode-editor-background),0 0 0 2px color-mix(in srgb,var(--vscode-debugIcon-breakpointForeground,#e51400) 55%,transparent)";
    }

    /** Draws prompt-gutter breakpoint dots that remain visible when Monaco hides line decorations. */
    function __dsoRefreshBreakpointLayer(root, editor) {
      const layer = __dsoBreakpointLayer(root);
      const model = editor && editor.getModel && editor.getModel();
      if (!layer || !model) { return; }
      const node = editor.getDomNode && editor.getDomNode();
      const rootRect = root && root.getBoundingClientRect ? root.getBoundingClientRect() : { height: 0, left: 0, top: 0 };
      const editorRect = node && node.getBoundingClientRect ? node.getBoundingClientRect() : { height: 0, left: 0, top: 0 };
      layer.textContent = "";
      layer.style.left = Math.round((Number(editorRect.left) || 0) - (Number(rootRect.left) || 0)) + "px";
      layer.style.top = "0px";
      layer.style.width = "18px";
      layer.style.height = Math.max(Number(rootRect.height) || 0, Number(editorRect.height) || 0, 1) + "px";
      const locations = root.__dsoBreakpointModelLocations || [];
      locations.forEach(function (item) {
        if (!item || item.line < 1 || item.line > model.getLineCount()) { return; }
        const dot = document.createElement("span");
        __dsoStyleBreakpointDot(dot, __dsoBreakpointDotTop(root, editor, item.line), __dsoBreakpointLineHeight(editor, item.line), !!item.column);
        layer.appendChild(dot);
      });
    }

    /** Schedules a breakpoint layer refresh after scroll or layout changes settle. */
    function __dsoScheduleBreakpointLayer(root, editor) {
      if (!root) { return; }
      window.clearTimeout(root.__dsoBreakpointLayerTimer);
      root.__dsoBreakpointLayerTimer = window.setTimeout(function () {
        root.__dsoBreakpointLayerTimer = 0;
        try { __dsoRefreshBreakpointLayer(root, editor); } catch (eRefreshBreakpointLayer) {}
      }, 0);
    }

    /** Estimates a model line from a client Y coordinate when Monaco lacks a target. */
    function __dsoBreakpointLineFromY(editor, event) {
      const model = editor && editor.getModel && editor.getModel();
      const node = editor && editor.getDomNode && editor.getDomNode();
      const rect = node && node.getBoundingClientRect && node.getBoundingClientRect();
      if (!model || !rect || !event) { return 0; }
      const ranges = editor.getVisibleRanges && editor.getVisibleRanges();
      const first = ranges && ranges[0] ? ranges[0].startLineNumber : 1;
      const last = ranges && ranges[0] ? ranges[0].endLineNumber : model.getLineCount();
      const scrollTop = Number(editor.getScrollTop && editor.getScrollTop()) || 0;
      const y = event.clientY - rect.top;
      for (let line = first; line <= last; line++) {
        const top = editor.getTopForLineNumber ? editor.getTopForLineNumber(line) - scrollTop : (line - first) * 19;
        const next = editor.getTopForLineNumber ? editor.getTopForLineNumber(line + 1) - scrollTop : top + 19;
        if (y >= top && y < next) { return line; }
      }
      return 0;
    }

    /** Returns a gutter model line from a captured DOM mouse event. */
    function __dsoBreakpointDomLine(editor, event) {
      if (!__dsoBreakpointLaneHit(editor, event)) { return 0; }
      const target = editor && editor.getTargetAtClientPoint && editor.getTargetAtClientPoint(event.clientX, event.clientY);
      const line = target && target.position && Number.isFinite(target.position.lineNumber) ? target.position.lineNumber : 0;
      return line || __dsoBreakpointLineFromY(editor, event);
    }

    /** Returns a model position for a context-menu breakpoint action. */
    function __dsoBreakpointContextPosition(editor, event) {
      const target = editor && editor.getTargetAtClientPoint && editor.getTargetAtClientPoint(event.clientX, event.clientY);
      const position = target && target.position ? target.position : (editor && editor.getPosition && editor.getPosition());
      if (!position || !Number.isFinite(position.lineNumber)) { return null; }
      return { column: Math.max(1, Math.floor(Number(position.column) || 1)), line: Math.max(1, Math.floor(Number(position.lineNumber))) };
    }

    /** Posts one de-duplicated breakpoint toggle after converting model coordinates to source coordinates. */
    function __dsoPostBreakpointToggle(root, post, rawLine, source, rawColumn, inline) {
      if (!rawLine) { return false; }
      const line = __dsoRelativeUserLine(root, rawLine);
      const column = inline ? Math.max(1, Math.floor(Number(rawColumn) || 1)) : 0;
      const key = line + ":" + column + ":" + !!inline;
      const now = Date.now();
      if (root.__dsoLastBreakpointToggleKey === key && now - (root.__dsoLastBreakpointToggleAt || 0) < 120) { return true; }
      root.__dsoLastBreakpointToggleKey = key;
      root.__dsoLastBreakpointToggleAt = now;
      __dsoLog(post, "breakpoint.toggle", { column: column, inline: !!inline, inputStartLine: Number(root.__dsoInputStartLine) || 1, line: line, rawColumn: rawColumn || 0, rawLine: rawLine, source: source });
      __dsoToggleLocalBreakpoint(root, line, column);
      const payload = { column: column, inline: !!inline, inputStartLine: Number(root.__dsoInputStartLine) || 1, line: line, rawColumn: rawColumn || 0, rawLine: rawLine, source: source, type: "toggleBreakpoint" };
      const fallback = function (reason) { const sent = typeof __dsoPostWebviewFallback === "function" ? __dsoPostWebviewFallback(Object.assign({}, payload, { type: "overlayToggleBreakpoint" })) : 0; __dsoLog(post, "breakpoint.toggle.webview", { line: line, reason: String(reason || ""), sent: sent, source: source }); };
      try { const request = post(payload); if (request && request.then) { request.then(function (response) { if (response && response.type === "opaque") { fallback("opaque"); return; } if (!response || response.ok === false) { fallback(response ? "status:" + response.status : "empty-response"); } }).catch(function (error) { fallback(error && error.message || error); }); } } catch (error) { fallback(error && error.message || error); }
      return true;
    }

    /** Removes any open breakpoint context menu. */
    function __dsoCloseBreakpointMenu(root) {
      const menu = root && root.__dsoBreakpointMenu;
      if (menu && menu.parentElement) { menu.parentElement.removeChild(menu); }
      if (root) { root.__dsoBreakpointMenu = null; }
    }

    /** Adds one command button to the overlay breakpoint context menu. */
    function __dsoAddBreakpointMenuButton(menu, label, action) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); action(); });
      menu.appendChild(button);
    }

    /** Shows the overlay-owned breakpoint context menu at the mouse location. */
    function __dsoShowBreakpointMenu(root, editor, post, event, position) {
      __dsoCloseBreakpointMenu(root);
      const menu = document.createElement("div");
      menu.className = "dso-breakpoint-menu";
      const rootRect = root.getBoundingClientRect ? root.getBoundingClientRect() : { left: 0, top: 0, width: 260, height: 140 };
      menu.style.left = Math.max(0, Math.min(rootRect.width - 210, event.clientX - rootRect.left)) + "px";
      menu.style.top = Math.max(0, Math.min(rootRect.height - 70, event.clientY - rootRect.top)) + "px";
      /** Toggles a whole-line breakpoint from the menu. */
      __dsoAddBreakpointMenuButton(menu, "Toggle Breakpoint", function () {
        __dsoPostBreakpointToggle(root, post, position.line, "context-menu", 0, false);
        __dsoCloseBreakpointMenu(root);
      });
      /** Toggles a column breakpoint from the menu. */
      __dsoAddBreakpointMenuButton(menu, "Toggle Inline Breakpoint", function () {
        __dsoPostBreakpointToggle(root, post, position.line, "context-menu-inline", position.column, true);
        __dsoCloseBreakpointMenu(root);
      });
      root.appendChild(menu);
      root.__dsoBreakpointMenu = menu;
    }

    /** Returns whether an event target is inside the overlay-owned breakpoint lane. */
    function __dsoEventInBreakpointLayer(root, event) {
      const layer = root && root.__dsoBreakpointLayer;
      const target = event && event.target;
      try { return !!(layer && target && layer.contains && layer.contains(target)); } catch (eLayerContains) { return false; }
    }

    /** Returns whether a captured document event lands inside the overlay bounds. */
    function __dsoEventInOverlayRoot(root, event) {
      const rect = root && root.getBoundingClientRect && root.getBoundingClientRect();
      const x = Number(event && event.clientX);
      const y = Number(event && event.clientY);
      return !!rect && Number.isFinite(x) && Number.isFinite(y) && x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
    }

    /** Handles one captured pointer event as a whole-line breakpoint gutter click. */
    function __dsoHandleBreakpointPointer(root, editor, post, event, source) {
      if (event.button !== undefined && event.button !== 0) { return false; }
      try { if (root.__dsoBreakpointMenu && root.__dsoBreakpointMenu.contains && root.__dsoBreakpointMenu.contains(event.target)) { return false; } } catch (eMenuContains) {}
      const line = __dsoBreakpointDomLine(editor, event);
      if (!line) {
        const x = __dsoBreakpointLaneOffset(editor, event);
        const limit = __dsoBreakpointLaneLimit(editor);
        if (Number.isFinite(x) && x <= limit + 24) {
          __dsoLog(post, "breakpoint.click.skip", { inputStartLine: Number(root.__dsoInputStartLine) || 1, laneLimit: limit, reason: x <= limit ? "no-line" : "outside-lane", x: Math.floor(x) });
        }
        return false;
      }
      try { event.preventDefault && event.preventDefault(); } catch (ePreventBreakpointDom) {}
      try { event.stopPropagation && event.stopPropagation(); } catch (eStopBreakpointDom) {}
      try { event.stopImmediatePropagation && event.stopImmediatePropagation(); } catch (eStopImmediateBreakpointDom) {}
      __dsoPostBreakpointToggle(root, post, line, source, 0, false);
      return true;
    }

    /** Handles one captured context menu event for line or inline breakpoint actions. */
    function __dsoHandleBreakpointContext(root, editor, post, event, source) {
      try { if (root.__dsoBreakpointMenu && root.__dsoBreakpointMenu.contains && root.__dsoBreakpointMenu.contains(event.target)) { return false; } } catch (eMenuContains) {}
      const position = __dsoBreakpointContextPosition(editor, event);
      if (!position) { return false; }
      try { event.preventDefault && event.preventDefault(); } catch (ePreventContext) {}
      try { event.stopPropagation && event.stopPropagation(); } catch (eStopContext) {}
      try { event.stopImmediatePropagation && event.stopImmediatePropagation(); } catch (eStopImmediateContext) {}
      __dsoShowBreakpointMenu(root, editor, post, event, position);
      __dsoLog(post, "breakpoint.context", { column: position.column, line: __dsoRelativeUserLine(root, position.line), rawLine: position.line, source: source });
      return true;
    }

    /** Installs gutter click and context-menu breakpoint toggling on the overlay editor. */
    function __dsoInstallBreakpointToggle(root, editor, post) {
      if (!root || !editor) { return; }
      try { root.__dsoBreakpointToggleDisposable && root.__dsoBreakpointToggleDisposable.dispose && root.__dsoBreakpointToggleDisposable.dispose(); } catch (eDisposeBreakpointToggle) {}
      try { root.__dsoBreakpointDomDisposable && root.__dsoBreakpointDomDisposable.dispose && root.__dsoBreakpointDomDisposable.dispose(); } catch (eDisposeBreakpointDom) {}
      try { root.__dsoBreakpointRootDisposable && root.__dsoBreakpointRootDisposable.dispose && root.__dsoBreakpointRootDisposable.dispose(); } catch (eDisposeBreakpointRoot) {}
      try { root.__dsoBreakpointLayerDisposable && root.__dsoBreakpointLayerDisposable.dispose && root.__dsoBreakpointLayerDisposable.dispose(); } catch (eDisposeBreakpointLayer) {}
      try { root.__dsoBreakpointDocumentDisposable && root.__dsoBreakpointDocumentDisposable.dispose && root.__dsoBreakpointDocumentDisposable.dispose(); } catch (eDisposeBreakpointDocument) {}
      try { root.__dsoBreakpointScrollDisposable && root.__dsoBreakpointScrollDisposable.dispose && root.__dsoBreakpointScrollDisposable.dispose(); } catch (eDisposeBreakpointScroll) {}
      try { root.__dsoBreakpointLayoutDisposable && root.__dsoBreakpointLayoutDisposable.dispose && root.__dsoBreakpointLayoutDisposable.dispose(); } catch (eDisposeBreakpointLayout) {}
      root.__dsoBreakpointToggleEditor = editor;
      try { if (editor.updateOptions) { editor.updateOptions({ glyphMargin: false, lineDecorationsWidth: 0, lineNumbersMinChars: 1 }); } } catch (eGlyphToggleOptions) {}
      const node = editor.getDomNode && editor.getDomNode();
      const layer = __dsoBreakpointLayer(root);
      const disposables = [];
      const pointer = function (event) { __dsoHandleBreakpointPointer(root, editor, post, event, "dom-capture"); };
      const rootPointer = function (event) { if (__dsoEventInBreakpointLayer(root, event)) { return; } if (event.target && node && node.contains && node.contains(event.target)) { return; } __dsoHandleBreakpointPointer(root, editor, post, event, "root-capture"); };
      const documentPointer = function (event) { if (!__dsoEventInOverlayRoot(root, event)) { return; } __dsoHandleBreakpointPointer(root, editor, post, event, "document-capture"); };
      const context = function (event) { __dsoHandleBreakpointContext(root, editor, post, event, "context-menu"); };
      const rootContext = function (event) { if (__dsoEventInBreakpointLayer(root, event)) { return; } if (event.target && node && node.contains && node.contains(event.target)) { return; } __dsoHandleBreakpointContext(root, editor, post, event, "root-context-menu"); };
      const documentContext = function (event) { if (!__dsoEventInOverlayRoot(root, event)) { return; } __dsoHandleBreakpointContext(root, editor, post, event, "document-context-menu"); };
      if (node && node.addEventListener) {
        node.addEventListener("mousedown", pointer, true);
        node.addEventListener("contextmenu", context, true);
        disposables.push(function () { node.removeEventListener("mousedown", pointer, true); node.removeEventListener("contextmenu", context, true); });
      }
      if (root.addEventListener && root !== node) {
        root.addEventListener("mousedown", rootPointer, true);
        root.addEventListener("contextmenu", rootContext, true);
        root.__dsoBreakpointRootDisposable = { dispose: function () { try { root.removeEventListener("mousedown", rootPointer, true); root.removeEventListener("contextmenu", rootContext, true); } catch (eRemoveBreakpointRoot) {} } };
      }
      if (document && document.addEventListener) {
        document.addEventListener("mousedown", documentPointer, true);
        document.addEventListener("contextmenu", documentContext, true);
        root.__dsoBreakpointDocumentDisposable = { dispose: function () { try { document.removeEventListener("mousedown", documentPointer, true); document.removeEventListener("contextmenu", documentContext, true); } catch (eRemoveBreakpointDocument) {} } };
      }
      root.__dsoBreakpointDomDisposable = { dispose: function () { disposables.forEach(function (dispose) { try { dispose(); } catch (eRemoveBreakpointDom) {} }); } };
      try { if (editor.onDidScrollChange) { root.__dsoBreakpointScrollDisposable = editor.onDidScrollChange(function () { __dsoScheduleBreakpointLayer(root, editor); }); } } catch (eBreakpointScroll) {}
      try { if (editor.onDidLayoutChange) { root.__dsoBreakpointLayoutDisposable = editor.onDidLayoutChange(function () { __dsoScheduleBreakpointLayer(root, editor); }); } } catch (eBreakpointLayout) {}
      __dsoLog(post, "breakpoint.install", { documentListener: !!(document && document.addEventListener), hasLayer: !!layer, hasNode: !!node, laneLimit: __dsoBreakpointLaneLimit(editor), rootListener: !!(root.addEventListener && root !== node) });
      try { __dsoRefreshBreakpointLayer(root, editor); } catch (eInitialBreakpointLayer) {}
      if (!editor.onMouseDown) { return; }
      root.__dsoBreakpointToggleDisposable = editor.onMouseDown(function (event) {
        const line = __dsoBreakpointMouseLine(event);
        if (!line) { return; }
        try { event.event && event.event.preventDefault && event.event.preventDefault(); } catch (ePreventBreakpoint) {}
        try { event.event && event.event.stopPropagation && event.event.stopPropagation(); } catch (eStopBreakpoint) {}
        try { event.event && event.event.stopImmediatePropagation && event.event.stopImmediatePropagation(); } catch (eStopImmediateBreakpoint) {}
        try { __dsoPostBreakpointToggle(root, post, line, "monaco", 0, false); } catch (ePostBreakpoint) {}
      });
    }
  `;
}

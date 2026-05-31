// Renderer-side hidden prelude view helpers for the Django shell overlay.

/** Builds JavaScript that keeps generated prelude lines out of the visible editor. */
export function overlayPreludeViewRendererSource(): string {
  return `
    /** Applies hidden prelude lines, shell prompts, and protected line metadata. */
    function __dsoApplyPreludeView(root, editor, model, startLine) {
      if (root) { root.__dsoUserStartLine = startLine; root.__dsoInputStartLine = startLine; root.__dsoProtectedPrefix = __dsoCanonicalPrefix(root); }
      try { if (editor && editor.setHiddenAreas) { editor.setHiddenAreas(startLine > 1 ? [{ startLineNumber: 1, endLineNumber: startLine - 1 }] : [], "django-shell-prelude"); } } catch (eHide) {}
      try { const ranges = editor && editor.getVisibleRanges && editor.getVisibleRanges(); const beforeInput = !ranges || !ranges.length || ranges.every(function (range) { return range.endLineNumber < startLine; }); if (beforeInput && editor && editor.revealLineInCenterIfOutsideViewport) { editor.revealLineInCenterIfOutsideViewport(startLine); } } catch (eReveal) {}
      try { __dsoInstallPreludeDomObservers(root, editor, startLine); } catch (eDomHide) {}
      __dsoApplyPreludeCssHide(root, startLine, editor);
      try { window.requestAnimationFrame(function () { __dsoApplyPreludeCssHide(root, startLine, editor); }); } catch (eCssLater) {}
      try { if (editor && editor.updateOptions) { editor.updateOptions({ lineNumbers: function (line) { return __dsoPromptForLine(model, startLine, line, root); } }); } } catch (eLineNumbers) {}
      try { window.__dsoSchedulePreludeSemanticDecorations ? window.__dsoSchedulePreludeSemanticDecorations(root) : (window.__dsoRefreshPreludeSemanticDecorations && window.__dsoRefreshPreludeSemanticDecorations(root)); } catch (eSemanticRefresh) {}
    }

    /** Installs coalesced DOM observers for virtualized Monaco line reuse. */
    function __dsoInstallPreludeDomObservers(root, editor, startLine) {
      if (!root || !editor) { return; }
      if (root.__dsoPreludeScrollEditor !== editor && editor.onDidScrollChange) {
        if (root.__dsoPreludeScrollDisposable && root.__dsoPreludeScrollDisposable.dispose) { root.__dsoPreludeScrollDisposable.dispose(); }
        root.__dsoPreludeScrollEditor = editor;
        root.__dsoPreludeScrollDisposable = editor.onDidScrollChange(function () { __dsoSchedulePreludeCssHide(root, editor, startLine); });
      }
      const node = editor.getDomNode && editor.getDomNode();
      const viewLines = node && node.querySelector(".view-lines");
      if (!viewLines || root.__dsoPreludeMutationNode === viewLines || !window.MutationObserver) { return; }
      if (root.__dsoPreludeMutationObserver) { root.__dsoPreludeMutationObserver.disconnect(); }
      root.__dsoPreludeMutationNode = viewLines;
      root.__dsoPreludeMutationObserver = new MutationObserver(function () { __dsoSchedulePreludeCssHide(root, editor, startLine); });
      root.__dsoPreludeMutationObserver.observe(viewLines, { attributes: true, childList: true, subtree: true });
    }

    /** Coalesces repeated line DOM updates while still hiding before the next paint. */
    function __dsoSchedulePreludeCssHide(root, editor, startLine) {
      if (!root || root.__dsoPreludeHideQueued) { return; }
      root.__dsoPreludeHideQueued = true;
      const apply = function () {
        root.__dsoPreludeHideQueued = false;
        __dsoApplyPreludeCssHide(root, root.__dsoInputStartLine || startLine, editor);
      };
      try { (window.queueMicrotask || function (callback) { Promise.resolve().then(callback); })(apply); } catch (eQueue) { window.setTimeout(apply, 0); }
    }

    /** Hides only currently rendered prelude DOM lines, preserving virtualized user lines. */
    function __dsoApplyPreludeCssHide(root, startLine, editor) {
      if (!root) { return; }
      const node = editor && editor.getDomNode && editor.getDomNode(), model = editor && editor.getModel && editor.getModel();
      if (!node) { return; }
      const ranges = editor.getVisibleRanges && editor.getVisibleRanges();
      const first = ranges && ranges[0] && ranges[0].startLineNumber;
      const lines = Array.from(node.querySelectorAll(".view-lines .view-line"));
      const protectedLines = String(root.__dsoProtectedPrefix || "").split(/\\r?\\n/).filter(Boolean).map(function (text) { return text.trim(); });
      const topOf = function (line) { const top = parseFloat(String(line && line.style && line.style.top || "")); return Number.isFinite(top) ? top : NaN; };
      const firstTop = topOf(lines[0]), secondTop = topOf(lines[1]);
      const height = Number.isFinite(secondTop - firstTop) && secondTop > firstTop ? secondTop - firstTop : 0;
      const leadingPrefix = protectedLines.length && protectedLines.every(function (text, index) { const line = lines[index]; return line && String(line.textContent || "").replace(/\\u00a0/g, " ").trim() === text; });
      lines.forEach(function (line, index) { const text = String(line.textContent || "").replace(/\\u00a0/g, " ").trim(); const byIndex = first ? first + index : 0; const byTop = height && Number.isFinite(topOf(line)) ? Math.round(topOf(line) / height) + 1 : 0; const lineNumber = byIndex || byTop; const beforeInput = lineNumber && lineNumber < startLine; const validLine = lineNumber && model && model.getLineCount && lineNumber <= model.getLineCount(); const modelText = validLine && model.getLineContent ? String(model.getLineContent(lineNumber) || "").trim() : ""; const stalePrefixText = protectedLines.indexOf(text) >= 0 && (!lineNumber || beforeInput || !validLine || (lineNumber >= startLine && modelText !== text)); const display = stalePrefixText || beforeInput || (leadingPrefix && index < protectedLines.length) ? "none" : ""; if (line.style.display !== display) { line.style.display = display; } });
    }
  `;
}

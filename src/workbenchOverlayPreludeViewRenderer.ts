// Renderer-side hidden prelude view helpers for the Django shell overlay.

/** Builds JavaScript that keeps generated prelude lines out of the visible editor. */
export function overlayPreludeViewRendererSource(): string {
  return `
    /** Applies shell prompt metadata without adding hidden prelude lines to the model. */
    function __dsoApplyPreludeView(root, editor, model, startLine) {
      startLine = 1;
      if (root) { root.__dsoUserStartLine = startLine; root.__dsoInputStartLine = startLine; root.__dsoProtectedPrefix = ""; }
      try { if (editor && editor.setHiddenAreas) { editor.setHiddenAreas([], "django-shell-prelude"); } } catch (eHide) {}
      try { if (editor && editor.updateOptions) { editor.updateOptions({ glyphMargin: true, lineDecorationsWidth: 0, lineNumbers: function (line) { return __dsoPromptForLine(model, startLine, line, root); }, lineNumbersMinChars: 1 }); } } catch (eLineNumbers) {}
    }

    /** Preserves compatibility with older injected code that tried to observe hidden prelude DOM. */
    function __dsoInstallPreludeDomObservers(root, editor, startLine) {
      return;
    }

    /** Compatibility no-op: overlay models no longer contain hidden prelude lines. */
    function __dsoSchedulePreludeCssHide(root, editor, startLine) {
      return;
    }

    /** Compatibility no-op: overlay models no longer contain hidden prelude lines. */
    function __dsoApplyPreludeCssHide(root, startLine, editor) {
      return;
    }
  `;
}

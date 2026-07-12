// Renderer-side ORM Query result-range decoration and stale-source handling.

/** Builds JavaScript that marks the exact final expression tabulated by the ORM Query backend. */
export function overlayQueryResultRendererSource(): string {
  return `
    /** Returns the visible user source currently owned by one overlay editor. */
    function __dsoQueryResultSource(root, model) {
      const value = String(model && model.getValue ? model.getValue() : "");
      try { return String(typeof __dsoUserText === "function" ? __dsoUserText(value, root) : value).replace(/\\s+$/, ""); } catch (eQueryResultText) { return value.replace(/\\s+$/, ""); }
    }

    /** Removes the rendered result marker while retaining the editor listener. */
    function __dsoClearQueryResult(root, editor) {
      if (!root) { return; }
      try { root.__dsoQueryResultDecorationIds = editor && editor.deltaDecorations ? editor.deltaDecorations(root.__dsoQueryResultDecorationIds || [], []) : []; } catch (eClearQueryResult) { root.__dsoQueryResultDecorationIds = []; }
      root.__dsoQueryResult = null;
      root.__dsoQueryResultSource = "";
    }

    /** Returns the last expression-like statement as a pre-run result candidate. */
    function __dsoQueryResultCandidate(root, model) {
      if (!root || root.__dsoExecutionMode !== "submit" || !model || !model.getLineCount) { return null; }
      const floor = Math.max(1, Number(root.__dsoInputStartLine) || 1);
      let last = model.getLineCount();
      while (last >= floor && (!String(model.getLineContent(last) || "").trim() || /^\\s*#/.test(String(model.getLineContent(last) || "")))) { last--; }
      if (last < floor) { return null; }
      const range = typeof __dsoExecutionRange === "function" ? __dsoExecutionRange(root, model, last) : { end: last, start: last };
      const first = String(model.getLineContent(range.start) || "").trim();
      const assignment = /^(?:[A-Za-z_]\\w*(?:\\s*(?:\\.[A-Za-z_]\\w*|\\[[^\\]]+\\]))*|\\([^)]*\\)|\\[[^\\]]*\\]|[A-Za-z_]\\w*\\s*,[^=]+)\\s*(?::\\s*[^=]+(?:=(?!=).*)?$|(?:\\*\\*|\\/\\/|<<|>>|[+\\-*\\/%@&|^])?=(?!=))/.test(first);
      if (!first || /^(?:async\\s+def|assert|break|class|continue|def|del|for|from|global|if|import|nonlocal|pass|raise|return|try|while|with|yield)\\b/.test(first) || /:\\s*(?:#.*)?$/.test(first) || assignment) { return null; }
      return { end: Math.max(range.start, range.end), start: range.start };
    }

    /** Applies a whole-line marker and inline result-kind label to the backend-confirmed final expression. */
    function __dsoApplyQueryResult(root, editor) {
      const model = editor && editor.getModel && editor.getModel();
      const result = root && root.__dsoQueryResult;
      if (!root || root.__dsoExecutionMode !== "submit" || !editor || !model || !editor.deltaDecorations) { return "query-result:none"; }
      if (result && __dsoQueryResultSource(root, model) !== String(root.__dsoQueryResultSource || "")) { root.__dsoQueryResult = null; root.__dsoQueryResultSource = ""; }
      const confirmed = root.__dsoQueryResult;
      const offset = Math.max(0, (Number(root.__dsoInputStartLine) || 1) - 1);
      const candidate = confirmed ? null : __dsoQueryResultCandidate(root, model);
      const start = confirmed ? Math.max(1, Math.min(model.getLineCount(), Math.floor(Number(confirmed.startLine) || 1) + offset)) : candidate && candidate.start;
      const end = confirmed ? Math.max(start, Math.min(model.getLineCount(), Math.floor(Number(confirmed.endLine) || start) + offset)) : candidate && candidate.end;
      if (!start || !end) { root.__dsoQueryResultDecorationIds = editor.deltaDecorations(root.__dsoQueryResultDecorationIds || [], []); return "query-result:none"; }
      const kind = confirmed ? String(confirmed.kind || "value") : "candidate";
      const label = confirmed ? String(confirmed.label || confirmed.kind || "result").slice(0, 120) : "last expression";
      const decorations = [{
        options: { className: "dso-query-result dso-query-result-" + kind, isWholeLine: true },
        range: { endColumn: model.getLineMaxColumn(end), endLineNumber: end, startColumn: 1, startLineNumber: start }
      }, {
        options: { after: { content: confirmed ? "  \u2190 result: " + label : "  \u2190 result candidate: " + label, inlineClassName: confirmed ? "dso-query-result-label" : "dso-query-result-candidate-label" } },
        range: { endColumn: model.getLineMaxColumn(end), endLineNumber: end, startColumn: model.getLineMaxColumn(end), startLineNumber: end }
      }];
      try { root.__dsoQueryResultDecorationIds = editor.deltaDecorations(root.__dsoQueryResultDecorationIds || [], decorations); } catch (eApplyQueryResult) { root.__dsoQueryResultDecorationIds = []; return "query-result:error"; }
      return "query-result:" + start + ":" + end + ":" + kind;
    }

    /** Stores a backend-confirmed result descriptor only when it still belongs to the submitted source. */
    window.__dsoSetOverlayQueryResult = function (result, source, ownerToken) {
      const root = document.getElementById("django-shell-overlay");
      if (ownerToken && (root ? root.__dsoOwnerToken !== ownerToken : window.__djangoShellOverlayOwnerToken !== ownerToken)) { return "owner-mismatch"; }
      if (!root) { return "no-overlay"; }
      const editor = root.__djangoShellEditor;
      const model = editor && editor.getModel && editor.getModel();
      const submittedSource = String(source || "").replace(/\\s+$/, "");
      if (!model || __dsoQueryResultSource(root, model) !== submittedSource) { return "query-result:stale-source"; }
      __dsoClearQueryResult(root, editor);
      if (!result) { return __dsoApplyQueryResult(root, editor); }
      root.__dsoQueryResult = result;
      root.__dsoQueryResultSource = submittedSource;
      return __dsoApplyQueryResult(root, editor);
    };

    /** Clears result decorations as soon as edits make the confirmed backend result stale. */
    window.__dsoInstallQueryResultDecoration = function (root, editor) {
      const model = editor && editor.getModel && editor.getModel();
      if (!root || root.__dsoExecutionMode !== "submit" || !editor || !model || root.__dsoQueryResultEditor === editor) { return; }
      try { root.__dsoQueryResultDisposable && root.__dsoQueryResultDisposable.dispose && root.__dsoQueryResultDisposable.dispose(); } catch (eOldQueryResultListener) {}
      root.__dsoQueryResultEditor = editor;
      root.__dsoQueryResultDisposable = model.onDidChangeContent ? model.onDidChangeContent(function () {
        if (root.__dsoQueryResult && __dsoQueryResultSource(root, model) !== String(root.__dsoQueryResultSource || "")) { __dsoClearQueryResult(root, editor); }
        __dsoApplyQueryResult(root, editor);
      }) : null;
      __dsoApplyQueryResult(root, editor);
    };
  `;
}

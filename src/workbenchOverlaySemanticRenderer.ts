// Renderer-side semantic decorations for hidden Django shell prelude imports.

/** Builds JavaScript that colors prelude-imported symbols in the visible editor. */
export function overlaySemanticRendererSource(): string {
  return `
    /** Installs CSS classes used by prelude semantic decorations. */
    function __dsoEnsureSemanticStyle() {
      let style = document.getElementById("django-shell-overlay-semantic-style");
      if (!style) { style = document.createElement("style"); }
      style.id = "django-shell-overlay-semantic-style";
      style.textContent = ".django-shell-semantic-class{color:var(--vscode-symbolIcon-classForeground,var(--vscode-editor-foreground))!important}.django-shell-semantic-namespace{color:var(--vscode-symbolIcon-moduleForeground,var(--vscode-editor-foreground))!important}.django-shell-semantic-function{color:var(--vscode-symbolIcon-functionForeground,var(--vscode-editor-foreground))!important}.django-shell-semantic-variable{color:var(--vscode-symbolIcon-variableForeground,var(--vscode-editor-foreground))!important}";
      if (!style.parentElement) { document.head.appendChild(style); }
    }

    /** Parses hidden prelude imports into bound symbol names and token classes. */
    function __dsoPreludeSemanticSymbols(root) {
      const symbols = Object.create(null);
      const lines = String(root && root.__dsoPreludeText || window.__djangoShellOverlayPrelude || "").split(/\\r?\\n/);
      for (let i = 0; i < lines.length; i++) { __dsoReadPreludeImportLine(lines[i], symbols); }
      return symbols;
    }

    /** Adds names imported by one generated prelude line to the symbol map. */
    function __dsoReadPreludeImportLine(line, symbols) {
      const text = String(line || "").trim();
      const declaration = text.match(/^([A-Za-z_]\\w*)\\s*:/);
      if (declaration) { symbols[declaration[1]] = "variable"; return; }
      let match = text.match(/^import\\s+(.+)$/);
      if (match) { __dsoReadPreludeImportNames(match[1], symbols, true); return; }
      match = text.match(/^from\\s+[A-Za-z_][\\w.]*\\s+import\\s+(.+)$/);
      if (match) { __dsoReadPreludeImportNames(match[1], symbols, false); }
    }

    /** Adds comma-separated import names to the symbol map. */
    function __dsoReadPreludeImportNames(value, symbols, moduleImport) {
      const parts = String(value || "").replace(/[()]/g, "").split(",");
      for (let i = 0; i < parts.length; i++) {
        const match = parts[i].trim().match(/^([A-Za-z_][\\w.]*|\\*)(?:\\s+as\\s+([A-Za-z_]\\w*))?$/);
        if (!match || match[1] === "*") { continue; }
        const name = match[2] || (moduleImport ? match[1].split(".", 1)[0] : match[1]);
        if (/^[A-Za-z_]\\w*$/.test(name)) { symbols[name] = moduleImport ? "namespace" : (/^[A-Z]/.test(name) ? "class" : "variable"); }
      }
    }

    /** Refreshes inline decorations for prelude-imported symbols. */
    window.__dsoRefreshPreludeSemanticDecorations = function (root) {
      const editor = root && root.__djangoShellEditor;
      const model = editor && editor.getModel && editor.getModel();
      if (!root || !editor || !model || !editor.deltaDecorations) { return; }
      __dsoEnsureSemanticStyle();
      const symbols = __dsoPreludeSemanticSymbols(root);
      const startLine = root.__dsoUserStartLine || root.__dsoInputStartLine || 1;
      const decorations = [];
      const pattern = /\\b[A-Za-z_]\\w*\\b/g;
      for (let line = startLine; line <= model.getLineCount(); line++) {
        const source = String(model.getLineContent(line) || "").split("#", 1)[0];
        for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
          const kind = symbols[match[0]];
          if (kind) { decorations.push({ options: { inlineClassName: "django-shell-semantic-" + kind }, range: { endColumn: match.index + match[0].length + 1, endLineNumber: line, startColumn: match.index + 1, startLineNumber: line } }); }
        }
      }
      root.__dsoSemanticDecorationIds = editor.deltaDecorations(root.__dsoSemanticDecorationIds || [], decorations);
    };

    /** Debounces semantic decoration refreshes while the user is typing. */
    window.__dsoSchedulePreludeSemanticDecorations = function (root) {
      if (!root) { return; }
      window.clearTimeout(root.__dsoSemanticTimer);
      root.__dsoSemanticTimer = window.setTimeout(function () { window.__dsoRefreshPreludeSemanticDecorations(root); }, 30);
    };

    /** Installs semantic decoration refresh hooks for the overlay editor. */
    window.__dsoInstallPreludeSemanticDecorations = function (root, editor) {
      if (!root || !editor || root.__dsoSemanticEditor === editor) { return; }
      root.__dsoSemanticEditor = editor;
      const model = editor.getModel && editor.getModel();
      const schedule = function () { window.__dsoSchedulePreludeSemanticDecorations(root); };
      try { root.__dsoSemanticDisposable = model && model.onDidChangeContent && model.onDidChangeContent(schedule); } catch (eSemanticListen) {}
      schedule();
    };
  `;
}

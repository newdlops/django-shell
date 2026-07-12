// Renderer-side semantic decorations for hidden Django shell prelude imports.
import { overlayExecutionUnitRendererSource } from "./workbenchOverlayExecutionUnitRenderer";

const SEMANTIC_DECORATION_DEBOUNCE_MS = 500;

/** Builds JavaScript that colors prelude-imported symbols in the visible editor. */
export function overlaySemanticRendererSource(includeExecutionUnitHelpers = true): string {
  return `
    ${includeExecutionUnitHelpers ? overlayExecutionUnitRendererSource() : ""}

    let __dsoSemanticPreludeCacheText = null;
    let __dsoSemanticPreludeCacheSymbols = null;

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
      const text = String(root && root.__dsoPreludeText || window.__djangoShellOverlayPrelude || "");
      if (__dsoSemanticPreludeCacheText === text && __dsoSemanticPreludeCacheSymbols) { return __dsoSemanticPreludeCacheSymbols; }
      const lines = text.split(/\\r?\\n/);
      for (let i = 0; i < lines.length; i++) { __dsoReadPreludeImportLine(lines[i], symbols); }
      __dsoSemanticPreludeCacheText = text;
      __dsoSemanticPreludeCacheSymbols = symbols;
      return symbols;
    }

    /** Adds one public runtime binding while excluding generated analysis helpers. */
    function __dsoAddPreludeSemanticSymbol(symbols, name, kind) {
      if (/^[A-Za-z_]\\w*$/.test(name) && !/^__dso_/i.test(name)) { symbols[name] = kind; }
    }

    /** Adds names imported by one generated prelude line to the symbol map. */
    function __dsoReadPreludeImportLine(line, symbols) {
      const text = String(line || "").trim();
      const declaration = text.match(/^([A-Za-z_]\\w*)\\s*:/);
      if (declaration) { __dsoAddPreludeSemanticSymbol(symbols, declaration[1], "variable"); return; }
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
        __dsoAddPreludeSemanticSymbol(symbols, name, moduleImport ? "namespace" : (/^[A-Z]/.test(name) ? "class" : "variable"));
      }
    }

    /** Masks comments and quoted strings so decorations only target Python code. */
    function __dsoSemanticCodeMask(line, state) {
      const source = String(line || "");
      const output = source.split("");
      let index = 0;
      const blank = function (start, end) { for (let cursor = start; cursor < end; cursor++) { output[cursor] = " "; } };
      while (index < source.length) {
        if (state.triple) {
          const end = source.indexOf(state.triple, index);
          if (end < 0) { blank(index, source.length); return output.join(""); }
          blank(index, end + 3); index = end + 3; state.triple = ""; continue;
        }
        if (source[index] === "#") { blank(index, source.length); break; }
        if (source[index] !== "'" && source[index] !== '"') { index++; continue; }
        const quote = source[index];
        if (source.slice(index, index + 3) === quote + quote + quote) {
          state.triple = quote + quote + quote; blank(index, index + 3); index += 3; continue;
        }
        const start = index++;
        while (index < source.length) {
          if (source[index] === "\\\\") { index += 2; continue; }
          if (source[index++] === quote) { break; }
        }
        blank(start, Math.min(index, source.length));
      }
      return output.join("");
    }

    /** Finds import-aware execution units in one model. */
    function __dsoSemanticUnits(model, startLine) {
      const units = [];
      const floor = Math.max(1, startLine);
      let line = floor;
      while (line <= model.getLineCount()) {
        while (line <= model.getLineCount() && !String(model.getLineContent(line) || "").trim()) { line++; }
        if (line > model.getLineCount()) { break; }
        const unit = __dsoExecutionUnitRange(model, line, floor);
        if (!unit) { line++; continue; }
        units.push(unit);
        line = unit.end + 1;
      }
      return units;
    }

    /** Collects conservative visible bindings that shadow runtime-prelude names in one unit. */
    function __dsoSemanticUnitBindings(model, unit, masks) {
      const bindings = Object.create(null);
      for (let line = unit.start; line <= unit.end; line++) {
        const source = masks[line] || "";
        const statements = source.split(";");
        for (let index = 0; index < statements.length; index++) {
          const statement = statements[index].trim();
          const imported = Object.create(null);
          __dsoReadPreludeImportLine(statement, imported);
          Object.keys(imported).forEach(function (name) { bindings[name] = true; });
          const declaration = statement.match(/^(?:async\\s+)?(?:def|class)\\s+([A-Za-z_]\\w*)/);
          const assignment = statement.match(/^([A-Za-z_]\\w*)\\s*(?::[^=;]+)?(?:=|:=)/);
          const annotation = statement.match(/^([A-Za-z_]\\w*)\\s*:/);
          if (declaration) { bindings[declaration[1]] = true; }
          if (assignment) { bindings[assignment[1]] = true; }
          if (annotation) { bindings[annotation[1]] = true; }
          for (const pattern of [/\\bfor\\s+([A-Za-z_]\\w*)\\s+in\\b/g, /\\bas\\s+([A-Za-z_]\\w*)\\b/g]) {
            for (let match = pattern.exec(statement); match; match = pattern.exec(statement)) { bindings[match[1]] = true; }
          }
        }
      }
      return bindings;
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
      const masks = [];
      const stringState = { triple: "" };
      for (let line = startLine; line <= model.getLineCount(); line++) { masks[line] = __dsoSemanticCodeMask(model.getLineContent(line), stringState); }
      for (const unit of __dsoSemanticUnits(model, startLine)) {
        const bindings = __dsoSemanticUnitBindings(model, unit, masks);
        for (let line = unit.start; line <= unit.end; line++) {
          const source = masks[line] || "";
          pattern.lastIndex = 0;
          for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
            const kind = symbols[match[0]];
            if (kind && !bindings[match[0]]) { decorations.push({ options: { description: "django-shell-runtime-semantic", inlineClassName: "django-shell-semantic-" + kind }, range: { endColumn: match.index + match[0].length + 1, endLineNumber: line, startColumn: match.index + 1, startLineNumber: line } }); }
          }
        }
      }
      try {
        root.__dsoSemanticDecorationIds = editor.deltaDecorations(root.__dsoSemanticDecorationIds || [], decorations);
        root.__dsoSemanticError = "";
      } catch (error) {
        root.__dsoSemanticDecorationIds = [];
        root.__dsoSemanticError = String(error && error.message || error);
      }
    };

    /** Debounces semantic decoration refreshes while the user is typing. */
    window.__dsoSchedulePreludeSemanticDecorations = function (root) {
      if (!root) { return; }
      window.clearTimeout(root.__dsoSemanticTimer);
      root.__dsoSemanticTimer = window.setTimeout(function () {
        root.__dsoSemanticTimer = 0;
        window.__dsoRefreshPreludeSemanticDecorations(root);
      }, ${SEMANTIC_DECORATION_DEBOUNCE_MS});
    };

    /** Installs semantic decoration refresh hooks for the overlay editor. */
    window.__dsoInstallPreludeSemanticDecorations = function (root, editor) {
      if (!root || !editor) { return; }
      if (root.__dsoSemanticEditor === editor) {
        if (!root.__dsoSemanticTimer) { window.__dsoSchedulePreludeSemanticDecorations(root); }
        return;
      }
      root.__dsoSemanticEditor = editor;
      const model = editor.getModel && editor.getModel();
      const schedule = function () { window.__dsoSchedulePreludeSemanticDecorations(root); };
      try { root.__dsoSemanticDisposable = model && model.onDidChangeContent && model.onDidChangeContent(schedule); } catch (eSemanticListen) {}
      schedule();
    };
  `;
}

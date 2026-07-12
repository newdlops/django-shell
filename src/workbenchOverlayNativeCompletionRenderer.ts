// Renderer-side adaptation of native Python completion imports to independent shell units.
import { overlayExecutionUnitRendererSource } from "./workbenchOverlayExecutionUnitRenderer";

/** Builds JavaScript that keeps native provider auto-imports inside the focused execution unit. */
export function overlayNativeCompletionRendererSource(includeExecutionUnitHelpers = true): string {
  return `
    ${includeExecutionUnitHelpers ? overlayExecutionUnitRendererSource() : ""}

    /** Returns one completion item's visible label. */
    function __dsoNativeCompletionLabel(item) {
      const label = item && item.completion && item.completion.label;
      return String(label && typeof label === "object" ? label.label || "" : label || "").trim();
    }

    /** Returns one edit's replacement text across Monaco and extension-host shapes. */
    function __dsoNativeEditText(edit) {
      return String(edit && (edit.text !== undefined ? edit.text : edit.newText) || "");
    }

    /** Returns one edit range as a plain Monaco-compatible range. */
    function __dsoNativeEditRange(edit) {
      const range = edit && edit.range;
      if (!range) { return null; }
      const start = range.start || range;
      const end = range.end || range;
      const startLineNumber = Number(range.startLineNumber !== undefined ? range.startLineNumber : start.lineNumber !== undefined ? start.lineNumber : Number(start.line) + 1);
      const startColumn = Number(range.startColumn !== undefined ? range.startColumn : start.column !== undefined ? start.column : Number(start.character) + 1);
      const endLineNumber = Number(range.endLineNumber !== undefined ? range.endLineNumber : end.lineNumber !== undefined ? end.lineNumber : Number(end.line) + 1);
      const endColumn = Number(range.endColumn !== undefined ? range.endColumn : end.column !== undefined ? end.column : Number(end.character) + 1);
      if (![startLineNumber, startColumn, endLineNumber, endColumn].every(Number.isFinite)) { return null; }
      return { startLineNumber: startLineNumber, startColumn: startColumn, endLineNumber: endLineNumber, endColumn: endColumn };
    }

    /** Splits a conservative Python import statement into imported specifications. */
    function __dsoNativeImportParts(statement) {
      const text = String(statement || "").trim();
      if (!text || text.indexOf(";") >= 0 || text.indexOf("#") >= 0 || text.indexOf("\\\\") >= 0 || text.indexOf("*") >= 0) { return null; }
      const compact = text.replace(/\\s+/g, " ");
      let match = /^from\\s+([A-Za-z_][\\w.]*)\\s+import\\s+(.+)$/.exec(compact);
      if (match) {
        const specs = match[2].replace(/^\\(\\s*|\\s*\\)$/g, "").split(",").map(function (part) { return part.trim(); }).filter(Boolean);
        return specs.length ? { head: "from " + match[1] + " import ", specs: specs, type: "from" } : null;
      }
      match = /^import\\s+(.+)$/.exec(compact);
      if (!match) { return null; }
      const specs = match[1].split(",").map(function (part) { return part.trim(); }).filter(Boolean);
      return specs.length ? { head: "import ", specs: specs, type: "import" } : null;
    }

    /** Returns the local binding introduced by one import specification. */
    function __dsoNativeImportBinding(spec, type) {
      const match = /^([A-Za-z_][\\w.]*)(?:\\s+as\\s+([A-Za-z_]\\w*))?$/.exec(String(spec || "").trim());
      if (!match) { return ""; }
      return match[2] || (type === "import" ? match[1].split(".")[0] : match[1]);
    }

    /** Narrows one import statement to the selected completion binding. */
    function __dsoNativeFocusedImport(statement, label) {
      const parts = __dsoNativeImportParts(statement);
      if (!parts || !label) { return ""; }
      const spec = parts.specs.find(function (candidate) { return __dsoNativeImportBinding(candidate, parts.type) === label; });
      return spec ? parts.head + spec : "";
    }

    /** Derives a complete import statement from one provider edit and its original model line. */
    function __dsoNativeImportFromEdit(model, edit, label) {
      const range = __dsoNativeEditRange(edit);
      const text = __dsoNativeEditText(edit);
      if (!range || !text) { return ""; }
      const direct = __dsoNativeFocusedImport(text.trim(), label);
      if (direct) { return direct; }
      if (range.startLineNumber !== range.endLineNumber) { return ""; }
      const line = String(model.getLineContent(range.startLineNumber) || "");
      const before = line.slice(0, Math.max(0, range.startColumn - 1));
      const after = line.slice(Math.max(0, range.endColumn - 1));
      const merged = __dsoNativeFocusedImport((before + text + after).trim(), label);
      if (merged) { return merged; }
      if (!/^[A-Za-z_][\\w]*$/.test(label) || !(new RegExp("\\\\b" + label + "\\\\b")).test(text)) { return ""; }
      for (let probe = range.startLineNumber - 1; probe >= Math.max(1, range.startLineNumber - 20); probe--) {
        const header = String(model.getLineContent(probe) || "").trim().match(/^from\\s+([A-Za-z_][\\w.]*)\\s+import\\s+\\(/);
        if (header) { return "from " + header[1] + " import " + label; }
        if (/^\\s*(?:from|import)\\b/.test(String(model.getLineContent(probe) || ""))) { break; }
      }
      return "";
    }

    /** Returns an equivalent import already present outside the focused unit. */
    function __dsoNativeExternalImport(model, unit, label, floorLine) {
      const floor = Math.max(1, Number(floorLine) || 1);
      for (let line = floor; line <= model.getLineCount(); line++) {
        if (line >= unit.start && line <= unit.end) { continue; }
        const source = String(model.getLineContent(line) || "");
        if (source !== source.trimStart()) { continue; }
        const focused = __dsoNativeFocusedImport(source.trim(), label);
        if (focused) { return focused; }
      }
      return "";
    }

    /** Returns whether the focused unit already imports one selected binding. */
    function __dsoNativeUnitImports(model, unit, label) {
      for (let line = unit.start; line <= unit.end; line++) {
        const source = String(model.getLineContent(line) || "");
        if (source === source.trimStart() && __dsoNativeFocusedImport(source.trim(), label)) { return true; }
      }
      return false;
    }

    /** Returns an import insertion point after focused-unit future imports. */
    function __dsoNativeImportInsertion(model, unit) {
      let line = unit.start;
      while (line <= unit.end && /^from\\s+__future__\\s+import\\s+/.test(String(model.getLineContent(line) || "").trim())) { line++; }
      return { lineNumber: line, column: 1 };
    }

    /** Rewrites native provider import edits to the focused independent execution unit. */
    function __dsoRelocateNativeCompletionImports(root, editor, item) {
      const model = editor && editor.getModel && editor.getModel();
      const position = editor && editor.getPosition && editor.getPosition();
      const completion = item && item.completion;
      const label = __dsoNativeCompletionLabel(item);
      if (!model || !position || !completion || !label) { return { changed: false, reason: "missing-context" }; }
      const floor = Math.max(1, Number(root && root.__dsoInputStartLine) || 1);
      const unit = __dsoExecutionUnitRange(model, position.lineNumber, floor);
      if (!unit || unit.start === floor || __dsoNativeUnitImports(model, unit, label)) { return { changed: false, reason: unit && unit.start === floor ? "first-unit" : "local-or-missing-unit" }; }
      const sourceEdits = Array.isArray(completion.additionalTextEdits) ? completion.additionalTextEdits : [];
      const kept = [], imports = [];
      for (let index = 0; index < sourceEdits.length; index++) {
        const edit = sourceEdits[index], range = __dsoNativeEditRange(edit);
        if (!range || (range.startLineNumber >= unit.start && range.endLineNumber <= unit.end)) { kept.push(edit); continue; }
        const statement = __dsoNativeImportFromEdit(model, edit, label);
        if (statement) { imports.push(statement); }
        else { kept.push(edit); }
      }
      if (!imports.length) {
        const inherited = __dsoNativeExternalImport(model, unit, label, floor);
        if (inherited) { imports.push(inherited); }
      }
      const unique = imports.filter(function (value, index) { return imports.indexOf(value) === index; });
      if (!unique.length) { return { changed: false, reason: "no-import" }; }
      const insertion = __dsoNativeImportInsertion(model, unit);
      const eol = model.getEOL ? model.getEOL() : "\\n";
      kept.push({ range: { startLineNumber: insertion.lineNumber, startColumn: insertion.column, endLineNumber: insertion.lineNumber, endColumn: insertion.column }, text: unique.join(eol) + eol + eol });
      completion.additionalTextEdits = kept;
      if (completion.additionalTextEdits !== kept) { return { changed: false, reason: "immutable" }; }
      return { changed: true, imports: unique.length, line: insertion.lineNumber };
    }

    /** Relocates completion imports without allowing an internal API mismatch to block acceptance. */
    function __dsoSafelyRelocateNativeCompletionImports(root, editor, item) {
      try { return __dsoRelocateNativeCompletionImports(root, editor, item); }
      catch (error) {
        root.__dsoNativeCompletionError = String(error && error.message || error);
        try { __dsoPost({ type: "log", event: "completion.nativeImport.error", error: root.__dsoNativeCompletionError }); } catch (eNativeCompletionLog) {}
        return { changed: false, reason: "error" };
      }
    }

    /** Wraps lazy completion resolution so late auto-import edits are relocated before application. */
    function __dsoWrapNativeCompletionResolve(root, editor, item) {
      if (!item || item.__dsoNativeResolveWrapped || item.isResolved || typeof item.resolve !== "function") { return false; }
      const original = item.resolve;
      try {
        item.resolve = function () {
          const args = arguments;
          return Promise.resolve(original.apply(item, args)).then(function (value) {
            const outcome = __dsoSafelyRelocateNativeCompletionImports(root, editor, item);
            if (outcome.changed) { root.__dsoNativeCompletionRelocations = Number(root.__dsoNativeCompletionRelocations || 0) + 1; }
            return value;
          });
        };
        item.__dsoNativeResolveWrapped = true;
        return true;
      } catch (eWrapResolve) { root.__dsoNativeCompletionError = String(eWrapResolve && eWrapResolve.message || eWrapResolve); return false; }
    }

    /** Installs the native SuggestController insertion hook for one overlay editor. */
    window.__dsoInstallNativeCompletionImports = function (root, editor) {
      const version = String(window.__djangoShellOverlayPatchVersion || "");
      if (!root || !editor || (root.__dsoNativeCompletionEditor === editor && root.__dsoNativeCompletionVersion === version)) { return root && root.__dsoNativeCompletionDisposable || null; }
      try { root.__dsoNativeCompletionDisposable && root.__dsoNativeCompletionDisposable.dispose && root.__dsoNativeCompletionDisposable.dispose(); } catch (eOldNativeCompletion) {}
      const controller = editor.getContribution && editor.getContribution("editor.contrib.suggestController");
      if (!controller || typeof controller.onWillInsertSuggestItem !== "function") {
        root.__dsoNativeCompletionError = "missing-onWillInsertSuggestItem";
        try { __dsoPost({ type: "log", event: "completion.nativeImport.unavailable", error: root.__dsoNativeCompletionError }); } catch (eNativeCompletionUnavailableLog) {}
        return null;
      }
      try {
        const disposable = controller.onWillInsertSuggestItem(function (event) {
          const item = event && event.item;
          if (__dsoWrapNativeCompletionResolve(root, editor, item)) { return; }
          const outcome = __dsoSafelyRelocateNativeCompletionImports(root, editor, item);
          if (outcome.changed) { root.__dsoNativeCompletionRelocations = Number(root.__dsoNativeCompletionRelocations || 0) + 1; }
        });
        root.__dsoNativeCompletionEditor = editor;
        root.__dsoNativeCompletionDisposable = disposable;
        root.__dsoNativeCompletionVersion = version;
        root.__dsoNativeCompletionError = "";
        return disposable;
      } catch (error) {
        root.__dsoNativeCompletionError = String(error && error.message || error);
        try { __dsoPost({ type: "log", event: "completion.nativeImport.installError", error: root.__dsoNativeCompletionError }); } catch (eNativeCompletionInstallLog) {}
        return null;
      }
    };
  `;
}

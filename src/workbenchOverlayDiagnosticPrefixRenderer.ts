// Renderer helpers for hidden Python diagnostic bindings in the overlay cell.

/** Builds JavaScript that keeps prelude names available to Pylance diagnostics. */
export function overlayDiagnosticPrefixRendererSource(): string {
  return `
    /** Returns a hidden import prefix for runtime names referenced by user code. */
    function __dsoDiagnosticPrefix(root, userText) {
      const marker = __DSO_INPUT_MARKER + "\\n";
      const prelude = root && root.__dsoPreludeText !== undefined ? root.__dsoPreludeText : window.__djangoShellOverlayPrelude;
      const used = __dsoUsedIdentifiers(userText);
      const lines = String(prelude || "").split(/\\r?\\n/);
      const prefix = [];
      let needsAny = false;
      for (let index = 0; index < lines.length; index++) {
        const line = String(lines[index] || "").trim();
        if (!line || line[0] === "#") { continue; }
        if (__dsoStickyPreludeImport(line)) { prefix.push(line); continue; }
        const importNames = __dsoImportBoundNames(line);
        if (importNames.some(function (name) { return used[name]; })) { prefix.push(line); continue; }
        const declared = __dsoDeclarationName(line);
        if (declared && used[declared]) { needsAny = true; prefix.push(declared + ": _DjsAny"); }
      }
      if (needsAny && !prefix.some(function (line) { return line === "from typing import Any as _DjsAny"; })) { prefix.unshift("from typing import Any as _DjsAny"); }
      return (prefix.length ? prefix.join("; ") : "pass") + "\\n" + marker;
    }

    /** Returns identifiers that appear in Python cell text. */
    function __dsoUsedIdentifiers(text) {
      const used = Object.create(null);
      String(text || "").replace(/[A-Za-z_]\\w*/g, function (name) { used[name] = true; return name; });
      return used;
    }

    /** Returns whether one import should stay available before the user finishes typing. */
    function __dsoStickyPreludeImport(line) {
      return /^from\\s+(?:[A-Za-z_]\\w*\\.)*models(?:\\.[A-Za-z_]\\w*)*\\s+import\\s+/.test(String(line || ""));
    }

    /** Returns names bound by a Python import line. */
    function __dsoImportBoundNames(line) {
      const fromImport = String(line || "").match(/^from\\s+[A-Za-z_][\\w.]*\\s+import\\s+(.+)$/);
      if (fromImport) { return __dsoImportParts(fromImport[1], false); }
      const moduleImport = String(line || "").match(/^import\\s+(.+)$/);
      return moduleImport ? __dsoImportParts(moduleImport[1], true) : [];
    }

    /** Returns names from one comma-separated import list. */
    function __dsoImportParts(value, moduleImport) {
      return String(value || "").replace(/[()]/g, "").split(",").map(function (part) {
        const match = part.trim().match(/^([A-Za-z_][\\w.]*|\\*)(?:\\s+as\\s+([A-Za-z_]\\w*))?$/);
        return match && match[1] !== "*" ? (match[2] || (moduleImport ? match[1].split(".", 1)[0] : match[1])) : "";
      }).filter(__dsoIsIdentifier);
    }

    /** Returns the declared name from a simple prelude assignment or annotation. */
    function __dsoDeclarationName(line) {
      const match = String(line || "").match(/^([A-Za-z_]\\w*)\\s*(?::[^=]+)?(?:=.*)?$/);
      return match && __dsoIsIdentifier(match[1]) ? match[1] : "";
    }

    /** Returns whether a value is a Python identifier. */
    function __dsoIsIdentifier(value) {
      return /^[A-Za-z_]\\w*$/.test(String(value || ""));
    }
  `;
}

// Shared hidden prelude helpers for the Django shell overlay source file.

const INPUT_MARKER = "# --- django shell input ---";

/** Builds hidden import text for Python analysis without touching disk. */
export function overlayPreludeText(importLines: string[]): string {
  const lines = uniquePreludeLines(importLines);
  return lines.length ? `# Django shell runtime imports for analysis.\n# ruff: noqa\n${lines.join("\n")}\n\n` : "";
}

/** Returns the zero-based first user-code line for the generated overlay file. */
export function overlayInputLineOffset(importLines: string[]): number {
  return prefixLineCount(overlayPreludeText(importLines));
}

/** Returns de-duplicated non-empty prelude lines within the renderer limit. */
function uniquePreludeLines(importLines: string[]): string[] {
  const seen = new Set<string>();
  return importLines.filter((line) => line && !seen.has(line) && seen.add(line)).slice(0, 5000);
}

/** Returns the first user line for a generated document prefix. */
function prefixLineCount(prelude: string): number {
  return `${prelude}${INPUT_MARKER}\n`.split(/\r?\n/).length - 1;
}

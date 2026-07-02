// Pure step-in target selection helpers for debugger control requests.

export interface DebugStepInTarget {
  column?: number;
  endColumn?: number;
  endLine?: number;
  id: number;
  label: string;
  line?: number;
}

export interface DebugSourceNameSpan {
  end: number;
  name: string;
  start: number;
}

/** Chooses the DAP step-in target that best matches known user-source symbols. */
export function chooseStepInTarget(targets: DebugStepInTarget[], candidateNames: Iterable<string>, pausedLine?: number, sourceLine = ""): DebugStepInTarget | undefined {
  const names = normalizedNameSet(candidateNames);
  if (!names.size) { return undefined; }
  return preferredNonZeroTarget(targets.filter((target) => targetRangeName(target, pausedLine, sourceLine, names)))
    ?? preferredNonZeroTarget(targets.filter((target) => targetLabelMatchesNames(target.label, names)));
}

/** Returns identifier spans from a Python source line. */
export function pythonIdentifierSpans(line: string): DebugSourceNameSpan[] {
  const spans: DebugSourceNameSpan[] = [];
  const pattern = /\b[A-Za-z_]\w*\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    const name = match[0];
    if (!PYTHON_KEYWORDS.has(name)) {
      spans.push({ end: match.index + name.length, name, start: match.index });
    }
  }
  return spans;
}

/** Returns non-attribute identifiers that are directly called on one Python line. */
export function pythonDirectCallIdentifierSpans(line: string): DebugSourceNameSpan[] {
  return pythonIdentifierSpans(line).filter((span) => {
    if (!/^\s*\(/.test(line.slice(span.end))) { return false; }
    return !line.slice(0, span.start).trimEnd().endsWith(".");
  });
}

/** Returns import aliases and local callable definitions visible in Python source. */
export function pythonImportedOrDefinedNames(source: string): Set<string> {
  const names = new Set<string>();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripPythonComment(lines[index]).trim();
    const fromImportBlock = line.match(/^from\s+\S+\s+import\s*\((.*)$/);
    if (fromImportBlock) {
      const parts = [fromImportBlock[1]];
      while (index + 1 < lines.length && !parts.join(" ").includes(")")) {
        index += 1;
        parts.push(stripPythonComment(lines[index]));
      }
      collectImportParts(parts.join(" ").replace(/[()]/g, ""), names);
      continue;
    }
    const fromImport = line.match(/^from\s+\S+\s+import\s+(.+)$/);
    if (fromImport) { collectImportParts(fromImport[1], names); continue; }
    const importLine = line.match(/^import\s+(.+)$/);
    if (importLine) { collectImportParts(importLine[1], names, true); continue; }
    const definition = line.match(/^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)\b/);
    if (definition) { names.add(definition[1]); }
  }
  return names;
}

/** Returns a normalized candidate-name set. */
function normalizedNameSet(candidateNames: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const name of candidateNames) {
    const normalized = String(name || "").trim();
    if (/^[A-Za-z_]\w*$/.test(normalized)) { names.add(normalized); }
  }
  return names;
}

/** Returns whether one target range lands on a known source identifier. */
function targetRangeName(target: DebugStepInTarget, pausedLine: number | undefined, sourceLine: string, names: Set<string>): string | undefined {
  if (!sourceLine || !Number.isFinite(Number(target.column)) || (target.line && pausedLine && target.line !== pausedLine)) { return undefined; }
  const column = Math.max(0, Number(target.column) - 1);
  return pythonIdentifierSpans(sourceLine).find((span) => span.start <= column && column < span.end && names.has(span.name))?.name;
}

/** Returns whether a DAP target label names a known user-source symbol. */
function targetLabelMatchesNames(label: string, names: Set<string>): boolean {
  const value = String(label || "");
  return [...names].sort((left, right) => right.length - left.length).some((name) => new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(name)}([^A-Za-z0-9_]|$)`).test(value));
}

/** Escapes a string for literal use in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Prefers a non-zero debugpy target when equivalent smart-step targets are repeated. */
function preferredNonZeroTarget(targets: DebugStepInTarget[]): DebugStepInTarget | undefined {
  const first = targets[0];
  if (!first) { return undefined; }
  const group = targets.filter((target) => targetBaseLabel(target.label) === targetBaseLabel(first.label));
  return [...group].reverse().find((target) => target.id > 0) ?? first;
}

/** Returns a stable label key without debugpy duplicate-call suffixes. */
function targetBaseLabel(label: string): string {
  return String(label || "").replace(/\s+\(call\s+\d+\)$/, "");
}

/** Adds names from a comma-separated Python import list. */
function collectImportParts(value: string, names: Set<string>, topLevel = false): void {
  for (const part of value.split(",")) {
    const cleaned = part.trim();
    if (!cleaned || cleaned === ")") { continue; }
    const alias = cleaned.match(/\bas\s+([A-Za-z_]\w*)$/);
    if (alias) { names.add(alias[1]); continue; }
    const name = cleaned.match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/);
    if (name) { names.add(topLevel ? name[1].split(".")[0] : name[1]); }
  }
}

/** Removes a trailing Python line comment for import parsing. */
function stripPythonComment(line: string): string {
  return line.replace(/\s+#.*$/, "");
}

const PYTHON_KEYWORDS = new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]);

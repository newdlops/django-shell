// Compact paused-debugger variable summaries for Monaco inline decorations.

import type { DebugScopeInfo, DebugVariableInfo } from "./debugInspector";

const INLINE_ARGUMENT_SCOPE = /\barguments?\b/i;
const INLINE_LOCAL_SCOPE = /\blocals?\b/i;
const MAX_INLINE_ENTRIES = 6;
const MAX_INLINE_ENTRY_CHARS = 96;
const MAX_INLINE_TEXT_CHARS = 240;
const INLINE_SEPARATOR = "  ·  ";

/** Formats bounded argument and local values for one paused-line inline decoration. */
export function debugInlineValueText(scopes: DebugScopeInfo[] | undefined): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const scope of inlineScopes(scopes)) {
    for (const variable of scope.variables) {
      const name = inlineVariableName(variable);
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      const entry = truncateInlineText(`${name} = ${inlineVariableValue(variable)}`, MAX_INLINE_ENTRY_CHARS);
      const next = entries.length ? `${entries.join(INLINE_SEPARATOR)}${INLINE_SEPARATOR}${entry}` : entry;
      if (next.length > MAX_INLINE_TEXT_CHARS) {
        break;
      }
      entries.push(entry);
      if (entries.length >= MAX_INLINE_ENTRIES) {
        return entries.join(INLINE_SEPARATOR);
      }
    }
  }
  return entries.join(INLINE_SEPARATOR);
}

/** Returns a stable renderer key that changes when either the paused line or its values change. */
export function debugInlineRenderKey(line: number, inlineText: string): string {
  return JSON.stringify([Math.max(0, Math.floor(Number(line) || 0)), String(inlineText || "")]);
}

/** Selects Arguments before Locals and excludes every other debugger scope. */
function inlineScopes(scopes: DebugScopeInfo[] | undefined): DebugScopeInfo[] {
  return (scopes ?? []).map((scope, index) => ({ index, priority: inlineScopePriority(scope.name), scope }))
    .filter((entry) => entry.priority >= 0)
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map((entry) => entry.scope);
}

/** Returns the display priority for a debugger scope, or -1 when it is not inline-safe. */
function inlineScopePriority(name: string): number {
  if (INLINE_ARGUMENT_SCOPE.test(name)) {
    return 0;
  }
  return INLINE_LOCAL_SCOPE.test(name) ? 1 : -1;
}

/** Returns a safe Python identifier for one inline variable, excluding private and synthetic rows. */
function inlineVariableName(variable: DebugVariableInfo): string {
  const name = String(variable.name || "").trim();
  if (variable.querysetPreview || name.startsWith("_") || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    return "";
  }
  return name;
}

/** Normalizes a DAP value and strips only its known expandable-reference suffix. */
function inlineVariableValue(variable: DebugVariableInfo): string {
  let value = normalizeInlineText(variable.value);
  const reference = Math.max(0, Math.floor(Number(variable.variablesReference) || 0));
  const suffix = reference ? `<${reference}>` : "";
  if (suffix && value.endsWith(suffix)) {
    value = value.slice(0, -suffix.length).trimEnd();
  }
  return value || "∅";
}

/** Collapses control characters and repeated whitespace so injected text stays on one editor line. */
function normalizeInlineText(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Truncates one inline entry with an ellipsis while respecting the requested character budget. */
function truncateInlineText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

// Runtime-prelude context detection for native Python overlay language features.

import { overlayExecutionUnitRange } from "./overlayExecutionUnit";

const MAX_PRELUDE_CACHE_ENTRIES = 4;
const preludeSymbolCache = new Map<string, Map<string, OverlayRuntimeSymbol>>();

/** Minimal zero-based source position accepted by pure runtime-context helpers. */
export interface OverlayRuntimePosition {
  character: number;
  line: number;
}

/** One name made available by the attached Django shell runtime prelude. */
export interface OverlayRuntimeSymbol {
  kind: "class" | "namespace" | "variable";
  name: string;
  source: string;
}

/** A completion request that needs either synthetic runtime names or hidden member analysis. */
export type OverlayRuntimeCompletionContext =
  | { kind: "member"; prefix: string; root: OverlayRuntimeSymbol }
  | { kind: "names"; prefix: string; symbols: OverlayRuntimeSymbol[] };

/** A non-completion request rooted in one runtime-only prelude name. */
export interface OverlayRuntimeFeatureContext {
  member: boolean;
  root: OverlayRuntimeSymbol;
}

/** Returns the runtime-only context for one completion, or nothing for ordinary native Python work. */
export function overlayRuntimeCompletionContext(text: string, position: OverlayRuntimePosition, prelude: string): OverlayRuntimeCompletionContext | undefined {
  const symbols = runtimePreludeSymbolMap(prelude);
  if (!symbols.size) { return undefined; }
  const line = lineAt(text, position.line);
  const character = boundedCharacter(line, position.character);
  if (!codePosition(line, character) || importStatementPrefix(line.slice(0, character))) { return undefined; }
  const tokenStart = identifierStart(line, character);
  const prefix = line.slice(tokenStart, character);
  if (tokenStart > 0 && line[tokenStart - 1] === ".") {
    const rootName = attributeRootName(line.slice(0, tokenStart - 1));
    const root = rootName ? symbols.get(rootName) : undefined;
    if (!root || visibleBindingsBefore(text, position).has(root.name)) { return undefined; }
    return { kind: "member", prefix, root };
  }
  const visible = visibleBindingsBefore(text, position);
  const candidates = [...symbols.values()]
    .filter((symbol) => !visible.has(symbol.name) && symbol.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name));
  return candidates.length ? { kind: "names", prefix, symbols: candidates } : undefined;
}

/** Returns whether hover/navigation/signature work is rooted in a runtime-only prelude name. */
export function overlayRuntimeFeatureContext(text: string, position: OverlayRuntimePosition, prelude: string): OverlayRuntimeFeatureContext | undefined {
  const symbols = runtimePreludeSymbolMap(prelude);
  if (!symbols.size) { return undefined; }
  const line = lineAt(text, position.line);
  const character = boundedCharacter(line, position.character);
  if (!codePosition(line, character)) { return undefined; }
  const word = wordAt(line, character);
  const direct = word ? symbols.get(word.text) : undefined;
  if (word && direct && !visibleBindingsBefore(text, { character: word.start, line: position.line }).has(direct.name)) { return { member: false, root: direct }; }
  const expressionEnd = word ? word.end : character;
  const expression = line.slice(0, expressionEnd);
  const rootName = expressionRootName(expression);
  const root = rootName ? symbols.get(rootName) : undefined;
  if (!root || visibleBindingsBefore(text, { character: word?.start ?? character, line: position.line }).has(root.name)) { return undefined; }
  return { member: root.name !== word?.text, root };
}

/** Parses runtime imports and declarations into their visible bound-name metadata. */
export function runtimePreludeSymbols(prelude: string): OverlayRuntimeSymbol[] {
  return [...runtimePreludeSymbolMap(prelude).values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Builds a unique lookup of public runtime-prelude names. */
function runtimePreludeSymbolMap(prelude: string): Map<string, OverlayRuntimeSymbol> {
  const cached = preludeSymbolCache.get(prelude);
  if (cached) { preludeSymbolCache.delete(prelude); preludeSymbolCache.set(prelude, cached); return cached; }
  const symbols = new Map<string, OverlayRuntimeSymbol>();
  for (const rawLine of prelude.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    const declaration = line.match(/^([A-Za-z_]\w*)\s*:\s*(.+)$/u);
    if (declaration) {
      addRuntimeSymbol(symbols, declaration[1], "variable", line);
      continue;
    }
    const moduleImport = line.match(/^import\s+(.+)$/u);
    if (moduleImport) {
      for (const item of importParts(moduleImport[1], true)) { addRuntimeSymbol(symbols, item.name, "namespace", line); }
      continue;
    }
    const fromImport = line.match(/^from\s+(?:\.+|\.*[A-Za-z_][\w.]*)\s+import\s+(.+)$/u);
    if (fromImport) {
      for (const item of importParts(fromImport[1], false)) { addRuntimeSymbol(symbols, item.name, /^[A-Z]/u.test(item.imported) ? "class" : "variable", line); }
    }
  }
  while (preludeSymbolCache.size >= MAX_PRELUDE_CACHE_ENTRIES) {
    const oldest = preludeSymbolCache.keys().next().value as string | undefined;
    if (oldest === undefined) { break; }
    preludeSymbolCache.delete(oldest);
  }
  preludeSymbolCache.set(prelude, symbols);
  return symbols;
}

/** Adds one public runtime name without exposing generated analyzer helpers. */
function addRuntimeSymbol(symbols: Map<string, OverlayRuntimeSymbol>, name: string, kind: OverlayRuntimeSymbol["kind"], source: string): void {
  if (!/^_[Dd]js/u.test(name) && name !== "*") { symbols.set(name, { kind, name, source }); }
}

/** Parses comma-separated Python import bindings. */
function importParts(value: string, moduleImport: boolean): Array<{ imported: string; name: string }> {
  const parts: Array<{ imported: string; name: string }> = [];
  for (const raw of value.replace(/[()]/gu, "").split(",")) {
    const match = raw.trim().match(/^([A-Za-z_][\w.]*|\*)(?:\s+as\s+([A-Za-z_]\w*))?$/u);
    if (!match || match[1] === "*") { continue; }
    const name = match[2] ?? (moduleImport ? match[1].split(".", 1)[0] : match[1]);
    parts.push({ imported: match[1].split(".").at(-1) ?? match[1], name });
  }
  return parts;
}

/** Returns visible names bound before one source position. */
function visibleBindingsBefore(text: string, position: OverlayRuntimePosition): Set<string> {
  const unit = overlayExecutionUnitRange(text, position.line, 0);
  const start = unit ? offsetAt(text, { character: 0, line: unit.start }) : offsetAt(text, { character: 0, line: position.line });
  const prefix = text.slice(start, offsetAt(text, position));
  const bindings = new Set<string>();
  for (const rawLine of prefix.split(/\r\n|\n|\r/)) {
    const line = rawLine.replace(/#.*$/u, "");
    for (const statement of simpleStatements(line)) {
      const moduleImport = statement.match(/^\s*import\s+(.+)$/u);
      const fromImport = statement.match(/^\s*from\s+(?:\.+|\.*[A-Za-z_][\w.]*)\s+import\s+(.+)$/u);
      if (moduleImport) { for (const item of importParts(moduleImport[1], true)) { bindings.add(item.name); } }
      if (fromImport) { for (const item of importParts(fromImport[1], false)) { bindings.add(item.name); } }
      for (const match of statement.matchAll(/\b(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/gu)) { bindings.add(match[1]); }
      for (const match of statement.matchAll(/(?:^|[,(])\s*([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/gu)) { bindings.add(match[1]); }
      for (const match of statement.matchAll(/\b(?:for\s+([A-Za-z_]\w*)\s+in|as\s+([A-Za-z_]\w*))/gu)) { bindings.add(match[1] ?? match[2]); }
      const parameters = statement.match(/\b(?:async\s+def|def)\s+[A-Za-z_]\w*\s*\(([^)]*)\)/u)?.[1];
      if (parameters) {
        for (const parameter of parameters.split(",")) {
          const name = parameter.trim().match(/^\*{0,2}([A-Za-z_]\w*)/u)?.[1];
          if (name) { bindings.add(name); }
        }
      }
    }
  }
  return bindings;
}

/** Returns the root identifier of an attribute/call/subscript chain suffix. */
function attributeRootName(expression: string): string | undefined {
  const direct = expression.match(/([A-Za-z_]\w*)(?:\s*\.\s*[A-Za-z_]\w*)*\s*$/u);
  if (direct) { return direct[1]; }
  const match = expressionWithoutGroups(expression).match(/([A-Za-z_]\w*)(?:\s*\.\s*[A-Za-z_]\w*)*\s*$/u);
  return match?.[1];
}

/** Removes call and subscript contents while preserving their surrounding dotted receiver chain. */
function expressionWithoutGroups(expression: string): string {
  let result = "";
  const stack: string[] = [];
  let quote = "";
  let escaped = false;
  for (const value of expression) {
    if (quote) {
      if (!escaped && value === quote) { quote = ""; }
      escaped = !escaped && value === "\\";
      if (value !== "\\") { escaped = false; }
      continue;
    }
    if (value === "'" || value === '"') { quote = value; continue; }
    if (value === "(" || value === "[") { stack.push(value); continue; }
    if (value === ")" || value === "]") {
      const opening = stack.pop();
      if (opening !== (value === ")" ? "(" : "[")) { return expression; }
      continue;
    }
    if (!stack.length) { result += value; }
  }
  return result;
}

/** Returns the root identifier around a hover or call position. */
function expressionRootName(expression: string): string | undefined {
  return attributeRootName(expression);
}

/** Returns the identifier covering a zero-based line character. */
function wordAt(line: string, character: number): { end: number; start: number; text: string } | undefined {
  const pattern = /\b[A-Za-z_]\w*\b/gu;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    if (character >= match.index && character <= match.index + match[0].length) { return { end: match.index + match[0].length, start: match.index, text: match[0] }; }
  }
  return undefined;
}

/** Returns whether the cursor is outside a simple quoted string or comment. */
function codePosition(line: string, character: number): boolean {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < character; index += 1) {
    const value = line[index];
    if (!quote && value === "#") { return false; }
    if (!escaped && (value === "'" || value === '"')) { quote = quote === value ? "" : quote || value; }
    escaped = !escaped && value === "\\";
    if (value !== "\\") { escaped = false; }
  }
  return !quote;
}

/** Returns whether the current semicolon-delimited statement is spelling an import. */
function importStatementPrefix(prefix: string): boolean { return /^\s*(?:from|import)\b/u.test(currentSimpleStatement(prefix)); }

/** Returns source after the last top-level semicolon outside quoted strings. */
function currentSimpleStatement(prefix: string): string { return simpleStatements(prefix).at(-1) ?? ""; }

/** Splits source at top-level semicolons while preserving nested and quoted values. */
function simpleStatements(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const value = source[index];
    if (quote) {
      if (!escaped && value === quote) { quote = ""; }
      escaped = !escaped && value === "\\";
      if (value !== "\\") { escaped = false; }
      continue;
    }
    if (value === "'" || value === '"') { quote = value; continue; }
    if (value === "(" || value === "[" || value === "{") { depth += 1; continue; }
    if (value === ")" || value === "]" || value === "}") { depth = Math.max(0, depth - 1); continue; }
    if (value === ";" && depth === 0) { statements.push(source.slice(start, index)); start = index + 1; }
  }
  statements.push(source.slice(start));
  return statements;
}

/** Returns the start character of the identifier immediately before the cursor. */
function identifierStart(line: string, character: number): number {
  let start = character;
  while (start > 0 && /[A-Za-z0-9_]/u.test(line[start - 1] ?? "")) { start -= 1; }
  return start;
}

/** Converts a source position to a bounded UTF-16 offset. */
function offsetAt(text: string, position: OverlayRuntimePosition): number {
  const lines = text.split(/\r\n|\n|\r/);
  let offset = 0;
  for (let line = 0; line < Math.min(position.line, lines.length); line += 1) { offset += lines[line].length + lineEndingLength(text, offset + lines[line].length); }
  return Math.min(text.length, offset + boundedCharacter(lines[position.line] ?? "", position.character));
}

/** Returns the line-ending width at one source offset. */
function lineEndingLength(text: string, offset: number): number { return text.startsWith("\r\n", offset) ? 2 : /[\r\n]/u.test(text[offset] ?? "") ? 1 : 0; }

/** Returns one source line or an empty line when out of bounds. */
function lineAt(text: string, line: number): string { return text.split(/\r\n|\n|\r/)[Math.max(0, line)] ?? ""; }

/** Clamps a character to one line's valid UTF-16 interval. */
function boundedCharacter(line: string, character: number): number { return Math.min(line.length, Math.max(0, Math.floor(character) || 0)); }

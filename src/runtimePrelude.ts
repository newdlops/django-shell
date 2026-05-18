// Runtime namespace prelude generation for overlay Python analysis.

import { BackendRuntimeVariable } from "./backendClient";

const ANY_IMPORT = "from typing import Any as _DjsAny";
const MAX_IMPORT_LINES = 180;
const MAX_DECLARATION_LINES = 160;

/** Returns prelude lines that make runtime namespace names visible to Python analysis. */
export function runtimePreludeLines(variables: BackendRuntimeVariable[]): string[] {
  const grouped = new Map<string, Map<string, string | undefined>>();
  const priorityGrouped = new Map<string, Map<string, string | undefined>>();
  const declarations: string[] = [];
  const standalone: string[] = [];
  const seenLines = new Set<string>();
  const boundNames = new Set<string>();
  let needsAny = false;
  for (const variable of variables) {
    if (!isPreludeVariable(variable)) {
      continue;
    }
    const targetGrouped = isPriorityImport(variable) ? priorityGrouped : grouped;
    const imported = addImportLine(runtimeImportLine(variable), targetGrouped, standalone, seenLines, boundNames);
    if (!imported && declarations.length < MAX_DECLARATION_LINES) {
      const typeName = typeAnnotationName(variable, grouped, standalone, seenLines, boundNames);
      const declaration = declarationLine(variable, typeName);
      if (declaration) {
        declarations.push(declaration.line);
        needsAny ||= declaration.usesAny;
      }
    }
  }
  const imports = [...standalone.slice(0, 80), ...groupedImportLines(priorityGrouped), ...groupedImportLines(grouped)].slice(0, MAX_IMPORT_LINES);
  const header = needsAny ? [ANY_IMPORT] : [];
  return [...header, ...imports, ...declarations].slice(0, MAX_IMPORT_LINES + MAX_DECLARATION_LINES + header.length);
}

/** Adds one import line to grouped output and records the names it binds. */
function addImportLine(line: string | undefined, grouped: Map<string, Map<string, string | undefined>>, standalone: string[], seenLines: Set<string>, boundNames: Set<string>): boolean {
  if (!line || seenLines.has(line)) {
    return false;
  }
  seenLines.add(line);
  for (const name of boundImportNames(line)) {
    boundNames.add(name);
  }
  const parsed = parseSimpleFromImport(line);
  if (!parsed) {
    standalone.push(line);
    return true;
  }
  const names = grouped.get(parsed.moduleName) ?? new Map<string, string | undefined>();
  names.set(parsed.name, parsed.alias);
  grouped.set(parsed.moduleName, names);
  return true;
}

/** Returns whether one runtime variable should be represented in the prelude. */
function isPreludeVariable(variable: BackendRuntimeVariable): boolean {
  return !["private", "bootstrap"].includes(variable.origin ?? "") && isIdentifier(variable.name);
}

/** Returns whether one import should avoid being starved by large factory preludes. */
function isPriorityImport(variable: BackendRuntimeVariable): boolean {
  return isClassLikeVariable(variable) && /\bmodels(?:\.|\s+import\b)/.test(runtimeImportLine(variable) ?? "");
}

/** Returns a typed or Any fallback declaration for a runtime name. */
function declarationLine(variable: BackendRuntimeVariable, typeName: string | undefined): { line: string; usesAny: boolean } | undefined {
  if (variable.kind === "module" || isClassLikeVariable(variable)) {
    return undefined;
  }
  return typeName
    ? { line: `${variable.name}: ${typeName}`, usesAny: false }
    : { line: `${variable.name}: _DjsAny`, usesAny: true };
}

/** Returns the best import line available for a runtime namespace value. */
function runtimeImportLine(variable: BackendRuntimeVariable): string | undefined {
  return variable.importLine ?? inferredClassImportLine(variable);
}

/** Infers a precise class import from backend previews when kind was ambiguous. */
function inferredClassImportLine(variable: BackendRuntimeVariable): string | undefined {
  const match = variable.preview.match(/^class ([A-Za-z_][\w.]*?)\.([A-Za-z_]\w*)$/);
  return match && match[2] === variable.name ? `from ${match[1]} import ${match[2]}` : undefined;
}

/** Returns whether a variable behaves like a class even if the backend kind is broad. */
function isClassLikeVariable(variable: BackendRuntimeVariable): boolean {
  return variable.kind === "class" || /^class [A-Za-z_][\w.]*$/.test(variable.preview) || variable.type === "type";
}

/** Imports and returns an annotation type name for one runtime variable when possible. */
function typeAnnotationName(variable: BackendRuntimeVariable, grouped: Map<string, Map<string, string | undefined>>, standalone: string[], seenLines: Set<string>, boundNames: Set<string>): string | undefined {
  const names = variable.typeImportLine ? boundImportNames(variable.typeImportLine) : [];
  const name = names[0];
  if (!name || name === variable.name) {
    return undefined;
  }
  addImportLine(variable.typeImportLine, grouped, standalone, seenLines, boundNames);
  return name;
}

/** Parses import lines that can be safely grouped by module. */
function parseSimpleFromImport(line: string): { alias?: string; moduleName: string; name: string } | undefined {
  const match = line.match(/^from ([A-Za-z_][\w.]*?) import ([A-Za-z_]\w*)(?: as ([A-Za-z_]\w*))?$/);
  return match ? { alias: match[3], moduleName: match[1], name: match[2] } : undefined;
}

/** Builds compact grouped import lines so hidden prelude keeps a small line offset. */
function groupedImportLines(grouped: Map<string, Map<string, string | undefined>>): string[] {
  const lines: string[] = [];
  for (const [moduleName, names] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sorted = [...names.entries()].sort(([left], [right]) => left.localeCompare(right));
    for (let index = 0; index < sorted.length; index += 16) {
      lines.push(`from ${moduleName} import ${sorted.slice(index, index + 16).map(importName).join(", ")}`);
    }
  }
  return lines;
}

/** Formats one imported name with an alias when needed. */
function importName([name, alias]: [string, string | undefined]): string {
  return alias ? `${name} as ${alias}` : name;
}

/** Returns names bound by one import line. */
function boundImportNames(line: string): string[] {
  const fromImport = line.match(/^from [A-Za-z_][\w.]*? import (.+)$/);
  if (fromImport) {
    return importParts(fromImport[1], false);
  }
  const moduleImport = line.match(/^import (.+)$/);
  return moduleImport ? importParts(moduleImport[1], true) : [];
}

/** Returns names bound by one comma-separated import list. */
function importParts(value: string, moduleImport: boolean): string[] {
  return value.replace(/[()]/g, "").split(",").map((part) => boundImportName(part.trim(), moduleImport)).filter(isIdentifier);
}

/** Returns the name bound by one import item. */
function boundImportName(part: string, moduleImport: boolean): string {
  const match = part.match(/^([A-Za-z_][\w.]*|\*)(?:\s+as\s+([A-Za-z_]\w*))?$/);
  return match && match[1] !== "*" ? match[2] ?? (moduleImport ? match[1].split(".", 1)[0] : match[1]) : "";
}

/** Returns whether a string can be used as a Python identifier. */
function isIdentifier(value: string | undefined): value is string {
  return !!value && /^[A-Za-z_]\w*$/.test(value);
}

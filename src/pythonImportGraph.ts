// Static Python import graph discovery for editor-only analysis preludes.

import * as fs from "fs";
import * as path from "path";

const MAX_IMPORT_FILES = 80;
const MAX_IMPORT_LINES = 500;
const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield"
]);

export interface PythonImportGraphDiscovery {
  files: number;
  imports: string[];
}

interface ParsedImportStatement {
  dependencies: string[];
  text: string;
}

/** Discovers static import statements reachable from one workspace Python module. */
export function discoverPythonImportGraph(sourceRoot: string, moduleName: string | undefined): PythonImportGraphDiscovery {
  const anchor = pythonModuleAliasImportLine(moduleName, "_django_shell_selected_settings");
  const imports = new Set<string>(anchor ? [anchor] : []);
  const queue = moduleName && isImportableModuleName(moduleName) ? [moduleName] : [];
  const queued = new Set(queue);
  const visited = new Set<string>();
  while (queue.length && visited.size < MAX_IMPORT_FILES && imports.size < MAX_IMPORT_LINES) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    const file = moduleFile(sourceRoot, current);
    if (!file) {
      continue;
    }
    visited.add(current);
    for (const statement of importStatements(file, current, sourceRoot)) {
      imports.add(statement.text);
      for (const dependency of statement.dependencies) {
        if (!visited.has(dependency) && !queued.has(dependency) && queue.length + visited.size < MAX_IMPORT_FILES) {
          queue.push(dependency);
          queued.add(dependency);
        }
      }
      if (imports.size >= MAX_IMPORT_LINES) {
        break;
      }
    }
  }
  return { files: visited.size, imports: [...imports] };
}

/** Builds a direct Python import alias line when the module and alias are syntactically valid. */
export function pythonModuleAliasImportLine(moduleName: string | undefined, alias: string): string | undefined {
  if (!moduleName || !isImportableModuleName(moduleName) || !isPythonIdentifier(alias)) {
    return undefined;
  }
  return `import ${moduleName} as ${alias}`;
}

/** Reads static top-level import statements from one Python file. */
function importStatements(file: string, currentModule: string, sourceRoot: string): ParsedImportStatement[] {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => parseImportStatement(line, currentModule, sourceRoot))
      .filter((statement): statement is ParsedImportStatement => statement !== undefined);
  } catch {
    return [];
  }
}

/** Parses one top-level Python import statement into normalized prelude text. */
function parseImportStatement(
  line: string,
  currentModule: string,
  sourceRoot: string
): ParsedImportStatement | undefined {
  if (/^\s/.test(line)) {
    return undefined;
  }
  const text = line.replace(/\s+#.*$/, "").trim();
  if (!text || text.includes(";") || text.includes("(") || text.includes(")") || text.includes("\\")) {
    return undefined;
  }
  const importMatch = text.match(/^import\s+(.+)$/);
  if (importMatch) {
    return parsePlainImport(text, importMatch[1], sourceRoot);
  }
  const fromMatch = text.match(/^from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)$/);
  if (fromMatch) {
    return parseFromImport(currentModule, fromMatch[1], fromMatch[2], sourceRoot);
  }
  return undefined;
}

/** Parses an import statement that starts with import. */
function parsePlainImport(text: string, importsText: string, sourceRoot: string): ParsedImportStatement | undefined {
  const modules = importsText.split(",").map((part) => importModuleName(part)).filter(isDefined);
  if (!modules.length || !modules.every(isImportableModuleName)) {
    return undefined;
  }
  return { dependencies: localModules(sourceRoot, modules), text };
}

/** Parses an import statement that starts with from. */
function parseFromImport(
  currentModule: string,
  moduleText: string,
  targetsText: string,
  sourceRoot: string
): ParsedImportStatement | undefined {
  const absolute = resolveFromModule(currentModule, moduleText);
  const targets = importTargets(targetsText);
  if (!absolute || absolute === "__future__" || !isImportableModuleName(absolute) || !targets) {
    return undefined;
  }
  return {
    dependencies: fromImportDependencies(sourceRoot, absolute, targets),
    text: `from ${absolute} import ${targetsText.trim()}`
  };
}

/** Returns a module name from one comma-separated import clause. */
function importModuleName(part: string): string | undefined {
  const name = part.trim().split(/\s+as\s+/i)[0]?.trim();
  return name || undefined;
}

/** Returns imported target identifiers from a from-import target list. */
function importTargets(targetsText: string): string[] | undefined {
  const trimmed = targetsText.trim();
  if (trimmed === "*") {
    return ["*"];
  }
  const targets = trimmed.split(",").map((part) => importModuleName(part)).filter(isDefined);
  return targets.length && targets.every(isPythonIdentifier) ? targets : undefined;
}

/** Resolves a possibly relative from-import module against the current module. */
function resolveFromModule(currentModule: string, moduleText: string): string | undefined {
  const dots = moduleText.match(/^\.+/)?.[0].length ?? 0;
  if (!dots) {
    return moduleText;
  }
  const tail = moduleText.slice(dots);
  const currentPackage = currentModule.split(".").slice(0, -1);
  const keep = currentPackage.length - (dots - 1);
  if (keep < 0) {
    return undefined;
  }
  return [...currentPackage.slice(0, keep), tail].filter(Boolean).join(".");
}

/** Returns local module dependencies from a plain import statement. */
function localModules(sourceRoot: string, modules: string[]): string[] {
  return modules.filter((moduleName) => moduleFile(sourceRoot, moduleName));
}

/** Returns local module dependencies from a from-import statement. */
function fromImportDependencies(sourceRoot: string, moduleName: string, targets: string[]): string[] {
  const dependencies = new Set<string>();
  if (moduleFile(sourceRoot, moduleName)) {
    dependencies.add(moduleName);
  }
  if (!targets.includes("*")) {
    for (const target of targets) {
      const child = `${moduleName}.${target}`;
      if (moduleFile(sourceRoot, child)) {
        dependencies.add(child);
      }
    }
  }
  return [...dependencies];
}

/** Returns the workspace file for an importable Python module name. */
function moduleFile(sourceRoot: string, moduleName: string): string | undefined {
  if (!isImportableModuleName(moduleName)) {
    return undefined;
  }
  const modulePath = path.join(sourceRoot, ...moduleName.split("."));
  for (const candidate of [`${modulePath}.py`, path.join(modulePath, "__init__.py")]) {
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Returns whether a path exists as a regular file. */
function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Returns true when a dotted module name can be written in Python import syntax. */
function isImportableModuleName(moduleName: string): boolean {
  return moduleName.split(".").every(isPythonIdentifier);
}

/** Returns true when a string is a Python identifier and not a keyword. */
function isPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !PYTHON_KEYWORDS.has(value);
}

/** Returns true for defined string values while narrowing TypeScript unions. */
function isDefined(value: string | undefined): value is string {
  return value !== undefined;
}

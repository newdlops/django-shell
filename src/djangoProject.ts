// Lightweight Django workspace discovery for shell environment and editor analysis.

import * as fs from "fs";
import * as path from "path";
import { discoverPythonImportGraph } from "./pythonImportGraph";

const EXCLUDED_DIRS = new Set([".django-shell", ".git", ".hg", ".mypy_cache", ".tox", ".venv", "node_modules", "out", "venv"]);
const MAX_SCAN_DEPTH = 10;
const MAX_MODEL_FILES = 2000;

export interface DjangoPreludeDiscovery {
  diagnostics: DjangoPreludeDiagnostics;
  imports: string[];
  managePy: string | undefined;
  settingsCandidates: string[];
  settingsImportGraph: string[];
  settingsModule: string | undefined;
  sourceRoot: string;
  virtualEnv: string | undefined;
}

export interface DjangoPreludeDiagnostics {
  durationMs: number;
  importBuildMs: number;
  modelFiles: number;
  modelImports: number;
  modelScanMs: number;
  settingsCandidates: number;
  settingsImportFiles: number;
  settingsImportMs: number;
  settingsImports: number;
  settingsMs: number;
}

export interface DjangoPreludeOptions {
  includeModelImports?: boolean;
  includeSettingsCandidates?: boolean;
  settingsModule?: string;
}

/** Discovers Django settings, virtualenv, and model imports for editor-only prelude text. */
export async function discoverDjangoPrelude(cwd: string, options: DjangoPreludeOptions = {}): Promise<DjangoPreludeDiscovery> {
  const started = Date.now();
  const managePy = findManagePy(cwd);
  const sourceRoot = managePy ? path.dirname(managePy) : cwd;
  const settingsStarted = Date.now();
  const settingsCandidates = options.includeSettingsCandidates === false ? [] : await findDjangoSettingsModules(cwd);
  const settingsModule = options.settingsModule ?? detectDjangoSettingsModule(cwd) ?? settingsCandidates[0];
  const settingsMs = Date.now() - settingsStarted;
  const scanStarted = Date.now();
  const modelFiles = options.includeModelImports === false ? [] : await findModelFiles(sourceRoot);
  const modelScanMs = Date.now() - scanStarted;
  const settingsImportStarted = Date.now();
  const settingsImports = discoverPythonImportGraph(sourceRoot, settingsModule);
  const settingsImportGraph = settingsImports.imports;
  const settingsImportMs = Date.now() - settingsImportStarted;
  const importStarted = Date.now();
  const modelImports = options.includeModelImports === false ? [] : modelImportLines(sourceRoot, modelFiles);
  const importBuildMs = Date.now() - importStarted;
  return {
    diagnostics: {
      durationMs: Date.now() - started,
      importBuildMs,
      modelFiles: modelFiles.length,
      modelImports: modelImports.length,
      modelScanMs,
      settingsCandidates: settingsCandidates.length,
      settingsImportFiles: settingsImports.files,
      settingsImportMs,
      settingsImports: settingsImports.imports.length,
      settingsMs
    },
    imports: uniqueLines([...baseDjangoImports(settingsModule), ...settingsImportGraph, ...modelImports]),
    managePy,
    settingsCandidates,
    settingsImportGraph,
    settingsModule,
    sourceRoot,
    virtualEnv: findVirtualEnv(cwd)
  };
}

/** Returns candidate DJANGO_SETTINGS_MODULE values discovered from workspace files. */
export async function findDjangoSettingsModules(cwd: string): Promise<string[]> {
  const managePy = findManagePy(cwd);
  const sourceRoot = managePy ? path.dirname(managePy) : cwd;
  const candidates = new Set<string>();
  const managed = detectDjangoSettingsModule(cwd);
  if (managed) {
    candidates.add(managed);
  }
  await collectSettingsCandidates(sourceRoot, managed, candidates);
  return [...candidates].sort();
}

/** Finds a conventional workspace virtualenv directory if one exists. */
export function findVirtualEnv(cwd: string): string | undefined {
  for (const name of [".venv", "venv"]) {
    const candidate = path.join(cwd, name);
    if (fs.existsSync(path.join(candidate, "pyvenv.cfg"))) {
      return candidate;
    }
  }
  return undefined;
}

/** Detects DJANGO_SETTINGS_MODULE from the nearest manage.py file. */
export function detectDjangoSettingsModule(cwd: string): string | undefined {
  const managePy = findManagePy(cwd);
  if (!managePy) {
    return undefined;
  }
  try {
    const text = fs.readFileSync(managePy, "utf8");
    return parseDjangoSettingsModule(text);
  } catch {
    return undefined;
  }
}

/** Parses a DJANGO_SETTINGS_MODULE literal from Python source text. */
export function parseDjangoSettingsModule(source: string): string | undefined {
  const match = source.match(/DJANGO_SETTINGS_MODULE["']\s*,\s*["']([^"']+)["']/);
  return match?.[1];
}

/** Finds the closest manage.py without descending into dependency or build directories. */
export function findManagePy(cwd: string): string | undefined {
  const direct = path.join(cwd, "manage.py");
  if (fs.existsSync(direct)) {
    return direct;
  }
  return findFile(cwd, "manage.py", 0);
}

/** Returns import lines for common Django console names. */
function baseDjangoImports(settingsModule: string | undefined): string[] {
  const imports = [
    "import django",
    "from django.apps import apps",
    "from django.conf import settings",
    "from django.db import models"
  ];
  if (settingsModule) {
    imports.unshift("import os", `os.environ.setdefault("DJANGO_SETTINGS_MODULE", "${settingsModule}")`);
  }
  return imports;
}

/** Removes duplicate generated import lines while keeping their first occurrence. */
function uniqueLines(lines: string[]): string[] {
  return [...new Set(lines)];
}

/** Collects settings candidates from managed settings paths and shallow Django packages. */
async function collectSettingsCandidates(
  sourceRoot: string,
  managed: string | undefined,
  candidates: Set<string>
): Promise<void> {
  const packages = new Set<string>([sourceRoot]);
  for (const packageDir of settingsPackageDirs(sourceRoot, managed)) {
    packages.add(packageDir);
  }
  await addDirectPackages(packages, sourceRoot);
  for (const packageDir of [...packages]) {
    await addDirectPackages(packages, packageDir);
  }
  for (const packageDir of packages) {
    await collectPackageSettings(sourceRoot, packageDir, candidates);
  }
}

/** Returns directories that can contain siblings of the configured settings module. */
function settingsPackageDirs(sourceRoot: string, managed: string | undefined): string[] {
  if (!managed) {
    return [];
  }
  const segments = managed.split(".").filter(Boolean);
  const settingsIndex = segments.indexOf("settings");
  if (settingsIndex >= 0) {
    return [path.join(sourceRoot, ...segments.slice(0, settingsIndex))];
  }
  return [path.join(sourceRoot, ...segments.slice(0, -1))];
}

/** Returns importable top-level packages without descending into the workspace. */
async function directPythonPackages(sourceRoot: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(sourceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isScannablePackageDir(entry.name, path.join(sourceRoot, entry.name)))
    .map((entry) => path.join(sourceRoot, entry.name));
}

/** Adds importable child packages to a candidate package set. */
async function addDirectPackages(packages: Set<string>, packageDir: string): Promise<void> {
  for (const child of await directPythonPackages(packageDir)) {
    packages.add(child);
  }
}

/** Returns true when a directory is worth checking for Django settings files. */
function isScannablePackageDir(name: string, dir: string): boolean {
  return !EXCLUDED_DIRS.has(name) && !name.startsWith("__pycache__") && fs.existsSync(path.join(dir, "__init__.py"));
}

/** Collects conventional settings.py, settings_*.py, and settings/*.py files in one package. */
async function collectPackageSettings(sourceRoot: string, packageDir: string, candidates: Set<string>): Promise<void> {
  if (!isDirectory(packageDir)) {
    return;
  }
  const files: string[] = [];
  await pushIfFile(files, path.join(packageDir, "settings.py"));
  await collectNamedSettingsFiles(files, packageDir);
  await collectSettingsPackageFiles(files, path.join(packageDir, "settings"));
  for (const file of files) {
    const moduleName = moduleNameForFile(sourceRoot, file);
    if (moduleName) {
      candidates.add(moduleName);
    }
  }
}

/** Adds settings_*.py files from a package directory. */
async function collectNamedSettingsFiles(files: string[], packageDir: string): Promise<void> {
  for (const entry of await readDir(packageDir)) {
    if (entry.isFile() && entry.name.startsWith("settings_") && entry.name.endsWith(".py")) {
      files.push(path.join(packageDir, entry.name));
    }
  }
}

/** Adds settings package modules such as settings/local.py. */
async function collectSettingsPackageFiles(files: string[], settingsDir: string): Promise<void> {
  for (const entry of await readDir(settingsDir)) {
    if (entry.isFile() && entry.name.endsWith(".py") && entry.name !== "__init__.py") {
      files.push(path.join(settingsDir, entry.name));
    }
  }
}

/** Adds one file path when it exists as a normal file. */
async function pushIfFile(files: string[], file: string): Promise<void> {
  try {
    if ((await fs.promises.stat(file)).isFile()) {
      files.push(file);
    }
  } catch {
    // Missing conventional files are expected in most packages.
  }
}

/** Reads directory entries, returning an empty list for absent conventions. */
async function readDir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Returns true when a filesystem path exists as a directory. */
function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Recursively finds model files while keeping workspace scans bounded. */
async function findModelFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, 0, false, files);
  return files;
}

/** Walks source directories and records likely Django model modules. */
async function walk(dir: string, depth: number, inModelsPackage: boolean, files: string[]): Promise<void> {
  if (depth > MAX_SCAN_DEPTH || files.length >= MAX_MODEL_FILES) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_MODEL_FILES) {
      return;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith("__pycache__")) {
        await walk(fullPath, depth + 1, inModelsPackage || entry.name === "models", files);
      }
      continue;
    }
    if (entry.isFile() && isModelFile(entry.name, inModelsPackage)) {
      files.push(fullPath);
    }
  }
}

/** Returns true for Python files likely to contain Django model classes. */
function isModelFile(name: string, inModelsPackage: boolean): boolean {
  return name === "models.py" || (inModelsPackage && name.endsWith(".py") && name !== "__init__.py");
}

/** Builds static imports for top-level classes found in model modules. */
function modelImportLines(sourceRoot: string, files: string[]): string[] {
  const imports = new Set<string>();
  for (const file of files) {
    const moduleName = moduleNameForFile(sourceRoot, file);
    if (!moduleName) {
      continue;
    }
    for (const className of modelClassNames(file)) {
      imports.add(`from ${moduleName} import ${className}`);
    }
  }
  return [...imports].sort();
}

/** Returns top-level class names from a Python file without importing the module. */
function modelClassNames(file: string): string[] {
  try {
    const text = fs.readFileSync(file, "utf8");
    return [...text.matchAll(/^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?:/gm)].map((match) => match[1]);
  } catch {
    return [];
  }
}

/** Converts a workspace Python file path into an importable module name. */
function moduleNameForFile(sourceRoot: string, file: string): string | undefined {
  const relative = path.relative(sourceRoot, file).replace(/\.py$/, "");
  const segments = relative.split(path.sep).filter((segment) => segment !== "__init__");
  return segments.every(isIdentifier) ? segments.join(".") : undefined;
}

/** Recursively searches for one file name with a shallow depth bound. */
function findFile(dir: string, fileName: string, depth: number): string | undefined {
  if (depth > 4) {
    return undefined;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
    if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
      const nested = findFile(fullPath, fileName, depth + 1);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

/** Returns true when a path segment is a valid Python identifier. */
function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

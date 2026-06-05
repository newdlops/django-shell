// Enforces repository code-size and documentation rules for AI-friendly maintenance.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const MAX_LINES = 1000;
const CODE_EXTENSIONS = new Set([".js", ".mjs", ".ts"]);
const EXCLUDED_DIRS = new Set([".codeidx", ".django-shell", ".git", ".lh", ".vscode-test", "dist", "node_modules", "out"]);
const SOURCE_DOC_DIRS = new Set(["scripts", "src"]);

/** Walks the repository and returns code files that should follow project guidelines. */
function codeFiles(dir = ROOT) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        files.push(...codeFiles(path.join(dir, entry.name)));
      }
      continue;
    }
    if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files.sort();
}

/** Returns a repository-relative path for readable diagnostics. */
function relative(file) {
  return path.relative(ROOT, file);
}

/** Returns true when a file belongs to a source directory that requires JSDoc checks. */
function requiresSourceDocs(file) {
  return SOURCE_DOC_DIRS.has(relative(file).split(path.sep)[0]);
}

/** Returns true when a line starts a function, method, constructor, or class declaration. */
function isDocumentableDeclaration(line) {
  if (/^\s*(if|for|while|switch|catch)\b/.test(line)) {
    return false;
  }
  return [
    /^\s*(export\s+)?class\s+\w+/,
    /^\s*(export\s+)?function\s+\w+\s*\(/,
    /^\s{2,}(private\s+|public\s+|protected\s+)?(static\s+)?\w+\([^)]*\)\s*(:\s*[^=]+)?\s*\{/,
    /^\s{2,}constructor\s*\([^)]*\)\s*\{/
  ].some((pattern) => pattern.test(line));
}

/** Returns the nearest previous non-empty line before a declaration. */
function previousMeaningfulLine(lines, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (lines[cursor].trim()) {
      return lines[cursor].trim();
    }
  }
  return "";
}

/** Validates a single code file and appends user-readable errors. */
function checkFile(file, errors) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES) {
    errors.push(`${relative(file)} has ${lines.length} lines; maximum is ${MAX_LINES}.`);
  }
  if (!/^\s*(\/\/|\/\*)/.test(lines[0] ?? "")) {
    errors.push(`${relative(file)} must start with a purpose summary comment.`);
  }
  if (!requiresSourceDocs(file)) {
    return;
  }
  lines.forEach((line, index) => {
    if (isDocumentableDeclaration(line) && !previousMeaningfulLine(lines, index).startsWith("/**")) {
      errors.push(`${relative(file)}:${index + 1} needs a JSDoc summary before this declaration.`);
    }
  });
}

/** Runs all guideline checks and exits non-zero when a rule is violated. */
function main() {
  const errors = [];
  for (const file of codeFiles()) {
    checkFile(file, errors);
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}

main();

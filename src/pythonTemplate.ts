// Loads the Python bootstrap templates shipped as resources so the compiled JavaScript carries no interpreter-loader source text.
import * as fs from "fs";
import * as path from "path";

const TEMPLATE_DIRECTORY = path.join(__dirname, "..", "python", "bootstrap_templates");
const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/g;
const cache = new Map<string, string>();

/** Returns the absolute path of the bootstrap template directory (exposed for tests). */
export function pythonTemplateDirectory(): string {
  return TEMPLATE_DIRECTORY;
}

/** Reads one template file, stripping the single trailing newline the on-disk file carries. */
export function readPythonTemplate(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const text = fs.readFileSync(path.join(TEMPLATE_DIRECTORY, name), "utf8").replace(/\r?\n$/, "");
  cache.set(name, text);
  return text;
}

/** Renders a template by substituting every `{{KEY}}` placeholder; values must already be Python literals where the template expects one. */
export function renderPythonTemplate(name: string, values: Record<string, string>): string {
  const template = readPythonTemplate(name);
  const used = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Python template ${name} has no value for {{${key}}}`);
    }
    used.add(key);
    return value;
  });
  for (const key of Object.keys(values)) {
    if (!used.has(key)) {
      throw new Error(`Python template ${name} does not use {{${key}}}`);
    }
  }
  return rendered;
}

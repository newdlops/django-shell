// Reads the ordered Python backend fragments exactly as the runtime bootstrap composes them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pythonDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../python");

/** Returns the manifest-ordered backend source with the runtime's two-newline separators. */
export function readComposedBackendSource() {
  const manifestPath = path.join(pythonDirectory, "django_shell_backend.parts.json");
  const fragments = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(fragments) || !fragments.length || !fragments.every((fragment) => typeof fragment === "string")) {
    throw new Error("Backend fragment manifest must be a non-empty string list");
  }
  return fragments.map((fragment) => fs.readFileSync(path.join(pythonDirectory, fragment), "utf8")).join("\n\n");
}

/** Returns the absolute Python runtime directory used by composed-source tests. */
export function backendPythonDirectory() {
  return pythonDirectory;
}

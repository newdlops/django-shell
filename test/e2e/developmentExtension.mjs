// Builds the isolated development extension wrapper used by VS Code E2E tests.

import fs from "node:fs";
import path from "node:path";

/** Creates a dependency-free development extension whose entrypoint stays inside its extension root. */
export function prepareDevelopmentExtension(root) {
  const directory = path.join(root, ".vscode-test", "django-shell-dev");
  fs.rmSync(directory, { force: true, recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  delete manifest.extensionDependencies;
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest, null, 2));
  fs.cpSync(path.join(root, "out"), path.join(directory, "out"), { dereference: true, recursive: true });
  for (const name of ["media", "node_modules", "python"]) {
    fs.symlinkSync(path.join(root, name), path.join(directory, name), "dir");
  }
  return directory;
}

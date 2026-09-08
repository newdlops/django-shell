// Owns and cleans the temporary extension, workspace, and profile created by one E2E run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareDevelopmentExtension } from "./developmentExtension.mjs";

/** Keeps concurrent runs isolated and removes only this run's artifacts on success or failure. */
export async function withE2eArtifacts(root, run, temporaryRoot = os.tmpdir()) {
  const owned = [];
  /** Registers a successfully created directory before later setup can fail. */
  function own(directory) { owned.push(directory); return directory; }
  /** Covers test-electron's explicit process.exit after its child handles Ctrl+C. */
  function cleanupOnExit() {
    for (const directory of [...owned].reverse()) {
      try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch (error) { console.warn(`E2E artifact cleanup failed for ${directory}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  process.once("exit", cleanupOnExit);
  try {
    const workspace = own(fs.mkdtempSync(path.join(temporaryRoot, "django-shell-e2e-")));
    const userData = own(fs.mkdtempSync(path.join(temporaryRoot, "django-shell-e2e-user-")));
    const extensionsDir = own(fs.mkdtempSync(path.join(temporaryRoot, "django-shell-e2e-extensions-")));
    const extensionPath = own(prepareDevelopmentExtension(root));
    return await run({ workspace, userData, extensionsDir, extensionPath });
  } finally {
    for (const directory of owned.reverse()) {
      try { await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch (error) { console.warn(`E2E artifact cleanup failed for ${directory}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    process.removeListener("exit", cleanupOnExit);
  }
}

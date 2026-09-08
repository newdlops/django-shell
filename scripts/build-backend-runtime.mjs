// Generates the packaged Python capability index using a development interpreter with only standard-library requirements.
import { spawnSync } from "node:child_process";

/** Selects an available development Python interpreter and regenerates the source index before compilation. */
function main() {
  const candidates = [process.env.DJANGO_SHELL_E2E_PYTHON, process.env.DJLS_E2E_BASE_PYTHON, "python3", "python"].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-c", "import ast, sys; sys.exit(sys.version_info < (3, 9))"], { stdio: "ignore" });
    if (probe.status !== 0) { continue; }
    const result = spawnSync(candidate, ["scripts/build-backend-runtime.py"], { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
    return;
  }
  throw new Error("Building the backend capability index requires Python 3.9+ (or DJANGO_SHELL_E2E_PYTHON).");
}

main();

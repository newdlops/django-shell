// Shared PTY helper setup for visible terminals and hidden backend sessions.

import * as fs from "fs";
import * as path from "path";

/** Ensures node-pty's native helper is executable on platforms that require it. */
export function ensureNodePtyHelperExecutable(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return;
  }
  const helper = path.resolve(
    path.dirname(require.resolve("node-pty")),
    "..",
    `prebuilds/${process.platform}-${process.arch}/spawn-helper`
  );
  try {
    fs.chmodSync(helper, 0o755);
  } catch {
    // node-pty reports the spawn error if this cannot be fixed.
  }
}

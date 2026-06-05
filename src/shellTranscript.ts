// Mirrors the raw Django shell session to the diagnostics output channel for troubleshooting.

import { DiagnosticLogger } from "./diagnostics";

const ANSI_OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f]/g;

/** Logs each complete shell output line (ANSI/control stripped, truncated) and returns the unflushed remainder. */
export function appendShellTranscript(logger: DiagnosticLogger, tail: string, data: string): string {
  const lines = (tail + data).split(/\r?\n/);
  const remainder = (lines.pop() ?? "").slice(-2000);
  for (const line of lines) {
    const clean = line.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(CONTROL, "").trimEnd();
    if (clean) {
      logger.log("shell.out", { line: clean.slice(0, 600) });
    }
  }
  return remainder;
}

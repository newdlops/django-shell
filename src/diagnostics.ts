// Diagnostic logging helpers for Django shell runtime and editor analysis.

import * as vscode from "vscode";

export type DiagnosticFields = Record<string, boolean | number | string | undefined>;

/** Writes structured diagnostic lines to the Django Shell output channel. */
export class DiagnosticLogger {
  /** Stores the shared output channel used for user-visible diagnostics. */
  constructor(private readonly output: vscode.OutputChannel) {}

  /** Appends one diagnostic event when logging is enabled. */
  log(event: string, fields: DiagnosticFields = {}): void {
    if (!this.enabled()) {
      return;
    }
    this.output.appendLine(`[${new Date().toISOString()}] ${event} ${formatFields(fields)}`);
  }

  /** Returns whether diagnostic logging is enabled in workspace settings. */
  private enabled(): boolean {
    return vscode.workspace.getConfiguration("djangoShell").get<boolean>("diagnosticLogging", false);
  }
}

/** Formats simple key-value fields for compact output channel diagnostics. */
function formatFields(fields: DiagnosticFields): string {
  return Object.entries(fields)
    .filter((entry): entry is [string, boolean | number | string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
}

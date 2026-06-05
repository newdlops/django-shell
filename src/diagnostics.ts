// Diagnostic logging helpers for Django shell runtime and editor analysis.

import * as vscode from "vscode";

export type DiagnosticFields = Record<string, boolean | number | string | undefined>;
type OutputChannelFactory = () => vscode.OutputChannel;

/** Writes structured diagnostic lines to the Django Shell output channel. */
export class DiagnosticLogger {
  /** Stores the shared output channel used for user-visible diagnostics. */
  constructor(private readonly output: vscode.OutputChannel | OutputChannelFactory) {}

  /** Appends one diagnostic event when logging is enabled. */
  log(event: string, fields: DiagnosticFields = {}): void {
    if (!this.enabled()) {
      return;
    }
    this.outputChannel().appendLine(`[${new Date().toISOString()}] ${event} ${formatFields(fields)}`);
  }

  /** Returns whether diagnostic logging is enabled in workspace settings (public so hot paths can skip work). */
  enabled(): boolean {
    return vscode.workspace.getConfiguration("djangoShell").get<boolean>("diagnosticLogging", false);
  }

  /** Returns the lazily-created output channel used for enabled diagnostics. */
  private outputChannel(): vscode.OutputChannel {
    return typeof this.output === "function" ? this.output() : this.output;
  }
}

/** Formats simple key-value fields for compact output channel diagnostics. */
function formatFields(fields: DiagnosticFields): string {
  return Object.entries(fields)
    .filter((entry): entry is [string, boolean | number | string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
}

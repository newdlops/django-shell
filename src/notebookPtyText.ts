// Pure terminal-text and PTY-command formatting helpers for the Django shell notebook session.

import { BackendRequestPayload } from "./backendClient";

/** Keeps the rendered setup terminal bounded and hides backend marker lines. */
export function trimTerminalText(text: string): string {
  return text
    .replace(/__DJANGO_SHELL_BACKEND_(?:READY|FAILED|RESPONSE)__\{[^\r\n]*\}/g, "")
    .slice(-12000);
}

/** Builds the short PTY command for one backend request; the bootstrap-defined `_djs_rpc` keeps shell history clean. */
export function buildPtyBackendRequest(id: string, payload: BackendRequestPayload, token: string): string {
  const request = JSON.stringify({ ...payload, token });
  return `_djs_rpc(${pythonString(request)}, ${pythonString(id)})\r`;
}

/** Types the user's literal code as a cell so raw_cell stays pure; IPython multi-line uses bracketed paste with a trailing newline so an open block closes and the cell executes (not a continuation prompt that would swallow the next typed command). */
export function buildPtyExecuteCell(code: string, ipython: boolean): string {
  return ipython && code.includes("\n") ? `\x1b[200~${code}\n\x1b[201~\r` : `${code}\r`;
}

/** Detects password-like prompts so the renderer can mask the next input. */
export function isSecretPrompt(text: string): boolean {
  return /(password|passcode|otp|token|verification code)[^\r\n:]*:?\s*$/i.test(text.slice(-300));
}

/** Returns the first PATH entry so diagnostics stay compact. */
export function firstPathEntry(value: string | undefined): string | undefined {
  return value?.split(process.platform === "win32" ? ";" : ":")[0];
}

/** Redacts submitted commands when the visible terminal is asking for a secret. */
export function safeCommand(line: string, visibleText: string): string {
  return isSecretPrompt(visibleText) ? "<redacted>" : line.slice(0, 160);
}

/** Encodes a JavaScript string as a Python string literal. */
function pythonString(value: string): string {
  return JSON.stringify(value);
}

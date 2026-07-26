// Webview asset URI helpers for Django Shell HTML builders.

import * as path from "path";
import * as vscode from "vscode";

/** Resolves one extension-owned webview asset into a CSP-compatible URI. */
export function webviewAssetUri(
  webview: vscode.Webview,
  extensionPath: string,
  ...segments: string[]
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, ...segments)));
}

/** Renders stylesheet links for extension-owned CSS assets without inline style blocks. */
export function webviewStylesheetLinks(
  webview: vscode.Webview,
  extensionPath: string,
  names: string[]
): string {
  return names
    .map((name) => `<link rel="stylesheet" href="${webviewAssetUri(webview, extensionPath, "media", name)}">`)
    .join("\n");
}


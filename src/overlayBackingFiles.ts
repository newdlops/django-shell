// Lightweight reset helpers for generated overlay Python backing files.

import * as path from "path";
import * as vscode from "vscode";
import { ensureIgnoredShadowDirectory } from "./filePythonShadow";

const EMPTY_ANALYSIS_TEXT = "";
const EMPTY_EDITOR_TEXT = "# --- django shell input ---\n";

interface OverlayBackingUris {
  analysis: vscode.Uri;
  editor: vscode.Uri;
}

/** Replaces stale generated overlay files with empty editor and analysis text. */
export async function resetOverlayBackingFiles(): Promise<void> {
  const uris = overlayBackingUris();
  const directory = path.dirname(uris.editor.fsPath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory));
  await ensureIgnoredShadowDirectory(directory);
  await Promise.all([writeOverlayFile(uris.analysis, EMPTY_ANALYSIS_TEXT), writeOverlayFile(uris.editor, EMPTY_EDITOR_TEXT)]);
}

/** Returns workspace-local URIs used by the overlay editor and analysis document. */
function overlayBackingUris(): OverlayBackingUris {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd());
  return {
    analysis: vscode.Uri.joinPath(root, ".django-shell", "analysis.py"),
    editor: vscode.Uri.joinPath(root, ".django-shell", "console-cell.py")
  };
}

/** Writes one backing file only when it does not already contain the requested text. */
async function writeOverlayFile(uri: vscode.Uri, text: string): Promise<void> {
  try {
    const current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    if (current === text) {
      return;
    }
  } catch {
    // Missing files are created below.
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

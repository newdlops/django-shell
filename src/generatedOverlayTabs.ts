// UI tab cleanup for generated Django shell overlay backing files.

import * as vscode from "vscode";

/** Schedules repeated cleanup for tabs opened asynchronously by the workbench. */
export function scheduleWorkspaceGeneratedOverlayTabCleanup(): void {
  for (const delayMs of [0, 100, 300, 800]) {
    setTimeout(() => void closeWorkspaceGeneratedOverlayTabs(), delayMs);
  }
}

/** Closes visible tabs for the workspace-local generated overlay files. */
export function closeWorkspaceGeneratedOverlayTabs(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd());
  return closeGeneratedOverlayTabs([
    vscode.Uri.joinPath(root, ".django-shell", "analysis.py"),
    vscode.Uri.joinPath(root, ".django-shell", "console-cell.py")
  ]);
}

/** Closes visible tabs for generated overlay files while keeping hidden documents open. */
export async function closeGeneratedOverlayTabs(uris: vscode.Uri[]): Promise<void> {
  const generated = new Set(uris.map((uri) => uri.toString()));
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
    const uri = tabUri(tab);
    return uri ? generated.has(uri.toString()) : false;
  });
  if (tabs.length) {
    await vscode.window.tabGroups.close(tabs, true);
  }
  const active = generatedActiveDocument(generated);
  if (active?.isDirty) {
    await active.save();
  }
  if (active) {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }
}

/** Extracts a URI from a VS Code tab input when the tab is file-backed. */
function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input as { uri?: vscode.Uri } | undefined;
  return input?.uri;
}

/** Returns the active generated overlay document when one is focused. */
function generatedActiveDocument(generated: Set<string>): vscode.TextDocument | undefined {
  const active = vscode.window.activeTextEditor?.document;
  return active && generated.has(active.uri.toString()) ? active : undefined;
}

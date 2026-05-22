// UI tab cleanup for generated Django shell overlay backing files.

import * as vscode from "vscode";

let generatedTabWatcher: vscode.Disposable | undefined;
const watchedGeneratedUris = new Set<string>();
let closeQueue: Promise<void> = Promise.resolve();

/** Schedules repeated cleanup for tabs opened asynchronously by the workbench. */
export function scheduleWorkspaceGeneratedOverlayTabCleanup(): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd());
  scheduleGeneratedOverlayTabCleanup([
    vscode.Uri.joinPath(root, ".django-shell", "analysis.py")
  ]);
}

/** Schedules repeated cleanup for specific generated overlay tabs. */
export function scheduleGeneratedOverlayTabCleanup(uris: vscode.Uri[]): void {
  rememberGeneratedOverlayUris(uris);
  ensureGeneratedOverlayTabWatcher();
  for (const delayMs of [50, 200, 500]) {
    setTimeout(() => void closeGeneratedOverlayTabs(uris), delayMs);
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
export function closeGeneratedOverlayTabs(uris: vscode.Uri[]): Promise<void> {
  closeQueue = closeQueue.catch(() => undefined).then(() => closeGeneratedOverlayTabsNow(uris));
  return closeQueue;
}

/** Serially closes only clean visible tabs for generated overlay files. */
async function closeGeneratedOverlayTabsNow(uris: vscode.Uri[]): Promise<void> {
  const generated = new Set(uris.map((uri) => uri.toString()));
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
    const uri = tabUri(tab);
    return uri ? generated.has(uri.toString()) : false;
  });
  const cleanTabs = tabs.filter((tab) => !isDirtyGeneratedTab(tab));
  if (cleanTabs.length) {
    await vscode.window.tabGroups.close(cleanTabs, true);
  }
}

/** Extracts a URI from a VS Code tab input when the tab is file-backed. */
function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input as { uri?: vscode.Uri } | undefined;
  return input?.uri;
}

/** Returns whether closing a generated tab would ask the user to save it. */
function isDirtyGeneratedTab(tab: vscode.Tab): boolean {
  const uri = tabUri(tab);
  return !!uri && vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString() && document.isDirty);
}

/** Remembers generated URIs that should never stay open as workbench tabs. */
function rememberGeneratedOverlayUris(uris: vscode.Uri[]): void {
  for (const uri of uris) {
    watchedGeneratedUris.add(uri.toString());
  }
}

/** Installs a tab watcher that closes generated file tabs without touching focus. */
function ensureGeneratedOverlayTabWatcher(): void {
  if (generatedTabWatcher) { return; }
  generatedTabWatcher = vscode.window.tabGroups.onDidChangeTabs(() => {
    const uris = [...watchedGeneratedUris].map((uri) => vscode.Uri.parse(uri));
    setTimeout(() => void closeGeneratedOverlayTabs(uris), 0);
  });
}

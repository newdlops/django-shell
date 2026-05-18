// Stores Django shell notebook-scoped selections in .djshell metadata.

import * as vscode from "vscode";

type JsonObject = { [key: string]: unknown };

const DJANGO_SHELL_METADATA_KEY = "djangoShell";
const SETTINGS_MODULE_KEY = "djangoSettingsModule";

/** Returns the Django settings module selected for one notebook document. */
export function notebookDjangoSettingsModule(notebook: vscode.NotebookDocument): string | undefined {
  const value = objectValue(notebook.metadata[DJANGO_SHELL_METADATA_KEY])[SETTINGS_MODULE_KEY];
  return typeof value === "string" && value ? value : undefined;
}

/** Persists a Django settings module selection into notebook metadata instead of settings.json. */
export async function updateNotebookDjangoSettingsModule(notebookUri: vscode.Uri, value: string): Promise<boolean> {
  const notebook = vscode.workspace.notebookDocuments.find((candidate) => candidate.uri.toString() === notebookUri.toString());
  if (!notebook) {
    return false;
  }
  const current = objectValue(notebook.metadata[DJANGO_SHELL_METADATA_KEY]);
  const nextSettings = value ? { ...current, [SETTINGS_MODULE_KEY]: value } : withoutKey(current, SETTINGS_MODULE_KEY);
  const metadata = {
    ...notebook.metadata
  };
  if (Object.keys(nextSettings).length) {
    metadata[DJANGO_SHELL_METADATA_KEY] = nextSettings;
  } else {
    delete metadata[DJANGO_SHELL_METADATA_KEY];
  }
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata(metadata)]);
  return vscode.workspace.applyEdit(edit);
}

/** Returns a JSON object value when metadata contains one. */
function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

/** Returns an object copy without one key. */
function withoutKey(value: JsonObject, key: string): JsonObject {
  const next = { ...value };
  delete next[key];
  return next;
}

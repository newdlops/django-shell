// Handles optional file-backed Python shadow document writes.

import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";

export interface ShadowWriteResult {
  changed: boolean;
  skippedByCache: boolean;
}

const GENERATED_FILE_PATTERN = /^django_shell_console_(?:prelude|cell_\d+)\.py$/;
const GENERATED_FILE_MARKERS = [
  "# --- django shell input ---",
  "# Django shell input starts below.",
  "# Django shell runtime imports for analysis.",
  "# Django workspace imports for editor analysis.",
  "# Generated Django shell imports for editor analysis."
];
const GENERATED_WORKSPACE_FILE_PATTERN = /^(?:analysis|console-cell|django_shell_console_cell_\d+|django_shell_console_prelude)\.py$/;
const ignoredShadowRoots = new Set<string>();

/** Removes the older nested shadow directory that skewed project-root detection. */
export async function deleteOldShadowArtifacts(deleteRootFiles: boolean): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd());
  await deleteOldShadowDirectory(root);
  await deleteLegacyDjangoshellDirectory(root);
  await deleteLegacyPreludeModule(root);
  if (deleteRootFiles) {
    await deleteGeneratedRootShadowFiles();
  }
}

/** Removes generated file-backed provider artifacts from all workspace shadow directories. */
export async function deleteGeneratedShadowArtifacts(): Promise<void> {
  await saveOpenGeneratedShadowDocuments();
  const folders = vscode.workspace.workspaceFolders ?? [];
  await Promise.all(folders.map((folder) => deleteGeneratedShadowArtifactsIn(folder.uri)));
  await deleteGeneratedRootShadowFiles();
}

/** Saves open generated documents so VS Code does not keep dirty hidden buffers alive. */
async function saveOpenGeneratedShadowDocuments(): Promise<void> {
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty || !isGeneratedShadowUri(document.uri)) {
      continue;
    }
    try {
      await document.save();
    } catch {
      try {
        await vscode.workspace.fs.writeFile(document.uri, Buffer.from(document.getText(), "utf8"));
      } catch {
        // Best effort only; cleanup below still removes generated files when possible.
      }
    }
  }
}

/** Removes generated files from one workspace-local .django-shell directory. */
async function deleteGeneratedShadowArtifactsIn(root: vscode.Uri): Promise<void> {
  const directory = vscode.Uri.joinPath(root, ".django-shell");
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(directory);
  } catch {
    return;
  }
  await Promise.all(entries.map(async ([name, type]) => {
    if (type === vscode.FileType.File && GENERATED_WORKSPACE_FILE_PATTERN.test(name)) {
      await deleteIfGenerated(vscode.Uri.joinPath(directory, name));
    }
  }));
  await deleteDirectoryIfEmpty(directory);
}

/** Returns whether one URI belongs to the generated shadow file set. */
function isGeneratedShadowUri(uri: vscode.Uri): boolean {
  const parent = path.basename(path.dirname(uri.fsPath));
  const name = path.basename(uri.fsPath);
  return (parent === ".django-shell" && GENERATED_WORKSPACE_FILE_PATTERN.test(name)) || GENERATED_FILE_PATTERN.test(name);
}

/** Removes one directory when generated cleanup has left it empty. */
async function deleteDirectoryIfEmpty(directory: vscode.Uri): Promise<void> {
  try {
    if ((await vscode.workspace.fs.readDirectory(directory)).length === 0) {
      await vscode.workspace.fs.delete(directory, { recursive: false, useTrash: false });
    }
  } catch {
    // A non-empty or concurrently removed directory does not need follow-up.
  }
}

/** Removes the older nested shadow directory for one workspace root. */
async function deleteOldShadowDirectory(root: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, ".django-shell", "intellisense"), {
      recursive: true,
      useTrash: false
    });
  } catch {
    // The old directory is absent in fresh workspaces.
  }
}

/** Removes the legacy generated shadow directory that used a different folder name. */
async function deleteLegacyDjangoshellDirectory(root: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, ".djangoshell"), {
      recursive: true,
      useTrash: false
    });
  } catch {
    // The legacy directory is absent in fresh workspaces.
  }
}

/** Removes the generated shared prelude module now that cell shadows inline preludes. */
async function deleteLegacyPreludeModule(root: vscode.Uri): Promise<void> {
  await deleteIfGenerated(vscode.Uri.joinPath(root, ".django-shell", "django_shell_console_prelude.py"));
}

/** Removes stale root-level generated shadow files from older bridge modes. */
async function deleteGeneratedRootShadowFiles(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    await deleteGeneratedRootShadowFilesIn(folder.uri);
  }
}

/** Removes generated shadow files from one workspace root after checking their marker. */
async function deleteGeneratedRootShadowFilesIn(root: vscode.Uri): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(root);
  } catch {
    return;
  }
  await Promise.all(entries.map(async ([name, type]) => {
    if (type === vscode.FileType.File && GENERATED_FILE_PATTERN.test(name)) {
      await deleteIfGenerated(vscode.Uri.joinPath(root, name));
    }
  }));
}

/** Deletes one generated shadow file only when its expected marker is present. */
async function deleteIfGenerated(uri: vscode.Uri): Promise<void> {
  try {
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    if (GENERATED_FILE_MARKERS.some((marker) => text.startsWith(marker))) {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    }
  } catch {
    // Files that disappear concurrently do not need cleanup.
  }
}

/** Writes a shadow file only when its cached or on-disk contents have changed. */
export async function writeShadowFile(
  uri: vscode.Uri,
  text: string,
  cache: Map<string, string>
): Promise<ShadowWriteResult> {
  const key = uri.toString();
  const directory = path.dirname(uri.fsPath);
  await ensureIgnoredShadowDirectory(directory);
  if (cache.get(key) === text) {
    return { changed: false, skippedByCache: true };
  }
  try {
    const current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    if (current === text) {
      cache.set(key, text);
      return { changed: false, skippedByCache: false };
    }
  } catch {
    // Missing or unreadable shadow files are recreated below.
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
  cache.set(key, text);
  return { changed: true, skippedByCache: false };
}

/** Adds generated workspace shadow directories to local Git excludes. */
export async function ensureIgnoredShadowDirectory(directory: string): Promise<void> {
  if (path.basename(directory) !== ".django-shell" || ignoredShadowRoots.has(directory)) {
    return;
  }
  ignoredShadowRoots.add(directory);
  const exclude = await gitInfoExcludePath(path.dirname(directory));
  if (!exclude) {
    return;
  }
  try {
    let text = "";
    try {
      text = await fs.readFile(exclude, "utf8");
    } catch {
      await fs.mkdir(path.dirname(exclude), { recursive: true });
    }
    if (text.split(/\r?\n/).some((line) => [".django-shell", ".django-shell/"].includes(line.trim()))) {
      return;
    }
    await fs.appendFile(exclude, `${text.endsWith("\n") || !text ? "" : "\n"}.django-shell/\n`);
  } catch {
    // Git excludes are best-effort; generated files still stay grouped in one hidden directory.
  }
}

/** Returns the local Git exclude path for a workspace root when it is a Git repository. */
async function gitInfoExcludePath(root: string): Promise<string | undefined> {
  const dotGit = path.join(root, ".git");
  try {
    const stat = await fs.stat(dotGit);
    if (stat.isDirectory()) {
      return path.join(dotGit, "info", "exclude");
    }
    const match = (await fs.readFile(dotGit, "utf8")).match(/^gitdir:\s*(.+)\s*$/m);
    return match ? path.join(path.resolve(root, match[1].trim()), "info", "exclude") : undefined;
  } catch {
    return undefined;
  }
}

/** Opens a generated shadow document and synchronizes any cached VS Code text. */
export async function openSyncedShadowDocument(uri: vscode.Uri, text: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.getText() === text) {
    return document;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, fullDocumentRange(document), text);
  if (!await vscode.workspace.applyEdit(edit)) {
    throw new Error(`Could not synchronize Python shadow document ${uri.fsPath}.`);
  }
  return document;
}

/** Returns the full range of a text document. */
function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const lastLine = document.lineAt(Math.max(0, document.lineCount - 1));
  return new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
}

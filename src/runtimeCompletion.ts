// Deprecated runtime completions for Django shell notebook Python cells.

import * as vscode from "vscode";
import { BackendRuntimeInspection, BackendRuntimeVariable } from "./backendClient";
import { DiagnosticLogger } from "./diagnostics";
import { NOTEBOOK_TYPE, PRELUDE_CELL_ROLE, SETUP_CELL_ROLE } from "./notebookConstants";
import { DjangoConsoleController } from "./notebookController";

/** Provides completion items from the attached Django shell runtime namespace. */
export class RuntimeCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly inspectionCache = new Map<string, { expiresAt: number; promise: Promise<BackendRuntimeInspection> }>();
  private providerRegistration?: vscode.Disposable;

  /** Stores the controller used to inspect notebook-specific runtimes. */
  constructor(private readonly controller: DjangoConsoleController, private readonly logger?: DiagnosticLogger) {}

  /** Registers the provider for Python editors hosted inside notebook cells. */
  activate(context: vscode.ExtensionContext): void {
    this.disposables.push(
      this.controller.onDidChangeRuntime(() => this.inspectionCache.clear()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("djangoShell.enableRuntimeCompletion")) {
          this.updateRegistration();
        }
      })
    );
    this.updateRegistration();
    context.subscriptions.push(this);
  }

  /** Releases completion provider registrations. */
  dispose(): void {
    this.providerRegistration?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Registers or removes the expensive runtime completion provider from settings. */
  private updateRegistration(): void {
    const enabled = vscode.workspace.getConfiguration("djangoShell").get<boolean>("enableRuntimeCompletion", false);
    if (enabled && !this.providerRegistration) {
      this.providerRegistration = vscode.languages.registerCompletionItemProvider(
        { language: "python", scheme: "vscode-notebook-cell" },
        this
      );
      this.logger?.log("runtime.completion.registration", { enabled: true });
      return;
    }
    if (!enabled && this.providerRegistration) {
      this.providerRegistration.dispose();
      this.providerRegistration = undefined;
      this.inspectionCache.clear();
      this.logger?.log("runtime.completion.registration", { enabled: false });
    }
  }

  /** Returns runtime namespace completion items for Django shell input cells. */
  async provideCompletionItems(
    document: vscode.TextDocument,
    _position: vscode.Position,
    token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[]> {
    const started = Date.now();
    const cell = djangoPythonCell(document);
    if (!cell || token.isCancellationRequested) {
      return [];
    }
    const inspection = await this.runtimeInspection(cell.notebook.uri);
    if (!inspection.ok || token.isCancellationRequested) {
      this.logger?.log("runtime.completion", { ms: Date.now() - started, ok: false });
      return [];
    }
    const items = inspection.variables.filter(isCompletableVariable).map(completionItem);
    this.logger?.log("runtime.completion", {
      items: items.length,
      loadedModules: inspection.loadedModuleCount,
      ms: Date.now() - started,
      variables: inspection.variables.length
    });
    return items;
  }

  /** Returns a short-lived runtime inspection cache for completion bursts. */
  private runtimeInspection(notebookUri: vscode.Uri): Promise<BackendRuntimeInspection> {
    const key = notebookUri.toString();
    const cached = this.inspectionCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.promise;
    }
    const promise = this.controller.inspectRuntime(notebookUri);
    this.inspectionCache.set(key, { expiresAt: Date.now() + 2000, promise });
    return promise;
  }
}

/** Returns the Django shell Python cell that owns a text document. */
function djangoPythonCell(document: vscode.TextDocument): vscode.NotebookCell | undefined {
  if (document.uri.scheme !== "vscode-notebook-cell" || document.languageId !== "python") {
    return undefined;
  }
  for (const notebook of vscode.workspace.notebookDocuments) {
    if (notebook.notebookType !== NOTEBOOK_TYPE) {
      continue;
    }
    const cell = notebook.getCells().find((candidate) => candidate.document.uri.toString() === document.uri.toString());
    if (cell && ![PRELUDE_CELL_ROLE, SETUP_CELL_ROLE].includes(cell.metadata?.role)) {
      return cell;
    }
  }
  return undefined;
}

/** Returns whether a runtime variable should be shown as a user-facing completion. */
function isCompletableVariable(variable: BackendRuntimeVariable): boolean {
  const origin = variable.origin ?? inferredOrigin(variable);
  return isIdentifier(variable.name) && !variable.name.startsWith("__") && !["bootstrap", "private", "last"].includes(origin);
}

/** Converts one backend variable summary into a VS Code completion item. */
function completionItem(variable: BackendRuntimeVariable): vscode.CompletionItem {
  const item = new vscode.CompletionItem(variable.name, completionKind(variable.kind));
  item.detail = variable.type;
  item.documentation = completionDocs(variable);
  item.sortText = `zz_runtime_${variable.name}`;
  return item;
}

/** Maps backend variable kinds to VS Code completion item kinds. */
function completionKind(kind?: string): vscode.CompletionItemKind {
  if (kind === "module") {
    return vscode.CompletionItemKind.Module;
  }
  if (kind === "class") {
    return vscode.CompletionItemKind.Class;
  }
  if (kind === "callable") {
    return vscode.CompletionItemKind.Function;
  }
  return vscode.CompletionItemKind.Variable;
}

/** Builds concise markdown documentation for a runtime completion item. */
function completionDocs(variable: BackendRuntimeVariable): vscode.MarkdownString {
  const docs = new vscode.MarkdownString(undefined, true);
  docs.isTrusted = false;
  docs.appendMarkdown("Runtime value from the attached Django shell.");
  docs.appendCodeblock(variable.preview, "python");
  if (variable.importLine) {
    docs.appendMarkdown("\nImport hint:");
    docs.appendCodeblock(variable.importLine, "python");
  }
  return docs;
}

/** Returns true when a name is a valid Python identifier-like completion label. */
function isIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Infers a variable origin for older backend payloads that did not include one. */
function inferredOrigin(variable: BackendRuntimeVariable): string {
  if (variable.name.startsWith("_djs_")) {
    return "bootstrap";
  }
  if (variable.name === "_") {
    return "last";
  }
  if (variable.name.startsWith("_")) {
    return "private";
  }
  return "initial";
}

// Activity Bar webview that searches and filters installed Django models in place.

import * as path from "path";
import * as vscode from "vscode";
import type { ModelDataSource } from "./modelBrowser";
import { modelCatalogHtml } from "./modelCatalogHtml";
import { DiagnosticLogger } from "./diagnostics";

interface CatalogMessage {
  app?: string;
  model?: string;
  type: string;
}

const VIEW_ID = "djangoShell.modelCatalog";

/** Renders a searchable, filterable list of models that opens the data browser on selection. */
export class ModelCatalog implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;

  /** Stores the extension path and the model data source. */
  constructor(private readonly extensionPath: string, private readonly source: ModelDataSource, private readonly logger?: DiagnosticLogger) {}

  /** Registers the webview view provider and its refresh command. */
  activate(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(VIEW_ID, this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.commands.registerCommand("djangoShell.refreshModelCatalog", () => this.postModels()),
      this.source.onDidChangeRuntime(() => this.postModels())
    );
    context.subscriptions.push(this);
  }

  /** Builds the webview, wires messaging, and loads the model list. */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(this.extensionPath, "media"))] };
    view.webview.html = modelCatalogHtml(view.webview, this.extensionPath);
    view.webview.onDidReceiveMessage((message: CatalogMessage) => void this.handleMessage(message), undefined, this.disposables);
    view.onDidDispose(() => { this.view = undefined; }, undefined, this.disposables);
  }

  /** Releases provider listeners. */
  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Routes one message from the catalog webview. */
  private async handleMessage(message: CatalogMessage): Promise<void> {
    if (message.type === "ready") {
      await this.postModels();
    } else if (message.type === "open" && message.app && message.model) {
      await vscode.commands.executeCommand("djangoShell.openModelData", { app: message.app, model: message.model });
    }
  }

  /** Loads the model catalog and posts it to the webview. */
  private async postModels(): Promise<void> {
    if (!this.view) {
      return;
    }
    const started = Date.now();
    const list = await this.source.listModels();
    this.logger?.log("model.catalog.load", { models: list.models.length, ms: Date.now() - started, ok: list.ok });
    void this.view.webview.postMessage({ error: list.error, models: list.models, ok: list.ok, type: "models" });
  }
}

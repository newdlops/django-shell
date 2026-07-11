// Workspace watcher that drives the built-in experimental engine's backend hot-reload RPC.

import * as vscode from "vscode";
import type { BackendHotReloadResult } from "./backendHotReloadProtocol";
import type { DiagnosticLogger } from "./diagnostics";
import { shouldIgnoreNativeHotReload } from "./nativeHotReloadFilter";
import { NativeHotReloadQueue, type NativeHotReloadQueueBackend } from "./nativeHotReloadQueue";

/** Owns the live setting, workspace watcher, queue, and user feedback for one shell process. */
export class NativeHotReloadCoordinator implements vscode.Disposable {
  private readonly activeDisposables: vscode.Disposable[] = [];
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];
  private queue: NativeHotReloadQueue | undefined;
  private started = false;
  private status: vscode.StatusBarItem | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;

  /** Stores the backend and the gate that permits idle or debugger-paused reloads. */
  constructor(
    private readonly backend: NativeHotReloadQueueBackend,
    private readonly logger?: DiagnosticLogger,
    private readonly canReload: () => boolean = () => true
  ) {}

  /** Starts configuration tracking and applies the current hot-reload setting. */
  start(): void {
    if (this.disposed || this.started) { return; }
    this.started = true;
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("djangoShell.debug.hotReload")) { this.applyConfiguration(); }
    }));
    this.applyConfiguration();
  }

  /** Stops queued work and releases watcher, status, and setting resources. */
  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.disableWatcher();
    for (const disposable of this.disposables.splice(0)) { disposable.dispose(); }
  }

  /** Enables or disables the active watcher without restarting the Django shell. */
  private applyConfiguration(): void {
    const enabled = vscode.workspace.getConfiguration("djangoShell.debug").get<boolean>("hotReload", true);
    if (enabled) { this.enableWatcher(); } else { this.disableWatcher(); }
  }

  /** Creates the watcher and a fresh serialized queue for the active backend. */
  private enableWatcher(): void {
    if (this.disposed || this.watcher) { return; }
    this.queue = new NativeHotReloadQueue(this.backend, {
      canFlush: this.canReload,
      onReloading: (active) => this.setReloading(active),
      onResult: (result, paths) => this.handleResult(result, paths)
    });
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.py");
    this.activeDisposables.push(
      this.watcher,
      this.watcher.onDidChange((uri) => this.enqueue(uri)),
      this.watcher.onDidCreate((uri) => this.enqueue(uri))
    );
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.name = "Django Shell Hot Reload";
    this.status.text = "$(flame) Shell Hot Reload";
    this.status.tooltip = "Built-in experimental debugger: changed Python modules reload in the live Django shell.";
    this.status.show();
    this.activeDisposables.push(this.status);
    this.logger?.log("debug.native.hotReload.started", {});
  }

  /** Cancels active queue work while retaining the live configuration listener. */
  private disableWatcher(): void {
    this.queue?.dispose();
    this.queue = undefined;
    for (const disposable of this.activeDisposables.splice(0)) { disposable.dispose(); }
    if (this.watcher) { this.logger?.log("debug.native.hotReload.stopped", {}); }
    this.watcher = undefined;
    this.status = undefined;
  }

  /** Adds one safe workspace file to the runtime-independent queue. */
  private enqueue(uri: vscode.Uri): void {
    if (uri.scheme !== "file" || shouldIgnoreNativeHotReload(uri.fsPath)) { return; }
    this.queue?.enqueue(uri.fsPath);
  }

  /** Mirrors queue activity into the status bar. */
  private setReloading(active: boolean): void {
    if (this.status) { this.status.text = active ? "$(sync~spin) Reloading shell..." : "$(flame) Shell Hot Reload"; }
  }

  /** Reports successful, partial, skipped, and failed module reloads without hiding backend details. */
  private handleResult(result: BackendHotReloadResult, paths: string[]): void {
    const ok = result.results.filter((row) => row.status === "ok");
    const partial = result.results.filter((row) => row.status === "partial");
    const errors = result.results.filter((row) => row.status === "error");
    const skipped = result.results.filter((row) => row.status === "skipped");
    const detailRows = [...partial, ...errors];
    const hidden = Math.max(0, detailRows.length - 3);
    const detail = `${detailRows.slice(0, 3).map((row) => `${row.module || row.path}: ${row.message}`).join("; ")}${hidden ? `; ... and ${hidden} more` : ""}`.slice(0, 1200);
    this.logger?.log("debug.native.hotReload.result", { detail: detail || result.error, errors: errors.length, files: paths.length, ok: ok.length, partial: partial.length, skipped: skipped.length });
    if (!result.ok || detailRows.length) {
      const attention = (detail || result.error || "unknown backend error").slice(0, 1200);
      void vscode.window.showWarningMessage(`Django Shell hot reload needs attention: ${attention}`);
    } else if (ok.length) {
      void vscode.window.showInformationMessage(`$(flame) Hot reloaded: ${ok.map((row) => row.module || row.path).join(", ")}`);
    }
  }
}

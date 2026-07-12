// Coalesces a debug request made while the Django backend is still attaching.
import * as vscode from "vscode";
import type { DiagnosticLogger } from "./diagnostics";

/** Supplies runtime ownership and debug-start callbacks without coupling the gate to the console class. */
export interface DeferredDebugStartOptions {
  current: (generation: number) => boolean;
  generation: () => number;
  logger?: DiagnosticLogger;
  onCancelled: (reason: string) => void;
  run: () => Promise<void>;
}

/** Holds at most one debug click and replays it when the matching runtime becomes ready. */
export class DeferredDebugStart {
  private drainPromise: Promise<void> | undefined;
  private pending = false;

  /** Accepts one request and reports repeated clicks without scheduling duplicate debug runs. */
  request(): void {
    if (this.pending) { this.options.logger?.log("debug.start.queue.duplicate", {}); return; }
    this.pending = true;
    this.options.logger?.log("debug.start.queued", {});
    void vscode.window.showInformationMessage("Django shell backend is still initializing. Debugging will start automatically when it is ready.");
  }

  /** Starts the deferred request once for the runtime generation that just became ready. */
  drain(): void {
    if (this.drainPromise || !this.pending) { return; }
    const generation = this.options.generation(); const drain = this.runGeneration(generation).finally(() => { if (this.drainPromise === drain) { this.drainPromise = undefined; } if (this.pending && this.options.current(this.options.generation())) { this.drain(); } });
    this.drainPromise = drain;
  }

  /** Drops a request that cannot belong to a restarted, failed, or closed backend. */
  cancel(reason: string, notify = false): void {
    if (!this.pending) { return; }
    this.pending = false;
    this.options.logger?.log("debug.start.cancel", { reason });
    this.options.onCancelled(reason);
    if (notify) { void vscode.window.showWarningMessage(`Queued Django shell debugging was cancelled because the backend ${reason}.`); }
  }

  /** Runs the request only while its owning backend generation remains current. */
  private async runGeneration(generation: number): Promise<void> {
    if (!this.pending || !this.options.current(generation)) { return; }
    this.pending = false;
    this.options.logger?.log("debug.start.replay", {});
    await this.options.run();
  }

  /** Stores host callbacks used for ownership checks, replay, logging, and feedback. */
  constructor(private readonly options: DeferredDebugStartOptions) {}
}

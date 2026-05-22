// Completion request cache for the Django shell overlay Python editor.

import * as vscode from "vscode";
import { cloneCompletionResult, CompletionResult, completionRequestShape, completionResultCount } from "./completionRequestCache";
import { DiagnosticLogger } from "./diagnostics";
import { withLatencyBudget } from "./latencyBudget";

const COMPLETION_CACHE_TTL_MS = 3000;
const COMPLETION_BUDGET_MS = 500;

type Loader = () => Promise<CompletionResult | undefined>;

/** Caches repeated overlay completion requests while the user extends one token. */
export class OverlayCompletionRequestCache {
  private readonly completionCache = new Map<string, { expiresAt: number; result: CompletionResult }>();
  private readonly completionInFlight = new Map<string, Promise<CompletionResult>>();

  /** Stores the optional diagnostic logger used for cache timing. */
  constructor(private readonly logger?: DiagnosticLogger) {}

  /** Returns cached or freshly loaded completions without blocking the editor indefinitely. */
  async provide(document: vscode.TextDocument, position: vscode.Position, trigger: string | undefined, loader: Loader): Promise<CompletionResult> {
    const started = Date.now();
    const shape = completionRequestShape(document, position);
    const cached = this.cachedCompletion(shape.key);
    if (cached) {
      this.log(started, "hit", completionResultCount(cached), trigger);
      return cloneCompletionResult(cached, shape.replacementRange);
    }
    const existing = this.completionInFlight.get(shape.key);
    if (existing) {
      const ready = await withLatencyBudget(existing, COMPLETION_BUDGET_MS);
      this.log(started, ready.completed ? "join" : "budget", ready.value ? completionResultCount(ready.value) : 0, trigger);
      return ready.completed && ready.value ? cloneCompletionResult(ready.value, shape.replacementRange) : [];
    }
    const promise = loader().then((result) => result ?? []);
    this.completionInFlight.set(shape.key, promise);
    promise.then((result) => this.remember(shape.key, result)).finally(() => {
      if (this.completionInFlight.get(shape.key) === promise) {
        this.completionInFlight.delete(shape.key);
      }
    }).catch(() => undefined);
    const ready = await withLatencyBudget(promise, COMPLETION_BUDGET_MS);
    this.log(started, ready.completed ? "load" : "budget", ready.value ? completionResultCount(ready.value) : 0, trigger);
    return ready.completed && ready.value ? cloneCompletionResult(ready.value, shape.replacementRange) : [];
  }

  /** Returns a still-valid completion cache entry for one request key. */
  private cachedCompletion(key: string): CompletionResult | undefined {
    const cached = this.completionCache.get(key);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      this.completionCache.delete(key);
      return undefined;
    }
    return cached.result;
  }

  /** Stores a non-empty completion result for later token-extension requests. */
  private remember(key: string, result: CompletionResult): void {
    if (completionResultCount(result) > 0) {
      this.completionCache.set(key, { expiresAt: Date.now() + COMPLETION_CACHE_TTL_MS, result });
    }
  }

  /** Writes one compact cache timing diagnostic. */
  private log(started: number, mode: string, items: number, trigger: string | undefined): void {
    this.logger?.log("overlay.completion.cache", { items, mode, ms: Date.now() - started, trigger });
  }
}

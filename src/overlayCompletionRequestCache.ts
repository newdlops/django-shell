// Completion request cache for the Django shell overlay Python editor.

import * as vscode from "vscode";
import { cloneCompletionResult, CompletionResult, completionRequestShape, completionResultCount } from "./completionRequestCache";
import { DiagnosticLogger } from "./diagnostics";

const COMPLETION_CACHE_TTL_MS = 3000;
const EMPTY_COMPLETION_CACHE_TTL_MS = 400;
const MAX_COMPLETION_CACHE_ENTRIES = 16;

type Loader = (isCurrent: () => boolean) => Promise<CompletionResult | undefined>;

interface ActiveRequest {
  key: string;
  promise: Promise<CompletionResult>;
  requestKey: string;
}

interface PendingRequest {
  key: string;
  loader: Loader;
  promise: Promise<CompletionResult>;
  reject: (error: unknown) => void;
  requestKey: string;
  resolve: (result: CompletionResult) => void;
}

interface CompletionRequest {
  mode: "join" | "load" | "queue";
  promise: Promise<CompletionResult>;
}

/** Caches repeated exact overlay completion requests while serializing provider work. */
export class OverlayCompletionRequestCache {
  private readonly completionCache = new Map<string, { expiresAt: number; result: CompletionResult }>();
  private activeRequest: ActiveRequest | undefined;
  private generation = 0;
  private latestRequestKey = "";
  private pendingRequest: PendingRequest | undefined;

  /** Stores the optional diagnostic logger used for cache timing. */
  constructor(private readonly logger?: DiagnosticLogger) {}

  /** Returns cached or freshly loaded completions without blocking the editor indefinitely. */
  async provide(document: vscode.TextDocument, position: vscode.Position, trigger: string | undefined, loader: Loader): Promise<CompletionResult> {
    const started = Date.now();
    const shape = completionRequestShape(document, position);
    const shapeKey = `${this.generation}:${trigger ?? ""}:${shape.key}`;
    const requestKey = this.requestKey(document, position, shape.replacementRange, shapeKey);
    const key = requestKey;
    this.latestRequestKey = requestKey;
    this.cancelSupersededPending(requestKey);
    const cached = this.cachedCompletion(key);
    if (cached) {
      if (this.pendingRequest?.key === key) {
        this.pendingRequest.resolve([]);
        this.pendingRequest = undefined;
      }
      this.log(started, "hit", completionResultCount(cached), trigger);
      return cloneCompletionResult(cached, shape.replacementRange);
    }
    const request = this.request(key, requestKey, loader);
    const result = await request.promise;
    this.log(started, request.mode, completionResultCount(result), trigger);
    return cloneCompletionResult(result, shape.replacementRange);
  }

  /** Clears cached and not-yet-started completion work. */
  clear(): void {
    this.generation += 1;
    this.latestRequestKey = "";
    this.completionCache.clear();
    this.pendingRequest?.resolve([]);
    this.pendingRequest = undefined;
  }

  /** Returns an active, queued, or newly started request for one stable shape. */
  private request(key: string, requestKey: string, loader: Loader): CompletionRequest {
    if (this.activeRequest?.requestKey === requestKey) {
      return { mode: "join", promise: this.activeRequest.promise };
    }
    if (this.pendingRequest?.requestKey === requestKey) {
      this.pendingRequest.loader = loader;
      return { mode: "join", promise: this.pendingRequest.promise };
    }
    if (this.activeRequest) {
      return { mode: "queue", promise: this.queue(key, requestKey, loader) };
    }
    return { mode: "load", promise: this.start(key, requestKey, loader) };
  }

  /** Starts one heavyweight provider load and launches only the latest pending request afterward. */
  private start(key: string, requestKey: string, loader: Loader): Promise<CompletionResult> {
    const isCurrent = () => this.latestRequestKey === requestKey;
    const promise = Promise.resolve().then(() => loader(isCurrent)).then((result) => isCurrent() ? result ?? [] : []);
    const active = { key, promise, requestKey };
    this.activeRequest = active;
    promise.then((result) => { if (isCurrent()) { this.remember(key, result); } }).finally(() => {
      if (this.activeRequest === active) {
        this.activeRequest = undefined;
        this.startPending();
      }
    }).catch(() => undefined);
    return promise;
  }

  /** Stores one latest pending request while a provider load is already active. */
  private queue(key: string, requestKey: string, loader: Loader): Promise<CompletionResult> {
    this.pendingRequest?.resolve([]);
    let resolve!: (result: CompletionResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<CompletionResult>((next, fail) => { resolve = next; reject = fail; });
    this.pendingRequest = { key, loader, promise, reject, requestKey, resolve };
    return promise;
  }

  /** Starts the retained pending request if it still describes the latest editor context. */
  private startPending(): void {
    const pending = this.pendingRequest;
    this.pendingRequest = undefined;
    if (!pending) {
      return;
    }
    if (pending.requestKey !== this.latestRequestKey) {
      pending.resolve([]);
      return;
    }
    this.start(pending.key, pending.requestKey, pending.loader).then(pending.resolve, pending.reject);
  }

  /** Resolves a pending request that has been superseded by a newer completion shape. */
  private cancelSupersededPending(requestKey: string): void {
    if (this.pendingRequest && this.pendingRequest.requestKey !== requestKey) {
      this.pendingRequest.resolve([]);
      this.pendingRequest = undefined;
    }
  }

  /** Builds an exact request identity from the active token and its stable surrounding shape. */
  private requestKey(document: vscode.TextDocument, position: vscode.Position, replacementRange: vscode.Range, key: string): string {
    const start = document.offsetAt(replacementRange.start);
    const end = document.offsetAt(position);
    return `${key}:${start}:${end}:${document.getText().slice(start, end)}`;
  }

  /** Returns a still-valid completion cache entry for one request key. */
  private cachedCompletion(key: string): CompletionResult | undefined {
    this.pruneCache();
    const cached = this.completionCache.get(key);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      this.completionCache.delete(key);
      return undefined;
    }
    this.completionCache.delete(key);
    this.completionCache.set(key, cached);
    return cached.result;
  }

  /** Stores one completion result with a short negative-cache lifetime and bounded LRU size. */
  private remember(key: string, result: CompletionResult): void {
    if (result instanceof vscode.CompletionList && result.isIncomplete) { return; }
    this.pruneCache();
    this.completionCache.delete(key);
    while (this.completionCache.size >= MAX_COMPLETION_CACHE_ENTRIES) {
      const oldest = this.completionCache.keys().next().value as string | undefined;
      if (oldest === undefined) { break; }
      this.completionCache.delete(oldest);
    }
    const ttl = completionResultCount(result) > 0 ? COMPLETION_CACHE_TTL_MS : EMPTY_COMPLETION_CACHE_TTL_MS;
    this.completionCache.set(key, { expiresAt: Date.now() + ttl, result });
  }

  /** Removes all expired cached completion results. */
  private pruneCache(): void {
    const now = Date.now();
    for (const [key, cached] of this.completionCache) {
      if (cached.expiresAt <= now) { this.completionCache.delete(key); }
    }
  }

  /** Writes one compact cache timing diagnostic. */
  private log(started: number, mode: string, items: number, trigger: string | undefined): void {
    this.logger?.log("overlay.completion.cache", { items, mode, ms: Date.now() - started, trigger });
  }
}

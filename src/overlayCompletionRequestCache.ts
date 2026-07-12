// Completion request cache for the Django shell overlay Python editor.

import * as vscode from "vscode";
import { cloneCompletionResult, CompletionResult, completionRequestShape, completionResultCount } from "./completionRequestCache";
import { DiagnosticLogger } from "./diagnostics";

const COMPLETION_CACHE_TTL_MS = 3000;
const MAX_COMPLETION_CACHE_ENTRIES = 16;

type Loader = (isCurrent: () => boolean) => Promise<CompletionResult | undefined>;

interface ActiveRequest {
  isCancelled: () => boolean;
  promise: Promise<CompletionResult>;
  requestKey: string;
  stableKey: string;
  token: string;
}

interface PendingRequest {
  isCancelled: () => boolean;
  loader: Loader;
  promise: Promise<CompletionResult>;
  reject: (error: unknown) => void;
  requestKey: string;
  resolve: (result: CompletionResult) => void;
  stableKey: string;
  token: string;
}

interface CompletionRequest {
  mode: "join" | "load" | "queue";
  promise: Promise<CompletionResult>;
}

interface CachedCompletion {
  expiresAt: number;
  result: CompletionResult;
  stableKey: string;
  token: string;
}

/** Caches repeated exact overlay completion requests while serializing provider work. */
export class OverlayCompletionRequestCache {
  private readonly completionCache = new Map<string, CachedCompletion>();
  private activeRequest: ActiveRequest | undefined;
  private generation = 0;
  private latestRequestKey = "";
  private pendingRequest: PendingRequest | undefined;

  /** Stores the optional diagnostic logger used for cache timing. */
  constructor(private readonly logger?: DiagnosticLogger) {}

  /** Returns cached or freshly loaded completions without blocking the editor indefinitely. */
  async provide(document: vscode.TextDocument, position: vscode.Position, trigger: string | undefined, loader: Loader, isCancelled: () => boolean = () => false): Promise<CompletionResult> {
    const started = Date.now();
    const shape = completionRequestShape(document, position);
    const stableKey = `${this.generation}:${shape.key}`;
    const requestKey = this.requestKey(document, position, shape.replacementRange, stableKey, trigger);
    const token = document.getText().slice(document.offsetAt(shape.replacementRange.start), document.offsetAt(position));
    this.latestRequestKey = requestKey;
    const cached = this.cachedCompletion(requestKey);
    if (cached) {
      if (this.pendingRequest) {
        this.pendingRequest.resolve(cached);
        this.pendingRequest = undefined;
      }
      this.log(started, "hit", completionResultCount(cached), trigger);
      return cloneCompletionResult(cached, shape.replacementRange);
    }
    const request = this.request(stableKey, requestKey, token, loader, isCancelled);
    const result = await request.promise;
    const delivered = completionResultCount(result) ? result : this.compatibleCachedCompletion(stableKey, token) ?? result;
    this.log(started, request.mode, completionResultCount(delivered), trigger);
    return cloneCompletionResult(delivered, shape.replacementRange);
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
  private request(stableKey: string, requestKey: string, token: string, loader: Loader, isCancelled: () => boolean): CompletionRequest {
    if (this.activeRequest?.requestKey === requestKey) {
      this.activeRequest.isCancelled = isCancelled;
      if (this.pendingRequest) { this.updatePending(this.pendingRequest, stableKey, requestKey, token, loader, isCancelled); }
      return { mode: "join", promise: this.activeRequest.promise };
    }
    if (this.pendingRequest) {
      this.updatePending(this.pendingRequest, stableKey, requestKey, token, loader, isCancelled);
      return { mode: "queue", promise: this.pendingRequest.promise };
    }
    if (this.activeRequest) {
      return { mode: "queue", promise: this.queue(stableKey, requestKey, token, loader, isCancelled) };
    }
    return { mode: "load", promise: this.start(stableKey, requestKey, token, loader, isCancelled) };
  }

  /** Starts one heavyweight provider load and launches only the latest pending request afterward. */
  private start(stableKey: string, requestKey: string, token: string, loader: Loader, isCancelled: () => boolean): Promise<CompletionResult> {
    let active!: ActiveRequest;
    const isCurrent = () => this.latestRequestKey === requestKey && !active.isCancelled();
    const promise = Promise.resolve().then(() => loader(isCurrent)).then((result) => result ?? []);
    active = { isCancelled, promise, requestKey, stableKey, token };
    this.activeRequest = active;
    promise.then((result) => {
      this.remember(requestKey, stableKey, token, result);
      if (this.activeRequest === active) { this.activeRequest = undefined; this.finishPending(active, result); }
    }, () => {
      if (this.activeRequest === active) { this.activeRequest = undefined; this.startPending(); }
    });
    return promise;
  }

  /** Stores one latest pending request while a provider load is already active. */
  private queue(stableKey: string, requestKey: string, token: string, loader: Loader, isCancelled: () => boolean): Promise<CompletionResult> {
    let resolve!: (result: CompletionResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<CompletionResult>((next, fail) => { resolve = next; reject = fail; });
    this.pendingRequest = { isCancelled, loader, promise, reject, requestKey, resolve, stableKey, token };
    return promise;
  }

  /** Transfers all queued callers to the newest completion context without settling them empty. */
  private updatePending(pending: PendingRequest, stableKey: string, requestKey: string, token: string, loader: Loader, isCancelled: () => boolean): void {
    pending.isCancelled = isCancelled;
    pending.loader = loader;
    pending.requestKey = requestKey;
    pending.stableKey = stableKey;
    pending.token = token;
  }

  /** Reuses a compatible active prefix result or starts the transferred latest request. */
  private finishPending(active: ActiveRequest, result: CompletionResult): void {
    const pending = this.pendingRequest;
    if (pending && (pending.requestKey === active.requestKey || reusableCompletionResult(active, pending, result))) {
      this.pendingRequest = undefined;
      pending.resolve(result);
      return;
    }
    this.startPending();
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
    this.start(pending.stableKey, pending.requestKey, pending.token, pending.loader, pending.isCancelled).then(pending.resolve, pending.reject);
  }

  /** Builds an exact request identity from the active token and its stable surrounding shape. */
  private requestKey(document: vscode.TextDocument, position: vscode.Position, replacementRange: vscode.Range, key: string, trigger: string | undefined): string {
    const start = document.offsetAt(replacementRange.start);
    const end = document.offsetAt(position);
    return `${key}:${trigger ?? ""}:${start}:${end}:${document.getText().slice(start, end)}`;
  }

  /** Returns a still-valid completion cache entry for one exact request. */
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
    if (cached.result instanceof vscode.CompletionList && cached.result.isIncomplete) { return undefined; }
    this.completionCache.delete(key); this.completionCache.set(key, cached);
    return cached.result;
  }

  /** Returns recent compatible candidates only after the latest provider transiently returns empty. */
  private compatibleCachedCompletion(stableKey: string, token: string): CompletionResult | undefined {
    this.pruneCache();
    const entries = [...this.completionCache.values()].reverse();
    const cached = entries.find((entry) => entry.stableKey === stableKey
      && token.length > entry.token.length
      && token.startsWith(entry.token)
      && completionResultMatchesToken(entry.result, token));
    return cached ? incompleteFilteredResult(cached.result, token) : undefined;
  }

  /** Stores one non-empty exact completion result with a short bounded LRU lifetime. */
  private remember(key: string, stableKey: string, token: string, result: CompletionResult): void {
    if (completionResultCount(result) === 0) { return; }
    this.pruneCache();
    this.completionCache.delete(key);
    while (this.completionCache.size >= MAX_COMPLETION_CACHE_ENTRIES) {
      const oldest = this.completionCache.keys().next().value as string | undefined;
      if (oldest === undefined) { break; }
      this.completionCache.delete(oldest);
    }
    this.completionCache.set(key, { expiresAt: Date.now() + COMPLETION_CACHE_TTL_MS, result, stableKey, token });
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

/** Returns whether a cached result contains an item compatible with the current token. */
function completionResultMatchesToken(result: CompletionResult, token: string): boolean {
  if (!token) { return true; }
  const normalized = token.toLowerCase();
  const items = result instanceof vscode.CompletionList ? result.items : result;
  return items.some((item) => completionFilterText(item).toLowerCase().startsWith(normalized));
}

/** Returns whether one complete active list is safe for a single in-flight token extension. */
function reusableCompletionResult(active: ActiveRequest, pending: PendingRequest, result: CompletionResult): boolean {
  return active.stableKey === pending.stableKey
    && pending.token.length > active.token.length
    && pending.token.startsWith(active.token)
    && completionResultCanFilter(result, pending.token);
}

/** Returns whether one explicitly complete list can keep filtering for a longer token. */
function completionResultCanFilter(result: CompletionResult, token: string): boolean {
  return result instanceof vscode.CompletionList
    && !result.isIncomplete
    && completionResultMatchesToken(result, token);
}

/** Returns matching known candidates as incomplete so later typing always rechecks the provider. */
function incompleteFilteredResult(result: CompletionResult, token: string): vscode.CompletionList {
  const items = result instanceof vscode.CompletionList ? result.items : result;
  const normalized = token.toLowerCase();
  return new vscode.CompletionList(items.filter((item) => completionFilterText(item).toLowerCase().startsWith(normalized)), true);
}

/** Returns the provider text used to filter one completion item. */
function completionFilterText(item: vscode.CompletionItem): string {
  if (item.filterText) { return item.filterText; }
  return typeof item.label === "string" ? item.label : item.label.label;
}

// Runtime-independent batching for the built-in experimental debugger's hot-reload watcher.

import type { BackendHotReloadResult } from "./backendHotReloadProtocol";

export interface NativeHotReloadQueueBackend {
  hotReload(paths: string[]): Promise<BackendHotReloadResult>;
}

export interface NativeHotReloadQueueOptions {
  canFlush?: () => boolean;
  debounceMs?: number;
  maxBatchSize?: number;
  onReloading?: (active: boolean) => void;
  onResult?: (result: BackendHotReloadResult, paths: string[]) => void;
  retryDelayMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_RETRY_DELAY_MS = 250;

/** Debounces file changes, waits for a safe execution state, and serializes bounded backend batches. */
export class NativeHotReloadQueue {
  private disposed = false;
  private flushChain = Promise.resolve();
  private generation = 0;
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Stores the backend and lifecycle callbacks owned by one live shell process. */
  constructor(private readonly backend: NativeHotReloadQueueBackend, private readonly options: NativeHotReloadQueueOptions = {}) {}

  /** Adds one normalized source path to the next debounce batch. */
  enqueue(path: string): void {
    if (this.disposed) { return; }
    this.pending.add(path);
    this.schedule(this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  /** Cancels queued work and suppresses callbacks from an in-flight request. */
  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.generation += 1;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.pending.clear();
  }

  /** Replaces the pending timer with one serialized flush attempt. */
  private schedule(delayMs: number): void {
    if (this.disposed) { return; }
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const generation = this.generation;
      this.flushChain = this.flushChain.catch(() => undefined).then(() => this.flush(generation));
    }, delayMs);
  }

  /** Sends sorted paths in backend-bounded chunks once execution is idle or debugger-paused. */
  private async flush(generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation || this.pending.size === 0) { return; }
    if (this.options.canFlush && !this.options.canFlush()) {
      this.schedule(this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
      return;
    }

    const paths = [...this.pending].sort();
    this.pending.clear();
    const maxBatchSize = Math.max(1, this.options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE);
    const results: BackendHotReloadResult["results"] = [];
    const errors: string[] = [];
    const attemptedPaths: string[] = [];
    let inFlightChunk: string[] = [];
    let ok = true;
    this.options.onReloading?.(true);
    try {
      for (let index = 0; index < paths.length; index += maxBatchSize) {
        if (this.disposed || generation !== this.generation) { return; }
        if (this.options.canFlush && !this.options.canFlush()) {
          for (const path of paths.slice(index)) { this.pending.add(path); }
          this.schedule(this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
          break;
        }
        const chunk = paths.slice(index, index + maxBatchSize);
        inFlightChunk = chunk;
        const result = await this.backend.hotReload(chunk);
        if (this.disposed || generation !== this.generation) { return; }
        if (result.retryable === true) {
          for (const path of paths.slice(index)) { this.pending.add(path); }
          inFlightChunk = [];
          this.schedule(this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
          break;
        }
        attemptedPaths.push(...chunk);
        inFlightChunk = [];
        results.push(...result.results);
        ok = ok && result.ok;
        if (result.error) { errors.push(result.error); }
      }
      if (attemptedPaths.length > 0) {
        this.options.onResult?.({ engine: "experimental", error: errors.length ? errors.join("; ") : undefined, ok, retryable: false, results }, attemptedPaths);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onResult?.({ engine: "experimental", error: message, ok: false, retryable: false, results }, [...attemptedPaths, ...inFlightChunk]);
    } finally {
      if (!this.disposed && generation === this.generation) { this.options.onReloading?.(false); }
    }
  }
}

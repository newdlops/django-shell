// Generation-safe asynchronous cache for runtime metadata requests.

/** Caches one asynchronous value without allowing stale completions to replace newer state. */
export class VersionedAsyncCache<T> {
  private generation = 0;
  private hasValue = false;
  private pending: Promise<T> | undefined;
  private value: T | undefined;

  /** Returns the current invalidation generation for related request guards. */
  get version(): number { return this.generation; }

  /** Returns a cached value or joins the one loader running for the current generation. */
  get(loader: () => Promise<T>): Promise<T> {
    if (this.hasValue) { return Promise.resolve(this.value as T); }
    if (this.pending) { return this.pending; }
    const generation = this.generation;
    let loaded: Promise<T>;
    try { loaded = loader(); } catch (error) { loaded = Promise.reject(error); }
    const request = loaded.then((value) => {
      if (generation === this.generation) { this.value = value; this.hasValue = true; }
      return value;
    }).finally(() => { if (this.pending === request) { this.pending = undefined; } });
    this.pending = request;
    return request;
  }

  /** Returns whether a request generation still represents the active runtime state. */
  isCurrent(generation: number): boolean { return generation === this.generation; }

  /** Invalidates cached and in-flight ownership while allowing old callers to settle safely. */
  invalidate(): void {
    this.generation += 1;
    this.hasValue = false;
    this.pending = undefined;
    this.value = undefined;
  }
}

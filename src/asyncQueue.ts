// Serializes asynchronous work by stable string keys.

/** Runs keyed async tasks one at a time while allowing unrelated keys to proceed. */
export class SerializedAsyncQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Runs one task after earlier tasks for the same key finish. */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, next);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === next) {
        this.tails.delete(key);
      }
    }
  }
}

// Serializes asynchronous work by stable string keys.

export type AsyncQueuePriority = "high" | "normal";

/** Stores one keyed queue's active state and priority lanes. */
interface QueueState { active: boolean; high: QueuedTask[]; normal: QueuedTask[] }

/** Wraps one task so the queue can start it without knowing its result type. */
interface QueuedTask { reject(error: Error): void; start(): void }

/** Runs keyed async tasks one at a time while allowing unrelated keys to proceed. */
export class SerializedAsyncQueue {
  private readonly queues = new Map<string, QueueState>();

  /** Runs one task after active work, allowing high-priority work to pass queued normal tasks. */
  run<T>(key: string, task: () => Promise<T>, priority: AsyncQueuePriority = "normal", signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) { return Promise.reject(new Error("Queued request cancelled.")); }
    const state = this.queues.get(key) ?? { active: false, high: [], normal: [] };
    this.queues.set(key, state);
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => signal?.removeEventListener("abort", abort);
      const queued: QueuedTask = { reject: (error) => { cleanup(); reject(error); }, start: () => { cleanup(); void this.execute(key, state, task, resolve, reject); } };
      const abort = (): void => {
        const index = state[priority].indexOf(queued);
        if (index < 0) { return; }
        state[priority].splice(index, 1);
        queued.reject(new Error("Queued request cancelled."));
        this.drain(key, state);
      };
      signal?.addEventListener("abort", abort, { once: true });
      state[priority].push(queued);
      this.drain(key, state);
    });
  }

  /** Rejects waiting tasks while leaving active-task cleanup under its owner's control. */
  cancel(key: string, error: Error): void {
    const state = this.queues.get(key);
    if (!state) { return; }
    for (const task of [...state.high.splice(0), ...state.normal.splice(0)]) { task.reject(error); }
    if (!state.active) { this.queues.delete(key); }
  }

  /** Starts the next queued task when this key is idle. */
  private drain(key: string, state: QueueState): void {
    if (state.active) { return; }
    const next = state.high.shift() ?? state.normal.shift();
    if (!next) { if (this.queues.get(key) === state) { this.queues.delete(key); } return; }
    state.active = true;
    next.start();
  }

  /** Settles one task and releases the key for the next priority lane entry. */
  private async execute<T>(key: string, state: QueueState, task: () => Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void): Promise<void> {
    try {
      resolve(await task());
    } catch (error) {
      reject(error);
    } finally {
      state.active = false;
      this.drain(key, state);
    }
  }
}

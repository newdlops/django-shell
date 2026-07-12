// Priority queue that preserves state-mutation barriers around serialized analysis work.

/** Describes one queued action without exposing its result type to the shared scheduler. */
interface QueueEntry {
  action: () => PromiseLike<unknown> | unknown;
  barrier: boolean;
  priority: number;
  reject: (error: unknown) => void;
  resolve: (value: unknown) => void;
  sequence: number;
}

/** Serializes work while allowing high-priority reads to pass lower-priority reads before the next mutation barrier. */
export class PriorityBarrierQueue {
  private entries: QueueEntry[] = [];
  private running = false;
  private scheduled = false;
  private sequence = 0;

  /** Enqueues analysis work that may be reordered only within its current mutation-barrier segment. */
  enqueue<T>(priority: number, action: () => PromiseLike<T> | T): Promise<T> {
    return this.add(false, priority, action);
  }

  /** Enqueues state-changing work that every earlier request must precede and every later request must follow. */
  enqueueBarrier<T>(action: () => PromiseLike<T> | T): Promise<T> {
    return this.add(true, 0, action);
  }

  /** Stores one action and schedules a microtask so same-turn callers can be ordered by priority. */
  private add<T>(barrier: boolean, priority: number, action: () => PromiseLike<T> | T): Promise<T> {
    const promise = new Promise<T>((resolve, reject) => {
      this.entries.push({
        action,
        barrier,
        priority,
        reject,
        resolve: (value) => resolve(value as T),
        sequence: this.sequence++
      });
    });
    this.schedule();
    return promise;
  }

  /** Starts the queue on the next microtask without creating concurrent drain loops. */
  private schedule(): void {
    if (this.running || this.scheduled) {
      return;
    }
    this.scheduled = true;
    void Promise.resolve().then(() => {
      this.scheduled = false;
      return this.drain();
    });
  }

  /** Runs queued actions one at a time and preserves failures for their individual callers. */
  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.entries.length) {
        const entry = this.takeNext();
        try {
          entry.resolve(await entry.action());
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      this.running = false;
      if (this.entries.length) {
        this.schedule();
      }
    }
  }

  /** Chooses the highest-priority read before the first pending mutation, or that mutation when it is next. */
  private takeNext(): QueueEntry {
    const barrierIndex = this.entries.findIndex((entry) => entry.barrier);
    const candidateCount = barrierIndex < 0 ? this.entries.length : barrierIndex;
    if (candidateCount === 0) {
      return this.entries.shift()!;
    }
    let selected = 0;
    for (let index = 1; index < candidateCount; index += 1) {
      const candidate = this.entries[index];
      const current = this.entries[selected];
      if (candidate.priority > current.priority || (candidate.priority === current.priority && candidate.sequence < current.sequence)) {
        selected = index;
      }
    }
    return this.entries.splice(selected, 1)[0];
  }
}

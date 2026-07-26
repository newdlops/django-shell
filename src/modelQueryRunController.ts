// Owns the timeout, interruption, and late-result lifecycle for one ORM query execution.

import type { BackendInterruptResult } from "./backendClient";

/** States exposed to the query webview while a query execution changes lifecycle. */
export type ModelQueryRunState = "idle" | "running" | "slow" | "cancelling" | "succeeded" | "failed" | "timedOut" | "cancelled";

/** A serializable query execution state, including enough timing data for the webview to render elapsed time. */
export interface ModelQueryRunSnapshot {
  elapsedMs: number;
  error?: string;
  interruptConfirmed?: boolean;
  requestId: number;
  startedAt?: number;
  state: ModelQueryRunState;
  timeoutMs?: number;
}

/** The settled result from one attempted query execution. */
export type ModelQueryRunOutcome<T> =
  | { kind: "busy" }
  | { kind: "succeeded"; value: T }
  | { error: string; kind: "failed" }
  | { error?: string; interruptConfirmed: boolean; kind: "cancelled" }
  | { error?: string; interruptConfirmed?: boolean; kind: "timedOut" };

/** Dependencies injected into the controller so its lifecycle can be tested without VS Code or a live Django process. */
export interface ModelQueryRunControllerOptions {
  clearTimer?: typeof clearTimeout;
  interrupt(reason: string): Promise<BackendInterruptResult>;
  now?: () => number;
  onChange(snapshot: ModelQueryRunSnapshot): void;
  setTimer?: typeof setTimeout;
  slowAfterMs?: number;
  timeoutMs(): number;
}

interface ActiveRun {
  cancelled: boolean;
  cancelPromise?: Promise<void>;
  requestId: number;
  resolve(outcome: ModelQueryRunOutcome<unknown>): void;
  settled: boolean;
  slowTimer?: ReturnType<typeof setTimeout>;
  startedAt: number;
  timeoutMs: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_SLOW_AFTER_MS = 8000;

/** Runs one ORM query at a time and safely retires timed-out, cancelled, or late backend work. */
export class ModelQueryRunController {
  private activeRun: ActiveRun | undefined;
  private disposed = false;
  private nextRequestId = 0;
  private currentSnapshot: ModelQueryRunSnapshot = { elapsedMs: 0, requestId: 0, state: "idle" };
  private readonly clearTimer: typeof clearTimeout;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly slowAfterMs: number;

  /** Stores injectable clock/timer dependencies and begins in the idle state. */
  constructor(private readonly options: ModelQueryRunControllerOptions) {
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.slowAfterMs = Math.max(0, options.slowAfterMs ?? DEFAULT_SLOW_AFTER_MS);
  }

  /** Returns whether an execution is running or being interrupted. */
  get active(): boolean {
    return this.activeRun !== undefined;
  }

  /** Returns the latest lifecycle state, calculating current elapsed time only while a run remains active. */
  get snapshot(): ModelQueryRunSnapshot {
    if (!this.activeRun || this.currentSnapshot.startedAt === undefined) {
      return { ...this.currentSnapshot };
    }
    return { ...this.currentSnapshot, elapsedMs: this.elapsedSince(this.currentSnapshot.startedAt) };
  }

  /** Starts an execution unless another query is active, and settles without allowing late work to update state. */
  run<T>(execute: () => Promise<T>): Promise<ModelQueryRunOutcome<T>> {
    if (this.disposed || this.activeRun) {
      return Promise.resolve({ kind: "busy" });
    }
    const startedAt = this.now();
    const active: ActiveRun = {
      cancelled: false,
      requestId: ++this.nextRequestId,
      resolve: () => undefined,
      settled: false,
      startedAt,
      timeoutMs: this.timeoutMs()
    };
    this.activeRun = active;
    this.publish({ elapsedMs: 0, requestId: active.requestId, startedAt, state: "running", timeoutMs: active.timeoutMs });
    this.scheduleTimers(active);
    return new Promise<ModelQueryRunOutcome<T>>((resolve) => {
      active.resolve = resolve as (outcome: ModelQueryRunOutcome<unknown>) => void;
      // Both fulfillment and rejection are handled here even if this run is cancelled or times out first.
      Promise.resolve().then(execute).then(
        (value) => this.finishSuccess(active, value),
        (error: unknown) => this.finishFailure(active, error)
      );
    });
  }

  /** Interrupts an active execution once and waits only for the interrupt acknowledgement, never the original query promise. */
  async cancel(reason: "modelQuery.cancel" | "modelQuery.dispose"): Promise<void> {
    const active = this.activeRun;
    if (!active || active.settled) {
      return;
    }
    if (active.cancelPromise) {
      return active.cancelPromise;
    }
    active.cancelled = true;
    this.clearTimers(active);
    this.publish({ elapsedMs: this.elapsedSince(active.startedAt), requestId: active.requestId, startedAt: active.startedAt, state: "cancelling" });
    active.cancelPromise = this.finishCancellation(active, reason);
    return active.cancelPromise;
  }

  /** Cancels active work on a best-effort basis and prevents any further lifecycle notifications. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    void this.cancel("modelQuery.dispose");
  }

  /** Arms slow and hard-timeout timers using the setting value captured at execution start. */
  private scheduleTimers(active: ActiveRun): void {
    if (this.slowAfterMs > 0) {
      active.slowTimer = this.setTimer(() => this.markSlow(active), this.slowAfterMs);
    }
    if (active.timeoutMs > 0) {
      active.timeoutTimer = this.setTimer(() => this.timeout(active), active.timeoutMs);
    }
  }

  /** Marks a still-running request as slow without changing its execution generation. */
  private markSlow(active: ActiveRun): void {
    if (!this.isCurrent(active) || active.cancelled) {
      return;
    }
    this.publish({ elapsedMs: this.elapsedSince(active.startedAt), requestId: active.requestId, startedAt: active.startedAt, state: "slow", timeoutMs: active.timeoutMs });
  }

  /** Retires a query at its hard timeout before requesting a best-effort backend interrupt. */
  private timeout(active: ActiveRun): void {
    if (!this.isCurrent(active) || active.cancelled) {
      return;
    }
    active.cancelled = true;
    this.finish(active, { interruptConfirmed: undefined, kind: "timedOut" }, { elapsedMs: this.elapsedSince(active.startedAt), requestId: active.requestId, startedAt: active.startedAt, state: "timedOut", timeoutMs: active.timeoutMs });
    void this.options.interrupt("modelQuery.timeout").then(
      (result) => this.confirmTimedOutInterrupt(active, result),
      (error: unknown) => this.confirmTimedOutInterrupt(active, failedInterrupt(error))
    );
  }

  /** Records the interrupt acknowledgement for a timed-out request without reviving that retired execution. */
  private confirmTimedOutInterrupt(active: ActiveRun, result: BackendInterruptResult): void {
    if (this.currentSnapshot.requestId !== active.requestId || this.currentSnapshot.state !== "timedOut") {
      return;
    }
    const interruptConfirmed = Boolean(result.ok && result.interrupted);
    const error = interruptConfirmed ? undefined : interruptError(result);
    this.publish({ ...this.currentSnapshot, error, interruptConfirmed });
  }

  /** Awaits a manual interrupt acknowledgement after first invalidating the original query result. */
  private async finishCancellation(active: ActiveRun, reason: "modelQuery.cancel" | "modelQuery.dispose"): Promise<void> {
    let result: BackendInterruptResult;
    try {
      result = await this.options.interrupt(reason);
    } catch (error) {
      result = failedInterrupt(error);
    }
    if (!this.isCurrent(active)) {
      return;
    }
    const interruptConfirmed = Boolean(result.ok && result.interrupted);
    const error = interruptConfirmed ? undefined : interruptError(result);
    const outcome: ModelQueryRunOutcome<unknown> = error
      ? { error, interruptConfirmed, kind: "cancelled" }
      : { interruptConfirmed, kind: "cancelled" };
    this.finish(active, outcome, { elapsedMs: this.elapsedSince(active.startedAt), error, interruptConfirmed, requestId: active.requestId, startedAt: active.startedAt, state: "cancelled" });
  }

  /** Settles a current successful result unless cancellation or timeout has already invalidated it. */
  private finishSuccess<T>(active: ActiveRun, value: T): void {
    if (!this.isCurrent(active) || active.cancelled) {
      return;
    }
    this.finish(active, { kind: "succeeded", value }, { elapsedMs: this.elapsedSince(active.startedAt), requestId: active.requestId, startedAt: active.startedAt, state: "succeeded" });
  }

  /** Settles an execution failure unless cancellation or timeout has already invalidated it. */
  private finishFailure(active: ActiveRun, cause: unknown): void {
    if (!this.isCurrent(active) || active.cancelled) {
      return;
    }
    const error = cause instanceof Error ? cause.message : String(cause);
    this.finish(active, { error, kind: "failed" }, { elapsedMs: this.elapsedSince(active.startedAt), error, requestId: active.requestId, startedAt: active.startedAt, state: "failed" });
  }

  /** Clears timers, retires the active generation, publishes terminal state, and resolves the original run promise. */
  private finish(active: ActiveRun, outcome: ModelQueryRunOutcome<unknown>, snapshot: ModelQueryRunSnapshot): void {
    if (!this.isCurrent(active)) {
      return;
    }
    active.settled = true;
    this.clearTimers(active);
    this.activeRun = undefined;
    this.publish(snapshot);
    active.resolve(outcome);
  }

  /** Returns whether this exact request still owns the active generation. */
  private isCurrent(active: ActiveRun): boolean {
    return this.activeRun === active && !active.settled;
  }

  /** Clears all pending lifecycle timers for one request. */
  private clearTimers(active: ActiveRun): void {
    if (active.slowTimer) {
      this.clearTimer(active.slowTimer);
      active.slowTimer = undefined;
    }
    if (active.timeoutTimer) {
      this.clearTimer(active.timeoutTimer);
      active.timeoutTimer = undefined;
    }
  }

  /** Publishes a snapshot unless the owning console has been disposed. */
  private publish(snapshot: ModelQueryRunSnapshot): void {
    this.currentSnapshot = snapshot;
    if (!this.disposed) {
      this.options.onChange({ ...snapshot });
    }
  }

  /** Returns non-negative elapsed time relative to the injected clock. */
  private elapsedSince(startedAt: number): number {
    return Math.max(0, this.now() - startedAt);
  }

  /** Reads and normalizes the timeout once so the execution and its visible status share one value. */
  private timeoutMs(): number {
    return Math.max(0, this.options.timeoutMs());
  }
}

/** Converts an interrupt rejection into the shared backend-interrupt result shape. */
function failedInterrupt(error: unknown): BackendInterruptResult {
  return { error: error instanceof Error ? error.message : String(error), interrupted: false, ok: false };
}

/** Returns a concise actionable interrupt failure reason for the query state snapshot. */
function interruptError(result: BackendInterruptResult): string {
  return result.error ?? result.message ?? "Django Shell could not interrupt the query.";
}

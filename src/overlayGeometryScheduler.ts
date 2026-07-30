// Latest-value geometry dispatcher for the workbench overlay host.
import type { WorkbenchOverlayGeometry } from "./workbenchOverlay";

/** Describes the asynchronous geometry operation performed by the overlay host. */
export type GeometryDispatch = (geometry: WorkbenchOverlayGeometry) => Promise<void>;

/** Coalesces geometry updates into an immediate leading dispatch and one newest trailing value. */
export class OverlayGeometryScheduler {
  private active = true;
  private disposed = false;
  private inFlight = false;
  private lastKey = "";
  private pending: WorkbenchOverlayGeometry | undefined;
  private retryGeometry: WorkbenchOverlayGeometry | undefined;
  private retryKey = "";
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retriedKey = "";

  /** Creates a scheduler that calls the supplied dispatcher for distinct rectangles. */
  constructor(private readonly dispatch: GeometryDispatch, private readonly canDispatch: () => boolean) {}

  /** Queues a rectangle, immediately starting work when the renderer lane is available. */
  update(geometry: WorkbenchOverlayGeometry): void {
    if (this.disposed || !this.active) { return; }
    const key = geometryKey(geometry);
    if (this.retryTimer && this.retryKey && key !== this.retryKey) { this.cancelRetry(); }
    if (key === this.lastKey && !this.pending) { return; }
    this.pending = geometry;
    this.flush();
  }

  /** Lets a renderer transaction release the single latest held rectangle. */
  resume(): void { this.flush(); }

  /** Pauses dispatching while retaining the latest warm geometry. */
  pause(): void { this.active = false; this.cancelRetry(); }

  /** Resumes dispatching the newest retained rectangle. */
  activate(): void { if (this.disposed) { return; } this.active = true; this.flush(); }

  /** Cancels pending retries and permanently releases scheduler state. */
  dispose(): void { this.disposed = true; this.pending = undefined; this.cancelRetry(); }

  /** Starts at most one request and leaves only the newest later rectangle pending. */
  private flush(): void {
    if (this.disposed || !this.active || this.inFlight || !this.pending || !this.canDispatch()) { return; }
    const geometry = this.pending;
    const key = geometryKey(geometry);
    if (this.retryTimer && key === this.retryKey) { return; }
    this.pending = undefined;
    if (key === this.lastKey) { this.flush(); return; }
    this.inFlight = true;
    void this.dispatch(geometry).then(() => {
      this.lastKey = key;
      this.retriedKey = "";
    }).catch(() => {
      if (!this.disposed && this.active && this.retriedKey !== key && (!this.pending || geometryKey(this.pending) === key)) {
        this.retriedKey = key;
        this.retryKey = key;
        this.retryGeometry = geometry;
        if (this.pending && geometryKey(this.pending) === key) { this.pending = undefined; }
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          if (!this.pending && this.retryGeometry) { this.pending = this.retryGeometry; }
          this.retryGeometry = undefined;
          this.retryKey = "";
          this.flush();
        }, 400);
      }
    }).finally(() => { this.inFlight = false; this.flush(); });
  }

  /** Clears the bounded retry timer. */
  private cancelRetry(): void { if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; } this.retryGeometry = undefined; this.retryKey = ""; }
}

/** Produces a stable integer-pixel rectangle identity for duplicate suppression. */
export function geometryKey(geometry: WorkbenchOverlayGeometry): string {
  return [geometry.left, geometry.top, geometry.width, geometry.height].map((value) => Math.round(Number(value) || 0)).join(":");
}

// Shared lightweight Debug Adapter Protocol contracts for debugger helpers.

/** Minimal DAP request surface shared by VS Code debug sessions and direct debugpy clients. */
export interface DebugRequestSession {
  readonly id?: string;
  customRequest<T = unknown>(command: string, args?: unknown): PromiseLike<T>;
}

/** Optional lifecycle method exposed by direct DAP clients. */
export interface DisposableDebugRequestSession extends DebugRequestSession {
  disconnect?(): Promise<void>;
}

// Distinguishes safe connection fallback from a request whose execution outcome is unknown.

/** Records whether a socket failure happened after a request may have reached Python. */
export class BackendSocketFailure extends Error {
  /** Retains delivery state so callers never replay an ambiguously executed request. */
  constructor(message: string, readonly submitted: boolean) { super(message); this.name = "BackendSocketFailure"; }
}

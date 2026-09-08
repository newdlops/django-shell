// Loads only a requested runtime capability and its dependencies, coalescing shared work across callers.
import type { BackendClient } from "./backendClient";
import { parseLoadFeatureResponse } from "./backendClientResponses";
import { backendCapabilityPayload, type BackendCapability, type BackendCapabilityPayload } from "./backendCapabilities";
import { readBackendSource } from "./backendBootstrap";
import type { BackendUploadFrame } from "./backendUploadChannel";

/** Manages independent capability promises so a large optional load does not gate an already-ready feature. */
export class BackendCapabilityLoader {
  private readonly ready = new Map<BackendCapability, Promise<void>>([["base", Promise.resolve()]]);
  private sequence = 0;

  /** Stores one runtime's delivery paths and identity check. */
  constructor(private readonly runtimePath: string, private readonly client: BackendClient, private readonly current: () => boolean,
    private readonly upload: (frame: BackendUploadFrame, command: string) => Promise<string>) {}

  /** Shares each capability's load and allows only failed capabilities to be retried. */
  ensure(feature: BackendCapability): Promise<void> {
    try { this.assertCurrent(); } catch (error) { return Promise.reject(error); }
    const existing = this.ready.get(feature);
    if (existing) { return existing; }
    const attempt = this.load(feature).catch((error: unknown) => { this.ready.delete(feature); throw error; });
    this.ready.set(feature, attempt);
    return attempt;
  }

  /** Loads prerequisites first, then transfers one feature over a socket or an acknowledged stdin frame. */
  private async load(feature: BackendCapability): Promise<void> {
    const source = readBackendSource(this.runtimePath);
    const payload = source ? backendCapabilityPayload(this.runtimePath, source, feature) : undefined;
    if (!payload) { throw new Error("The requested backend capability source is unavailable."); }
    await Promise.all(payload.requires.map((dependency) => this.ensure(dependency)));
    this.assertCurrent();
    try {
      const cached = await this.client.loadFeature(undefined, payload.digest, feature, payload.requires);
      this.assertCurrent();
      if (cached.ok) { return; }
      const uploaded = await this.client.loadFeature(payload.data, payload.digest, feature, payload.requires);
      this.assertCurrent();
      if (uploaded.ok) { return; }
    } catch { /* A terminal-only connection receives data through the short stdin reader call below. */ }
    this.assertCurrent();
    const frame = this.frame(payload);
    const command = `_djs_backend_module._load_capability_from_stdin(${JSON.stringify(feature)},${Buffer.byteLength(frame.header)},${JSON.stringify(frame.id)})\r`;
    const result = parseLoadFeatureResponse(await this.upload(frame, command));
    this.assertCurrent();
    if (!result.ok) { throw new Error(result.error || `The ${feature} backend capability could not be loaded.`); }
  }

  /** Builds metadata separately from the source so neither digest nor payload is typed as Python code. */
  private frame(payload: BackendCapabilityPayload): BackendUploadFrame {
    const id = `cap-${payload.feature}-${this.client.runtimeId.slice(0, 8)}-${++this.sequence}`;
    return { id, data: payload.data, header: JSON.stringify({ digest: payload.digest, feature: payload.feature, requires: payload.requires, size: payload.data.length }) };
  }

  /** Rejects continuations belonging to a replaced runtime before they can reach a new PTY. */
  private assertCurrent(): void {
    if (!this.current()) { throw new Error("Django shell runtime changed while loading a capability."); }
  }
}

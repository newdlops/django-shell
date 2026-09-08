// Sends capability bytes only after a remote stdin reader acknowledges ownership of the terminal.
export interface BackendUploadFrame { id: string; header: string; data: string }
const UPLOAD_PREFIX = "__DJANGO_SHELL_UPLOAD_READY__";

/** Owns one framed upload without turning its base64 contents into interactive Python cells. */
export class BackendUploadChannel {
  private frame: BackendUploadFrame | undefined;
  private tail = "";
  private timer: NodeJS.Timeout | undefined;
  private stages = new Set<string>();
  private input = "";

  /** Receives the current session's writer; session disposal cancels the channel before replacing the process. */
  constructor(private readonly write: (data: string) => void) {}

  /** Reports whether transfer output belongs to protocol traffic rather than a user's shell cell. */
  get active(): boolean { return Boolean(this.frame); }

  /** Registers data before the corresponding short reader command reaches the PTY. */
  stage(frame: BackendUploadFrame): void {
    this.cancel();
    this.frame = frame;
  }

  /** Holds manual terminal input until the reader has restored normal terminal settings. */
  holdInput(data: string): boolean {
    if (!this.frame) { return false; }
    this.input += data;
    return true;
  }

  /** Handles fragmented reader-ready markers and ignores stale, duplicated, or mismatched acknowledgements. */
  accept(data: string): void {
    if (!this.frame) { return; }
    this.tail = (this.tail + data).slice(-16000);
    for (;;) {
      const start = this.tail.indexOf(UPLOAD_PREFIX);
      if (start < 0) { this.tail = this.tail.slice(-UPLOAD_PREFIX.length); return; }
      const end = this.tail.indexOf("\n", start);
      if (end < 0) { this.tail = this.tail.slice(start); return; }
      const line = this.tail.slice(start + UPLOAD_PREFIX.length, end).trim();
      this.tail = this.tail.slice(end + 1);
      try {
        const marker = JSON.parse(line) as { id?: string; size?: number; stage?: string };
        if (marker.id !== this.frame.id || !["header", "payload"].includes(marker.stage ?? "") || this.stages.has(marker.stage as string)) { continue; }
        if (marker.stage === "payload" && !this.stages.has("header")) { continue; }
        const payload = marker.stage === "header" ? this.frame.header : this.frame.data;
        if (marker.size !== Buffer.byteLength(payload)) { continue; }
        this.stages.add(marker.stage as string);
        this.send(this.frame, payload, 0);
      } catch { /* Ordinary terminal text is never an upload acknowledgement. */ }
    }
  }

  /** Reports whether framing is intact and releases held input only after a complete transfer response. */
  finish(id?: string, response?: string): boolean {
    if (id && this.frame?.id !== id) { return true; }
    let complete = true;
    if (response !== undefined) {
      try {
        const result = JSON.parse(response) as { ok?: boolean; restartRequired?: boolean } | null;
        complete = typeof result?.ok === "boolean" && result.restartRequired !== true;
      } catch { complete = false; }
    }
    const input = complete ? this.input : "";
    this.cancel();
    if (input) { this.write(input); }
    return complete;
  }

  /** Cancels queued writes and discards old-runtime input when the session closes or restarts. */
  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined; this.frame = undefined; this.tail = ""; this.input = ""; this.stages.clear();
  }

  /** Feeds small raw chunks while a bounded reader is active, without adding Python statements or terminal echoes. */
  private send(frame: BackendUploadFrame, payload: string, offset: number): void {
    if (this.frame !== frame) { return; }
    const end = Math.min(payload.length, offset + 16384);
    this.write(payload.slice(offset, end));
    if (end < payload.length) { this.timer = setTimeout(() => this.send(frame, payload, end), 1); }
  }
}

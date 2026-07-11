// Engine-neutral Debug Adapter Protocol client for overlay-owned debugging.

import * as net from "net";
import type { DebugRequestSession } from "./debugAdapterTypes";
import { DJANGO_SHELL_NATIVE_DEBUG_TYPE, type DjangoShellDebugEngine } from "./debugEngine";
import { buildDebugpySteppingRules } from "./debugSteppingRules";
import type { DiagnosticLogger } from "./diagnostics";

interface DapMessage { body?: unknown; command?: string; event?: string; message?: string; request_seq?: number; success?: boolean; type: "event" | "request" | "response"; }
interface PendingRequest { command: string; reject(error: Error): void; resolve(value: unknown): void; timer: ReturnType<typeof setTimeout>; }
interface EventWaiter { reject(error: Error): void; resolve(body: unknown): void; timer: ReturnType<typeof setTimeout>; }
export interface StoppedEventBody { reason?: string; threadId?: number; }
export interface ContinuedEventBody { allThreadsContinued?: boolean; threadId?: number; }

export interface DirectDebugAdapterEndpoint {
  host: string;
  port: number;
}

export interface DirectDebugAdapterHooks {
  onContinued?(body: ContinuedEventBody): void;
  onOutput?(text: string): void;
  onStopped?(body: StoppedEventBody): void;
  onTerminated?(): void;
}

export interface DirectDebugAdapterAttachOptions {
  cwd?: string;
  django?: boolean;
  engine?: DjangoShellDebugEngine;
  justMyCode?: boolean;
  name?: string;
  pathMappings?: Array<{ localRoot: string; remoteRoot: string }>;
}

const REQUEST_TIMEOUT_MS = 20000;
const INITIALIZE_TIMEOUT_MS = 5000;

/** Maintains a direct DAP connection without creating a VS Code DebugSession. */
export class DirectDebugAdapterSession implements DebugRequestSession {
  readonly id = `direct-debug-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private attached = false;
  private buffer = Buffer.alloc(0);
  private nextSeq = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly seenEvents = new Set<string>();
  private socket: net.Socket | undefined;
  private readonly waiters = new Map<string, EventWaiter[]>();

  /** Stores event hooks used by the custom overlay debugger UI. */
  constructor(private readonly hooks: DirectDebugAdapterHooks = {}, private readonly logger?: DiagnosticLogger) {}

  /** Connects to a DAP endpoint, lets callers set breakpoints, then completes configuration. */
  async attach(endpoint: DirectDebugAdapterEndpoint, beforeConfigurationDone?: () => Promise<void>, options: DirectDebugAdapterAttachOptions = {}): Promise<void> {
    try {
      await this.attachOnce(endpoint, beforeConfigurationDone, options);
    } catch (error) {
      this.closeTransport(error instanceof Error ? error : new Error(String(error)), false);
      if (!isInitializeTimeout(error)) { throw error; }
      this.logger?.log("debug.direct.attach.retry", { host: endpoint.host, port: endpoint.port });
      await delay(150);
      await this.attachOnce(endpoint, beforeConfigurationDone, options);
    }
  }

  /** Performs one direct attach handshake over a fresh DAP socket. */
  private async attachOnce(endpoint: DirectDebugAdapterEndpoint, beforeConfigurationDone?: () => Promise<void>, options: DirectDebugAdapterAttachOptions = {}): Promise<void> {
    await this.openSocket(endpoint);
    await this.customRequest("initialize", buildDirectDebugAdapterInitializeArguments(options));
    const attach = this.customRequest("attach", buildDirectDebugAdapterAttachArguments(options));
    await this.waitForEvent("initialized", 5000).catch(() => undefined);
    await beforeConfigurationDone?.();
    await this.customRequest("configurationDone", {});
    await attach;
    this.attached = true;
  }

  /** Sends one DAP request and resolves with the response body. */
  customRequest<T = unknown>(command: string, args: unknown = {}): Promise<T> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error("Debug adapter socket is not connected."));
    }
    const seq = this.nextSeq++;
    const payload = JSON.stringify({ arguments: args, command, seq, type: "request" });
    const header = Buffer.from(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`, "utf8");
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = command === "initialize" ? INITIALIZE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => { const error = new Error(`DAP request timed out: ${command}`); this.pending.delete(seq); reject(error); if (!this.attached) { this.closeTransport(error, false); } }, timeoutMs);
      this.pending.set(seq, { command, reject, resolve: (value) => resolve(value as T), timer });
      this.socket?.write(Buffer.concat([header, Buffer.from(payload, "utf8")]), (error) => {
        if (!error) { return; }
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(error);
      });
    });
  }

  /** Sends a DAP disconnect request before closing the transport. */
  async disconnect(): Promise<void> {
    if (!this.socket) { return; }
    try {
      if (this.attached) { await this.customRequest("disconnect", { restart: false, terminateDebuggee: false }); }
    } catch (error) {
      this.logger?.log("debug.direct.disconnect.error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.closeTransport(new Error("Debug adapter disconnected."), true);
    }
  }

  /** Allows this client to be used as a VS Code-style disposable. */
  dispose(): void { void this.disconnect(); }

  /** Opens the TCP socket and wires protocol parsing. */
  private openSocket(endpoint: DirectDebugAdapterEndpoint): Promise<void> {
    if (this.socket && !this.socket.destroyed) { return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
      const fail = (error: Error) => { socket.destroy(); reject(error); };
      socket.once("connect", () => { socket.off("error", fail); this.socket = socket; this.attached = false; resolve(); });
      socket.once("error", fail);
      socket.on("data", (chunk) => this.handleData(chunk));
      socket.on("error", (error) => this.logger?.log("debug.direct.socket.error", { error: error.message }));
      socket.on("close", () => { this.attached = false; this.rejectPending(new Error("Debug adapter socket closed.")); this.hooks.onTerminated?.(); });
    });
  }

  /** Closes the DAP socket immediately and rejects in-flight requests. */
  private closeTransport(error: Error, notify: boolean): void {
    const socket = this.socket;
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    this.attached = false;
    if (socket && !socket.destroyed) {
      socket.end();
      socket.destroy();
    }
    this.rejectPending(error);
    if (notify) { this.hooks.onTerminated?.(); }
  }

  /** Parses Content-Length framed DAP messages from accumulated bytes. */
  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) { return; }
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) { this.buffer = Buffer.alloc(0); return; }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) { return; }
      const raw = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.handleMessage(raw);
    }
  }

  /** Dispatches one parsed DAP message to pending requests or event hooks. */
  private handleMessage(raw: string): void {
    try {
      const message = JSON.parse(raw) as DapMessage;
      if (message.type === "response") { this.handleResponse(message); return; }
      if (message.type === "event") { this.handleEvent(message.event ?? "", message.body); }
    } catch (error) {
      this.logger?.log("debug.direct.parse.error", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Resolves or rejects the request matching one response message. */
  private handleResponse(message: DapMessage): void {
    const pending = this.pending.get(message.request_seq ?? 0);
    if (!pending) { return; }
    clearTimeout(pending.timer);
    this.pending.delete(message.request_seq ?? 0);
    if (message.success === false) { pending.reject(new Error(message.message || `DAP request failed: ${pending.command}`)); return; }
    pending.resolve(message.body);
  }

  /** Emits high-level hooks for DAP events relevant to overlay debugging. */
  private handleEvent(event: string, body: unknown): void {
    this.seenEvents.add(event);
    this.resolveEvent(event, body);
    if (event === "stopped") { this.hooks.onStopped?.((body ?? {}) as StoppedEventBody); return; }
    if (event === "continued") { this.hooks.onContinued?.((body ?? {}) as ContinuedEventBody); return; }
    if (event === "terminated" || event === "exited") { this.hooks.onTerminated?.(); return; }
    if (event === "output") { this.hooks.onOutput?.(String((body as { output?: string } | undefined)?.output ?? "")); }
  }

  /** Waits for one event name, resolving immediately when it has already arrived. */
  private waitForEvent(event: string, timeoutMs: number): Promise<unknown> {
    if (this.seenEvents.has(event)) { return Promise.resolve({}); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.removeEventWaiter(event, waiter); reject(new Error(`DAP event timed out: ${event}`)); }, timeoutMs);
      const waiter: EventWaiter = { reject, resolve, timer };
      this.waiters.set(event, [...(this.waiters.get(event) ?? []), waiter]);
    });
  }

  /** Resolves all waiters for one event. */
  private resolveEvent(event: string, body: unknown): void {
    const waiters = this.waiters.get(event) ?? [];
    this.waiters.delete(event);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(body);
    }
  }

  /** Removes one event waiter after timeout. */
  private removeEventWaiter(event: string, waiter: EventWaiter): void {
    const waiters = (this.waiters.get(event) ?? []).filter((item) => item !== waiter);
    if (waiters.length) { this.waiters.set(event, waiters); } else { this.waiters.delete(event); }
  }

  /** Rejects all outstanding requests and event waiters. */
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
  }
}

/** Returns whether an attach failure came from an unresponsive DAP initialize handshake. */
function isInitializeTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes("DAP request timed out: initialize");
}

/** Builds initialize arguments appropriate for the selected direct debug adapter. */
export function buildDirectDebugAdapterInitializeArguments(options: DirectDebugAdapterAttachOptions): Record<string, unknown> {
  return { adapterID: options.engine === "experimental" ? DJANGO_SHELL_NATIVE_DEBUG_TYPE : "python", clientID: "django-shell-overlay", columnsStartAt1: true, linesStartAt1: true, pathFormat: "path", supportsVariablePaging: true, supportsVariableType: true };
}

/** Builds engine-specific attach arguments for an overlay-owned direct session. */
export function buildDirectDebugAdapterAttachArguments(options: DirectDebugAdapterAttachOptions): Record<string, unknown> {
  const args: Record<string, unknown> = { name: options.name ?? "Django Shell Overlay", request: "attach" };
  if (options.engine !== "experimental") {
    Object.assign(args, { django: options.django ?? true, justMyCode: options.justMyCode ?? false, rules: buildDebugpySteppingRules(), showReturnValue: true, steppingResumesAllThreads: false, subProcess: false, type: "python" });
  }
  if (options.cwd) { args.cwd = options.cwd; }
  if (options.pathMappings?.length) { args.pathMappings = options.pathMappings; }
  return args;
}

/** Waits briefly before retrying a stale adapter connection. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

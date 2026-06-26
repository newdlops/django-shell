// Debug event wiring for the custom Django shell console.

import * as vscode from "vscode";
import type { DebugControlAction } from "./debugControls";
import { type DebugFrameInfo, type DebugPanelState, inspectDebugFrame, inspectDebugThread } from "./debugInspector";
import type { DiagnosticLogger } from "./diagnostics";

export type DebugStatusState = "attached" | "error" | "idle" | "paused" | "running" | "starting";

interface DebugEventHooks {
  getSession(): vscode.DebugSession | undefined;
  lastControlAction(): DebugControlAction | undefined;
  logger?: DiagnosticLogger;
  postInfo(info: DebugFrameInfo): void;
  postStatus(state: DebugStatusState, detail?: string): void;
  refreshBreakpoints(): void;
  runCurrentInput(): Promise<string>;
  setPausedThread(threadId: number | undefined): void;
  setSession(session: vscode.DebugSession | undefined): void;
  syncBreakpoints(reason: string): Promise<void>;
}

/** Registers VS Code debug events that keep the custom console debugger panel current. */
export function registerCustomConsoleDebugEvents(disposables: vscode.Disposable[], hooks: DebugEventHooks): void {
  let generation = 0;
  const clearInfo = (state: DebugPanelState) => hooks.postInfo({ focusVariables: [], scopes: [], state });
  const inspectStack = (item: vscode.DebugThread | vscode.DebugStackFrame | undefined) => {
    generation += 1;
    const current = generation;
    if (item && "frameId" in item) { hooks.logger?.log("debug.active.frame", { frameId: item.frameId, threadId: item.threadId }); }
    void refreshPausedFrame(item, hooks, () => current === generation);
  };
  const inspectStopped = (session: vscode.DebugSession, body: { reason?: string; threadId?: number } | undefined) => {
    if (session.id !== hooks.getSession()?.id) { return; }
    generation += 1;
    const current = generation;
    hooks.setPausedThread(body?.threadId);
    hooks.logger?.log("debug.dap.stopped", { reason: body?.reason ?? "", threadId: body?.threadId ?? 0 });
    void logDebugStack(session, body?.threadId, hooks);
    void refreshStoppedThread(session, body, hooks, () => current === generation);
  };
  disposables.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (!isDjangoShellSession(session)) { return; }
      hooks.logger?.log("debug.session.start", { sessionId: session.id });
      hooks.setSession(session); hooks.postStatus("attached", "active"); clearInfo("attached"); hooks.refreshBreakpoints(); void startDebuggedInput(hooks);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (hooks.getSession()?.id !== session.id) { return; }
      hooks.logger?.log("debug.session.terminate", { sessionId: session.id });
      generation += 1; hooks.setSession(undefined); hooks.postStatus("idle", "ended"); clearInfo("idle");
    }),
    vscode.debug.onDidChangeBreakpoints(() => { hooks.refreshBreakpoints(); void hooks.syncBreakpoints("breakpointsChanged"); }),
    vscode.debug.onDidChangeActiveDebugSession((session) => {
      hooks.logger?.log("debug.session.active", { sessionId: session?.id ?? "", shell: session ? isDjangoShellSession(session) : false });
      if (session?.id === hooks.getSession()?.id) { hooks.postStatus("attached", "active"); }
    }),
    vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
      if (event.session.id !== hooks.getSession()?.id) { return; }
      if (event.event === "continued") { generation += 1; hooks.logger?.log("debug.dap.continued", { threadId: (event.body as { threadId?: number } | undefined)?.threadId ?? 0 }); hooks.postStatus("running", "continued"); clearInfo("running"); return; }
      if (event.event === "stopped") { inspectStopped(event.session, event.body as { reason?: string; threadId?: number } | undefined); }
    }),
    vscode.debug.registerDebugAdapterTrackerFactory("*", {
      /** Creates a tracker for Django Shell debugpy sessions only. */
      createDebugAdapterTracker(session) {
        if (!isDjangoShellSession(session)) { return undefined; }
        return {
          /** Mirrors standard DAP stopped/continued events into the custom console UI. */
          onDidSendMessage(message) {
            const event = message as { body?: { reason?: string; threadId?: number }; event?: string; type?: string };
            if (event.type !== "event") { return; }
            if (event.event === "continued") { generation += 1; hooks.logger?.log("debug.dap.continued", { threadId: event.body?.threadId ?? 0 }); hooks.postStatus("running", "continued"); clearInfo("running"); return; }
            if (event.event === "stopped") { inspectStopped(session, event.body); }
          }
        };
      }
    }),
    vscode.debug.onDidChangeActiveStackItem(inspectStack)
  );
}

/** Returns whether a debug session belongs to this extension's shell attach flow. */
function isDjangoShellSession(session: vscode.DebugSession): boolean {
  return session.type === "python" && session.configuration.name === "Django Shell";
}

/** Synchronizes breakpoints, then runs the current overlay input under the attached debugger. */
async function startDebuggedInput(hooks: DebugEventHooks): Promise<void> {
  try {
    await waitForDebugAdapterReady(hooks.getSession(), hooks);
    await hooks.syncBreakpoints("sessionStart");
    const report = await hooks.runCurrentInput();
    hooks.logger?.log("debug.attach.runCurrent", { report });
  } catch (error) {
    hooks.logger?.log("debug.attach.runCurrent.error", { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Waits until the debug adapter answers a basic DAP request before running user code. */
async function waitForDebugAdapterReady(session: vscode.DebugSession | undefined, hooks: DebugEventHooks, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError = "";
  while (session && Date.now() < deadline) {
    attempts += 1;
    try {
      await session.customRequest("threads", {});
      hooks.logger?.log("debug.attach.ready", { attempts, sessionId: session.id });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(100);
    }
  }
  hooks.logger?.log("debug.attach.ready.timeout", { attempts, error: lastError, sessionId: session?.id ?? "" });
}

/** Resolves after a short timeout. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Logs the raw DAP stack so missing overlay frames are diagnosable from Output. */
async function logDebugStack(session: vscode.DebugSession, threadId: number | undefined, hooks: DebugEventHooks): Promise<void> {
  try {
    const resolvedThreadId = threadId ?? await firstDebugThreadId(session);
    if (!resolvedThreadId) { return; }
    const response = await session.customRequest("stackTrace", { levels: 30, startFrame: 0, threadId: resolvedThreadId }) as { stackFrames?: Array<{ id: number; line: number; name: string; source?: { name?: string; path?: string } }> };
    hooks.logger?.log("debug.stack", { frames: JSON.stringify((response.stackFrames ?? []).map(debugStackFrameFields)), threadId: resolvedThreadId });
  } catch (error) {
    hooks.logger?.log("debug.stack.error", { error: error instanceof Error ? error.message : String(error), threadId: threadId ?? 0 });
  }
}

/** Returns the first DAP thread id for stack logging when a stopped event omits it. */
async function firstDebugThreadId(session: vscode.DebugSession): Promise<number | undefined> {
  const response = await session.customRequest("threads", {}) as { threads?: Array<{ id: number }> };
  return response.threads?.[0]?.id;
}

/** Formats one DAP stack frame for compact diagnostics. */
function debugStackFrameFields(frame: { id: number; line: number; name: string; source?: { name?: string; path?: string } }): { id: number; line: number; name: string; path: string } {
  return { id: frame.id, line: frame.line, name: frame.name, path: frame.source?.path ?? frame.source?.name ?? "" };
}

/** Refreshes paused frame location and variables if VS Code focuses a stack frame. */
async function refreshPausedFrame(item: vscode.DebugThread | vscode.DebugStackFrame | undefined, hooks: DebugEventHooks, isCurrent: () => boolean): Promise<void> {
  const session = hooks.getSession();
  if (!session || !item || item.session.id !== session.id) {
    hooks.postInfo({ focusVariables: [], scopes: [], state: session ? "attached" : "idle" });
    return;
  }
  if (!("frameId" in item)) { return; }
  hooks.postStatus("paused", "breakpoint");
  try {
    const info = await inspectDebugFrame(session, item);
    if (isCurrent() && hooks.getSession()?.id === session.id) { hooks.logger?.log("debug.frame", frameFields(info)); hooks.postInfo(info); }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hooks.logger?.log("debug.inspect.error", { error: message });
    hooks.postInfo({ error: message, focusVariables: [], scopes: [], state: "error" });
  }
}

/** Refreshes paused frame info directly from a DAP stopped event. */
async function refreshStoppedThread(session: vscode.DebugSession, body: { reason?: string; threadId?: number } | undefined, hooks: DebugEventHooks, isCurrent: () => boolean): Promise<void> {
  hooks.postStatus("paused", String(body?.reason || "stopped"));
  try {
    const info = await inspectDebugThread(session, body?.threadId, { preferOverlay: hooks.lastControlAction() !== "stepInto" });
    if (isCurrent() && hooks.getSession()?.id === session.id) { hooks.logger?.log("debug.frame", frameFields(info)); hooks.postInfo(info); }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hooks.logger?.log("debug.stopped.inspect.error", { error: message });
    hooks.postInfo({ error: message, focusVariables: [], scopes: [], state: "error" });
  }
}

/** Returns compact diagnostic fields for one inspected debug frame. */
function frameFields(info: DebugFrameInfo): { column: number; line: number; path: string; scopes: number; variables: number } {
  return { column: info.frame?.column ?? 0, line: info.frame?.line ?? 0, path: info.frame?.path ?? "", scopes: info.scopes.length, variables: info.focusVariables.length };
}

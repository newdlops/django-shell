// Debug event wiring for the custom Django shell console.

import * as vscode from "vscode";
import type { DebugControlAction } from "./debugControls";
import { type DebugFrameInfo, type DebugPanelState, inspectDebugFrame, inspectDebugThread } from "./debugInspector";
import type { DiagnosticLogger } from "./diagnostics";

export type DebugStatusState = "attached" | "error" | "idle" | "paused" | "running" | "starting";

interface DebugEventHooks {
  consumeRunOnSessionStart(): boolean;
  getSession(): vscode.DebugSession | undefined;
  interruptExecution(reason: string): Promise<void>;
  lastControlAction(): DebugControlAction | undefined;
  logger?: DiagnosticLogger;
  postInfo(info: DebugFrameInfo): void;
  postStatus(state: DebugStatusState, detail?: string): void;
  refreshBreakpoints(): void;
  runCurrentInput(): Promise<string>;
  setPausedThread(threadId: number | undefined): void;
  setSession(session: vscode.DebugSession | undefined): void;
  shouldRefocusOverlay(): boolean;
  syncBreakpoints(reason: string): Promise<void>;
}

interface DebugThreadEventBody {
  allThreadsContinued?: boolean;
  reason?: string;
  threadId?: number;
}

/** Registers VS Code debug events that keep shell debug state synchronized. */
export function registerCustomConsoleDebugEvents(disposables: vscode.Disposable[], hooks: DebugEventHooks): void {
  let generation = 0;
  let pausedThreadId: number | undefined;
  const clearInfo = (state: DebugPanelState) => hooks.postInfo({ state });
  const inspectStack = (item: vscode.DebugThread | vscode.DebugStackFrame | undefined) => {
    if (shouldIgnoreActiveStackItem(item, pausedThreadId, hooks)) { hooks.logger?.log("debug.active.frame.ignore", { pausedThreadId: pausedThreadId ?? 0, threadId: item && "threadId" in item ? item.threadId : 0 }); return; }
    generation += 1;
    const current = generation;
    if (item && "frameId" in item) { hooks.logger?.log("debug.active.frame", { frameId: item.frameId, threadId: item.threadId }); }
    void refreshPausedFrame(item, hooks, () => current === generation);
  };
  const inspectStopped = (session: vscode.DebugSession, body: DebugThreadEventBody | undefined) => {
    if (session.id !== hooks.getSession()?.id) { return; }
    if (shouldIgnoreOverlayThreadEvent(body?.threadId, pausedThreadId, hooks)) { hooks.logger?.log("debug.dap.stopped.ignore", { pausedThreadId: pausedThreadId ?? 0, reason: body?.reason ?? "", threadId: body?.threadId ?? 0 }); return; }
    generation += 1;
    const current = generation;
    pausedThreadId = body?.threadId;
    hooks.setPausedThread(pausedThreadId);
    hooks.logger?.log("debug.dap.stopped", { reason: body?.reason ?? "", threadId: body?.threadId ?? 0 });
    void logDebugStack(session, body?.threadId, hooks);
    void refreshStoppedThread(session, body, hooks, () => current === generation);
  };
  const handleContinued = (body: DebugThreadEventBody | undefined) => {
    if (shouldIgnoreContinuedThread(body, pausedThreadId, hooks)) { hooks.logger?.log("debug.dap.continued.ignore", { pausedThreadId: pausedThreadId ?? 0, threadId: body?.threadId ?? 0 }); return; }
    pausedThreadId = undefined;
    hooks.setPausedThread(undefined);
    generation += 1;
    hooks.logger?.log("debug.dap.continued", { threadId: body?.threadId ?? 0 });
    hooks.postStatus("running", "continued");
    clearInfo("running");
  };
  disposables.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (!isDjangoShellSession(session)) { return; }
      hooks.logger?.log("debug.session.start", { sessionId: session.id });
      hooks.setSession(session); hooks.postStatus("attached", "active"); clearInfo("attached"); hooks.refreshBreakpoints();
      if (hooks.consumeRunOnSessionStart()) { void startDebuggedInput(hooks); } else { hooks.logger?.log("debug.session.start.skipRun", { sessionId: session.id }); }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (hooks.getSession()?.id !== session.id) { return; }
      hooks.logger?.log("debug.session.terminate", { sessionId: session.id });
      void hooks.interruptExecution("debugSessionTerminate");
      generation += 1; hooks.setSession(undefined); hooks.postStatus("idle", "ended"); clearInfo("idle");
    }),
    vscode.debug.onDidChangeBreakpoints(() => { hooks.refreshBreakpoints(); void hooks.syncBreakpoints("breakpointsChanged"); }),
    vscode.debug.onDidChangeActiveDebugSession((session) => {
      hooks.logger?.log("debug.session.active", { sessionId: session?.id ?? "", shell: session ? isDjangoShellSession(session) : false });
      if (session?.id === hooks.getSession()?.id) { hooks.postStatus("attached", "active"); }
    }),
    vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
      if (event.session.id !== hooks.getSession()?.id) { return; }
      if (event.event === "continued") { handleContinued(event.body as DebugThreadEventBody | undefined); return; }
      if (event.event === "stopped") { inspectStopped(event.session, event.body as DebugThreadEventBody | undefined); }
    }),
    vscode.debug.registerDebugAdapterTrackerFactory("*", {
      /** Creates a tracker for Django Shell debugpy sessions only. */
      createDebugAdapterTracker(session) {
        if (!isDjangoShellSession(session)) { return undefined; }
        return {
          /** Interrupts Python before debugpy disconnect resumes the stopped user thread. */
          onWillReceiveMessage(message) {
            const request = message as { command?: string; type?: string };
            if (request.type === "request" && (request.command === "disconnect" || request.command === "terminate")) { void hooks.interruptExecution(`debugAdapter.${request.command}`); }
          },
          /** Mirrors standard DAP stopped/continued events into the custom console UI. */
          onDidSendMessage(message) {
            const event = message as { body?: { reason?: string; threadId?: number }; event?: string; type?: string };
            if (event.type !== "event") { return; }
            if (event.event === "continued") { handleContinued(event.body); return; }
            if (event.event === "stopped") { inspectStopped(session, event.body); }
          }
        };
      }
    }),
    vscode.debug.onDidChangeActiveStackItem(inspectStack)
  );
}

/** Returns whether an active-stack notification points away from the paused overlay thread. */
function shouldIgnoreActiveStackItem(item: vscode.DebugThread | vscode.DebugStackFrame | undefined, pausedThreadId: number | undefined, hooks: DebugEventHooks): boolean {
  if (!item && hooks.shouldRefocusOverlay() && typeof pausedThreadId === "number") {
    return true;
  }
  const threadId = item && "threadId" in item ? item.threadId : undefined;
  return shouldIgnoreOverlayThreadEvent(threadId, pausedThreadId, hooks);
}

/** Returns whether a continued event belongs to debugpy thread churn outside the overlay pause. */
function shouldIgnoreContinuedThread(body: DebugThreadEventBody | undefined, pausedThreadId: number | undefined, hooks: DebugEventHooks): boolean {
  if (body?.allThreadsContinued || hooks.lastControlAction() === "continue" || hooks.lastControlAction() === "stop" || hooks.lastControlAction() === "restart") {
    return false;
  }
  return shouldIgnoreOverlayThreadEvent(body?.threadId, pausedThreadId, hooks);
}

/** Returns whether one thread event should not replace the current overlay debug frame. */
function shouldIgnoreOverlayThreadEvent(threadId: number | undefined, pausedThreadId: number | undefined, hooks: DebugEventHooks): boolean {
  return hooks.shouldRefocusOverlay() && typeof threadId === "number" && typeof pausedThreadId === "number" && threadId !== pausedThreadId;
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

/** Refreshes paused frame location if VS Code focuses a stack frame. */
async function refreshPausedFrame(item: vscode.DebugThread | vscode.DebugStackFrame | undefined, hooks: DebugEventHooks, isCurrent: () => boolean): Promise<void> {
  const session = hooks.getSession();
  if (!session || !item || item.session.id !== session.id) {
    hooks.postInfo({ state: session ? "attached" : "idle" });
    return;
  }
  if (!("frameId" in item)) { return; }
  hooks.postStatus("paused", "breakpoint");
  try {
    const stepInto = hooks.lastControlAction() === "stepInto";
    const info = await inspectDebugFrame(session, item, { preferOverlay: !stepInto, preferUserSource: stepInto });
    if (isCurrent() && hooks.getSession()?.id === session.id) { hooks.logger?.log("debug.frame", frameFields(info)); hooks.postInfo(info); }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hooks.logger?.log("debug.inspect.error", { error: message });
    hooks.postInfo({ error: message, state: "error" });
  }
}

/** Refreshes paused frame info directly from a DAP stopped event. */
async function refreshStoppedThread(session: vscode.DebugSession, body: { reason?: string; threadId?: number } | undefined, hooks: DebugEventHooks, isCurrent: () => boolean): Promise<void> {
  hooks.postStatus("paused", String(body?.reason || "stopped"));
  try {
    const stepInto = hooks.lastControlAction() === "stepInto";
    const info = await inspectDebugThread(session, body?.threadId, { preferOverlay: !stepInto, preferUserSource: stepInto });
    if (isCurrent() && hooks.getSession()?.id === session.id) { hooks.logger?.log("debug.frame", frameFields(info)); hooks.postInfo(info); }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hooks.logger?.log("debug.stopped.inspect.error", { error: message });
    hooks.postInfo({ error: message, state: "error" });
  }
}

/** Returns compact diagnostic fields for one inspected debug frame. */
function frameFields(info: DebugFrameInfo): { column: number; frames: number; line: number; path: string } {
  return { column: info.frame?.column ?? 0, frames: info.frames?.length ?? 0, line: info.frame?.line ?? 0, path: info.frame?.path ?? "" };
}

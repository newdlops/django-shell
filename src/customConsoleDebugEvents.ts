// Debug event wiring for the custom Django shell console.

import * as vscode from "vscode";
import { type DebugFrameInfo, type DebugPanelState, inspectDebugFrame, inspectDebugThread } from "./debugInspector";
import type { DiagnosticLogger } from "./diagnostics";

export type DebugStatusState = "attached" | "error" | "idle" | "paused" | "running" | "starting";

interface DebugEventHooks {
  getSession(): vscode.DebugSession | undefined;
  logger?: DiagnosticLogger;
  postInfo(info: DebugFrameInfo): void;
  postStatus(state: DebugStatusState, detail?: string): void;
  refreshBreakpoints(): void;
  setSession(session: vscode.DebugSession | undefined): void;
}

/** Registers VS Code debug events that keep the custom console debugger panel current. */
export function registerCustomConsoleDebugEvents(disposables: vscode.Disposable[], hooks: DebugEventHooks): void {
  let generation = 0;
  const clearInfo = (state: DebugPanelState) => hooks.postInfo({ focusVariables: [], scopes: [], state });
  const inspectStack = (item: vscode.DebugThread | vscode.DebugStackFrame | undefined) => {
    generation += 1;
    const current = generation;
    void refreshPausedFrame(item, hooks, () => current === generation);
  };
  const inspectStopped = (session: vscode.DebugSession, body: { reason?: string; threadId?: number } | undefined) => {
    if (session.id !== hooks.getSession()?.id) { return; }
    generation += 1;
    const current = generation;
    void refreshStoppedThread(session, body, hooks, () => current === generation);
  };
  disposables.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (!isDjangoShellSession(session)) { return; }
      hooks.setSession(session); hooks.postStatus("attached", "active"); clearInfo("attached"); hooks.refreshBreakpoints();
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (hooks.getSession()?.id !== session.id) { return; }
      generation += 1; hooks.setSession(undefined); hooks.postStatus("idle", "ended"); clearInfo("idle");
    }),
    vscode.debug.onDidChangeBreakpoints(() => hooks.refreshBreakpoints()),
    vscode.debug.onDidChangeActiveDebugSession((session) => {
      if (session?.id === hooks.getSession()?.id) { hooks.postStatus("attached", "active"); }
    }),
    vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
      if (event.session.id !== hooks.getSession()?.id) { return; }
      if (event.event === "continued") { generation += 1; hooks.postStatus("running", "continued"); clearInfo("running"); return; }
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
            if (event.event === "continued") { generation += 1; hooks.postStatus("running", "continued"); clearInfo("running"); return; }
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
    if (isCurrent() && hooks.getSession()?.id === session.id) { hooks.postInfo(info); }
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
    const info = await inspectDebugThread(session, body?.threadId);
    if (isCurrent() && hooks.getSession()?.id === session.id) { hooks.postInfo(info); }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hooks.logger?.log("debug.stopped.inspect.error", { error: message });
    hooks.postInfo({ error: message, focusVariables: [], scopes: [], state: "error" });
  }
}

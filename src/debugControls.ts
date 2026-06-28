// Debug control command helpers for the Django shell custom console.

import * as vscode from "vscode";
import type { DisposableDebugRequestSession } from "./debugAdapterTypes";

export const DEBUG_CONTROL_ACTIONS = ["continue", "pause", "stepOver", "stepInto", "stepOut", "restart", "stop"] as const;

export type DebugControlAction = typeof DEBUG_CONTROL_ACTIONS[number];

export type DebugControlUiState = "attached" | "idle" | "paused" | "running";

export interface DebugControlResult {
  threadId?: number;
}

const COMMANDS: Record<DebugControlAction, string> = {
  continue: "workbench.action.debug.continue",
  pause: "workbench.action.debug.pause",
  restart: "workbench.action.debug.restart",
  stepInto: "workbench.action.debug.stepInto",
  stepOut: "workbench.action.debug.stepOut",
  stepOver: "workbench.action.debug.stepOver",
  stop: "workbench.action.debug.stop"
};

const STATES: Record<DebugControlAction, DebugControlUiState> = {
  continue: "running",
  pause: "paused",
  restart: "running",
  stepInto: "running",
  stepOut: "running",
  stepOver: "running",
  stop: "idle"
};

/** Returns whether a raw webview value names a supported debugger control action. */
export function isDebugControlAction(value: unknown): value is DebugControlAction {
  return typeof value === "string" && (DEBUG_CONTROL_ACTIONS as readonly string[]).includes(value);
}

/** Returns the VS Code command id that implements one debugger action. */
export function debugControlCommand(action: DebugControlAction): string {
  return COMMANDS[action];
}

/** Returns the optimistic debugger UI state after one action is requested. */
export function debugControlState(action: DebugControlAction): DebugControlUiState {
  return STATES[action];
}

/** Returns compact status detail for one requested debugger action. */
export function debugControlDetail(action: DebugControlAction): string {
  return action.replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`);
}

/** Executes one debugger action against the Django shell debug adapter session. */
export async function runDebugControl(action: DebugControlAction, session?: DisposableDebugRequestSession | vscode.DebugSession, preferredThreadId?: number, interruptExecution?: () => Promise<unknown>): Promise<DebugControlResult> {
  if (action === "stop" && session) {
    await interruptExecution?.();
    if ("disconnect" in session && typeof session.disconnect === "function") { await session.disconnect(); } else { await vscode.debug.stopDebugging(session as vscode.DebugSession); }
    return {};
  }
  if (session && action !== "restart") {
    const threadId = preferredThreadId ?? await firstThreadId(session);
    if (!threadId) {
      throw new Error("Debugger is attached but no debug thread is available yet. Run a Python cell or use Pause first.");
    }
    await session.customRequest(dapRequest(action), { threadId });
    return { threadId };
  }
  await vscode.commands.executeCommand(debugControlCommand(action));
  return {};
}

/** Returns the first known DAP thread id for control requests. */
async function firstThreadId(session: DisposableDebugRequestSession | vscode.DebugSession): Promise<number | undefined> {
  const response = await session.customRequest("threads", {}) as { threads?: Array<{ id: number }> };
  return response.threads?.[0]?.id;
}

/** Maps one UI action to its standard DAP request name. */
function dapRequest(action: DebugControlAction): string {
  if (action === "continue") { return "continue"; }
  if (action === "pause") { return "pause"; }
  if (action === "stepInto") { return "stepIn"; }
  if (action === "stepOut") { return "stepOut"; }
  if (action === "stepOver") { return "next"; }
  return debugControlCommand(action);
}

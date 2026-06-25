// Debug control command helpers for the Django shell custom console.

import * as vscode from "vscode";

export const DEBUG_CONTROL_ACTIONS = ["continue", "pause", "stepOver", "stepInto", "stepOut", "restart", "stop"] as const;

export type DebugControlAction = typeof DEBUG_CONTROL_ACTIONS[number];

export type DebugControlUiState = "attached" | "idle" | "paused" | "running";

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

/** Executes one debugger action against VS Code's active debug session. */
export async function runDebugControl(action: DebugControlAction, session?: vscode.DebugSession): Promise<void> {
  if (action === "stop" && session) {
    await vscode.debug.stopDebugging(session);
    return;
  }
  await vscode.commands.executeCommand(debugControlCommand(action));
}

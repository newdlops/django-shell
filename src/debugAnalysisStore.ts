// Shared debug analysis state for the Django Shell Activity Bar panel.

import * as vscode from "vscode";
import type { DebugFrameInfo, DebugPanelState, DebugVariableInfo } from "./debugInspector";

export type DebugAnalysisState = DebugPanelState | "starting";

export interface DebugAnalysisSnapshot {
  detail: string;
  info: DebugFrameInfo;
  state: DebugAnalysisState;
}

export type DebugVariableResolver = (reference: number) => Promise<DebugVariableInfo[]>;

export interface DebugAnalysisSink {
  setDebugAnalysisInfo(info: DebugFrameInfo): void;
  setDebugAnalysisStatus(state: DebugAnalysisState, detail?: string): void;
  setDebugAnalysisVariableResolver(resolver: DebugVariableResolver | undefined): void;
}

export interface DebugAnalysisSource {
  debugAnalysisSnapshot(): DebugAnalysisSnapshot;
  inspectDebugVariableChildren(reference: number): Promise<DebugVariableInfo[]>;
  readonly onDidChangeDebugAnalysis: vscode.Event<void>;
}

/** Stores debugger analysis state shared between the console runtime and sidebar panel. */
export class DebugAnalysisStore implements DebugAnalysisSink, DebugAnalysisSource, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private detail = "";
  private info: DebugFrameInfo = { state: "idle" };
  private resolver: DebugVariableResolver | undefined;
  private state: DebugAnalysisState = "idle";

  readonly onDidChangeDebugAnalysis = this.changeEmitter.event;

  /** Releases listeners owned by the store. */
  dispose(): void {
    this.changeEmitter.dispose();
  }

  /** Returns the latest debugger analysis snapshot. */
  debugAnalysisSnapshot(): DebugAnalysisSnapshot {
    return { detail: this.detail, info: this.info, state: this.state };
  }

  /** Updates debugger status shown by the sidebar panel. */
  setDebugAnalysisStatus(state: DebugAnalysisState, detail = ""): void {
    this.state = state;
    this.detail = detail;
    if (state !== "starting" && state !== "paused") {
      this.info = { state };
    }
    this.changeEmitter.fire();
  }

  /** Updates paused-frame analysis shown by the sidebar panel. */
  setDebugAnalysisInfo(info: DebugFrameInfo): void {
    this.info = info;
    this.state = info.state;
    this.changeEmitter.fire();
  }

  /** Sets the callback used to lazily expand debugger variables. */
  setDebugAnalysisVariableResolver(resolver: DebugVariableResolver | undefined): void {
    this.resolver = resolver;
    this.changeEmitter.fire();
  }

  /** Expands a debugger variable through the active debug adapter session. */
  inspectDebugVariableChildren(reference: number): Promise<DebugVariableInfo[]> {
    return this.resolver?.(reference) ?? Promise.resolve([]);
  }
}

// Shared debug analysis state for the Django Shell Activity Bar panel.

import * as vscode from "vscode";
import { isOverlayDebugFramePath } from "./debugFrameNavigation";
import type { DebugFrameInfo, DebugPanelState, DebugVariableInfo } from "./debugInspector";

export type DebugAnalysisState = DebugPanelState | "starting";

export interface DebugTraceEntry {
  frame: string;
  kind: "native" | "overlay";
  line: number;
  location: string;
  path?: string;
}

export interface DebugAnalysisSnapshot {
  detail: string;
  info: DebugFrameInfo;
  state: DebugAnalysisState;
  trace: DebugTraceEntry[];
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

const MAX_DEBUG_TRACE_ENTRIES = 8;

/** Stores debugger analysis state shared between the console runtime and sidebar panel. */
export class DebugAnalysisStore implements DebugAnalysisSink, DebugAnalysisSource, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private detail = "";
  private info: DebugFrameInfo = { state: "idle" };
  private resolver: DebugVariableResolver | undefined;
  private state: DebugAnalysisState = "idle";
  private trace: DebugTraceEntry[] = [];

  readonly onDidChangeDebugAnalysis = this.changeEmitter.event;

  /** Releases listeners owned by the store. */
  dispose(): void {
    this.changeEmitter.dispose();
  }

  /** Returns the latest debugger analysis snapshot. */
  debugAnalysisSnapshot(): DebugAnalysisSnapshot {
    return { detail: this.detail, info: this.info, state: this.state, trace: [...this.trace] };
  }

  /** Updates debugger status shown by the sidebar panel. */
  setDebugAnalysisStatus(state: DebugAnalysisState, detail = ""): void {
    this.state = state;
    this.detail = detail;
    if (state === "idle" || state === "starting") {
      this.trace = [];
    }
    if (state !== "starting" && state !== "paused") {
      this.info = { state };
    }
    this.changeEmitter.fire();
  }

  /** Updates paused-frame analysis shown by the sidebar panel. */
  setDebugAnalysisInfo(info: DebugFrameInfo): void {
    this.info = info;
    this.state = info.state;
    this.appendDebugTrace(info);
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

  /** Records one paused frame location for debugger flow traceability. */
  private appendDebugTrace(info: DebugFrameInfo): void {
    const entry = debugTraceEntry(info);
    if (!entry) {
      return;
    }
    const previous = this.trace[this.trace.length - 1];
    if (previous && sameDebugTraceEntry(previous, entry)) {
      this.trace = [...this.trace.slice(0, -1), entry];
      return;
    }
    this.trace = [...this.trace, entry].slice(-MAX_DEBUG_TRACE_ENTRIES);
  }
}

/** Converts paused debug frame information into a compact trace entry. */
function debugTraceEntry(info: DebugFrameInfo): DebugTraceEntry | undefined {
  const frame = info.state === "paused" ? info.frame : undefined;
  if (!frame) {
    return undefined;
  }
  const path = frame.path?.replace(/\\/g, "/");
  const file = debugTraceFile(path);
  return { frame: frame.name || "frame", kind: isOverlayDebugFramePath(path) ? "overlay" : "native", line: frame.line, location: `${file}${frame.line ? `:${frame.line}` : ""}`, path };
}

/** Returns the display file name for one trace source path. */
function debugTraceFile(path: string | undefined): string {
  if (!path) {
    return "unknown";
  }
  return path.split("/").pop() || path;
}

/** Returns whether two trace entries point at the same paused frame. */
function sameDebugTraceEntry(left: DebugTraceEntry, right: DebugTraceEntry): boolean {
  return left.frame === right.frame && left.line === right.line && left.path === right.path;
}

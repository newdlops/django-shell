// Activity Bar tree view for Django Shell debugger frame and variable analysis.

import * as vscode from "vscode";
import type { DebugScopeInfo, DebugStackFrameInfo, DebugVariableInfo } from "./debugInspector";
import type { DebugAnalysisSource, DebugAnalysisSnapshot, DebugTraceEntry } from "./debugAnalysisStore";
import type { DiagnosticLogger } from "./diagnostics";

type DebugAnalysisNode = GroupNode | SourceNode | StackFrameNode | StatusNode | TraceNode | VariableNode;

interface GroupNode {
  children: DebugAnalysisNode[];
  collapsed?: boolean;
  icon: string;
  kind: "group";
  label: string;
}

interface SourceNode {
  kind: "source";
  text: string;
}

interface StackFrameNode {
  frame: DebugStackFrameInfo;
  kind: "frame";
}

interface StatusNode {
  description?: string;
  icon: string;
  kind: "status";
  label: string;
  tooltip?: string;
}

interface TraceNode {
  kind: "trace";
  trace: DebugTraceEntry;
}

interface VariableNode {
  kind: "variable";
  variable: DebugVariableInfo;
}

const VIEW_ID = "djangoShell.debugAnalysis";

/** Provides the left Activity Bar panel for paused Django Shell debug analysis. */
export class DebugAnalysisPanel implements vscode.TreeDataProvider<DebugAnalysisNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<DebugAnalysisNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private visible = false;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  /** Stores the debug analysis source and optional diagnostics logger. */
  constructor(private readonly source: DebugAnalysisSource, private readonly logger?: DiagnosticLogger) {
    this.disposables.push(source.onDidChangeDebugAnalysis(() => this.handleDebugAnalysisChange()));
  }

  /** Registers the Activity Bar tree view. */
  activate(context: vscode.ExtensionContext): void {
    const tree = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this });
    this.disposables.push(
      tree,
      tree.onDidChangeVisibility((event) => {
        this.visible = event.visible;
        if (event.visible) {
          this.changeEmitter.fire(undefined);
        }
      })
    );
    if (tree.visible) {
      this.visible = true;
      this.changeEmitter.fire(undefined);
    }
    context.subscriptions.push(this);
  }

  /** Releases tree view listeners and refresh resources. */
  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changeEmitter.dispose();
  }

  /** Returns a VS Code tree item for one analysis node. */
  getTreeItem(node: DebugAnalysisNode): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(node.label, node.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      return item;
    }
    if (node.kind === "source") {
      const item = new vscode.TreeItem("Current line", vscode.TreeItemCollapsibleState.None);
      item.description = node.text;
      item.iconPath = new vscode.ThemeIcon("code");
      item.tooltip = node.text;
      return item;
    }
    if (node.kind === "frame") {
      return stackFrameTreeItem(node.frame);
    }
    if (node.kind === "trace") {
      return traceTreeItem(node.trace);
    }
    if (node.kind === "variable") {
      return variableTreeItem(node.variable);
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    item.tooltip = node.tooltip;
    return item;
  }

  /** Returns child nodes for the current debug analysis state. */
  async getChildren(node?: DebugAnalysisNode): Promise<DebugAnalysisNode[]> {
    if (node?.kind === "group") {
      return node.children;
    }
    if (node?.kind === "variable") {
      return this.variableChildren(node.variable);
    }
    if (node) {
      return [];
    }
    return rootNodes(this.source.debugAnalysisSnapshot());
  }

  /** Invalidates the tree when debugger analysis changes. */
  private handleDebugAnalysisChange(): void {
    if (this.visible) {
      this.changeEmitter.fire(undefined);
    }
  }

  /** Loads child variables for one expandable DAP variable reference. */
  private async variableChildren(variable: DebugVariableInfo): Promise<DebugAnalysisNode[]> {
    const reference = Number(variable.variablesReference) || 0;
    if (!reference) {
      return [];
    }
    try {
      return (await this.source.inspectDebugVariableChildren(reference)).map(variableNode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.log("debug.analysis.variables.error", { error: message, reference });
      return [{ icon: "warning", kind: "status", label: message }];
    }
  }
}

/** Builds root nodes from the latest debug analysis snapshot. */
function rootNodes(snapshot: DebugAnalysisSnapshot): DebugAnalysisNode[] {
  const info = snapshot.info;
  if (info.state === "paused") {
    return pausedNodes(snapshot);
  }
  if (info.state === "error" || snapshot.state === "error") {
    return [{ icon: "warning", kind: "status", label: info.error || snapshot.detail || "Debug inspection failed" }];
  }
  if (snapshot.state === "starting") {
    return [{ description: snapshot.detail, icon: "debug-start", kind: "status", label: "Debugger attaching" }];
  }
  if (snapshot.state === "attached") {
    return [{ description: snapshot.detail, icon: "debug-alt", kind: "status", label: "Debugger attached" }];
  }
  if (snapshot.state === "running") {
    return [{ description: snapshot.detail, icon: "debug-continue", kind: "status", label: "Debugger running" }];
  }
  if (snapshot.state === "paused") {
    return [{ description: snapshot.detail, icon: "debug-pause", kind: "status", label: "Debugger paused" }];
  }
  return [{ icon: "debug-alt", kind: "status", label: "Start Django Shell debugging to inspect paused frames." }];
}

/** Builds tree sections for a paused debug frame. */
function pausedNodes(snapshot: DebugAnalysisSnapshot): DebugAnalysisNode[] {
  const frame = snapshot.info.frame;
  const nodes: DebugAnalysisNode[] = [];
  if (frame) {
    nodes.push({ children: [stackFrameNode({ line: frame.line, name: frame.name, path: frame.path }), sourceNode(snapshot.info.error || frame.sourceLine || "")].filter(Boolean) as DebugAnalysisNode[], icon: "debug-stackframe", kind: "group", label: "Paused Frame" });
  }
  if (snapshot.trace.length) {
    nodes.push({ children: snapshot.trace.map(traceNode), icon: "history", kind: "group", label: "Trace" });
  }
  if (snapshot.info.frames?.length) {
    nodes.push({ children: snapshot.info.frames.map(stackFrameNode), collapsed: true, icon: "list-tree", kind: "group", label: "Stack" });
  }
  if (snapshot.info.scopes?.length) {
    nodes.push({ children: snapshot.info.scopes.map(scopeNode), icon: "variable-group", kind: "group", label: "Variables" });
  }
  return nodes.length ? nodes : [{ icon: "debug-pause", kind: "status", label: snapshot.detail || "Debugger paused" }];
}

/** Wraps a stack frame as a tree node. */
function stackFrameNode(frame: DebugStackFrameInfo): StackFrameNode {
  return { frame, kind: "frame" };
}

/** Wraps a source line as a tree node when text is present. */
function sourceNode(text: string): SourceNode | undefined {
  return text ? { kind: "source", text } : undefined;
}

/** Converts a debug scope into a tree group. */
function scopeNode(scope: DebugScopeInfo): GroupNode {
  const suffix = typeof scope.total === "number" ? ` (${scope.total})` : "";
  return { children: scope.variables.map(variableNode), icon: "variable-group", kind: "group", label: `${scope.name}${suffix}` };
}

/** Wraps a debugger variable as a tree node. */
function variableNode(variable: DebugVariableInfo): VariableNode {
  return { kind: "variable", variable };
}

/** Wraps a debugger trace entry as a tree node. */
function traceNode(trace: DebugTraceEntry): TraceNode {
  return { kind: "trace", trace };
}

/** Builds a tree item for one debugger trace entry. */
function traceTreeItem(trace: DebugTraceEntry): vscode.TreeItem {
  const item = new vscode.TreeItem(trace.kind === "overlay" ? "Overlay" : "Native", vscode.TreeItemCollapsibleState.None);
  item.description = `${trace.location} · ${trace.frame}`;
  item.iconPath = new vscode.ThemeIcon(trace.kind === "overlay" ? "layout-panel" : "file-code");
  item.tooltip = trace.path ? `${trace.path}:${trace.line}` : trace.location;
  return item;
}

/** Builds a tree item for one stack frame. */
function stackFrameTreeItem(frame: DebugStackFrameInfo): vscode.TreeItem {
  const item = new vscode.TreeItem(frame.name || "frame", vscode.TreeItemCollapsibleState.None);
  item.description = frameLocation(frame);
  item.iconPath = new vscode.ThemeIcon("debug-stackframe");
  item.tooltip = `${frame.name || "frame"} ${item.description || ""}`.trim();
  return item;
}

/** Builds a tree item for one debugger variable. */
function variableTreeItem(variable: DebugVariableInfo): vscode.TreeItem {
  const reference = Number(variable.variablesReference) || 0;
  const item = new vscode.TreeItem(variable.name || "(unnamed)", reference ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  item.description = variable.value;
  item.iconPath = new vscode.ThemeIcon(reference ? "symbol-field" : "symbol-variable");
  item.tooltip = variable.type ? `${variable.name}: ${variable.value} (${variable.type})` : `${variable.name}: ${variable.value}`;
  return item;
}

/** Formats one stack frame location for compact display. */
function frameLocation(frame: DebugStackFrameInfo): string {
  const path = frame.path || "";
  const file = path.split(/[\\/]/).pop() || path || "unknown";
  return `${file}${frame.line ? `:${frame.line}` : ""}`;
}

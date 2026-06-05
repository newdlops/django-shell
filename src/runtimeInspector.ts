// Runtime tree view for observing Django shell variables and loaded modules.

import * as path from "path";
import * as vscode from "vscode";
import type { BackendRuntimeChildren, BackendRuntimeInspection, BackendRuntimeModule, BackendRuntimePathSegment, BackendRuntimeVariable } from "./backendClient";
import { DiagnosticLogger } from "./diagnostics";

type RuntimeNode = GroupNode | ModuleNode | StatusNode | VariableNode;

interface GroupNode {
  children: RuntimeNode[];
  collapsed?: boolean;
  icon: string;
  kind: "group";
  label: string;
}

interface ModuleNode {
  kind: "module";
  module: BackendRuntimeModule;
}

interface StatusNode {
  description?: string;
  icon: string;
  kind: "status";
  label: string;
  tooltip?: string;
}

interface VariableNode {
  kind: "variable";
  variable: BackendRuntimeVariable;
}

interface RuntimeInspectionSource {
  inspectActiveRuntime(): Promise<BackendRuntimeInspection>;
  inspectRuntimeChildren(path: BackendRuntimePathSegment[], kind?: string): Promise<BackendRuntimeChildren>;
  readonly onDidChangeRuntime: vscode.Event<void>;
}

const VIEW_ID = "djangoShell.runtimeInspector";

/** Provides a debug-like tree view over the active Django shell runtime. */
export class RuntimeInspector implements vscode.TreeDataProvider<RuntimeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<RuntimeNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private inspection: BackendRuntimeInspection | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private runtimeVersion = 0;
  private visible = false;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  /** Stores the runtime source used as the inspection data provider. */
  constructor(private readonly source: RuntimeInspectionSource, private readonly logger?: DiagnosticLogger) {
    this.disposables.push(source.onDidChangeRuntime(() => this.handleRuntimeChange()));
  }

  /** Registers the VS Code tree view, refresh action, and Activity Bar entrypoint. */
  activate(context: vscode.ExtensionContext, onVisible?: () => void | Promise<void>): void {
    const tree = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this });
    this.disposables.push(
      tree,
      tree.onDidChangeVisibility((event) => {
        this.visible = event.visible;
        if (event.visible) {
          void onVisible?.();
          this.scheduleRefresh(0);
          return;
        }
        this.clearScheduledRefresh();
      }),
      vscode.commands.registerCommand("djangoShell.refreshInspector", () => this.refresh())
    );
    if (tree.visible) {
      this.visible = true;
      void onVisible?.();
      this.scheduleRefresh(0);
    }
    context.subscriptions.push(this);
  }

  /** Releases tree view listeners and cached inspection resources. */
  dispose(): void {
    this.clearScheduledRefresh();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changeEmitter.dispose();
  }

  /** Reloads runtime data and refreshes the tree view. */
  async refresh(): Promise<void> {
    this.clearScheduledRefresh();
    if (!this.refreshInFlight) {
      const version = this.runtimeVersion;
      this.refreshInFlight = this.loadInspection(version).finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    await this.refreshInFlight;
  }

  /** Loads runtime data once while preserving newer invalidations. */
  private async loadInspection(version: number): Promise<void> {
    const started = Date.now();
    try {
      const inspection = await this.source.inspectActiveRuntime();
      if (version !== this.runtimeVersion) {
        this.logger?.log("runtime.inspector.refresh.stale", { ms: Date.now() - started });
        if (this.visible) {
          this.scheduleRefresh(0);
        }
        return;
      }
      this.inspection = inspection;
    } catch (error) {
      if (version !== this.runtimeVersion) {
        this.logger?.log("runtime.inspector.refresh.stale", { error: runtimeErrorMessage(error), ms: Date.now() - started });
        if (this.visible) {
          this.scheduleRefresh(0);
        }
        return;
      }
      this.inspection = { error: runtimeErrorMessage(error), modules: [], ok: false, variables: [] };
    }
    this.logger?.log("runtime.inspector.refresh", {
      loadedModules: this.inspection.loadedModuleCount,
      modules: this.inspection.modules.length,
      ms: Date.now() - started,
      ok: this.inspection.ok,
      variables: this.inspection.variables.length
    });
    this.changeEmitter.fire(undefined);
  }

  /** Invalidates hidden tree data without inspecting until the view is visible. */
  private handleRuntimeChange(): void {
    this.runtimeVersion += 1;
    this.inspection = undefined;
    if (this.visible) {
      this.scheduleRefresh(150);
    }
    this.changeEmitter.fire(undefined);
  }

  /** Schedules a visible inspector refresh without stacking repeated timers. */
  private scheduleRefresh(delayMs: number): void {
    if (!this.visible) {
      return;
    }
    this.clearScheduledRefresh();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delayMs);
  }

  /** Clears a pending delayed refresh. */
  private clearScheduledRefresh(): void {
    if (!this.refreshTimer) {
      return;
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /** Returns a VS Code tree item for one runtime node. */
  getTreeItem(node: RuntimeNode): vscode.TreeItem {
    if (node.kind === "group") {
      const state = node.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
      const item = new vscode.TreeItem(node.label, state);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      return item;
    }
    if (node.kind === "status") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.description;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.tooltip = node.tooltip;
      return item;
    }
    if (node.kind === "module") {
      return moduleTreeItem(node.module);
    }
    return variableTreeItem(node.variable);
  }

  /** Returns child nodes for the root or group nodes. */
  async getChildren(node?: RuntimeNode): Promise<RuntimeNode[]> {
    if (node?.kind === "group") {
      return node.children;
    }
    if (node?.kind === "variable") {
      return this.variableChildren(node.variable);
    }
    if (node) {
      return [];
    }
    const inspection = await this.currentInspection();
    if (!inspection.ok) {
      return [inspectionStatusNode(inspection)];
    }
    return inspectionGroups(inspection);
  }

  /** Returns cached runtime inspection data or loads it on first render. */
  private async currentInspection(): Promise<BackendRuntimeInspection> {
    if (!this.inspection) {
      if (this.visible && !this.refreshTimer && !this.refreshInFlight) {
        this.scheduleRefresh(0);
      }
      return { error: "Loading runtime data...", modules: [], ok: false, variables: [] };
    }
    return this.inspection;
  }

  /** Loads child nodes for an expandable runtime variable. */
  private async variableChildren(variable: BackendRuntimeVariable): Promise<RuntimeNode[]> {
    if (!variable.path || !variable.hasChildren) {
      return [];
    }
    const result = await this.source.inspectRuntimeChildren(variable.path, variable.kind);
    this.logger?.log("runtime.inspector.children", {
      children: result.children.length,
      ok: result.ok,
      variable: variable.name
    });
    if (!result.ok) {
      return [childrenStatusNode(result)];
    }
    return result.children.map(variableNode);
  }
}

/** Builds a compact root status node for unavailable runtime inspection. */
function inspectionStatusNode(inspection: BackendRuntimeInspection): StatusNode {
  const fallback = "No Django shell runtime attached.";
  if (isRemoteInspectionDisabled(inspection.error)) {
    return {
      description: "terminal transport",
      icon: "info",
      kind: "status",
      label: "Runtime variables unavailable",
      tooltip: inspection.error
    };
  }
  return { icon: "warning", kind: "status", label: inspection.error ?? fallback };
}

/** Builds a compact child status node for unavailable nested inspection. */
function childrenStatusNode(result: BackendRuntimeChildren): StatusNode {
  const fallback = "Could not inspect children.";
  if (isRemoteInspectionDisabled(result.error)) {
    return {
      description: "terminal transport",
      icon: "info",
      kind: "status",
      label: "Children unavailable",
      tooltip: result.error
    };
  }
  return { icon: "warning", kind: "status", label: result.error ?? fallback };
}

/** Returns whether the backend is in the expected remote terminal fallback mode. */
function isRemoteInspectionDisabled(error: string | undefined): boolean {
  return Boolean(error?.startsWith("Remote runtime inspection is disabled"));
}

/** Builds top-level tree groups for runtime variables and modules. */
function inspectionGroups(inspection: BackendRuntimeInspection): RuntimeNode[] {
  const totalModules = inspection.loadedModuleCount ?? inspection.modules.length;
  const user = variablesByOrigin(inspection.variables, "user");
  const last = variablesByOrigin(inspection.variables, "last");
  const initial = variablesByOrigin(inspection.variables, "initial");
  const internal = inspection.variables.filter((variable) => ["bootstrap", "private"].includes(variable.origin ?? ""));
  return compactGroups([
    groupNode(`User Session (${user.length})`, "account", variableKindGroups(user)),
    groupNode(`Last Result (${last.length})`, "debug-console", last.map((variable) => ({ kind: "variable", variable }))),
    groupNode(`Initial Shell Namespace (${initial.length})`, "symbol-namespace", variableKindGroups(initial), true),
    groupNode(`Bootstrap / Private (${internal.length})`, "shield", variableKindGroups(internal), true),
    groupNode(`Loaded Modules (${inspection.modules.length}/${totalModules})`, "package", moduleHierarchy(inspection.modules), true)
  ]);
}

/** Builds a display group node. */
function groupNode(label: string, icon: string, children: RuntimeNode[], collapsed = false): GroupNode {
  return { children, collapsed, icon, kind: "group", label };
}

/** Removes empty groups from the tree. */
function compactGroups(groups: GroupNode[]): RuntimeNode[] {
  return groups.filter((group) => group.children.length > 0);
}

/** Returns variables matching one backend-provided origin. */
function variablesByOrigin(variables: BackendRuntimeVariable[], origin: string): BackendRuntimeVariable[] {
  return variables.filter((variable) => (variable.origin ?? inferredOrigin(variable)) === origin);
}

/** Builds kind-based subgroups for variables under one origin group. */
function variableKindGroups(variables: BackendRuntimeVariable[]): RuntimeNode[] {
  return compactGroups([
    groupNode("Values", "symbol-value", variables.filter((variable) => ["primitive", "collection", "object"].includes(variableKind(variable))).map(variableNode)),
    groupNode("Imports / Modules", "symbol-module", variables.filter((variable) => variableKind(variable) === "module").map(variableNode)),
    groupNode("Classes", "symbol-class", variables.filter((variable) => variableKind(variable) === "class").map(variableNode)),
    groupNode("Callables", "symbol-method", variables.filter((variable) => variableKind(variable) === "callable").map(variableNode))
  ]);
}

/** Converts one variable summary into a tree node. */
function variableNode(variable: BackendRuntimeVariable): VariableNode {
  return { kind: "variable", variable };
}

/** Returns the backend kind or an inference for older inspection payloads. */
function variableKind(variable: BackendRuntimeVariable): string {
  if (variable.kind) {
    return variable.kind;
  }
  if (variable.preview.startsWith("module ")) {
    return "module";
  }
  if (variable.preview.startsWith("class ")) {
    return "class";
  }
  if (variable.preview.startsWith("callable ")) {
    return "callable";
  }
  return "object";
}

/** Returns a conservative origin for older inspection payloads. */
function inferredOrigin(variable: BackendRuntimeVariable): string {
  if (variable.name.startsWith("_djs_")) {
    return "bootstrap";
  }
  if (variable.name === "_") {
    return "last";
  }
  if (variable.name.startsWith("_")) {
    return "private";
  }
  return "initial";
}

/** Builds package-like hierarchy for loaded Python modules. */
function moduleHierarchy(modules: BackendRuntimeModule[]): RuntimeNode[] {
  const roots = new Map<string, GroupNode>();
  for (const module of modules) {
    const parts = module.name.split(".");
    let group = ensureGroup(roots, parts[0] || "(root)");
    for (const part of parts.slice(1, -1)) {
      group = ensureChildGroup(group.children, part);
    }
    group.children.push({ kind: "module", module });
  }
  return [...roots.values()].sort((left, right) => left.label.localeCompare(right.label));
}

/** Finds or creates a root module group. */
function ensureGroup(groups: Map<string, GroupNode>, label: string): GroupNode {
  const existing = groups.get(label);
  if (existing) {
    return existing;
  }
  const created = groupNode(label, "package", [], true);
  groups.set(label, created);
  return created;
}

/** Finds or creates a child module group. */
function ensureChildGroup(children: RuntimeNode[], label: string): GroupNode {
  const existing = children.find((child): child is GroupNode => child.kind === "group" && child.label === label);
  if (existing) {
    return existing;
  }
  const created = groupNode(label, "package", [], true);
  children.push(created);
  return created;
}

/** Builds a tree item for one runtime variable. */
function variableTreeItem(variable: BackendRuntimeVariable): vscode.TreeItem {
  const state = variable.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
  const item = new vscode.TreeItem(variable.name, state);
  item.description = shorten(variable.preview, 80);
  item.iconPath = new vscode.ThemeIcon(variableIcon(variableKind(variable)));
  item.tooltip = `${variable.name}: ${variable.type}\n${variable.preview}`;
  return item;
}

/** Returns the icon name for a runtime variable kind. */
function variableIcon(kind: string): string {
  const icons: Record<string, string> = {
    callable: "symbol-method",
    class: "symbol-class",
    collection: "list-tree",
    module: "symbol-module",
    primitive: "symbol-value"
  };
  return icons[kind] ?? "symbol-variable";
}

/** Builds a tree item for one loaded Python module. */
function moduleTreeItem(module: BackendRuntimeModule): vscode.TreeItem {
  const item = new vscode.TreeItem(module.name, vscode.TreeItemCollapsibleState.None);
  item.description = module.file ? path.basename(module.file) : module.package;
  item.iconPath = new vscode.ThemeIcon("symbol-module");
  item.tooltip = [module.name, module.file, module.package].filter(Boolean).join("\n");
  return item;
}

/** Shortens long labels without evaluating runtime values. */
function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

/** Returns a compact display message for runtime inspection failures. */
function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

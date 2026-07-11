// Cross-extension hover anchor and renderer refire handshake for Django shell overlays.

import * as vscode from "vscode";

/** Identifies a zero-based hover anchor in one VS Code document. */
export interface OverlayHoverAnchor {
  character: number;
  line: number;
  uri: vscode.Uri;
}

/** Reports a normalized visible overlay anchor to a cooperating extension. */
export type OverlayHoverAnchorResult = { handled: false } | ({ handled: true } & OverlayHoverAnchor);

/** Reports whether the matching overlay Monaco editor accepted a hover refire. */
export interface OverlayHoverRefireResult {
  handled: boolean;
}

/** Supplies one live overlay endpoint to the shared command handshake. */
export interface OverlayHoverHandshakeEndpoint {
  analysisUri: vscode.Uri;
  editorUri: vscode.Uri;
  evaluate: (expression: string) => Promise<string>;
  lineOffset: () => number;
  ownerToken: string;
}

/** Stores registered overlay endpoints for one extension activation context. */
interface OverlayHoverHandshakeHub {
  endpoints: Set<OverlayHoverHandshakeEndpoint>;
}

const hubs = new WeakMap<vscode.ExtensionContext, OverlayHoverHandshakeHub>();
const REFIRE_REPORT = "overlay-hover-refired";

/** Registers one live overlay with the shared IntelliSense hover commands. */
export function registerOverlayHoverHandshake(context: vscode.ExtensionContext, endpoint: OverlayHoverHandshakeEndpoint): vscode.Disposable {
  let hub = hubs.get(context);
  if (!hub) {
    hub = { endpoints: new Set() };
    hubs.set(context, hub);
    context.subscriptions.push(registerHandshakeCommands(hub));
  }
  hub.endpoints.add(endpoint);
  return new vscode.Disposable(() => hub?.endpoints.delete(endpoint));
}

/** Registers the two public commands used by cooperating hover extensions. */
function registerHandshakeCommands(hub: OverlayHoverHandshakeHub): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand("djangoShell.resolveOverlayHoverAnchor", (anchor: unknown) => resolveOverlayHoverAnchor(hub, anchor)),
    vscode.commands.registerCommand("djangoShell.refireOverlayHover", (anchor: unknown) => refireOverlayHover(hub, anchor))
  );
}

/** Resolves an analysis or editor anchor to the matching visible overlay model. */
function resolveOverlayHoverAnchor(hub: OverlayHoverHandshakeHub, anchor: unknown): OverlayHoverAnchorResult {
  const parsed = parseOverlayHoverAnchor(anchor);
  if (!parsed) {
    return { handled: false };
  }
  for (const endpoint of [...hub.endpoints].reverse()) {
    const normalized = normalizeOverlayHoverAnchor(parsed, endpoint);
    if (normalized.handled) {
      return normalized;
    }
  }
  return { handled: false };
}

/** Refires hover inside the matching renderer-owned Monaco editor. */
async function refireOverlayHover(hub: OverlayHoverHandshakeHub, anchor: unknown): Promise<OverlayHoverRefireResult> {
  const parsed = parseOverlayHoverAnchor(anchor);
  if (!parsed) {
    return { handled: false };
  }
  for (const endpoint of [...hub.endpoints].reverse()) {
    const normalized = normalizeOverlayHoverAnchor(parsed, endpoint);
    if (!normalized.handled) {
      continue;
    }
    try {
      const report = await endpoint.evaluate(overlayHoverRefireExpression(endpoint.ownerToken, normalized));
      if (report === REFIRE_REPORT) {
        return { handled: true };
      }
    } catch {}
  }
  return { handled: false };
}

/** Maps one generated analysis/editor URI and position onto the visible overlay URI. */
export function normalizeOverlayHoverAnchor(anchor: OverlayHoverAnchor, endpoint: Pick<OverlayHoverHandshakeEndpoint, "analysisUri" | "editorUri" | "lineOffset">): OverlayHoverAnchorResult {
  const editorKey = endpoint.editorUri.toString();
  const anchorKey = anchor.uri.toString();
  const offset = anchorKey === endpoint.analysisUri.toString() ? normalizedLineOffset(endpoint.lineOffset()) : 0;
  if (anchorKey !== editorKey && anchorKey !== endpoint.analysisUri.toString()) {
    return { handled: false };
  }
  const line = anchor.line - offset;
  return line >= 0 ? { character: anchor.character, handled: true, line, uri: endpoint.editorUri } : { handled: false };
}

/** Builds renderer JavaScript that hides and reopens hover on the existing overlay editor. */
export function overlayHoverRefireExpression(ownerToken: string, anchor: OverlayHoverAnchor): string {
  const position = { column: anchor.character + 1, lineNumber: anchor.line + 1 };
  const uri = anchor.uri.toString();
  return `(async function(){const root=document.getElementById("django-shell-overlay");if(!root||root.__dsoOwnerToken!==${JSON.stringify(ownerToken)}){return "owner-mismatch";}const style=root.style||{};if(root.__dsoExplicitlyParked||root.__dsoGeometryParked||root.__dsoHasActiveConsoleGroup===false||style.display==="none"||style.visibility==="hidden"){return "overlay-hidden";}const editor=root.__djangoShellEditor;const model=editor&&editor.getModel&&editor.getModel();if(!editor||!editor.setPosition||!editor.trigger){return "no-overlay-editor";}if(!model||!model.uri||String(model.uri.toString&&model.uri.toString()||model.uri)!==${JSON.stringify(uri)}){return "overlay-model-mismatch";}try{editor.trigger("django-shell-hover-handshake","editor.action.hideHover",{});await new Promise(function(resolve){setTimeout(resolve,60);});if(document.getElementById("django-shell-overlay")!==root||root.__dsoOwnerToken!==${JSON.stringify(ownerToken)}){return "stale-overlay";}editor.setPosition(${JSON.stringify(position)});editor.focus&&editor.focus();editor.trigger("django-shell-hover-handshake","editor.action.showHover",{});return ${JSON.stringify(REFIRE_REPORT)};}catch(error){return "overlay-hover-error:"+String(error&&error.message||error);}})()`;
}

/** Parses and validates a command argument as a zero-based hover anchor. */
function parseOverlayHoverAnchor(value: unknown): OverlayHoverAnchor | undefined {
  const candidate = value as Partial<OverlayHoverAnchor> | undefined;
  const uri = candidate?.uri;
  if (!isUri(uri) || !isPositionComponent(candidate?.line) || !isPositionComponent(candidate?.character)) {
    return undefined;
  }
  return { character: candidate.character, line: candidate.line, uri };
}

/** Returns whether a command argument exposes the stable VS Code URI shape. */
function isUri(value: unknown): value is vscode.Uri {
  const candidate = value as { scheme?: unknown; toString?: unknown } | undefined;
  return !!candidate && typeof candidate.scheme === "string" && typeof candidate.toString === "function";
}

/** Returns whether a command position component is a non-negative integer. */
function isPositionComponent(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Returns a safe non-negative analysis-to-editor line delta. */
function normalizedLineOffset(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Parses one hover markdown file link into a target file and one-based position. */
export function parseHoverLinkTarget(href: string): { column: number; line: number; uri: vscode.Uri } | undefined {
  try {
    const uri = vscode.Uri.parse(href, true);
    if (uri.scheme !== "file") {
      return undefined;
    }
    const match = /^L?(\d+)(?:[,:](\d+))?/i.exec(decodeURIComponent(uri.fragment || ""));
    return { column: match?.[2] ? Number(match[2]) : 1, line: match?.[1] ? Number(match[1]) : 1, uri: uri.with({ fragment: "" }) };
  } catch {
    return undefined;
  }
}

/** Returns whether two filesystem paths are equal after platform-neutral normalization. */
export function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase();
}

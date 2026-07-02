// Debug stack-frame source selection helpers for Django shell debugging.

import { fileURLToPath } from "node:url";

export interface DebugSourceFrame {
  line?: number;
  source?: {
    name?: string;
    path?: string;
  };
}

export interface DebugSourceFrameSelectionOptions {
  preferOverlay?: boolean;
  preferUserSource?: boolean;
  workspaceRoots?: string[];
}

const OVERLAY_SOURCE_SUFFIX = "/.django-shell/console-cell.py";
const PACKAGE_PATH = /(?:^|\/)(?:site-packages|dist-packages)(?:\/|$)/;
const STDLIB_PATH = /(?:^|\/)(?:lib|Lib)\/python\d+(?:\.\d+)?(?:\/|$)/;

/** Chooses the debugger frame that best matches the requested source preference. */
export function choosePreferredDebugSourceFrame<T extends DebugSourceFrame>(frames: T[], options: DebugSourceFrameSelectionOptions = {}): T | undefined {
  const current = frames[0];
  if (!current) { return undefined; }
  if (options.preferOverlay) {
    if (isOverlayDebugSourceFrame(current)) { return current; }
    if (!isUserDebugSourceFrame(current)) {
      return frames.find(isOverlayDebugSourceFrame)
        ?? frames.find((frame) => isWorkspaceDebugSourceFrame(frame, options.workspaceRoots ?? []))
        ?? frames.find(isUserDebugSourceFrame)
        ?? current;
    }
    return current;
  }
  if (options.preferUserSource) {
    return frames.find((frame) => isWorkspaceDebugSourceFrame(frame, options.workspaceRoots ?? []))
      ?? frames.find(isUserDebugSourceFrame)
      ?? current;
  }
  return current;
}

/** Returns whether a frame points at the generated overlay source file. */
export function isOverlayDebugSourceFrame(frame: DebugSourceFrame): boolean {
  return isOverlayDebugSourcePath(sourcePathForDebugSourceFrame(frame));
}

/** Returns whether a path points at the generated overlay source file. */
export function isOverlayDebugSourcePath(pathOrUri: string | undefined): boolean {
  const normalized = normalizeDebugSourcePath(pathOrUri).replace(/\\/g, "/");
  return !!normalized && (normalized === "console-cell.py" || normalized.endsWith(OVERLAY_SOURCE_SUFFIX));
}

/** Returns a normalized filesystem path or source name for a debug frame. */
export function sourcePathForDebugSourceFrame(frame: DebugSourceFrame): string {
  return normalizeDebugSourcePath(frame.source?.path ?? frame.source?.name ?? "");
}

/** Converts file URIs to filesystem paths while preserving ordinary source names. */
export function normalizeDebugSourcePath(value: string | undefined): string {
  if (!value) { return ""; }
  if (/^file:\/\//i.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** Returns whether a frame belongs to a user source file outside generated overlays and libraries. */
export function isUserDebugSourceFrame(frame: DebugSourceFrame): boolean {
  const path = sourcePathForDebugSourceFrame(frame);
  return isConcreteDebugSourceFrame(frame, path) && isUserDebugSourcePath(path);
}

/** Returns whether a path points at user source outside generated overlays and libraries. */
export function isUserDebugSourcePath(pathOrUri: string | undefined): boolean {
  const path = normalizeDebugSourcePath(pathOrUri);
  return !!path && !path.startsWith("<") && !isOverlayDebugSourcePath(path) && !isLibraryDebugSourcePath(path);
}

/** Returns whether a frame belongs to one of the active workspace roots. */
function isWorkspaceDebugSourceFrame(frame: DebugSourceFrame, workspaceRoots: string[]): boolean {
  const path = sourcePathForDebugSourceFrame(frame);
  return isConcreteDebugSourceFrame(frame, path) && isWorkspaceDebugSourcePath(path, workspaceRoots);
}

/** Returns whether a path points at user source inside one active workspace root. */
export function isWorkspaceDebugSourcePath(pathOrUri: string | undefined, workspaceRoots: string[]): boolean {
  const path = normalizeDebugSourcePath(pathOrUri);
  return isUserDebugSourcePath(path) && workspaceRoots.some((root) => isPathInsideRoot(path, root));
}

/** Returns whether a frame has a real source location. */
function isConcreteDebugSourceFrame(frame: DebugSourceFrame, path = sourcePathForDebugSourceFrame(frame)): boolean {
  return !!path && !path.startsWith("<") && Math.max(0, Number(frame.line) || 0) > 0;
}

/** Returns whether a path is inside a package manager or Python runtime directory. */
function isLibraryDebugSourcePath(path: string): boolean {
  const normalized = comparablePath(path);
  return PACKAGE_PATH.test(normalized) || STDLIB_PATH.test(normalized);
}

/** Returns whether a source path is equal to or nested inside one workspace root. */
function isPathInsideRoot(path: string, root: string): boolean {
  const source = comparablePath(path);
  const base = comparablePath(root);
  return !!source && !!base && (source === base || source.startsWith(`${base}/`));
}

/** Normalizes a path for case-insensitive prefix comparisons. */
function comparablePath(path: string): string {
  return normalizeDebugSourcePath(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

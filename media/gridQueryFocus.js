// Focus, caret, and query-workspace scroll preservation helpers.

/** Builds a stable attribute selector for one query control key. */
function controlSelector(key) {
  const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(String(key || "")) : String(key || "").replace(/[^A-Za-z0-9_-]/g, "\\$&");
  return `[data-query-control-key="${escaped}"]`;
}

/** Captures a query control's caret position only when it is currently focused. */
export function captureQueryFocus(root = document) {
  const active = root.activeElement || document.activeElement;
  if (!active?.closest?.("[data-query-builder-root]")) { return undefined; }
  const key = active.dataset?.queryControlKey;
  if (!key) { return undefined; }
  return {
    direction: typeof active.selectionDirection === "string" ? active.selectionDirection : undefined,
    end: Number.isInteger(active.selectionEnd) ? active.selectionEnd : undefined,
    key,
    start: Number.isInteger(active.selectionStart) ? active.selectionStart : undefined
  };
}

/** Restores focus and text selection without changing the user's scroll position. */
export function restoreQueryFocus(root, target, { reveal = false } = {}) {
  const key = target?.key || target?.controlKey;
  if (!key) { return false; }
  const control = root?.querySelector?.(controlSelector(key));
  if (!control?.focus) { return false; }
  if (reveal) { control.scrollIntoView?.({ block: "nearest" }); }
  control.focus({ preventScroll: !reveal });
  if (Number.isInteger(target.start) && Number.isInteger(target.end) && typeof control.setSelectionRange === "function") {
    control.setSelectionRange(target.start, target.end, target.direction);
  }
  return true;
}

/** Creates a one-shot explicit focus intent that wins over captured focus. */
export function createQueryFocusIntent() {
  let pending;
  return {
    /** Returns and clears the current explicit focus target. */
    consume() { const value = pending; pending = undefined; return value; },
    /** Stores one structural or issue-navigation focus target. */
    set(intent) { pending = intent && intent.controlKey ? { ...intent } : undefined; }
  };
}

/** Exposes pure selector behavior for focused tests. */
export const __test = { controlSelector };

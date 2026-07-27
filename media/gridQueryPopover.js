// Fixed-layer popover positioning for Query Builder menus and comboboxes.

/** Returns a viewport-clamped popover position above or below its anchor. */
function popoverPosition(anchorRect, contentRect, viewport = {}) {
  const margin = 8;
  const width = Math.min(contentRect.width || 0, Math.max(0, (viewport.width || 0) - (margin * 2)));
  const below = (viewport.height || 0) - anchorRect.bottom;
  const above = anchorRect.top;
  const placeAbove = below < contentRect.height && above > below;
  return {
    left: Math.max(margin, Math.min(anchorRect.left, (viewport.width || 0) - width - margin)),
    maxHeight: Math.max(80, (placeAbove ? above : below) - margin),
    top: placeAbove ? Math.max(margin, anchorRect.top - Math.min(contentRect.height, above - margin)) : Math.min((viewport.height || 0) - margin, anchorRect.bottom),
    width
  };
}

/** Creates a single portal popover with rAF-batched scroll and resize repositioning. */
export function createQueryPopover({ anchor, layer, onClose, root = document } = {}) {
  const view = root.defaultView || window;
  const node = root.createElement("div");
  node.className = "query-popover";
  node.hidden = true;
  layer.appendChild(node);
  let frame;
  let opened = false;

  /** Positions the fixed popover inside the current viewport without clipping its anchor. */
  function reposition() {
    frame = undefined;
    if (!opened) { return; }
    const anchorRect = anchor.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const position = popoverPosition(anchorRect, rect, { height: view.innerHeight, width: view.innerWidth });
    node.style.left = `${position.left}px`;
    node.style.maxHeight = `${position.maxHeight}px`;
    node.style.top = `${position.top}px`;
    node.style.width = `${position.width}px`;
  }

  /** Requests at most one position update for a burst of layout events. */
  function schedule() {
    if (!opened || frame !== undefined) { return; }
    frame = view.requestAnimationFrame(reposition);
  }

  /** Closes the current content and reports a semantic reason to its owner. */
  function close(reason = "programmatic") {
    if (!opened) { return; }
    opened = false;
    node.hidden = true;
    node.replaceChildren();
    onClose?.(reason);
  }

  /** Opens safe caller-provided DOM content in the dedicated portal layer. */
  function open(content) {
    node.replaceChildren(content);
    opened = true;
    node.hidden = false;
    schedule();
  }

  view.addEventListener("resize", schedule);
  root.addEventListener("scroll", schedule, true);
  return {
    /** Closes the portal and removes all observers. */
    destroy() { if (frame !== undefined) { view.cancelAnimationFrame(frame); } view.removeEventListener("resize", schedule); root.removeEventListener("scroll", schedule, true); close("destroy"); node.remove(); },
    close,
    node,
    open,
    reposition: schedule
  };
}

/** Exposes deterministic geometry for tests without a DOM viewport. */
export const __test = { popoverPosition };

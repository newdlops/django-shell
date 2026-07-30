// Accessible geometry and interaction controller for the Query Builder drawer.

export const QUERY_DRAWER_MINIMUM_HEIGHT = 220;
export const QUERY_DRAWER_PREFERRED_HEIGHT = 360;
export const QUERY_GRID_MINIMUM_HEIGHT = 144;

/** Clamps a requested drawer height to the supplied inclusive range. */
function clampHeight(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.round(Number(value) || minimum)));
}

/** Calculates height bounds from already measured layout inputs. */
function calculateDrawerBounds({ containerHeight, fixedHeight, gridHidden } = {}) {
  const available = Math.floor((Number.isFinite(containerHeight) && containerHeight > 0 ? containerHeight : 0) - (Number.isFinite(fixedHeight) && fixedHeight > 0 ? fixedHeight : 0) - (gridHidden ? 0 : QUERY_GRID_MINIMUM_HEIGHT));
  return { minimumHeight: QUERY_DRAWER_MINIMUM_HEIGHT, maximumHeight: Math.max(QUERY_DRAWER_MINIMUM_HEIGHT, available) };
}

/** Measures direct layout siblings and returns the current drawer bounds. */
function measureDrawerBounds({ container, drawer, grid, root }) {
  const measuredHeight = container?.getBoundingClientRect?.().height;
  const containerHeight = Number.isFinite(measuredHeight) && measuredHeight > 0 ? measuredHeight : root?.defaultView?.innerHeight || 0;
  const fixedHeight = [...(container?.children || [])]
    .filter((child) => child !== drawer && child !== grid && !child.hidden)
    .reduce((total, child) => {
      const height = child.getBoundingClientRect?.().height;
      return total + (Number.isFinite(height) && height > 0 ? height : 0);
    }, 0);
  return calculateDrawerBounds({ containerHeight, fixedHeight, gridHidden: Boolean(grid?.hidden) });
}

/** Creates the Query Builder's measurable, keyboard-accessible drawer resizer. */
export function createQueryDrawerResize({ container, drawer, grid, handle, onHeight, root = document } = {}) {
  let dragging = false;
  let pointerId;
  let startHeight = 0;
  let startY = 0;
  let appliedHeight = QUERY_DRAWER_MINIMUM_HEIGHT;
  let emitted = "";

  /** Applies a height, synchronizes separator semantics, and emits state changes. */
  function setHeight(value, draggingUpdate = false, forceEmit = false) {
    const bounds = measureDrawerBounds({ container, drawer, grid, root });
    appliedHeight = clampHeight(value, bounds.minimumHeight, bounds.maximumHeight);
    drawer.style.height = `${appliedHeight}px`;
    handle.setAttribute("aria-valuemin", String(bounds.minimumHeight));
    handle.setAttribute("aria-valuemax", String(bounds.maximumHeight));
    handle.setAttribute("aria-valuenow", String(appliedHeight));
    handle.setAttribute("aria-valuetext", `${appliedHeight} pixels high`);
    const next = `${appliedHeight}/${bounds.minimumHeight}/${bounds.maximumHeight}/${draggingUpdate}`;
    if (forceEmit || next !== emitted) {
      emitted = next;
      onHeight?.(appliedHeight, draggingUpdate, bounds);
    }
  }

  /** Removes pointer listeners and capture for the active pointer only. */
  function finishPointer(event) {
    if (!dragging || (event?.pointerId !== undefined && event.pointerId !== pointerId)) { return; }
    dragging = false;
    handle.removeAttribute("data-dragging");
    root.removeEventListener("pointermove", movePointer);
    root.removeEventListener("pointerup", finishPointer);
    root.removeEventListener("pointercancel", finishPointer);
    if (pointerId !== undefined && handle.hasPointerCapture?.(pointerId)) { handle.releasePointerCapture?.(pointerId); }
    pointerId = undefined;
    setHeight(appliedHeight, false, true);
  }

  /** Converts movement of the drawer's bottom separator into a matching height. */
  function movePointer(event) {
    if (dragging && (event.pointerId === undefined || event.pointerId === pointerId)) {
      setHeight(startHeight + (event.clientY - startY), true);
    }
  }

  /** Begins one primary-pointer resize gesture. */
  function startPointer(event) {
    if (dragging || event.button !== 0) { return; }
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    startY = event.clientY;
    startHeight = appliedHeight = drawer.getBoundingClientRect().height;
    handle.dataset.dragging = "true";
    handle.setPointerCapture?.(pointerId);
    root.addEventListener("pointermove", movePointer);
    root.addEventListener("pointerup", finishPointer);
    root.addEventListener("pointercancel", finishPointer);
  }

  /** Handles documented separator keyboard controls. */
  function onKeyDown(event) {
    const bounds = measureDrawerBounds({ container, drawer, grid, root });
    const current = appliedHeight || drawer.getBoundingClientRect().height;
    const step = event.shiftKey ? 64 : 16;
    const value = event.key === "ArrowUp" ? current - step : event.key === "ArrowDown" ? current + step : event.key === "Home" ? bounds.minimumHeight : event.key === "End" ? bounds.maximumHeight : undefined;
    if (value === undefined) { return; }
    event.preventDefault();
    setHeight(value);
  }

  /** Reclamps the current height after a layout change when the drawer is visible. */
  function refresh() {
    if (!dragging && !drawer.hidden) { setHeight(appliedHeight || drawer.getBoundingClientRect().height); }
  }

  const ResizeObserverClass = root.defaultView?.ResizeObserver || globalThis.ResizeObserver;
  const observer = typeof ResizeObserverClass === "function" ? new ResizeObserverClass(refresh) : undefined;
  if (container) { observer?.observe(container); }
  if (grid) { observer?.observe(grid); }
  root.defaultView?.addEventListener("resize", refresh);
  handle.addEventListener("pointerdown", startPointer);
  handle.addEventListener("lostpointercapture", finishPointer);
  handle.addEventListener("keydown", onKeyDown);
  return {
    /** Removes all installed pointer, keyboard, window, and observer behavior. */
    destroy() {
      finishPointer();
      observer?.disconnect();
      root.defaultView?.removeEventListener("resize", refresh);
      handle.removeEventListener("pointerdown", startPointer);
      handle.removeEventListener("lostpointercapture", finishPointer);
      handle.removeEventListener("keydown", onKeyDown);
    },
    /** Recalculates bounds after a layout transition. */
    refresh,
    /** Synchronizes a restored height after the drawer opens. */
    setHeight(value) { setHeight(value); }
  };
}

/** Exposes pure helpers for focused geometry tests. */
export const __test = { calculateDrawerBounds, clampHeight };

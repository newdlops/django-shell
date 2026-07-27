// Pointer and keyboard resize behavior for the Model Data Query Builder drawer.

/** Clamps a requested drawer height to the currently usable viewport range. */
function clampHeight(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.round(Number(value) || minimum)));
}

/** Creates an accessible horizontal drawer resize controller with no Recipe dependency. */
export function createQueryDrawerResize({ drawer, handle, onHeight, root = document } = {}) {
  let dragging = false;
  let startHeight = 0;
  let startY = 0;

  /** Calculates bounds from the visible viewport while preserving room for the data grid. */
  function bounds() {
    const viewport = Math.max(440, root.defaultView?.innerHeight || window.innerHeight || 800);
    return { maximum: Math.max(320, Math.min(660, viewport - 180)), minimum: 220 };
  }

  /** Applies a height to both the DOM and its UI-state owner. */
  function setHeight(value, draggingUpdate = false) {
    const range = bounds();
    const height = clampHeight(value, range.minimum, range.maximum);
    drawer.style.height = `${height}px`;
    handle.setAttribute("aria-valuemin", String(range.minimum));
    handle.setAttribute("aria-valuemax", String(range.maximum));
    handle.setAttribute("aria-valuenow", String(height));
    onHeight?.(height, draggingUpdate, range);
  }

  /** Completes a pointer resize without leaving document listeners behind. */
  function finishPointer() {
    if (!dragging) { return; }
    dragging = false;
    handle.removeAttribute("data-dragging");
    root.removeEventListener("pointermove", movePointer);
    root.removeEventListener("pointerup", finishPointer);
    root.removeEventListener("pointercancel", finishPointer);
  }

  /** Converts a pointer delta into a height change from the drawer's bottom edge. */
  function movePointer(event) {
    if (!dragging) { return; }
    setHeight(startHeight + (startY - event.clientY), true);
  }

  /** Starts pointer capture when the user grabs the dedicated resize separator. */
  function startPointer(event) {
    if (event.button !== 0) { return; }
    event.preventDefault();
    dragging = true;
    startY = event.clientY;
    startHeight = drawer.getBoundingClientRect().height;
    handle.dataset.dragging = "true";
    handle.setPointerCapture?.(event.pointerId);
    root.addEventListener("pointermove", movePointer);
    root.addEventListener("pointerup", finishPointer);
    root.addEventListener("pointercancel", finishPointer);
  }

  /** Handles standard separator keyboard resizing with Home and End bounds. */
  function onKeyDown(event) {
    const current = drawer.getBoundingClientRect().height;
    const range = bounds();
    const increment = event.shiftKey ? 48 : 16;
    const next = event.key === "ArrowUp" ? current + increment : event.key === "ArrowDown" ? current - increment : event.key === "Home" ? range.minimum : event.key === "End" ? range.maximum : undefined;
    if (next === undefined) { return; }
    event.preventDefault();
    setHeight(next);
  }

  handle.addEventListener("pointerdown", startPointer);
  handle.addEventListener("keydown", onKeyDown);
  return {
    /** Removes all local and transient document listeners. */
    destroy() { finishPointer(); handle.removeEventListener("pointerdown", startPointer); handle.removeEventListener("keydown", onKeyDown); },
    /** Synchronizes a restored persisted height after the drawer opens. */
    setHeight(value) { setHeight(value); }
  };
}

/** Exposes the pure height clamp for focused tests. */
export const __test = { clampHeight };

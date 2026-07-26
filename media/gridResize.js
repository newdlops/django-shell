// Column resizing for the model grid: drag a header's right edge to set its width.
// The first drag freezes the table to a fixed layout (capturing each column's current auto width)
// so columns can both grow and shrink despite the white-space:nowrap cell content.

const MIN_WIDTH = 72;
const MAX_WIDTH = 480;

/** Clamps a requested column width to the grid's keyboard- and pointer-safe limits. */
function clampWidth(width) {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));
}

/** Updates the exposed separator value for a resized column header. */
function announceWidth(th, width) {
  const handle = th.querySelector(".colresize");
  handle?.setAttribute("aria-valuenow", String(width));
  handle?.setAttribute("aria-valuetext", `${width} pixels`);
}

/** Stores one clamped header width and notifies the viewport renderer. */
function setWidth(th, width, state, onResize) {
  const next = clampWidth(width);
  th.style.width = `${next}px`;
  announceWidth(th, next);
  if (th.dataset.key) {
    state.widths[th.dataset.key] = next;
  }
  onResize?.();
}

/** Freezes the table to fixed layout once, pinning every header to its current rendered width. */
function freezeLayout(table, state) {
  if (table.dataset.fixed === "1") {
    return;
  }
  for (const th of table.tHead.rows[0].cells) {
    const key = th.dataset.key;
    const width = state.widths[key] || Math.round(th.getBoundingClientRect().width);
    th.style.width = `${width}px`;
    announceWidth(th, width);
    if (key) {
      state.widths[key] = width;
    }
  }
  table.style.tableLayout = "fixed";
  table.dataset.fixed = "1";
}

/** Re-applies stored widths to a freshly rebuilt header, restoring fixed layout when any exist. */
function applyStoredWidths(table, state) {
  let applied = false;
  for (const th of table.tHead.rows[0].cells) {
    const width = state.widths[th.dataset.key];
    if (width) {
      th.style.width = `${width}px`;
      announceWidth(th, width);
      applied = true;
    }
  }
  if (applied) {
    table.style.tableLayout = "fixed";
    table.dataset.fixed = "1";
  }
}

/** Wires drag-to-resize on header handles (and restores any saved widths); onResize runs per change. */
export function makeResizable(table, state, onResize) {
  applyStoredWidths(table, state);
  table.tHead.addEventListener("mousedown", (event) => {
    const handle = event.target.closest(".colresize");
    if (!handle) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    freezeLayout(table, state);
    const th = handle.closest("th");
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    const move = (moveEvent) => {
      setWidth(th, startWidth + (moveEvent.clientX - startX), state, onResize);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  table.tHead.addEventListener("keydown", (event) => {
    const handle = event.target.closest(".colresize");
    if (!handle) {
      return;
    }
    const th = handle.closest("th");
    const current = Number(state.widths[th.dataset.key] || th.getBoundingClientRect().width);
    const amount = event.shiftKey ? 32 : 8;
    const next = event.key === "ArrowLeft" ? current - amount
      : event.key === "ArrowRight" ? current + amount
        : event.key === "Home" ? MIN_WIDTH
          : event.key === "End" ? MAX_WIDTH : undefined;
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    freezeLayout(table, state);
    setWidth(th, next, state, onResize);
  });
}

export const __test = { clampWidth };

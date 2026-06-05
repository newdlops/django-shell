// Column resizing for the model grid: drag a header's right edge to set its width.
// The first drag freezes the table to a fixed layout (capturing each column's current auto width)
// so columns can both grow and shrink despite the white-space:nowrap cell content.

const MIN_WIDTH = 48;

/** Freezes the table to fixed layout once, pinning every header to its current rendered width. */
function freezeLayout(table, state) {
  if (table.dataset.fixed === "1") {
    return;
  }
  for (const th of table.tHead.rows[0].cells) {
    const key = th.dataset.key;
    const width = state.widths[key] || Math.round(th.getBoundingClientRect().width);
    th.style.width = `${width}px`;
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
    const key = th.dataset.key;
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    const move = (moveEvent) => {
      const width = Math.max(MIN_WIDTH, Math.round(startWidth + (moveEvent.clientX - startX)));
      th.style.width = `${width}px`;
      if (key) {
        state.widths[key] = width;
      }
      if (onResize) {
        onResize();
      }
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

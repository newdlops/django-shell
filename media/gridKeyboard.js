// Keyboard navigation for the virtualized Django model data grid.

/** Installs roving grid-cell focus and invokes callbacks for virtual offscreen targets. */
export function installGridKeyboard(table, ctx) {
  /** Gives one current cell the tab stop and removes it from its rendered peers. */
  function activate(cell) {
    for (const peer of table.querySelectorAll('[role="gridcell"][tabindex="0"]')) {
      peer.tabIndex = -1;
    }
    cell.tabIndex = 0;
  }

  /** Requests focus for a logical row and column, allowing the owner to reveal virtual cells. */
  function focus(rowIndex, key) {
    const selector = `tr[data-row-index="${rowIndex}"] [role="gridcell"][data-key="${CSS.escape(key)}"]`;
    const cell = table.querySelector(selector);
    if (cell) {
      activate(cell);
      cell.focus();
      return;
    }
    ctx.reveal(rowIndex, key);
  }

  table.addEventListener("focusin", (event) => {
    const cell = event.target.closest('[role="gridcell"]');
    if (cell) {
      activate(cell);
    }
  });

  table.addEventListener("keydown", (event) => {
    if (event.target.matches("input,select,textarea,button")) {
      return;
    }
    const cell = event.target.closest('[role="gridcell"]');
    if (!cell) {
      return;
    }
    const row = cell.closest("tr[data-row-index]");
    const rowIndex = Number(row?.dataset.rowIndex);
    const key = cell.dataset.key;
    const keys = ctx.logicalKeys();
    const columnIndex = keys.indexOf(key);
    if (!Number.isFinite(rowIndex) || columnIndex < 0) {
      return;
    }
    let nextRow = rowIndex;
    let nextKey = key;
    if (event.key === "ArrowLeft") {
      nextKey = keys[Math.max(0, columnIndex - 1)];
    } else if (event.key === "ArrowRight") {
      nextKey = keys[Math.min(keys.length - 1, columnIndex + 1)];
    } else if (event.key === "ArrowUp") {
      nextRow = Math.max(0, rowIndex - 1);
    } else if (event.key === "ArrowDown") {
      nextRow = Math.min(ctx.rowCount() - 1, rowIndex + 1);
    } else if (event.key === "Home") {
      nextKey = keys[0];
      nextRow = event.metaKey || event.ctrlKey ? 0 : rowIndex;
    } else if (event.key === "End") {
      nextKey = keys[keys.length - 1];
      nextRow = event.metaKey || event.ctrlKey ? Math.max(0, ctx.rowCount() - 1) : rowIndex;
    } else if (event.key === "PageUp") {
      nextRow = Math.max(0, rowIndex - Math.max(1, ctx.viewportRows?.() ?? 10));
    } else if (event.key === "PageDown") {
      nextRow = Math.min(ctx.rowCount() - 1, rowIndex + Math.max(1, ctx.viewportRows?.() ?? 10));
    } else if (event.key === "Escape" && ctx.closeDetail?.()) {
      event.preventDefault();
      return;
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      ctx.activate(cell);
      return;
    } else {
      return;
    }
    event.preventDefault();
    focus(nextRow, nextKey);
  });
}

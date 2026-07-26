// Column pinning (freeze-left) for the model browser grid via sticky positioning.

/** Toggles a column's pinned state, updates its header button, and repaints sticky offsets. */
export function togglePin(col, button, state, gridwrap) {
  if (state.pinned.has(col)) {
    state.pinned.delete(col);
    button.classList.remove("active");
    button.title = "Pin column (freeze left)";
  } else {
    state.pinned.add(col);
    button.classList.add("active");
    button.title = "Unpin column";
  }
  repaintPins(gridwrap, state);
}

/** Recomputes cumulative left offsets and applies sticky positioning to pinned columns (offset past the row-number gutter). */
export function repaintPins(gridwrap, state) {
  const headRow = gridwrap.querySelector("thead tr");
  const body = gridwrap.querySelector("tbody");
  if (!headRow) {
    return;
  }
  const lefts = {};
  let offset = headRow.querySelector(".rownum")?.offsetWidth || 0;
  const headerCells = [...headRow.querySelectorAll("[data-key]")];
  for (const cell of headerCells) {
    const key = cell.dataset.key;
    if (key && state.pinned.has(key)) {
      lefts[key] = offset;
      offset += cell.offsetWidth;
    }
  }
  for (const cell of headerCells) {
    setPin(cell, lefts[cell.dataset.key]);
  }
  if (body) {
    for (const row of body.children) {
      if (!row.dataset.pk) {
        continue;
      }
      for (const cell of row.querySelectorAll("[data-key]")) {
        setPin(cell, lefts[cell.dataset.key]);
      }
    }
  }
}

/** Applies or clears sticky-left positioning on one grid cell. */
function setPin(cell, left) {
  if (!cell) {
    return;
  }
  if (left === undefined) {
    cell.classList.remove("pinned");
    cell.style.left = "";
    cell.style.position = "";
    return;
  }
  cell.classList.add("pinned");
  cell.style.position = "sticky";
  cell.style.left = `${left}px`;
}

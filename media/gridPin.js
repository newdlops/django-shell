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
  const lead = headRow.children[0] && headRow.children[0].classList.contains("rownum") ? 1 : 0;
  const lefts = {};
  let offset = lead && headRow.children[0] ? headRow.children[0].offsetWidth : 0;
  for (let i = 0; i < state.columns.length; i += 1) {
    if (state.pinned.has(state.columns[i].attname)) {
      lefts[i] = offset;
      offset += headRow.children[i + lead] ? headRow.children[i + lead].offsetWidth : 0;
    }
  }
  for (let i = 0; i < state.columns.length; i += 1) {
    setPin(headRow.children[i + lead], lefts[i]);
  }
  if (body) {
    for (const row of body.children) {
      if (!row.dataset.pk) {
        continue;
      }
      for (let i = 0; i < state.columns.length; i += 1) {
        setPin(row.children[i + lead], lefts[i]);
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

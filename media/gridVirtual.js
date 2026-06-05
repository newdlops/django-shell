// Row virtualization (windowing) for the model browser grid. Renders only the rows near the
// viewport plus top/bottom spacer rows that hold the scrollbar proportional, so tables with many
// rows (Load-more accumulation, or socket "all") stay responsive instead of building thousands of
// <tr>. Base data rows are uniform height (single-line, nowrap, ellipsised cells), so one measured
// row height drives the window math. Detail (relation-expansion) rows live only inside the current
// window: any window change rebuilds tbody from row data, which closes open expansions cleanly.

const OVERSCAN = 12;
const RENDER_ALL_MAX = 80;
const DEFAULT_ROW_H = 24;

/** Creates a row-windowing controller bound to a scroll container; it owns the tbody's row rendering. */
export function createVirtualRows(ctx) {
  // ctx: { scroller, getBody(), columnSpan(), buildRow(row, index), onRender() }
  let rows = [];
  let rowH = DEFAULT_ROW_H;
  let measured = false;
  let renderedFirst = 0;
  let renderedEnd = 0;

  /** True while a cell editor input/select is focused, so a scroll re-render won't discard the edit. */
  function isEditing() {
    const active = document.activeElement;
    return Boolean(active && ctx.scroller.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName));
  }

  /** Builds a full-width zero-padding spacer row of the given pixel height (stands in for off-window rows). */
  function spacer(height) {
    const tr = document.createElement("tr");
    tr.className = "vspacer";
    const td = document.createElement("td");
    td.colSpan = ctx.columnSpan();
    td.style.cssText = `padding:0;border:0;height:${Math.max(0, Math.round(height))}px`;
    tr.appendChild(td);
    return tr;
  }

  /** Computes the [first, end) row window for the current scroll position, padded by overscan. */
  function windowRange() {
    const top = ctx.scroller.scrollTop;
    const viewH = ctx.scroller.clientHeight || 0;
    const first = Math.max(0, Math.floor(top / rowH) - OVERSCAN);
    const count = Math.ceil(viewH / rowH) + OVERSCAN * 2;
    return { end: Math.min(rows.length, first + count), first };
  }

  /** Replaces tbody with the [first, end) window of rows, bracketed by spacer rows. */
  function paintWindow(first, end) {
    const body = ctx.getBody();
    if (!body) {
      return;
    }
    const frag = document.createDocumentFragment();
    if (first > 0) {
      frag.appendChild(spacer(first * rowH));
    }
    for (let i = first; i < end; i += 1) {
      frag.appendChild(ctx.buildRow(rows[i], i));
    }
    if (end < rows.length) {
      frag.appendChild(spacer((rows.length - end) * rowH));
    }
    body.replaceChildren(frag);
    renderedFirst = first;
    renderedEnd = end;
    if (!measured) {
      measure(body);
    }
    afterRender();
  }

  /** Replaces tbody with every row (small tables skip windowing entirely — no spacers, no scroll math). */
  function paintAll() {
    const body = ctx.getBody();
    if (!body) {
      return;
    }
    const frag = document.createDocumentFragment();
    for (let i = 0; i < rows.length; i += 1) {
      frag.appendChild(ctx.buildRow(rows[i], i));
    }
    body.replaceChildren(frag);
    renderedFirst = 0;
    renderedEnd = rows.length;
    afterRender();
  }

  /** Measures a real row's height once and re-renders if it differs from the working estimate. */
  function measure(body) {
    const sample = body.querySelector("tr[data-pk]");
    const height = sample ? sample.offsetHeight : 0;
    measured = true;
    if (height > 4 && Math.abs(height - rowH) > 1) {
      rowH = height;
      render();
    }
  }

  /** Runs the post-render hook (e.g. repaint pinned-column offsets on the new visible cells). */
  function afterRender() {
    if (ctx.onRender) {
      ctx.onRender();
    }
  }

  /** Renders all rows when the set is small, otherwise the current viewport window. */
  function render() {
    if (rows.length <= RENDER_ALL_MAX) {
      paintAll();
    } else {
      const range = windowRange();
      paintWindow(range.first, range.end);
    }
  }

  /** Re-renders only once the visible band has scrolled past the rendered (overscanned) range. */
  function onScroll() {
    if (rows.length <= RENDER_ALL_MAX || isEditing()) {
      return;
    }
    const top = ctx.scroller.scrollTop;
    const viewH = ctx.scroller.clientHeight || 0;
    const needFirst = Math.floor(top / rowH);
    const needEnd = Math.ceil((top + viewH) / rowH);
    if (needFirst < renderedFirst || needEnd > renderedEnd) {
      const range = windowRange();
      paintWindow(range.first, range.end);
    }
  }

  ctx.scroller.addEventListener("scroll", onScroll, { passive: true });

  // Re-window when the scroll container itself resizes (log-panel drag handle, window/panel resize): otherwise a
  // taller viewport would show blank space below the last rendered row until the next scroll. Rendering rows does
  // not change the scroller's own box size (it is sized by the grid track, not by tbody content), so no loop.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => { if (rows.length > RENDER_ALL_MAX) { render(); } }).observe(ctx.scroller);
  }

  return {
    /** Replaces (or appends to) the row data and renders; a fresh (non-append) load resets the scroll. */
    setRows(next, append) {
      rows = append ? rows.concat(next || []) : (next || []).slice();
      if (!append) {
        measured = false;
        ctx.scroller.scrollTop = 0;
      }
      render();
      return rows.length;
    },
    /** Re-renders the current window in place (use after external row-data mutations). */
    refresh() {
      render();
    },
    /** Total rows currently held by the controller. */
    count() {
      return rows.length;
    }
  };
}

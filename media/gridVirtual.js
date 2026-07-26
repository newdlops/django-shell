// Row virtualization (windowing) for the model browser grid. Renders only the rows near the
// viewport plus top/bottom spacer rows that hold the scrollbar proportional, so tables with many
// rows (Load-more accumulation, or socket "all") stay responsive instead of building thousands of
// <tr>. Base data rows are uniform height (single-line, nowrap, ellipsised cells), so one measured
// row height drives the window math. Detail (relation-expansion) rows live only inside the current
// window: any window change rebuilds tbody from row data, which closes open expansions cleanly.

import { calculateRowWindow, DEFAULT_ROW_HEIGHT } from "./gridViewport.js";

const RENDER_ALL_MAX = 80;

/** Creates a row-windowing controller bound to a scroll container; it owns the tbody's row rendering. */
export function createVirtualRows(ctx) {
  // ctx: { scroller, getBody(), columnSpan(), buildRow(row, index), onRender() }
  let rows = [];
  let rowH = DEFAULT_ROW_HEIGHT;
  let measured = false;
  let renderedFirst = 0;
  let renderedEnd = 0;

  /** Commits a focused inline edit before rebuilding its row outside the current virtual window. */
  function settleActiveEditor() {
    const active = document.activeElement;
    if (active && ctx.scroller.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) {
      active.blur();
    }
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
    return calculateRowWindow({ maxRows: ctx.maxRows?.(), rowCount: rows.length, rowHeight: rowH, scrollTop: ctx.scroller.scrollTop, viewportHeight: ctx.scroller.clientHeight || 0 });
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

  /** Returns whether the current data shape must use a bounded viewport rather than an all-row render. */
  function needsWindowing() {
    return rows.length > RENDER_ALL_MAX || Boolean(ctx.shouldWindow?.(rows.length));
  }

  /** Renders all rows when the data shape is small, otherwise the current viewport window. */
  function render() {
    if (!needsWindowing()) {
      paintAll();
    } else {
      const range = windowRange();
      paintWindow(range.first, range.end);
    }
  }

  /** Re-renders only once the visible band has scrolled past the rendered (overscanned) range. */
  function onScroll() {
    if (!needsWindowing()) {
      return;
    }
    const top = ctx.scroller.scrollTop;
    const viewH = ctx.scroller.clientHeight || 0;
    const needFirst = Math.floor(top / rowH);
    const needEnd = Math.ceil((top + viewH) / rowH);
    if (needFirst < renderedFirst || needEnd > renderedEnd) {
      // Do not indefinitely freeze the DOM while an editor is focused. Blurring stages its current value through the
      // normal editor contract, then the fresh window can contain the rows at the requested scroll position.
      settleActiveEditor();
      const range = windowRange();
      paintWindow(range.first, range.end);
    }
  }

  ctx.scroller.addEventListener("scroll", onScroll, { passive: true });

  // Re-window when the scroll container itself resizes (log-panel drag handle, window/panel resize): otherwise a
  // taller viewport would show blank space below the last rendered row until the next scroll. Rendering rows does
  // not change the scroller's own box size (it is sized by the grid track, not by tbody content), so no loop.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => { if (needsWindowing()) { render(); } }).observe(ctx.scroller);
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

// Two-axis viewport calculations for keeping wide model grids within a bounded DOM budget.

export const DEFAULT_COLUMN_WIDTH = 160;
export const DEFAULT_ROW_HEIGHT = 24;
export const DOM_CELL_BUDGET = 1200;
export const MAX_COLUMN_WIDTH = 480;
export const MIN_COLUMN_WIDTH = 72;
export const ROW_OVERSCAN = 8;
export const COLUMN_OVERSCAN = 2;

/** Returns the persisted or default width for one logical grid column. */
export function columnWidth(key, widths) {
  const value = Number(widths && widths[key]);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_COLUMN_WIDTH;
  }
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(value)));
}

/** Creates the logical grid columns from Django fields followed by relation actions. */
export function logicalColumns(columns, relations, widths) {
  const fields = (columns || []).map((column) => ({
    key: column.attname,
    kind: "field",
    source: column,
    width: columnWidth(column.attname, widths)
  }));
  const relationColumns = (relations || []).map((relation) => ({
    key: `rel:${relation.name}`,
    kind: "relation",
    source: relation,
    width: columnWidth(`rel:${relation.name}`, widths)
  }));
  return [...fields, ...relationColumns];
}

/** Calculates the visible non-pinned column band plus its spacer widths. */
export function calculateColumnWindow(columns, pinnedKeys, scrollLeft, viewportWidth) {
  const available = columns || [];
  const byKey = new Map(available.map((column) => [column.key, column]));
  const pinned = [];
  for (const key of pinnedKeys || []) {
    const column = byKey.get(key);
    if (column?.kind === "field") {
      pinned.push(column);
    }
  }
  const pinnedKeySet = new Set(pinned.map((column) => column.key));
  const scrollable = available.filter((column) => !pinnedKeySet.has(column.key));
  const width = Math.max(1, Number(viewportWidth) || 1);
  let before = 0;
  let first = 0;
  while (first < scrollable.length && before + scrollable[first].width <= scrollLeft) {
    before += scrollable[first].width;
    first += 1;
  }
  let visibleEnd = first;
  let covered = before;
  const target = scrollLeft + width;
  while (visibleEnd < scrollable.length && covered < target) {
    covered += scrollable[visibleEnd].width;
    visibleEnd += 1;
  }
  const start = Math.max(0, first - COLUMN_OVERSCAN);
  const end = Math.min(scrollable.length, visibleEnd + COLUMN_OVERSCAN);
  const leftSpacerWidth = scrollable.slice(0, start).reduce((sum, column) => sum + column.width, 0);
  const visible = scrollable.slice(start, end);
  const rightSpacerWidth = scrollable.slice(end).reduce((sum, column) => sum + column.width, 0);
  const pinnedWidth = pinned.reduce((sum, column) => sum + column.width, 0);
  const totalWidth = 46 + pinnedWidth + leftSpacerWidth + visible.reduce((sum, column) => sum + column.width, 0) + rightSpacerWidth;
  const logicalColumnIndices = Object.fromEntries([...pinned, ...scrollable].map((column, index) => [column.key, index + 2]));
  return { end, leftSpacerWidth, logicalColumnIndices, pinned, rightSpacerWidth, scrollable, start, totalWidth, visible };
}

/** Calculates a bounded vertical row band with spacer heights for a virtualized grid body. */
export function calculateRowWindow({ maxRows = Number.POSITIVE_INFINITY, rowCount, rowHeight = DEFAULT_ROW_HEIGHT, scrollTop, viewportHeight }) {
  const count = Math.max(0, Number(rowCount) || 0);
  const height = Math.max(1, Number(rowHeight) || DEFAULT_ROW_HEIGHT);
  const rowLimit = Number.isFinite(Number(maxRows)) ? Math.max(1, Number(maxRows)) : Number.POSITIVE_INFINITY;
  const first = Math.max(0, Math.floor(Math.max(0, Number(scrollTop) || 0) / height) - ROW_OVERSCAN);
  const visible = Math.ceil(Math.max(0, Number(viewportHeight) || 0) / height) + ROW_OVERSCAN * 2;
  const end = Math.min(count, first + Math.max(1, Math.min(visible, rowLimit)));
  return { bottomSpacerHeight: Math.max(0, count - end) * height, end, first, topSpacerHeight: first * height };
}

/** Manages horizontal column window changes for a table that retains native row rendering. */
export function createGridViewport(ctx) {
  let columns = [];
  let snapshot = calculateColumnWindow(columns, ctx.pinned(), 0, ctx.scroller.clientWidth);
  let scheduled = false;

  /** Schedules one viewport calculation for the latest horizontal scroll position. */
  function schedule() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      refresh();
    });
  }

  /** Rebuilds the column snapshot when its visible range or geometry changed. */
  function refresh(force = false) {
    const next = calculateColumnWindow(columns, ctx.pinned(), ctx.scroller.scrollLeft, ctx.scroller.clientWidth);
    const changed = force
      || next.start !== snapshot.start
      || next.end !== snapshot.end
      || next.pinned.map((column) => column.key).join(",") !== snapshot.pinned.map((column) => column.key).join(",")
      || next.totalWidth !== snapshot.totalWidth;
    snapshot = next;
    if (changed) {
      ctx.onChange(snapshot);
    }
    return snapshot;
  }

  /** Returns the offset of a logical key inside the scrollable, non-pinned region. */
  function offsetFor(key) {
    let offset = 0;
    for (const column of snapshot.scrollable) {
      if (column.key === key) {
        return offset;
      }
      offset += column.width;
    }
    return undefined;
  }

  /** Scrolls a field into the horizontal viewport and rebuilds its visible column band. */
  function scrollToKey(key) {
    if (!key || snapshot.pinned.some((column) => column.key === key)) {
      return false;
    }
    const offset = offsetFor(key);
    if (offset === undefined) {
      return false;
    }
    const target = Math.max(0, offset - Math.max(0, (ctx.scroller.clientWidth - columnWidth(key, ctx.widths())) / 2));
    ctx.scroller.scrollLeft = target;
    refresh(true);
    return true;
  }

  ctx.scroller.addEventListener("scroll", schedule, { passive: true });
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => refresh(true)).observe(ctx.scroller);
  }

  return {
    /** Replaces logical columns and forces an initial render. */
    setColumns(next) {
      columns = next || [];
      refresh(true);
    },
    /** Forces a geometry refresh after pinning or resizing. */
    refresh,
    /** Returns the current rendered column band. */
    snapshot() {
      return snapshot;
    },
    /** Scrolls an offscreen column into view. */
    scrollToKey,
    /** Returns whether row virtualization is required for the current logical grid. */
    shouldVirtualizeRows(rowCount) {
      return rowCount > 80 || rowCount * (columns.length + 1) > 900;
    }
  };
}

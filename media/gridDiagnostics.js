// Grid render diagnostics that report bounded, value-free performance metadata to the extension host.

/** Reports the current grid render shape without emitting model values or query text. */
export function reportGridRender({ logicalRows, post, snapshot, startedAt, table }) {
  const renderedCells = table.querySelectorAll('[role="gridcell"]').length;
  post({
    grid: {
      logicalColumns: snapshot.pinned.length + snapshot.scrollable.length + 1,
      logicalRows,
      ms: Math.round((performance.now() - startedAt) * 10) / 10,
      renderedCells,
      renderedColumns: snapshot.pinned.length + snapshot.visible.length + 1,
      renderedRows: table.querySelectorAll('tbody tr[data-row-index]').length
    },
    type: "gridRendered"
  });
}

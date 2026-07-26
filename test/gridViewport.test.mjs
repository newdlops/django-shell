// Verifies bounded row/column viewport calculations for dense Django model grids.

import assert from "node:assert/strict";
import test from "node:test";

import { calculateColumnWindow, calculateRowWindow, columnWidth, DOM_CELL_BUDGET, logicalColumns, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "../media/gridViewport.js";

/** Builds predictable field descriptors for viewport math assertions. */
function fields(count) {
  return Array.from({ length: count }, (_, index) => ({ attname: `field_${index}`, type: "CharField" }));
}

test("clamps persisted grid widths to the supported resize range", () => {
  assert.equal(columnWidth("name", { name: 12 }), MIN_COLUMN_WIDTH);
  assert.equal(columnWidth("name", { name: 999 }), MAX_COLUMN_WIDTH);
  assert.equal(columnWidth("name", {}), 160);
});

test("keeps only a bounded visible band of a very wide model schema", () => {
  const columns = logicalColumns(fields(300), [], {});
  const window = calculateColumnWindow(columns, new Set(), 2400, 640);
  const renderedCells = 50 * (1 + window.visible.length + Number(Boolean(window.leftSpacerWidth)) + Number(Boolean(window.rightSpacerWidth)));
  assert.ok(window.visible.length < 12, "a 640px viewport renders only nearby columns");
  assert.ok(renderedCells <= DOM_CELL_BUDGET, "50 rows × 300 fields stays under the DOM cell budget");
  assert.ok(window.leftSpacerWidth > 0);
  assert.ok(window.rightSpacerWidth > 0);
});

test("keeps pinned fields outside the horizontal column window", () => {
  const columns = logicalColumns(fields(24), [], {});
  const pinned = new Set(["field_0", "field_3"]);
  const window = calculateColumnWindow(columns, pinned, 1200, 320);
  assert.deepEqual(window.pinned.map((column) => column.key), ["field_0", "field_3"]);
  assert.equal(window.visible.some((column) => pinned.has(column.key)), false);
});

test("preserves user pin order and assigns logical indices before schema-order columns", () => {
  const columns = logicalColumns(fields(4), [], {});
  const window = calculateColumnWindow(columns, new Set(["field_3", "field_1"]), 0, 640);

  assert.deepEqual(window.pinned.map((column) => column.key), ["field_3", "field_1"]);
  assert.equal(window.logicalColumnIndices.field_3, 2);
  assert.equal(window.logicalColumnIndices.field_1, 3);
  assert.equal(window.logicalColumnIndices.field_0, 4);
  assert.equal(window.logicalColumnIndices.field_2, 5);
});

test("bounds row virtualization by the current visible-column budget even in a tall viewport", () => {
  const columns = logicalColumns(fields(400), [], {});
  const columnWindow = calculateColumnWindow(columns, new Set(), 0, 640);
  const maximumRows = Math.floor(DOM_CELL_BUDGET / columnWindow.visible.length);
  const rowWindow = calculateRowWindow({ maxRows: maximumRows, rowCount: 500, rowHeight: 24, scrollTop: 0, viewportHeight: 12000 });
  assert.ok((rowWindow.end - rowWindow.first) * columnWindow.visible.length <= DOM_CELL_BUDGET);
  assert.equal(rowWindow.first, 0);
  assert.ok(rowWindow.bottomSpacerHeight > 0);
});

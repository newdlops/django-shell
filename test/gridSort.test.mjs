// Verifies model-grid sort cycling and Recipe order translation.

import assert from "node:assert/strict";
import test from "node:test";

import { gridOrderFromRecipe, nextGridOrder, recipeWithGridOrder } from "../media/gridSort.js";

/** Creates the smallest valid Recipe shape needed by sort helper tests. */
function recipe() {
  return { computed: [{ alias: "score", enabled: true, kind: "formula" }], mode: "rows", orderBy: [], source: { app: "db", model: "Company" }, version: 2 };
}

test("grid header sort cycles ascending, descending, and default", () => {
  assert.deepEqual(nextGridOrder([], "name"), [{ desc: false, field: "name" }]);
  assert.deepEqual(nextGridOrder([{ desc: false, field: "name" }], "name"), [{ desc: true, field: "name" }]);
  assert.deepEqual(nextGridOrder([{ desc: true, field: "name" }], "name"), []);
  assert.deepEqual(nextGridOrder([{ desc: true, field: "name" }], "created_at"), [{ desc: false, field: "created_at" }]);
});

test("grid header order uses concrete field and enabled computed references", () => {
  const concrete = recipeWithGridOrder(recipe(), "name", false);
  const computed = recipeWithGridOrder(recipe(), "score", true);

  assert.deepEqual(concrete.orderBy[0].ref, { kind: "field", path: "name" });
  assert.deepEqual(computed.orderBy[0].ref, { alias: "score", kind: "computed" });
  assert.deepEqual(gridOrderFromRecipe({ orderBy: [...concrete.orderBy, ...computed.orderBy] }), [{ desc: false, field: "name" }, { desc: true, field: "score" }]);
  assert.deepEqual(recipeWithGridOrder(computed, "score", undefined).orderBy, []);
});

test("grid header order allocates a bounded node id without colliding with the applied Recipe", () => {
  const existing = recipe();
  existing.where = { children: [{ kind: "comparison", nodeId: "grid-order-name" }], join: "and", kind: "group", negated: false, nodeId: "where-root" };

  const sorted = recipeWithGridOrder(existing, "name", false);
  const long = recipeWithGridOrder(recipe(), "x".repeat(100), false);

  assert.equal(sorted.orderBy[0].nodeId, "grid-order-name-2");
  assert.ok(long.orderBy[0].nodeId.length <= 64);
});

// Verifies compact filter editing preserves the full query and uses correct typed predicate values.
import assert from "node:assert/strict";
import test from "node:test";
import { clearRowFiltersAction, supportsQuickFilters } from "../media/gridQuickFilters.js";
import { createEmptyQueryRecipe, createQueryRecipeStore } from "../media/gridQueryRecipeStore.js";
import { __test as predicate } from "../media/gridPredicateBuilder.js";
import { rhsIsCompatible } from "../media/gridPredicateValue.js";

/** Creates a real draft store with one ordinary text condition and applied computed results. */
function fixture() {
  const recipe = createEmptyQueryRecipe({ app: "accounts", model: "User" });
  recipe.computed = [{ kind: "aggregate", alias: "total", enabled: true }];
  recipe.orderBy = [{ ref: { kind: "field", path: "id" }, direction: "desc" }];
  recipe.where.children.push({ kind: "comparison", nodeId: "name", lhs: { kind: "field", path: "username" }, lookup: "icontains", rhs: { kind: "literal", value: "alex" }, negated: false });
  return createQueryRecipeStore(recipe);
}

test("quick filtering admits nested groups and field comparisons while revealing unrelated draft changes", () => {
  const store = fixture();
  assert.equal(supportsQuickFilters(store.getSnapshot()), true);
  store.dispatch({ type: "ADD_GROUP", parentId: store.getSnapshot().draft.where.nodeId, scope: "where" });
  assert.equal(supportsQuickFilters(store.getSnapshot()), true);
  store.undo();
  store.dispatch({ type: "UPDATE_NODE", scope: "where", nodeId: "name", changes: { rhs: { kind: "field", path: "email" } } });
  assert.equal(supportsQuickFilters(store.getSnapshot()), true);
  store.undo();
  const snapshot = store.getSnapshot();
  snapshot.draft.computed[0].alias = "changed";
  assert.equal(supportsQuickFilters(snapshot), false);
  assert.equal(supportsQuickFilters(store.getSnapshot()), true);
});

test("clearing row filters is undoable and preserves applied rows and every other query section", () => {
  const store = fixture(), before = store.getSnapshot();
  store.dispatch(clearRowFiltersAction(before.draft));
  const next = store.getSnapshot();
  assert.deepEqual(next.draft.where.children, []);
  assert.deepEqual(next.draft.computed, before.draft.computed);
  assert.deepEqual(next.draft.orderBy, before.draft.orderBy);
  assert.deepEqual(next.applied, before.applied);
  assert.equal(next.dirty, true);
  store.undo();
  assert.deepEqual(store.getSnapshot().draft, before.draft);
});

test("root AND/OR and NOT controls update their actual group without changing applied filters", () => {
  const store = fixture(), before = store.getSnapshot();
  store.dispatch({ type: "UPDATE_NODE", scope: "where", nodeId: before.draft.where.nodeId, changes: { join: "or", negated: true } });
  assert.equal(store.getSnapshot().draft.where.join, "or");
  assert.equal(store.getSnapshot().draft.where.negated, true);
  assert.deepEqual(store.getSnapshot().draft.where.children, before.draft.where.children);
  assert.deepEqual(store.getSnapshot().applied, before.applied);
});

test("first field selection initializes the displayed text, boolean, and choice defaults", () => {
  const empty = { lhs: { kind: "field", path: "" }, lookup: "exact", rhs: { kind: "literal", value: null } };
  assert.equal(predicate.fieldSelectionChanges(empty, { type: "CharField" }, "username", "where").lookup, "icontains");
  assert.deepEqual(predicate.fieldSelectionChanges(empty, { type: "BooleanField" }, "is_active", "where").rhs, { kind: "literal", value: true });
  assert.deepEqual(predicate.fieldSelectionChanges(empty, { type: "IntegerField", choices: [[2, "Active"]] }, "status", "where").rhs, { kind: "literal", value: 2 });
});

test("Exists inner group updates preserve their parent predicate and other source-row conditions", () => {
  const store = fixture();
  store.dispatch({ type: "ADD_EXISTS_PREDICATE", scope: "where" });
  const before = store.getSnapshot().draft;
  const exists = before.where.children.at(-1);
  store.dispatch({ type: "UPDATE_NODE", scope: "where", nodeId: exists.where.nodeId, changes: { join: "or", negated: true } });
  const after = store.getSnapshot().draft;
  assert.deepEqual(after.where.children[0], before.where.children[0]);
  assert.deepEqual(after.where.children.at(-1), { ...exists, where: { ...exists.where, join: "or", negated: true } });
});

test("list and range operators preserve structured values and return to a scalar without stale values", () => {
  const scalar = { lookup: "exact", rhs: { kind: "literal", value: 42 } };
  for (const [lookup, rhs] of [["in", { kind: "list", values: [] }], ["range", { kind: "range", lower: null, upper: null }]]) {
    const next = predicate.lookupChanges(scalar, lookup);
    assert.deepEqual(next.rhs, rhs);
    assert.equal(rhsIsCompatible(rhs, "where", { type: "IntegerField" }, lookup), true);
    assert.deepEqual(predicate.lookupChanges(next, "exact").rhs, { kind: "literal", value: null });
  }
});

// Focused contract tests for computed-column draft creation and source-order behavior.
import assert from "node:assert/strict";
import test from "node:test";
import { createComputedDraft, emptyComputedGroup, previousEnabledAliases, reduceComputedPredicate, suggestComputedAlias, summaryUnavailable } from "../media/gridComputedShared.js";
import { __test as list, requiresKindConfirmation } from "../media/gridComputedBuilder.js";

test("computed alias suggestions are valid, deterministic, and never rewrite a supplied alias", () => {
  const current = [{ alias: "count", enabled: true, nodeId: "one" }, { alias: "count_2", enabled: true, nodeId: "two" }];
  assert.equal(suggestComputedAlias("aggregate", current), "count_3");
  assert.equal(createComputedDraft("formula", "formula-1", "chosen_by_user").alias, "chosen_by_user");
});

test("enabled upstream aliases are the only Formula dependency choices", () => {
  const columns = [{ alias: "first", enabled: true, nodeId: "a" }, { alias: "hidden", enabled: false, nodeId: "b" }, { alias: "current", enabled: true, nodeId: "c" }];
  assert.deepEqual(previousEnabledAliases(columns, "c"), ["first"]);
});

test("reordered Formula references produce a local forward-reference error", () => {
  const recipe = { computed: [{ alias: "after", enabled: true, nodeId: "a", kind: "aggregate" }, { alias: "formula", enabled: true, expression: { alias: "after", kind: "computed" }, kind: "formula", nodeId: "b" }] };
  assert.deepEqual(list.formulaForwardReferences(recipe, recipe.computed[1]), []);
  recipe.computed.reverse();
  assert.deepEqual(list.formulaForwardReferences(recipe, recipe.computed[0]), ["after"]);
});

test("shared aggregate filters retain nested structural edits immutably", () => {
  const root = emptyComputedGroup("filter-root");
  const grouped = reduceComputedPredicate(root, { parentId: "filter-root", type: "ADD_GROUP" });
  const nested = reduceComputedPredicate(grouped, { parentId: grouped.children[0].nodeId, type: "ADD_COMPARISON" });
  assert.equal(root.children.length, 0);
  assert.equal(nested.children[0].children[0].kind, "comparison");
});

test("Summary mode reports unavailable columns without removing their recipes", () => {
  const windowColumn = createComputedDraft("window", "window-1", "rank");
  assert.equal(summaryUnavailable({ mode: "summary" }, windowColumn), true);
  assert.equal(summaryUnavailable({ mode: "summary" }, createComputedDraft("aggregate", "aggregate-1", "total")), false);
});

test("non-default computed bodies require an explicit type-change confirmation", () => {
  const empty = createComputedDraft("aggregate", "aggregate-1", "count");
  assert.equal(requiresKindConfirmation(empty), false);
  assert.equal(requiresKindConfirmation({ ...empty, field: { kind: "field", path: "amount" } }), true);
});

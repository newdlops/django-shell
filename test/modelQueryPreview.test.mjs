// Tests Recipe human summaries, ORM preview composition, and backend issue de-duplication.

import assert from "node:assert/strict";
import test from "node:test";
import { mergeRecipeIssues } from "../media/gridQueryResultBuilder.js";
import { describeQueryRecipe, renderRecipePreview } from "../media/gridQuerySummary.js";

const recipe = {
  computed: [], groupBy: [], mode: "rows", orderBy: [], source: { app: "db", model: "Company" }, version: 2,
  postFilter: { children: [], join: "and", kind: "group", negated: false, nodeId: "post-root" },
  where: { children: [{ kind: "group", negated: true, nodeId: "group-1", join: "or", children: [
    { kind: "comparison", lhs: { kind: "field", path: "name" }, lookup: "icontains", negated: false, nodeId: "cmp-1", rhs: { kind: "literal", value: "acme" } },
    { kind: "comparison", lhs: { kind: "field", path: "active" }, lookup: "exact", negated: false, nodeId: "cmp-2", rhs: { kind: "literal", value: true } }
  ] }], join: "and", kind: "group", negated: false, nodeId: "where-root" }
};

test("human summary preserves boolean parentheses, NOT, and implicit primary-key order", () => {
  const text = describeQueryRecipe(recipe);
  assert.match(text, /NOT \(name icontains/);
  assert.match(text, / OR /);
  assert.match(text, /primary key ascending/);
});

test("full preview keeps the shared narrative while adding host ORM text", () => {
  const preview = renderRecipePreview(recipe, "Company.objects.filter(...)");
  assert.ok(preview.startsWith(`Recipe: ${describeQueryRecipe(recipe)}`));
  assert.match(preview, /Django ORM/);
});

test("backend issues merge with client issues by code, node id, and path", () => {
  const duplicate = { code: "VALUE_INVALID", nodeId: "cmp-1", path: "/where/0", severity: "error" };
  const merged = mergeRecipeIssues([duplicate], [duplicate, { code: "VALUE_INVALID", nodeId: "cmp-2", path: "/where/0", severity: "error" }]);
  assert.equal(merged.length, 2);
});

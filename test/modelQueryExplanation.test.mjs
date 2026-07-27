// Focused pure explanation tests for Model Query Builder guidance.

import assert from "node:assert/strict";
import test from "node:test";
import { applyAvailability, explainComparison, explainImplicitBehavior, explainPredicateGroup, formatExplanationText, formatQueryLiteral, queryExplanationTokens } from "../media/gridQueryExplanation.js";
import { describeQueryRecipe } from "../media/gridQuerySummary.js";

/** Exercises the incomplete predicate priority used by every predicate surface. */
test("comparison explanation leads with the next required choice", () => {
  assert.match(explainComparison({}).text, /Choose the field/);
  assert.match(explainComparison({ lhs: { kind: "field", path: "name" } }).text, /Choose how/);
  assert.match(explainComparison({ lhs: { kind: "field", path: "name" }, lookup: "exact" }).text, /Choose whether/);
  assert.match(explainComparison({ lhs: { kind: "field", path: "name" }, lookup: "exact", rhs: { kind: "literal", value: "" } }).text, /Enter the value/);
});

/** Preserves negation and plain-language case-insensitive descriptions. */
test("comparison explanation describes complete comparisons", () => {
  const result = explainComparison({ lhs: { kind: "field", path: "name" }, lookup: "icontains", negated: true, rhs: { kind: "literal", value: "Acme" } }, { fields: { name: { label: "Company name" } } });
  assert.equal(result.state, "complete");
  assert.equal(result.text, "Excludes rows where Company name (`name`) contains, ignoring case “Acme” (case-insensitive).");
});

/** Keeps every null-state/Not combination aligned with its effective predicate meaning. */
test("null-state explanations and compact summaries never invert Boolean null semantics", () => {
  const cases = [
    { negated: false, value: true, phrase: "is null" },
    { negated: false, value: false, phrase: "has a value" },
    { negated: true, value: true, phrase: "has a value" },
    { negated: true, value: false, phrase: "is null" }
  ];
  for (const entry of cases) {
    const node = { kind: "comparison", lhs: { kind: "computed", alias: "latest_valuation_id" }, lookup: "isnull", negated: entry.negated, rhs: { kind: "literal", value: entry.value } };
    assert.match(explainComparison(node, { postFilter: true }).text, new RegExp(`Keeps calculated results where .* ${entry.phrase}`));
    const summary = describeQueryRecipe({ computed: [], mode: "rows", orderBy: [], where: { children: [node], join: "and", kind: "group", negated: false } });
    assert.match(summary, new RegExp(`@latest_valuation_id ${entry.phrase}`));
    assert.doesNotMatch(summary, /isnull (true|false)/);
  }
});

/** Covers roots, nested groups, defaults, and safely bounded literal output. */
test("group and implicit explanations remain bounded", () => {
  assert.match(explainPredicateGroup({ children: [] }, { root: true }).text, /include every row/);
  assert.match(explainPredicateGroup({ children: [] }, { root: false }).text, /nested group/);
  assert.deepEqual(explainImplicitBehavior({ mode: "rows", orderBy: [] }, {}, { transport: "ORM" }), ["Order rows by the primary key ascending because no result order is set.", "Run through ORM.", "Keep the previous grid visible until this draft applies successfully."]);
  assert.equal(formatQueryLiteral("a".repeat(100)).length, 80);
  assert.equal(formatQueryLiteral('a"b'), '“a"b”');
});

/** Keeps Apply reasons in the documented priority order. */
test("apply availability prioritizes source through validation errors", () => {
  assert.match(applyAvailability({}, {}).text, /Open a model/);
  assert.match(applyAvailability({ draft: { source: { app: "x", model: "Y" } } }, { applying: true, draftRevision: 2 }).text, /Applying Recipe revision 2/);
  assert.match(applyAvailability({ draft: { source: { app: "x", model: "Y" } } }, { validation: { issues: [{ severity: "error" }, { severity: "warning" }] } }).text, /Fix 1 error/);
});

test("explanation identifiers become safe code tokens without changing compatibility text", () => {
  const tokens = queryExplanationTokens("Adds `latest_valuation_id` from `valuation_history_set`.");
  assert.deepEqual(tokens, [{ kind: "text", value: "Adds " }, { kind: "code", value: "latest_valuation_id" }, { kind: "text", value: " from " }, { kind: "code", value: "valuation_history_set" }, { kind: "text", value: "." }]);
  assert.equal(formatExplanationText(tokens), "Adds `latest_valuation_id` from `valuation_history_set`.");
});

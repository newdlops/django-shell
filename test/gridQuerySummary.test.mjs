// Verifies that the collapsed Query Builder summary projects only the applied Recipe.
import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyQueryRecipe, createQueryRecipeStore } from "../media/gridQueryRecipeStore.js";
import { describeQueryRecipe, renderQuerySummary, summarizeRecipeFilters } from "../media/gridQuerySummary.js";

/** Creates a minimal text-only element double that rejects unsafe HTML rendering. */
function createElement() {
  return {
    get innerHTML() { throw new Error("summary rendering must not use innerHTML"); },
    hidden: false,
    textContent: "",
    title: ""
  };
}

/** Creates the complete fixed summary element collection expected by the renderer. */
function createElements() {
  return Object.fromEntries(["queryFilterButton", "queryColumnsButton", "queryModeButton", "queryHumanSummary", "queryDirtyState", "queryAppliedWhere", "queryAppliedPostFilter", "queryAppliedFilters", "queryAppliedFiltersEmpty"].map((id) => [id, createElement()]));
}

/** Creates one canonical Recipe with a deterministic source-row comparison. */
function recipeWithWhere(path = "active", value = true) {
  const recipe = createEmptyQueryRecipe({ app: "db", model: "Company" });
  recipe.where.children.push({ kind: "comparison", lhs: { kind: "field", path }, lookup: "exact", negated: false, nodeId: "where-cmp", rhs: { kind: "literal", value } });
  return recipe;
}

/** Verifies applied content remains distinct from an unaccepted dirty draft. */
function testAppliedProjection() {
  const elements = createElements();
  const applied = recipeWithWhere();
  applied.computed.push({ alias: "total", enabled: true, kind: "aggregate" });
  applied.mode = "summary";
  applied.postFilter.children.push({ kind: "comparison", lhs: { alias: "total", kind: "computed" }, lookup: "gt", negated: false, nodeId: "applied-post", rhs: { kind: "literal", value: 1 } });
  const draft = recipeWithWhere("active", "draft");
  draft.where.children[0].lookup = "icontains";
  draft.computed.push({ alias: "draftOne", enabled: true, kind: "aggregate" }, { alias: "draftTwo", enabled: true, kind: "aggregate" });
  draft.mode = "rows";
  draft.postFilter.children.push({ kind: "comparison", lhs: { kind: "field", path: "name" }, lookup: "icontains", negated: false, nodeId: "draft-post", rhs: { kind: "literal", value: "draft" } });
  renderQuerySummary(elements, { applied, draft, dirty: true });

  assert.equal(elements.queryFilterButton.textContent, "Filters 2");
  assert.equal(elements.queryFilterButton.title, "Applied filters: 1 row condition(s), 1 result condition(s). Open the Filter Rows draft editor.");
  assert.equal(elements.queryColumnsButton.textContent, "Columns 1");
  assert.equal(elements.queryColumnsButton.title, "Applied calculated columns. Open the Calculated Values draft editor.");
  assert.equal(elements.queryModeButton.textContent, "Summary");
  assert.equal(elements.queryModeButton.title, "Applied result mode. Open the Result draft editor.");
  assert.match(elements.queryHumanSummary.textContent, /Applied · active exact true/);
  assert.match(elements.queryHumanSummary.textContent, /1 computed column: total/);
  assert.match(elements.queryHumanSummary.textContent, /Summary global summary ordered by primary key ascending/);
  assert.equal(elements.queryHumanSummary.title, elements.queryHumanSummary.textContent);
  assert.match(elements.queryHumanSummary.title, /1 computed column: total/);
  assert.match(elements.queryHumanSummary.title, /Summary global summary ordered by primary key ascending/);
  assert.equal(elements.queryAppliedWhere.textContent, "Rows · active exact true");
  assert.equal(elements.queryAppliedWhere.title, "Rows · active exact true");
  assert.equal(elements.queryAppliedPostFilter.textContent, "Results · @total gt 1");
  assert.equal(elements.queryAppliedPostFilter.title, "Results · @total gt 1");
  assert.equal(elements.queryAppliedFilters.hidden, false);
  assert.equal(elements.queryAppliedFiltersEmpty.hidden, true);
  assert.equal(elements.queryAppliedWhere.hidden, false);
  assert.equal(elements.queryAppliedPostFilter.hidden, false);
  assert.doesNotMatch(elements.queryHumanSummary.textContent, /draft/);
  assert.doesNotMatch(elements.queryAppliedWhere.textContent, /draft/);
  assert.doesNotMatch(elements.queryAppliedPostFilter.textContent, /draft/);
  assert.equal(elements.queryDirtyState.hidden, false);
}

/** Verifies both applied filter stages render in execution order. */
function testBothFilterStages() {
  const elements = createElements();
  const applied = recipeWithWhere();
  applied.computed.push({ alias: "total", enabled: true, kind: "aggregate" });
  applied.postFilter.children.push({ kind: "comparison", lhs: { alias: "total", kind: "computed" }, lookup: "gt", negated: false, nodeId: "post-cmp", rhs: { kind: "literal", value: 1 } });
  renderQuerySummary(elements, { applied, dirty: false });

  assert.equal(elements.queryFilterButton.textContent, "Filters 2");
  assert.equal(elements.queryAppliedWhere.textContent, "Rows · active exact true");
  assert.equal(elements.queryAppliedPostFilter.textContent, "Results · @total gt 1");
  assert.equal(elements.queryAppliedWhere.hidden, false);
  assert.equal(elements.queryAppliedPostFilter.hidden, false);
  const narrative = elements.queryHumanSummary.textContent;
  assert.ok(narrative.indexOf("computed column") < narrative.indexOf("Result filter:"));
  assert.ok(narrative.indexOf("Result filter:") < narrative.indexOf("Rows ordered"));
}

/** Verifies the empty applied Recipe has a stable, explicit empty projection. */
function testEmptyAppliedProjection() {
  const elements = createElements();
  renderQuerySummary(elements, { applied: createEmptyQueryRecipe({ app: "db", model: "Company" }), dirty: false });

  assert.equal(elements.queryFilterButton.textContent, "Filters 0");
  assert.equal(elements.queryAppliedFilters.hidden, true);
  assert.equal(elements.queryAppliedFiltersEmpty.hidden, false);
  assert.equal(elements.queryAppliedWhere.hidden, true);
  assert.equal(elements.queryAppliedPostFilter.hidden, true);
  assert.match(elements.queryHumanSummary.textContent, /^Applied · All rows/);
}

/** Verifies missing and partial snapshots safely retain the applied empty-state defaults. */
function testMissingAppliedProjection() {
  for (const snapshot of [undefined, {}, { applied: {} }]) {
    const elements = createElements();
    renderQuerySummary(elements, snapshot);
    assert.equal(elements.queryFilterButton.textContent, "Filters 0");
    assert.equal(elements.queryColumnsButton.textContent, "Columns 0");
    assert.equal(elements.queryModeButton.textContent, "Rows");
    assert.equal(elements.queryHumanSummary.textContent, "Applied · All rows · no computed columns · Rows ordered by primary key ascending");
    assert.equal(elements.queryAppliedFilters.hidden, true);
    assert.equal(elements.queryAppliedFiltersEmpty.hidden, false);
    assert.equal(elements.queryDirtyState.hidden, true);
  }
}

/** Verifies Apply rejection and newer drafts cannot replace the applied projection early. */
function testApplyLifecycleProjection() {
  const elements = createElements();
  const store = createQueryRecipeStore(createEmptyQueryRecipe({ app: "db", model: "Company" }));
  store.dispatch({ parentId: "where-root", type: "ADD_COMPARISON" });
  const applying = store.getSnapshot().draft;
  store.beginApply(1, applying);
  store.failApply(1, [{ code: "VALUE_REQUIRED", severity: "error" }]);
  renderQuerySummary(elements, store.getSnapshot());
  assert.equal(elements.queryFilterButton.textContent, "Filters 0");
  store.beginApply(2, applying);
  store.finishApply(2, applying);
  store.dispatch({ type: "ADD_COMPUTED" });
  renderQuerySummary(elements, store.getSnapshot());
  assert.equal(elements.queryFilterButton.textContent, "Filters 1");
  assert.equal(elements.queryDirtyState.hidden, false);
}

/** Verifies nested safe predicate text remains bounded and is never interpreted as markup. */
function testSafePredicateSummaries() {
  const recipe = createEmptyQueryRecipe({ app: "db", model: "Company" });
  const longLiteral = "x".repeat(80);
  recipe.where.children.push({ children: [{ kind: "comparison", lhs: { kind: "field", path: "falseNegated" }, lookup: "isnull", negated: true, nodeId: "null-false-negated", rhs: { kind: "literal", value: false } }, { kind: "comparison", lhs: { kind: "field", path: "falsePlain" }, lookup: "isnull", negated: false, nodeId: "null-false-plain", rhs: { kind: "literal", value: false } }, { kind: "comparison", lhs: { kind: "field", path: "trueNegated" }, lookup: "isnull", negated: true, nodeId: "null-true-negated", rhs: { kind: "literal", value: true } }, { kind: "comparison", lhs: { kind: "field", path: "truePlain" }, lookup: "isnull", negated: false, nodeId: "null-true-plain", rhs: { kind: "literal", value: true } }, { kind: "comparison", lhs: { kind: "field", path: "name" }, lookup: "exact", negated: true, nodeId: "html", rhs: { kind: "literal", value: "<img src=x onerror=alert(1)>" } }, { kind: "comparison", lhs: { kind: "field", path: "description" }, lookup: "exact", negated: false, nodeId: "long", rhs: { kind: "literal", value: longLiteral } }, { correlations: [{ outerPath: "company_id", targetPath: "company_id" }], kind: "existsPredicate", negated: false, nodeId: "exists", source: { kind: "relation", relation: "invoices" }, where: { children: [{ kind: "comparison", lhs: { kind: "field", path: "paid" }, lookup: "exact", negated: false, nodeId: "paid", rhs: { kind: "literal", value: false } }], join: "and", kind: "group", negated: false, nodeId: "exists-root" } }], join: "or", kind: "group", negated: true, nodeId: "nested" });
  const filters = summarizeRecipeFilters(recipe);

  assert.match(filters.sourceText, /NOT \(/);
  assert.match(filters.sourceText, /falseNegated is null/);
  assert.match(filters.sourceText, /falsePlain has a value/);
  assert.match(filters.sourceText, /trueNegated has a value/);
  assert.match(filters.sourceText, /truePlain is null/);
  assert.match(filters.sourceText, /NOT \(name exact "<img src=x onerror=alert\(1\)>"\)/);
  assert.match(filters.sourceText, /EXISTS invoices correlated by company_id=company_id where paid exact false/);
  assert.match(filters.sourceText, /"x{37}…"/);
  assert.doesNotMatch(filters.sourceText, new RegExp(`x{${longLiteral.length}}`));
  assert.match(describeQueryRecipe(recipe), /falseNegated is null/);
}

test("applied projection excludes dirty draft content", testAppliedProjection);
test("applied projection represents both filter stages", testBothFilterStages);
test("empty applied Recipe projects explicit None state", testEmptyAppliedProjection);
test("missing applied snapshots project stable empty defaults", testMissingAppliedProjection);
test("Apply lifecycle changes applied projection only on acceptance", testApplyLifecycleProjection);
test("predicate summaries remain safe text", testSafePredicateSummaries);

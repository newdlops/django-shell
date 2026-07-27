// Focused contract tests for scalar-subquery and Exists computed draft limits.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createComputedDraft } from "../media/gridComputedShared.js";
import { __test as subquery } from "../media/gridSubqueryBuilder.js";

test("scalar subquery drafts include the independent where root and scalar-only controls", () => {
  const item = createComputedDraft("scalarSubquery", "subquery-1", "latest_name");
  assert.equal(item.source.kind, "relation");
  assert.equal(item.select.kind, "field");
  assert.equal(item.where.kind, "group");
  assert.deepEqual(item.orderBy, []);
  assert.equal(item.onEmpty.kind, "literal");
});

test("Exists drafts reuse source/correlation/where but do not carry scalar select state", () => {
  const item = createComputedDraft("exists", "exists-1", "has_child");
  assert.equal(item.source.kind, "relation");
  assert.equal(item.where.kind, "group");
  assert.equal("select" in item, false);
  assert.equal("onEmpty" in item, false);
  assert.equal("orderBy" in item, false);
});

test("custom correlation and subquery order limits are bounded at four and three", () => {
  assert.equal(subquery.canAddCorrelation(Array.from({ length: 3 })), true);
  assert.equal(subquery.canAddCorrelation(Array.from({ length: 4 })), false);
  assert.equal(subquery.canAddOrder(Array.from({ length: 2 })), true);
  assert.equal(subquery.canAddOrder(Array.from({ length: 3 })), false);
});

test("subquery row choice moves only adjacent order entries and preserves boundaries", () => {
  const entries = [{ nodeId: "first" }, { nodeId: "second" }];
  assert.deepEqual(subquery.moveSubqueryOrder(entries, 1, -1), [{ nodeId: "second" }, { nodeId: "first" }]);
  assert.deepEqual(subquery.moveSubqueryOrder(entries, 0, -1), entries);
});

test("subquery field pickers keep accessor labels while using the filter-query relation identity", () => {
  const scope = { relations: [{ name: "valuation_history_set", queryName: "valuation_history", target: "db.ValuationHistory" }] };
  assert.equal(subquery.relationValue(scope.relations[0]), "valuation_history");
  assert.deepEqual(subquery.sourceTarget({ kind: "relation", relation: "valuation_history" }, scope), { app: "db", model: "ValuationHistory" });
  assert.deepEqual(subquery.sourceTarget({ kind: "relation", relation: "valuation_history_set" }, scope), { app: "db", model: "ValuationHistory" });
  assert.deepEqual(subquery.sourceTarget({ kind: "model", target: { app: "db", model: "Company" } }, scope), { app: "db", model: "Company" });
  assert.equal(subquery.sourceTarget({ kind: "relation", relation: "missing" }, scope), undefined);
});

test("scalar subquery editor exposes the six numbered assembly fieldsets in order", () => {
  const source = fs.readFileSync(new URL("../media/gridSubqueryBuilder.js", import.meta.url), "utf8");
  for (const label of ["1. Source", "2. Connection", "3. Target filter", "4. Returned value", "5. Row choice", "6. Output"]) { assert.ok(source.includes(label), `missing ${label}`); }
  const render = source.slice(source.indexOf("export function renderSubqueryBuilder"), source.indexOf("/** Renders an Exists"));
  const positions = ["sourceControls", "correlationControls", "targetFilter", "scalarControls"].map((name) => render.indexOf(name));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

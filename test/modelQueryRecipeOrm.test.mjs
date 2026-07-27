// Verifies Recipe v2 ORM-cell reconstruction without changing the legacy model ORM compiler.

import assert from "node:assert/strict";
import test from "node:test";

import { ModelQueryMetadataIndex } from "../out/modelQueryRecipeMetadata.js";
import { createEmptyModelQueryRecipe } from "../out/modelQueryRecipe.js";
import { buildRecipeCountOrm, buildRecipeRowsOrm, buildRecipeSummaryOrm } from "../out/modelQueryRecipeOrm.js";

const SOURCE = { app: "db", model: "Company" };
const COLUMNS = [
  { attname: "id", editable: false, name: "id", null: false, pk: true, type: "AutoField" },
  { attname: "name", editable: true, name: "name", null: false, pk: false, type: "CharField" },
  { attname: "amount", editable: true, name: "amount", null: false, pk: false, type: "IntegerField" },
  { attname: "is_demo", editable: true, name: "is_demo", null: false, pk: false, type: "BooleanField" }
];

/** Creates the minimal trusted metadata snapshot required by Recipe v2 validation. */
function metadata() {
  const index = new ModelQueryMetadataIndex();
  index.setCatalog([SOURCE, { app: "db", model: "ValuationHistory" }]);
  index.addTree(SOURCE, { fields: COLUMNS.map((column) => ({ attname: column.attname, name: column.name, null: column.null, pk: column.pk, type: column.type })), ok: true, pk: "id", relations: [{ filterField: "company_id", kind: "reverse", label: "valuation_history_set", name: "valuation_history", outerField: "id", single: false, target: "db.ValuationHistory" }] });
  index.addTree({ app: "db", model: "ValuationHistory" }, { fields: [{ attname: "id", name: "id", null: false, pk: true, type: "AutoField" }, { attname: "company_id", name: "company_id", null: false, pk: false, type: "AutoField" }], ok: true, pk: "id", relations: [] });
  index.addColumns(SOURCE, COLUMNS);
  return index;
}

/** Returns one fixed context for v2 ORM reconstruction tests. */
function context() {
  return { columns: COLUMNS, limit: 50, metadata: metadata(), relations: [], source: SOURCE, transport: "orm" };
}

test("compiles nested Boolean predicates into one app-qualified ORM rows cell", () => {
  const recipe = createEmptyModelQueryRecipe(SOURCE);
  recipe.where.children.push(
    { kind: "comparison", lhs: { kind: "field", path: "is_demo" }, lookup: "exact", negated: false, nodeId: "q-1", rhs: { kind: "literal", value: false } },
    { children: [
      { kind: "comparison", lhs: { kind: "field", path: "name" }, lookup: "icontains", negated: false, nodeId: "q-3", rhs: { kind: "literal", value: "테스트" } },
      { kind: "comparison", lhs: { kind: "field", path: "name" }, lookup: "icontains", negated: false, nodeId: "q-4", rhs: { kind: "literal", value: "demo" } }
    ], join: "or", kind: "group", negated: false, nodeId: "q-2" }
  );

  const compiled = buildRecipeRowsOrm(recipe, context());
  assert.equal(compiled.validation.ok, true);
  assert.match(compiled.cell, /^__import__\("django\.apps", fromlist=\["apps"\]\)\.apps\.get_model\("db", "Company"\)\._base_manager\.filter\(/);
  assert.match(compiled.cell, /"is_demo__exact": False/);
  assert.match(compiled.cell, /"name__icontains": "테스트"/);
  assert.match(compiled.cell, /\.order_by\("pk"\)\[0:51\]$/);
  assert.match(compiled.preview, /\n/);
});

test("compiles rows aggregate annotations and summary aggregates in Recipe order", () => {
  const recipe = createEmptyModelQueryRecipe(SOURCE);
  recipe.computed.push({
    alias: "total_amount",
    distinct: "auto",
    enabled: true,
    field: { kind: "field", path: "amount" },
    filter: { children: [], join: "and", kind: "group", negated: false, nodeId: "q-1" },
    function: "sum",
    kind: "aggregate",
    nodeId: "q-2"
  });
  const rows = buildRecipeRowsOrm(recipe, context());
  assert.equal(rows.validation.ok, true);
  assert.match(rows.cell, /\.annotate\(total_amount=models\.Sum\("amount", filter=models\.Q\(\)\)\)/);

  recipe.mode = "summary";
  const summary = buildRecipeSummaryOrm(recipe, context());
  assert.equal(summary.validation.ok, true);
  assert.equal(summary.cell, '[__import__("django.apps", fromlist=["apps"]).apps.get_model("db", "Company")._base_manager.filter(models.Q()).aggregate(total_amount=models.Sum("amount", filter=models.Q()))]');
});

test("builds count from the full validated Recipe and refuses injection-shaped input", () => {
  const recipe = createEmptyModelQueryRecipe(SOURCE);
  recipe.where.children.push({ kind: "comparison", lhs: { kind: "field", path: "name" }, lookup: "icontains", negated: false, nodeId: "q-1", rhs: { kind: "literal", value: "acme" } });
  const count = buildRecipeCountOrm(recipe, context());
  assert.equal(count.validation.ok, true);
  assert.match(count.cell, /\.filter\(models\.Q\(\*\*\{"name__icontains": "acme"\}\)\)\.count\(\)$/);

  recipe.where.children[0].lhs.path = "name); import os #";
  const rejected = buildRecipeRowsOrm(recipe, context());
  assert.equal(rejected.validation.ok, false);
  assert.equal(rejected.cell, "");
  assert.doesNotMatch(rejected.preview, /import os/);
});

/** Builds the Phase 11 relation-source scalar subquery using only trusted metadata correlation. */
test("compiles the complete Phase 11 relation scalar subquery with direct not-null filtering", () => {
  const recipe = createEmptyModelQueryRecipe(SOURCE);
  recipe.computed.push({
    alias: "latest_valuation_id", correlations: [], enabled: true, kind: "scalarSubquery", nodeId: "latest-valuation", onEmpty: { kind: "literal", value: null }, orderBy: [{ direction: "desc", nodeId: "latest-valuation-order", ref: { kind: "field", path: "id" } }], outputType: "auto", select: { field: { kind: "field", path: "id" }, kind: "field" }, source: { kind: "relation", relation: "valuation_history" }, where: { children: [], join: "and", kind: "group", negated: false, nodeId: "latest-valuation-where" }
  });
  recipe.postFilter.children.push({ kind: "comparison", lhs: { alias: "latest_valuation_id", kind: "computed" }, lookup: "isnull", negated: false, nodeId: "latest-valuation-present", rhs: { kind: "literal", value: false } });
  recipe.orderBy.push({ direction: "desc", nodeId: "outer-latest-valuation", ref: { alias: "latest_valuation_id", kind: "computed" } }, { direction: "asc", nodeId: "outer-id", ref: { kind: "field", path: "id" } });

  const compiled = buildRecipeRowsOrm(recipe, context());
  assert.equal(compiled.validation.ok, true);
  assert.doesNotMatch(compiled.cell, /SUBQUERY_CORRELATION/);
  assert.match(compiled.cell, /"company_id": models\.OuterRef\("id"\)/);
  assert.match(compiled.cell, /\.order_by\("-id"\)\.values\("id"\)\[:1\]/);
  assert.match(compiled.cell, /"latest_valuation_id__isnull": False/);
  assert.doesNotMatch(compiled.cell, /~\(models\.Q\(\*\*\{"latest_valuation_id__isnull"/);
  assert.match(compiled.cell, /\.order_by\("-latest_valuation_id", "id"\)/);
});

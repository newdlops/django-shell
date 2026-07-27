// Verifies ModelQueryRecipeV2 normalization, metadata resolution, and strict validation order.

import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createEmptyModelQueryRecipe, cloneModelQueryRecipe } = require("../out/modelQueryRecipe.js");
const { ModelQueryMetadataIndex } = require("../out/modelQueryRecipeMetadata.js");
const { validateModelQueryRecipe } = require("../out/modelQueryRecipeValidation.js");

/** Builds the smallest live-metadata context needed by recipe-core validation tests. */
function context() {
  const source = { app: "db", model: "Company" };
  const index = new ModelQueryMetadataIndex();
  index.setCatalog([source, { app: "db", model: "Address" }]);
  index.addTree(source, { ok: true, pk: "id", fields: [
    { attname: "id", name: "id", null: false, pk: true, type: "AutoField" },
    { attname: "name", name: "name", null: false, pk: false, type: "CharField" },
    { attname: "is_demo", name: "is_demo", null: false, pk: false, type: "BooleanField" },
    { attname: "created_at", name: "created_at", null: false, pk: false, type: "DateTimeField" },
    { attname: "score", name: "score", null: true, pk: false, type: "IntegerField" }
  ], relations: [{ filterField: "company_id", kind: "reverse", name: "addresses", outerField: "id", single: false, target: "db.Address" }] });
  index.addTree({ app: "db", model: "Address" }, { ok: true, pk: "id", fields: [
    { attname: "id", name: "id", null: false, pk: true, type: "AutoField" },
    { attname: "company_id", name: "company_id", null: false, pk: false, type: "IntegerField" },
    { attname: "city", name: "city", null: false, pk: false, type: "CharField" }
  ], relations: [] });
  const columns = [
    { attname: "id", name: "id", editable: false, null: false, pk: true, type: "AutoField" },
    { attname: "name", name: "name", editable: true, null: false, pk: false, type: "CharField" },
    { attname: "is_demo", name: "is_demo", editable: true, null: false, pk: false, type: "BooleanField" },
    { attname: "created_at", name: "created_at", editable: true, null: false, pk: false, type: "DateTimeField" },
    { attname: "score", name: "score", editable: true, null: true, pk: false, type: "IntegerField" }
  ];
  return { columns, metadata: index, source, transport: "orm" };
}

/** Adds a valid comparison at a deterministic recipe path. */
function comparison(nodeId, path, lookup, rhs) {
  return { kind: "comparison", nodeId, lhs: { kind: "field", path }, lookup, rhs, negated: false };
}

test("empty recipe is valid and has canonical roots", () => {
  const recipe = createEmptyModelQueryRecipe(context().source);
  const result = validateModelQueryRecipe(recipe, context());
  assert.equal(result.ok, true);
  assert.equal(result.normalized.where.nodeId, "where-root");
  assert.equal(result.normalized.postFilter.nodeId, "post-root");
});

test("nested AND/OR/NOT remains valid and does not mutate the input", () => {
  const recipe = createEmptyModelQueryRecipe(context().source);
  recipe.where.children.push({ kind: "group", nodeId: "names", join: "or", negated: true, children: [comparison("name-a", "name", "icontains", { kind: "literal", value: "A" })] });
  const frozen = cloneModelQueryRecipe(recipe);
  const result = validateModelQueryRecipe(recipe, context());
  assert.equal(result.ok, true);
  assert.deepEqual(recipe, frozen);
});

test("reports source, duplicate identifier, depth, and empty-group failures in stable phase order", () => {
  const recipe = createEmptyModelQueryRecipe({ app: "db", model: "Address" });
  recipe.where.children.push({ kind: "group", nodeId: "where-root", join: "and", negated: false, children: [] });
  const result = validateModelQueryRecipe(recipe, context());
  assert.deepEqual(result.issues.slice(0, 3).map((issue) => issue.code), ["RECIPE_SOURCE_MISMATCH", "NODE_ID_DUPLICATE", "EMPTY_NESTED_GROUP"]);
});

test("enforces path, relation terminal, type-specific lookup, and RHS matrix", () => {
  const recipe = createEmptyModelQueryRecipe(context().source);
  recipe.where.children.push(
    comparison("bad-path", "missing", "exact", { kind: "literal", value: "x" }),
    comparison("relation", "addresses", "exact", { kind: "literal", value: "x" }),
    comparison("boolean", "is_demo", "contains", { kind: "literal", value: "x" }),
    comparison("range", "score", "range", { kind: "literal", value: 1 }),
    comparison("in", "score", "in", { kind: "list", values: Array.from({ length: 201 }, (_, index) => index) })
  );
  const codes = validateModelQueryRecipe(recipe, context()).issues.map((issue) => issue.code);
  assert.ok(codes.includes("FIELD_PATH_INVALID"));
  assert.ok(codes.includes("FIELD_PATH_RELATION_TERMINAL"));
  assert.ok(codes.includes("LOOKUP_TYPE_MISMATCH"));
  assert.ok(codes.includes("RHS_KIND_UNSUPPORTED"));
  assert.ok(codes.includes("IN_LIST_LIMIT"));
});

test("normalizes blank RHS and rejects invalid relative time", () => {
  const recipe = createEmptyModelQueryRecipe(context().source);
  recipe.where.children.push(
    comparison("blank", "name", "blank", { kind: "literal", value: "ignored" }),
    comparison("time", "created_at", "gte", { kind: "relativeTime", amount: 0, anchor: "now", direction: "past", unit: "hours" })
  );
  const result = validateModelQueryRecipe(recipe, context());
  assert.equal(result.normalized.where.children[0].rhs.value, null);
  assert.ok(result.issues.some((issue) => issue.code === "RELATIVE_TIME_INVALID"));
});

test("enforces aliases and declaration-order computed references", () => {
  const recipe = createEmptyModelQueryRecipe(context().source);
  recipe.computed.push(
    { kind: "formula", nodeId: "future", alias: "next", enabled: true, outputType: "integer", expression: { kind: "computed", alias: "later" } },
    { kind: "formula", nodeId: "later", alias: "later", enabled: true, outputType: "integer", expression: { kind: "literal", value: 1 } },
    { kind: "formula", nodeId: "field", alias: "name", enabled: true, outputType: "integer", expression: { kind: "literal", value: 1 } },
    { kind: "formula", nodeId: "reserved", alias: "djs_hidden", enabled: true, outputType: "integer", expression: { kind: "literal", value: 1 } }
  );
  const codes = validateModelQueryRecipe(recipe, context()).issues.map((issue) => issue.code);
  assert.ok(codes.includes("COMPUTED_REFERENCE_FORWARD"));
  assert.ok(codes.includes("ALIAS_COLLISION"));
  assert.ok(codes.includes("ALIAS_RESERVED"));
});

test("enforces rows and summary result mode rules", () => {
  const rows = createEmptyModelQueryRecipe(context().source);
  rows.groupBy.push({ kind: "field", path: "name" });
  assert.ok(validateModelQueryRecipe(rows, context()).issues.some((issue) => issue.code === "COMPUTED_KIND_UNSUPPORTED_IN_SUMMARY"));
  const summary = createEmptyModelQueryRecipe(context().source);
  summary.mode = "summary";
  summary.postFilter.children.push(comparison("post", "name", "exact", { kind: "literal", value: "x" }));
  const codes = validateModelQueryRecipe(summary, context()).issues.map((issue) => issue.code);
  assert.ok(codes.includes("COMPUTED_KIND_UNSUPPORTED_IN_SUMMARY"));
  assert.ok(codes.includes("GLOBAL_SUMMARY_POST_FILTER_UNSUPPORTED"));
});

test("validates scalar subquery correlation and warns about implicit primary-key order", () => {
  const recipe = createEmptyModelQueryRecipe(context().source);
  recipe.computed.push({
    kind: "scalarSubquery", nodeId: "city", alias: "city", enabled: true, outputType: "text", source: { kind: "model", target: { app: "db", model: "Address" } }, correlations: [{ nodeId: "correlation", outerPath: "id", targetPath: "company_id" }], where: { kind: "group", nodeId: "city-where", join: "and", negated: false, children: [] }, select: { kind: "field", field: { kind: "field", path: "city" } }, orderBy: [], onEmpty: { kind: "literal", value: null }
  });
  const result = validateModelQueryRecipe(recipe, context());
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((issue) => issue.code === "SUBQUERY_IMPLICIT_ORDER"));
});

/** Requires automatic metadata correlation for relations while retaining explicit custom-model requirements. */
test("validates relation-source correlation contracts without permitting unsafe fallthrough", () => {
  const recipe = createEmptyModelQueryRecipe(context().source);
  recipe.computed.push({
    kind: "scalarSubquery", nodeId: "relation-subquery", alias: "related_id", enabled: true, outputType: "auto", source: { kind: "relation", relation: "addresses" }, correlations: [], where: { kind: "group", nodeId: "relation-where", join: "and", negated: false, children: [] }, select: { kind: "field", field: { kind: "field", path: "id" } }, orderBy: [], onEmpty: { kind: "literal", value: null }
  });
  const valid = validateModelQueryRecipe(recipe, context());
  assert.equal(valid.ok, true);
  assert.ok(!valid.issues.some((issue) => issue.code === "SUBQUERY_CORRELATION_REQUIRED" || issue.code === "SUBQUERY_CORRELATION_INVALID"));

  recipe.computed[0].correlations = [{ nodeId: "manual", outerPath: "id", targetPath: "company_id" }];
  assert.ok(validateModelQueryRecipe(recipe, context()).issues.some((issue) => issue.code === "SUBQUERY_CORRELATION_INVALID"));

  recipe.computed[0].source = { kind: "model", target: { app: "db", model: "Address" } };
  recipe.computed[0].correlations = [];
  assert.ok(validateModelQueryRecipe(recipe, context()).issues.some((issue) => issue.code === "SUBQUERY_CORRELATION_REQUIRED"));

  const missingMetadata = context();
  missingMetadata.metadata.getTree(missingMetadata.source).relations[0].filterField = undefined;
  recipe.computed[0].source = { kind: "relation", relation: "addresses" };
  assert.ok(validateModelQueryRecipe(recipe, missingMetadata).issues.some((issue) => issue.code === "SUBQUERY_CORRELATION_INVALID"));

  const malformedRawType = context();
  malformedRawType.metadata.getTree({ app: "db", model: "Address" }).fields.find((field) => field.attname === "company_id").type = "ForeignKey";
  assert.ok(validateModelQueryRecipe(recipe, malformedRawType).issues.some((issue) => issue.code === "SUBQUERY_CORRELATION_INVALID"));
});

// Verifies live metadata loading, validation, and ORM generation for nested relationship lookups.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createEmptyModelQueryRecipe } = require("../out/modelQueryRecipe.js");
const { ModelQueryMetadataIndex, loadModelQueryMetadata } = require("../out/modelQueryRecipeMetadata.js");
const { validateModelQueryRecipe } = require("../out/modelQueryRecipeValidation.js");

/** Creates realistic field metadata including foreign-key names and their distinct storage attributes. */
function field(name, type = "CharField", attname = name) { return { attname, name, null: false, pk: name === "id", type }; }

/** Provides two forward relations and one reverse relation without preloading their target models. */
function fixture() {
  const source = { app: "db", model: "Record" };
  const trees = {
    "db.Record": { ok: true, pk: "id", fields: [field("id", "AutoField"), field("company", "IntegerField", "company_id"), field("user", "IntegerField", "user_id")], relations: [{ name: "company", single: true, target: "db.Company", kind: "forward_fk" }, { name: "user", single: true, target: "db.User", kind: "forward_fk" }] },
    "db.Company": { ok: true, pk: "id", fields: [field("id", "AutoField"), field("user", "IntegerField", "user_id"), field("name")], relations: [{ name: "user", single: true, target: "db.User", kind: "forward_fk" }] },
    "db.User": { ok: true, pk: "id", fields: [field("id", "AutoField"), field("email", "EmailField")], relations: [{ name: "records", queryName: "records", single: false, target: "db.Record", kind: "reverse_fk", outerField: "id", filterField: "user_id" }] }
  };
  const requests = [];
  return { source, trees, requests, catalog: Object.keys(trees).map((key) => ({ app: key.split(".")[0], model: key.split(".")[1] })), async loadTree(model) { const key = `${model.app}.${model.model}`; requests.push(key); assert.ok(trees[key], key); return trees[key]; } };
}

/** Builds a scalar comparison with a stable identifier and supplied field path. */
function condition(path, nodeId = "lookup") { return { kind: "comparison", nodeId, lhs: { kind: "field", path }, lookup: "icontains", rhs: { kind: "literal", value: "@example.test" }, negated: false }; }

test("metadata resolves relation names before treating foreign-key attributes as terminal fields", () => {
  const data = fixture(), index = new ModelQueryMetadataIndex();
  for (const model of data.catalog) { index.addTree(model, data.trees[`${model.app}.${model.model}`]); }
  assert.equal(index.resolvePath(data.source, "company__user__email")?.type, "EmailField");
  assert.equal(index.resolvePath(data.source, "company_id")?.type, "IntegerField");
  assert.equal(index.resolvePath(data.source, "company_id__name"), undefined);
  assert.equal(index.resolvePath(data.source, "company__user__records__company__name")?.toMany, true);
});

test("preview and apply load each model referenced by a repeated multi-hop filter once", async () => {
  const data = fixture(), recipe = createEmptyModelQueryRecipe(data.source);
  recipe.where.children.push(condition("company__user__email"), condition("company__user__email", "second"));
  const metadata = await loadModelQueryMetadata(recipe, data.loadTree, data.catalog, []);
  assert.deepEqual(data.requests, ["db.Record", "db.Company", "db.User"]);
  const validation = validateModelQueryRecipe(recipe, { source: data.source, columns: [], metadata, transport: "orm" });
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  assert.equal(validation.normalized.where.children[0].lhs.path, "company__user__email");
});

test("scoped predicates load nested paths from their relation target and outer references from their owner", async () => {
  const data = fixture(), recipe = createEmptyModelQueryRecipe({ app: "db", model: "User" });
  recipe.where.children.push({ kind: "existsPredicate", nodeId: "exists", source: { kind: "relation", relation: "records" }, correlations: [], negated: false, where: { kind: "group", nodeId: "inner", join: "and", negated: false, children: [{ ...condition("company__user__email"), rhs: { kind: "outerField", path: "email" } }] } });
  const metadata = await loadModelQueryMetadata(recipe, data.loadTree, data.catalog, []);
  assert.equal(metadata.resolvePath(data.source, "company__user__email")?.type, "EmailField");
  assert.deepEqual(new Set(data.requests), new Set(["db.User", "db.Record", "db.Company"]));
  assert.equal(data.requests.length, 3);
});

test("invalid and storage-attribute traversal does not expand unrelated model metadata", async () => {
  const data = fixture(), recipe = createEmptyModelQueryRecipe(data.source);
  recipe.where.children.push(condition("company_id__name"), condition("missing__email", "missing"));
  const metadata = await loadModelQueryMetadata(recipe, data.loadTree, data.catalog, []);
  assert.deepEqual(data.requests, ["db.Record"]);
  assert.equal(metadata.resolvePath(data.source, "company_id__name"), undefined);
});

test("related ordering loads its field path even without a matching filter", async () => {
  const data = fixture(), recipe = createEmptyModelQueryRecipe(data.source);
  recipe.orderBy.push({ direction: "asc", nodeId: "related-order", ref: { kind: "field", path: "company__user__email" } });
  const metadata = await loadModelQueryMetadata(recipe, data.loadTree, data.catalog, []);
  assert.deepEqual(data.requests, ["db.Record", "db.Company", "db.User"]);
  const validation = validateModelQueryRecipe(recipe, { source: data.source, columns: [], metadata, transport: "orm" });
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
});

// Ensures Recipe v2 ORM compilation rejects hostile structure without a broad fallback cell.

import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyModelQueryRecipe } from "../out/modelQueryRecipe.js";
import { ModelQueryMetadataIndex } from "../out/modelQueryRecipeMetadata.js";
import { buildRecipeRowsOrm } from "../out/modelQueryRecipeOrm.js";

const SOURCE = { app: "db", model: "Company" };

/** Builds minimal live metadata containing only the allowed id and name fields. */
function context() {
  const columns = [
    { attname: "id", editable: false, name: "id", null: false, pk: true, type: "AutoField" },
    { attname: "name", editable: true, name: "name", null: false, pk: false, type: "CharField" }
  ];
  const metadata = new ModelQueryMetadataIndex();
  metadata.setCatalog([SOURCE]);
  metadata.addTree(SOURCE, { fields: columns.map((column) => ({ attname: column.attname, name: column.name, null: column.null, pk: column.pk, type: column.type })), ok: true, pk: "id", relations: [] });
  metadata.addColumns(SOURCE, columns);
  return { columns, limit: 50, metadata, relations: [], source: SOURCE, transport: "orm" };
}

test("rejects hostile paths, aliases, raw code, and node identifiers before emitting an ORM cell", () => {
  const hostile = [
    { mutate: (recipe) => { recipe.where.children.push({ kind: "comparison", lhs: { kind: "field", path: "name); import os #" }, lookup: "exact", negated: false, nodeId: "q-1", rhs: { kind: "literal", value: "x" } }); }, token: "import os" },
    { mutate: (recipe) => { recipe.computed.push({ alias: "x);delete()", enabled: true, expression: 'models.F("name")', kind: "codeExpression", nodeId: "q-1", outputType: "text", when: { children: [], join: "and", kind: "group", negated: false, nodeId: "q-2" } }); }, token: "delete" },
    { mutate: (recipe) => { recipe.where.children.push({ kind: "comparison", lhs: { kind: "field", path: "name" }, lookup: "exact", negated: false, nodeId: "<script>", rhs: { kind: "literal", value: "x" } }); }, token: "script" }
  ];

  for (const item of hostile) {
    const recipe = createEmptyModelQueryRecipe(SOURCE);
    item.mutate(recipe);
    const result = buildRecipeRowsOrm(recipe, context());
    assert.equal(result.cell, "");
    assert.equal(result.validation.ok, false);
    assert.doesNotMatch(result.preview, new RegExp(item.token));
  }
});

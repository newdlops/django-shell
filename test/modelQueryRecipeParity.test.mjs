// Ensures the composed backend carries the same Recipe v2 entry points for every model-browser transport.
import assert from "node:assert/strict";
import { readComposedBackendSource } from "./backendComposedSourceHelper.mjs";
import { MODEL_QUERY_RECIPE_CORPUS } from "./modelQueryRecipeCorpus.mjs";
import test from "node:test";

test("all shared Recipe corpus fixtures have the complete v2 root shape", () => {
  for (const fixture of MODEL_QUERY_RECIPE_CORPUS) {
    assert.equal(fixture.recipe.version, 2, fixture.name);
    assert.ok(fixture.recipe.where && fixture.recipe.postFilter, fixture.name);
    assert.ok(Array.isArray(fixture.recipe.computed), fixture.name);
  }
});

test("remote composed backend exports rows, summary, and count Recipe executors", () => {
  const source = readComposedBackendSource();
  for (const symbol of ["_browse_recipe_rows", "_browse_recipe_summary", "_browse_recipe_count", "_browse_recipe_validate"]) {
    assert.ok(source.includes(`def ${symbol}(`), symbol);
  }
});

// Guards host-side Recipe v2 lifecycle, revision, metadata, and reload contracts.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/modelBrowser.ts", import.meta.url), "utf8");

test("model browser keeps an applied Recipe revision and canonical initial-pk recipe", () => {
  assert.ok(source.includes("private appliedRecipe: ModelQueryRecipeV2"));
  assert.ok(source.includes("private appliedRecipeRevision = 0"));
  assert.ok(source.includes("createInitialPkModelQueryRecipe(recipeSource, target.initialPk)"));
  assert.ok(source.includes("isRecipeInitialPk(target.initialPk)"));
});

test("Recipe preview and apply share metadata loading but only current revisions execute", () => {
  assert.ok(source.includes("prepareRecipeMetadata(recipe)"));
  assert.ok(source.includes("recipeTreeRequests"));
  assert.ok(source.includes("message.revision !== this.latestRecipeRevision"));
  assert.ok(source.includes("type: \"queryRecipePreview\""));
  assert.ok(source.includes("type: \"queryRecipeApplied\""));
  assert.ok(source.includes("type: \"queryRecipeRejected\""));
  assert.ok(source.includes("buildRecipeRowsOrm(recipe, context)"));
  assert.ok(source.includes("buildRecipeSummaryOrm(recipe, context)"));
});

test("applied Recipe requests carry in-process metadata and stale data responses are suppressed", () => {
  assert.ok(source.includes("query.recipe = this.appliedRecipe"));
  assert.ok(source.includes("query.recipeMetadata = this.recipeMetadata.toBundle()"));
  assert.ok(source.includes("isCurrentRecipeLoad(generation, revision)"));
  assert.ok(source.includes("revision !== this.appliedRecipeRevision"));
  assert.ok(source.includes("loadRecipeSummary(this.appliedRecipeRevision)"));
});

test("runtime reload revalidates the applied Recipe before loading a new grid", () => {
  assert.ok(source.includes("void this.refreshAppliedRecipe()"));
  assert.ok(source.includes("const validation = this.compileRecipe(this.appliedRecipe, metadata)"));
  assert.ok(source.includes("if (!validation.ok) { this.post({ issues: validation.issues"));
  assert.ok(source.includes("await this.loadModel()"));
});

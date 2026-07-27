// Tests Recipe count provenance and host lifecycle source contracts.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const browser = fs.readFileSync(new URL("../src/modelBrowser.ts", import.meta.url), "utf8");
const recipeOrm = fs.readFileSync(new URL("../src/modelQueryRecipeOrm.ts", import.meta.url), "utf8");

test("Recipe count carries the same applied revision and query-log provenance", () => {
  assert.match(browser, /queryLog: this\.recipeLogMeta\("count"\)/);
  assert.match(browser, /revision !== this\.appliedRecipeRevision/);
  assert.match(recipeOrm, /buildRecipeCountOrm/);
});

test("host preserves an existing grid when backend Recipe rows are rejected", () => {
  assert.match(browser, /!rows\.ok && this\.recipeMetadata && rows\.issues\?\.length/);
  assert.match(browser, /type: "queryRecipeRejected"/);
});

test("initial primary-key recipes hydrate after the source schema becomes available", () => {
  assert.match(browser, /hydrateInitialRecipe\(\)/);
  assert.match(browser, /recipe: this\.appliedRecipe, revision: this\.appliedRecipeRevision, type: "queryRecipeApplied"/);
});

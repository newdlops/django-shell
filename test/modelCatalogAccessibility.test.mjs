// Regression coverage for the model catalog's semantic tree and bounded rendering contract.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../src/modelCatalogHtml.ts", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../media/modelCatalogSource.js", import.meta.url), "utf8");
const catalogCss = fs.readFileSync(new URL("../media/modelCatalog.css", import.meta.url), "utf8");

test("model catalog exposes labeled search, live status, and an ARIA model tree", () => {
  assert.match(html, /<label class="sr-only" for="modelSearch">Search models<\/label>/);
  assert.match(html, /id="catalogStatus" class="catalog-status" role="status" aria-live="polite"/);
  assert.match(html, /id="modelTree" class="list" role="tree" aria-label="Django models"/);
  assert.match(catalogCss, /@media \(prefers-reduced-motion:reduce\)/);
});

test("model catalog tree uses semantic buttons, roving focus, and native tree navigation", () => {
  assert.match(source, /row\.setAttribute\("role", "treeitem"\)/);
  assert.match(source, /row\.setAttribute\("aria-expanded", String\(open\)\)/);
  assert.match(source, /function setRovingTabStop\(key\)/);
  assert.match(source, /event\.key === "ArrowDown"/);
  assert.match(source, /event\.key === "ArrowLeft"/);
  assert.match(source, /event\.key === "Home"/);
});

test("model catalog keeps all rendered tree items within its 500-item budget", () => {
  assert.match(source, /const RENDER_CAP = 500;/);
  assert.match(source, /const DOM_NODE_BUDGET = 2000;/);
  assert.match(source, /renderedTreeItems >= RENDER_CAP \|\| renderedNodes/);
  assert.match(source, /renderedNodes \+ childListNodes \+ modelNodes > DOM_NODE_BUDGET/);
  assert.match(source, /renderedTreeItems \+= 1;/);
  assert.match(source, /Showing first 500 matches\. Refine your search\./);
});

test("model catalog retains clear loading, empty, and retryable error feedback", () => {
  assert.match(source, /Loading Django models…/);
  assert.match(source, /Refreshing models…/);
  assert.match(source, /No models match/);
  assert.match(source, /disconnected \? "Open Django Shell" : "Retry"/);
  assert.match(source, /type: "openConsole"/);
  assert.match(source, /function conciseError\(error\)/);
});

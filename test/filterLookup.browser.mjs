// Exercises searchable relation paths and nested Boolean filters in the production webview.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { serveFilterBrowser } from "./fixtures/filterBrowser.mjs";

const results = path.resolve(import.meta.dirname, "../.vscode-test/results");

/** Chooses a searchable field path through visible controls, including an optional pasted lookup. */
async function pick(page, row, lookup) {
  if (!await page.getByRole("dialog", { name: "Choose filter field" }).isVisible()) { await row.getByLabel("Condition field", { exact: true }).click(); }
  await page.getByRole("combobox", { name: "Search fields or paste a lookup" }).fill(lookup);
  await page.getByRole("option", { name: `Choose ${lookup}`, exact: true }).click();
}

/** Waits for current draft validation and its applied revision through normal Apply. */
async function apply(page) {
  await page.waitForFunction(() => !document.getElementById("queryDrawerApply").disabled);
  await page.locator("#queryDrawerApply").click();
  await page.waitForFunction(() => document.querySelector(".query-draft-status")?.textContent.includes("matches"));
}

/** Checks actual viewport and popup bounds independently of the scrollable data table. */
async function capture(page, name) {
  await page.screenshot({ path: path.join(results, `filter-lookup-${name}.png`), fullPage: true });
  const bounds = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, controls: [...document.querySelectorAll('.query-field-trigger,.query-field-portal:not([hidden]),#queryDrawerApply')].map((control) => control.getBoundingClientRect().toJSON()) }));
  assert.ok(bounds.documentWidth <= bounds.width + 1, JSON.stringify(bounds));
  assert.ok(bounds.controls.every((control) => control.x >= 0 && control.right <= bounds.width + 1), JSON.stringify(bounds));
}

/** Verifies drill-in, paste, ancestor editing, nested OR, duplication, exclusion, and draft restoration. */
async function exercise(page, url, width, height) {
  await page.setViewportSize({ width, height });
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById("title")?.textContent === "accounts.User");
  await page.locator("#queryFilterButton").click();
  const root = page.locator('#queryWhereRoot .query-predicate-group[data-depth="1"]').first();
  const rows = root.locator('[data-role="comparison"]');
  await root.getByRole("button", { name: "Add condition to this group", exact: true }).click();
  await page.getByRole("option", { name: "Browse company", exact: true }).click();
  await page.getByRole("option", { name: "Browse company__user", exact: true }).click();
  await page.getByRole("option", { name: "Choose company__user__email", exact: true }).waitFor();
  assert.equal(await rows.first().getByLabel("Condition field", { exact: true }).getAttribute("aria-haspopup"), "dialog");
  const fieldSearch = page.getByRole("combobox", { name: "Search fields or paste a lookup" });
  assert.equal(await fieldSearch.getAttribute("aria-autocomplete"), "list");
  assert.equal(await fieldSearch.getAttribute("aria-expanded"), "true");
  await capture(page, `explorer-${width}`);
  await page.getByRole("option", { name: "Choose company__user__email", exact: true }).click();
  await rows.first().getByLabel("Comparison value", { exact: true }).fill("@example.test");
  await page.waitForFunction(() => !document.getElementById("queryDrawerApply").disabled);
  await rows.first().getByLabel("Comparison value", { exact: true }).press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("queryFilterButton").textContent === "Filters 1");
  await page.locator("#queryClose").click();
  await page.locator("#queryFilterButton").click();
  assert.equal(await rows.first().getByLabel("Condition field", { exact: true }).getAttribute("title"), "company__user__email");
  const description = await rows.first().getByLabel("Condition field", { exact: true }).getAttribute("aria-describedby");
  assert.equal(await page.locator("#" + description).textContent(), "company › user › email");
  assert.equal(await rows.first().getByLabel("Comparison value", { exact: true }).inputValue(), "@example.test");

  await rows.first().getByLabel("Condition field", { exact: true }).click();
  await page.getByRole("button", { name: "Browse company", exact: true }).click();
  await page.getByRole("option", { name: "Choose company__name", exact: true }).click();
  await rows.first().getByLabel("Comparison value", { exact: true }).fill("Acme");
  await apply(page);
  await rows.first().getByLabel("Condition field", { exact: true }).click();
  await page.getByRole("button", { name: "Browse root fields", exact: true }).click();
  await page.getByRole("option", { name: "Choose is_active", exact: true }).click();
  assert.equal(await rows.first().getByLabel("Boolean value").inputValue(), "true");

  await root.getByRole("button", { name: "Add nested condition group", exact: true }).click();
  const nested = root.locator('.query-predicate-group[data-depth="2"]');
  await nested.getByRole("button", { name: "Add condition to this group", exact: true }).click();
  await pick(page, nested.locator('[data-role="comparison"]').first(), "company__user__email__iendswith");
  assert.equal(await nested.getByLabel("Comparison", { exact: true }).inputValue(), "iendswith");
  await nested.getByLabel("Comparison value", { exact: true }).fill("@example.test");
  await nested.locator('[data-role="comparison"]').first().getByRole("button", { name: "Duplicate", exact: true }).click();
  await nested.getByLabel("Comparison value", { exact: true }).last().fill("@partner.test");
  await nested.getByLabel("Join conditions", { exact: true }).selectOption("or");
  await nested.getByLabel("Negate condition", { exact: true }).last().check();
  await nested.getByLabel("Negate condition", { exact: true }).last().uncheck();
  await nested.getByLabel("Negate group", { exact: true }).check();
  await nested.getByLabel("Negate group", { exact: true }).uncheck();
  assert.equal(await page.locator("#queryBuilderTitle").textContent(), "Filters");
  await apply(page);
  const recipe = await page.evaluate(() => window.filterFixture.messages.filter((message) => message.type === "applyQueryRecipe").at(-1).recipe);
  assert.equal(recipe.where.join, "and");
  assert.equal(recipe.where.children[0].lhs.path, "is_active");
  assert.equal(recipe.where.children[1].join, "or");
  assert.equal(await page.locator("#queryFilterButton").textContent(), "Filters 3");
  assert.deepEqual(recipe.where.children[1].children.map((item) => [item.lhs.path, item.lookup, item.rhs.value]), [["company__user__email", "iendswith", "@example.test"], ["company__user__email", "iendswith", "@partner.test"]]);
  await page.locator("#queryEditorPane").hover();
  const scrollTop = await page.locator("#queryEditorPane").evaluate((node) => node.scrollTop);
  if (scrollTop) { await page.mouse.wheel(0, -scrollTop); }
  await page.waitForFunction(() => document.getElementById("queryEditorPane").scrollTop === 0);
  await capture(page, `composition-${width}`);
  await page.locator("#queryClose").click();
  await page.locator("#queryFilterButton").click();
  assert.equal(await page.locator("#queryBuilderTitle").textContent(), "Filters");
  assert.equal(await nested.getByLabel("Comparison value", { exact: true }).last().inputValue(), "@partner.test");
  console.log(`Searchable lookup and nested AND/OR passed at ${width} × ${height}.`);
}

/** Verifies metadata retry, keyboard search, empty states, and late-response protection. */
async function exerciseRecovery(page, url) {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(url + "?related-metadata-error=1");
  await page.waitForFunction(() => document.getElementById("title")?.textContent === "accounts.User");
  await page.locator("#queryFilterButton").click();
  await page.getByRole("button", { name: "Add condition to this group", exact: true }).click();
  await page.getByRole("option", { name: "Browse company", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor({ state: "visible" });
  await capture(page, "retry");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("option", { name: "Browse company__user", exact: true }).click();
  await page.getByRole("option", { name: "Choose company__user__is_active", exact: true }).click();
  assert.equal(await page.getByLabel("Boolean value").inputValue(), "true");
  await apply(page);
  await page.getByLabel("Condition field", { exact: true }).click();
  const search = page.getByRole("combobox", { name: "Search fields or paste a lookup" });
  await search.fill("unknown__field");
  await page.getByText("No field or relationship named", { exact: false }).waitFor();
  await capture(page, "no-matches");
  await search.press("Escape");
  assert.equal(await page.getByLabel("Condition field", { exact: true }).evaluate((node) => node === document.activeElement), true);

  await page.goto(url + "?slow-metadata=1");
  await page.waitForFunction(() => document.getElementById("title")?.textContent === "accounts.User");
  await page.locator("#queryFilterButton").click();
  await page.getByRole("button", { name: "Add condition to this group", exact: true }).click();
  await page.getByRole("option", { name: "Browse company", exact: true }).click();
  await search.press("ArrowDown");
  await search.press("ArrowUp");
  await page.getByRole("button", { name: "Browse root fields", exact: true }).click();
  await search.fill("username");
  await page.getByRole("option", { name: "Choose username", exact: true }).waitFor();
  await search.press("ArrowDown");
  await search.press("Enter");
  await page.getByLabel("Comparison value", { exact: true }).fill("mina");
  await apply(page);
  assert.equal(await page.getByLabel("Condition field", { exact: true }).getAttribute("title"), "username");
  assert.equal(await page.getByRole("dialog", { name: "Choose filter field" }).isVisible(), false);
  console.log("Retry, no matches, keyboard selection, focus return, and stale responses passed.");

  await page.locator("#queryWhereRoot").getByLabel("Comparison", { exact: true }).selectOption("iexact");
  await page.locator("#queryWhereRoot").getByLabel("Compare with", { exact: true }).selectOption("field");
  await page.getByLabel("Compare to field", { exact: true }).selectOption("email");
  await page.locator("#queryWhereRoot").getByRole("button", { name: "Add condition to this group", exact: true }).click();
  const dateRow = page.locator('#queryWhereRoot [data-role="comparison"]').last();
  await pick(page, dateRow, "created_at");
  await dateRow.getByLabel("Comparison", { exact: true }).selectOption("gte");
  await dateRow.getByLabel("Compare with", { exact: true }).selectOption("relativeTime");
  await dateRow.getByLabel("Relative time amount", { exact: true }).fill("7");
  await dateRow.getByLabel("Relative time unit", { exact: true }).selectOption("days");
  await dateRow.getByLabel("Relative time anchor", { exact: true }).selectOption("today");
  await apply(page);
  const typed = await page.evaluate(() => window.filterFixture.messages.filter((message) => message.type === "applyQueryRecipe").at(-1).recipe.where.children);
  assert.deepEqual(typed.map((item) => item.rhs), [{ kind: "field", path: "email" }, { amount: 7, anchor: "today", direction: "past", kind: "relativeTime", unit: "days" }]);
  console.log("Field-to-field and relative-date filters remain editable in the composer.");
}

/** Runs the browser checks and releases only its own processes and fixture server. */
async function main() {
  const { chromium } = await import(process.env.DJANGO_SHELL_PLAYWRIGHT || "playwright");
  const fixture = await serveFilterBrowser();
  let browser, page;
  const errors = [];
  fs.mkdirSync(results, { recursive: true });
  try {
    browser = await chromium.launch({ executablePath: process.env.DJANGO_SHELL_CHROMIUM_EXECUTABLE, headless: true });
    page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(String(error)));
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) { await exercise(page, fixture.url, width, height); }
    await exerciseRecovery(page, fixture.url);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error("Browser errors:", errors);
    await page?.screenshot({ path: path.join(results, "filter-lookup-failed.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await fixture.close(); }
}

await main();

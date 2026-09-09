// Exercises production filter controls, preserved query state, and responsive layouts in an isolated Chromium window.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { serveFilterBrowser } from "./fixtures/filterBrowser.mjs";

const results = path.resolve(import.meta.dirname, "../.vscode-test/results");

/** Waits for the current revision to finish validation rather than using an arbitrary delay. */
async function readyToApply(page) { await page.waitForFunction(() => !document.getElementById("queryDrawerApply").disabled); }

/** Returns backend apply requests observed by the fixture without touching product state. */
async function applications(page) { return page.evaluate(() => window.filterFixture.messages.filter((message) => message.type === "applyQueryRecipe")); }

/** Adds one real condition using the visible field selector. */
async function addCondition(page, field) {
  await page.getByRole("button", { name: "Add condition to this group", exact: true }).first().click();
  const row = page.locator("#queryWhereRoot [data-role=comparison]").last();
  await page.getByRole("combobox", { name: "Search fields or paste a lookup" }).fill(field);
  await page.getByRole("option", { name: "Choose " + field, exact: true }).click();
  return row;
}

/** Saves a stable state and checks viewport overflow independently of the scrollable data grid. */
async function capture(page, name) {
  await page.screenshot({ path: path.join(results, `filter-${name}.png`), fullPage: true });
  const geometry = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, apply: document.getElementById("queryDrawerApply").getBoundingClientRect().toJSON() }));
  assert.ok(geometry.documentWidth <= geometry.width + 1, JSON.stringify(geometry));
  assert.ok(geometry.apply.x >= 0 && geometry.apply.right <= geometry.width + 1, JSON.stringify(geometry));
}

/** Verifies filtering, OR, keyboard Apply, removal, Undo, focus return, and advanced editing at one width. */
async function exerciseFilters(page, url, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById("title")?.textContent === "accounts.User");
  await page.locator("#queryFilterButton").click();
  await page.locator("#queryAdvancedBuilder").waitFor({ state: "visible" });
  assert.equal(await page.locator("#queryDirtyState").isVisible(), false, "opening filters must not edit the draft");
  assert.equal(await page.locator("#queryReviewPane").isVisible(), false);
  await capture(page, `${width}-empty`);

  const textRow = await addCondition(page, "username");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Comparison value");
  assert.equal(await textRow.getByLabel("Comparison", { exact: true }).inputValue(), "icontains");
  await textRow.getByLabel("Comparison value", { exact: true }).fill("alex");
  const booleanRow = await addCondition(page, "is_active");
  assert.equal(await booleanRow.getByLabel("Boolean value").inputValue(), "true");
  await page.locator("#queryWhereRoot").getByLabel("Join conditions", { exact: true }).selectOption("or");
  await readyToApply(page);
  assert.equal((await applications(page)).length, 0, "draft editing does not execute a query");
  const toolbar = await page.evaluate(() => ({ add: document.querySelector('#queryWhereRoot button[aria-label="Add condition to this group"]').getBoundingClientRect().toJSON(), pane: document.getElementById("queryEditorPane").getBoundingClientRect().toJSON() }));
  assert.ok(toolbar.add.bottom <= toolbar.pane.bottom, "two conditions must leave Add condition fully visible: " + JSON.stringify(toolbar));
  await capture(page, `${width}-draft`);
  await page.getByLabel("Comparison value", { exact: true }).press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("queryFilterButton").textContent === "Filters 2");
  const applied = (await applications(page)).at(-1).recipe;
  assert.equal(applied.where.join, "or");
  assert.deepEqual(applied.where.children.map((item) => item.rhs.value), ["alex", true]);
  await capture(page, `${width}-applied`);

  await page.getByRole("button", { name: "Clear row filters", exact: true }).click();
  assert.equal((await applications(page)).length, 1, "clearing edits only the draft");
  assert.equal(await page.locator("#queryFilterButton").textContent(), "Filters 2");
  await page.locator("#queryUndo").click();
  await page.waitForFunction(() => document.querySelectorAll("#queryWhereRoot [data-role=comparison]").length === 2);
  await page.getByRole("button", { name: "Clear row filters", exact: true }).click();
  await readyToApply(page);
  await page.locator("#queryDrawerApply").click();
  await page.waitForFunction(() => document.getElementById("queryFilterButton").textContent === "Filters 0");
  await page.locator("#queryClose").click();
  assert.equal(await page.locator("#queryFilterButton").evaluate((node) => node === document.activeElement), true);

  await page.locator("#queryFilterButton").click();
  const numberRow = await addCondition(page, "login_count");
  await numberRow.getByLabel("Comparison", { exact: true }).selectOption("range");
  await numberRow.getByLabel("Range lower bound").fill("2");
  await numberRow.getByLabel("Range upper bound").fill("10");
  await readyToApply(page);
  await capture(page, `${width}-range`);
  await page.locator("#queryAdvancedBuilder").click();
  assert.equal(await page.getByLabel("Range lower bound").inputValue(), "2");
  assert.equal((await applications(page)).length, 2, "switching to advanced editing does not apply");
  await page.getByRole("button", { name: "Add nested condition group", exact: true }).first().click();
  await page.locator("#queryClose").click();
  await page.locator("#queryFilterButton").click();
  assert.equal(await page.locator("#queryBuilderTitle").textContent(), "Filters", "nested groups remain editable in the filter composer");
  console.log(`Filter interactions passed at ${width} × 900.`);
}

/** Verifies recoverable metadata and Apply failures retain useful controls and the previous grid rows. */
async function exerciseFailures(page, url) {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(url + "?metadata-error=1");
  await page.waitForFunction(() => document.getElementById("title")?.textContent === "accounts.User");
  await page.locator("#queryFilterButton").click();
  await page.getByRole("button", { name: "Retry", exact: true }).first().waitFor({ state: "visible" });
  await capture(page, "metadata-error");
  await page.evaluate(() => { window.filterFixture.metadataError = false; });
  await page.getByRole("button", { name: "Retry", exact: true }).first().click();
  const row = await addCondition(page, "email");
  await row.getByLabel("Comparison value", { exact: true }).fill("@example.test");
  await readyToApply(page);
  await page.evaluate(() => { window.filterFixture.rejectApply = true; });
  await page.locator("#queryDrawerApply").click();
  await page.locator("#queryProblemsPanel").waitFor({ state: "visible" });
  assert.match(await page.locator("#queryIssueSummary").textContent(), /could not apply/);
  assert.equal(await page.getByLabel("Comparison value", { exact: true }).inputValue(), "@example.test");
  assert.equal(await page.locator("#tbody tr").count(), 2);
  await capture(page, "apply-error");
  console.log("Metadata retry and server-rejection recovery passed.");
}

/** Checks structured list editing, numeric choices, long labels, theme tokens, and forced colors. */
async function exerciseTypedAndAppearance(page, url) {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById("title")?.textContent === "accounts.User");
  await page.locator("#queryFilterButton").click();
  const listRow = await addCondition(page, "login_count");
  await listRow.getByLabel("Comparison", { exact: true }).selectOption("in");
  const input = listRow.getByRole("spinbutton", { name: "Add list value", exact: true });
  for (const value of ["2", "10", "3"]) { await input.fill(value); await input.press("Enter"); }
  await listRow.getByRole("button", { name: "Remove 2", exact: true }).click();
  const choiceRow = await addCondition(page, "status");
  await choiceRow.getByLabel("Field value", { exact: true }).selectOption("2");
  const longRow = await addCondition(page, "long_customer_reference");
  const longValue = "regional-account-고객-reference-".repeat(8);
  await longRow.getByLabel("Comparison value", { exact: true }).fill(longValue);
  await readyToApply(page);
  await page.locator("#queryDrawerApply").click();
  await page.waitForFunction(() => document.getElementById("queryFilterButton").textContent === "Filters 3");
  const conditions = (await applications(page)).at(-1).recipe.where.children;
  assert.deepEqual(conditions.map((item) => item.rhs), [{ kind: "list", values: [10, 3] }, { kind: "literal", value: 2 }, { kind: "literal", value: longValue }]);
  const light = await page.addStyleTag({ content: ":root{color-scheme:light;--vscode-foreground:#333;--vscode-descriptionForeground:#616161;--vscode-disabledForeground:#767676;--vscode-editor-background:#fff;--vscode-editorGroupHeader-tabsBackground:#f3f3f3;--vscode-editorWidget-background:#f3f3f3;--vscode-panel-border:#ccc;--vscode-input-background:#fff;--vscode-input-foreground:#333;--vscode-input-border:#767676;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#333;--vscode-dropdown-background:#fff;--vscode-dropdown-foreground:#333;--vscode-dropdown-border:#767676;--vscode-list-hoverBackground:#eee;--vscode-badge-background:#ddd;--vscode-badge-foreground:#333}" });
  await capture(page, "light-long-values");
  await light.evaluate((node) => node.remove());
  await page.emulateMedia({ forcedColors: "active" });
  await page.getByLabel("Comparison value", { exact: true }).focus();
  await capture(page, "high-contrast");
  await page.emulateMedia({ forcedColors: "none" });
  console.log("List editing, numeric choices, long values, light theme, and high contrast passed.");
}

/** Runs the browser inventory and always closes its owned pages, processes, and fixture server. */
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
    for (const width of [390, 768, 1440]) { await exerciseFilters(page, fixture.url, width); }
    await exerciseFailures(page, fixture.url);
    await exerciseTypedAndAppearance(page, fixture.url);
    assert.deepEqual(errors, []);
  } catch (error) {
    await page?.screenshot({ path: path.join(results, "filter-failed.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await fixture.close(); }
}

await main();

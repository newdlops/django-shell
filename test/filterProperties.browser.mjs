// Exercises model-property selection, typed values, validation recovery, and responsive production filter UI.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { serveFilterBrowser } from "./fixtures/filterBrowser.mjs";

const results = path.resolve(import.meta.dirname, "../.vscode-test/results");

/** Adds a property by keyboard search and commits its complete field/lookup selection. */
async function add(page, name) {
  await page.getByRole("button", { name: "Add condition to this group", exact: true }).first().click();
  const search = page.getByRole("combobox", { name: "Search fields or paste a lookup" });
  await search.fill(name);
  await page.getByRole("option", { name: `Choose ${name}`, exact: true }).waitFor();
  await search.press("Enter");
  const rows = page.locator('#queryWhereRoot [data-role="comparison"]');
  return rows.nth(await rows.count() - 1);
}

/** Applies only the validated revision through the same control used by the live extension. */
async function apply(page) {
  await page.waitForFunction(() => !document.getElementById("queryDrawerApply").disabled);
  await page.locator("#queryDrawerApply").click();
  await page.waitForFunction(() => document.querySelector(".query-draft-status")?.textContent.includes("matches"));
  return page.evaluate(() => window.filterFixture.messages.filter((message) => message.type === "applyQueryRecipe").at(-1).recipe);
}

/** Checks reachable controls and saves actual rendered evidence independently of the data grid's horizontal scroll. */
async function capture(page, name) {
  const bounds = await page.evaluate(() => ({ width: innerWidth, page: document.documentElement.scrollWidth, controls: [...document.querySelectorAll('.query-field-trigger,.query-property-input input,.query-property-input select,select[aria-label="Property value type"],#queryDrawerApply')].map((node) => node.getBoundingClientRect().toJSON()) }));
  assert.ok(bounds.page <= bounds.width + 1, JSON.stringify(bounds));
  assert.ok(bounds.controls.every((rect) => rect.width > 0 && rect.x >= 0 && rect.right <= bounds.width + 1), JSON.stringify(bounds));
  await page.screenshot({ path: path.join(results, `filter-properties-${name}.png`), fullPage: true });
}

/** Verifies typed property input, saved draft, unsupported OR recovery, and list/range editing at one viewport. */
async function exercise(page, url, width, height) {
  await page.setViewportSize({ width, height });
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById("title")?.textContent === "accounts.User");
  await page.locator("#queryFilterButton").click();
  await page.getByRole("button", { name: "Add condition to this group", exact: true }).click();
  await page.getByText("Model properties", { exact: true }).waitFor();
  await page.getByRole("combobox", { name: "Search fields or paste a lookup" }).fill("display_name__icontains");
  await page.getByRole("option", { name: "Choose display_name__icontains", exact: true }).waitFor();
  await capture(page, `picker-${width}`);
  await page.getByRole("combobox", { name: "Search fields or paste a lookup" }).press("Enter");
  const rows = page.locator('#queryWhereRoot [data-role="comparison"]');
  const text = rows.first();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Comparison value");
  await text.getByLabel("Comparison value", { exact: true }).fill("001");
  assert.equal(await text.getByLabel("Property value type").inputValue(), "text");
  const number = await add(page, "total_price__gte");
  assert.equal(await number.getByLabel("Property value type").inputValue(), "number");
  await number.getByLabel("Comparison value", { exact: true }).fill("10000.5");
  const boolean = await add(page, "eligible");
  await boolean.getByLabel("Property value type").selectOption("boolean");
  await boolean.getByLabel("Boolean value").selectOption("false");
  const applied = await apply(page);
  assert.deepEqual(applied.where.children.map((item) => item.rhs.value), ["001", 10000.5, false]);
  await page.locator("#queryClose").click();
  await page.locator("#queryFilterButton").click();
  assert.equal(await number.getByLabel("Property value type").inputValue(), "number");
  assert.equal(await boolean.getByLabel("Boolean value").inputValue(), "false");
  await page.locator("#queryEditorPane").evaluate((node) => { node.scrollTop = 0; });
  await capture(page, `typed-${width}`);

  await page.locator("#queryWhereRoot").getByLabel("Join conditions", { exact: true }).selectOption("or");
  await page.locator(".query-predicate-issues").getByText("Use this property as a direct root AND condition.", { exact: false }).first().waitFor();
  assert.equal(await page.locator("#queryDrawerApply").isDisabled(), true);
  await capture(page, `unsupported-${width}`);
  await page.locator("#queryWhereRoot").getByLabel("Join conditions", { exact: true }).selectOption("and");
  await number.getByLabel("Comparison", { exact: true }).selectOption("range");
  await number.getByLabel("Range lower bound").fill("10.5");
  await number.getByLabel("Range upper bound").fill("20.5");
  await text.getByLabel("Comparison", { exact: true }).selectOption("in");
  await text.getByLabel("Add list value", { exact: true }).first().fill("false");
  await text.getByRole("button", { name: "Add list value", exact: true }).click();
  await boolean.getByLabel("Comparison", { exact: true }).selectOption("in");
  await boolean.getByRole("combobox", { name: "Add list value", exact: true }).selectOption("false");
  await boolean.getByRole("button", { name: "Add list value", exact: true }).click();
  const range = await apply(page);
  assert.deepEqual(range.where.children[0].rhs, { kind: "list", values: ["false"] });
  assert.deepEqual(range.where.children[1].rhs, { kind: "range", lower: 10.5, upper: 20.5 });
  assert.deepEqual(range.where.children[2].rhs, { kind: "list", values: [false] });
  assert.ok((await page.locator("#queryAppliedWhere").textContent()).includes("total_price range [10.5, 20.5]"), "the applied summary shows the actual range bounds");
  await capture(page, `range-list-${width}`);
  console.log(`Property filters passed at ${width} × ${height}.`);
}

/** Runs production UI checks in an isolated browser and closes only the fixture's own processes. */
async function main() {
  const { chromium } = await import(process.env.DJANGO_SHELL_PLAYWRIGHT || "playwright");
  const fixture = await serveFilterBrowser();
  let browser, page;
  const errors = [];
  fs.mkdirSync(results, { recursive: true });
  try {
    browser = await chromium.launch({ executablePath: process.env.DJANGO_SHELL_CHROMIUM_EXECUTABLE, headless: true });
    page = await browser.newPage(); page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(String(error)));
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) { await exercise(page, fixture.url, width, height); }
    const light = await page.addStyleTag({ content: ":root{color-scheme:light;--vscode-foreground:#333;--vscode-descriptionForeground:#616161;--vscode-disabledForeground:#767676;--vscode-editor-background:#fff;--vscode-editorGroupHeader-tabsBackground:#f3f3f3;--vscode-editorWidget-background:#f3f3f3;--vscode-panel-border:#ccc;--vscode-input-background:#fff;--vscode-input-foreground:#333;--vscode-input-border:#767676;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#333;--vscode-dropdown-background:#fff;--vscode-dropdown-foreground:#333;--vscode-dropdown-border:#767676;--vscode-list-hoverBackground:#eee;--vscode-badge-background:#ddd;--vscode-badge-foreground:#333}" });
    await capture(page, "light"); await light.evaluate((node) => node.remove());
    await page.emulateMedia({ forcedColors: "active" }); await capture(page, "contrast");
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error("Browser errors:", errors);
    await page?.screenshot({ path: path.join(results, "filter-properties-failed.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await fixture.close(); }
}

await main();

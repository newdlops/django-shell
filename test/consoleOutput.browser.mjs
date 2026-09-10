// Exercises execution disclosures, streaming output retention, scrolling, and keyboard use in the real renderer.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { serveConsoleBrowser } from "./fixtures/consoleBrowser.mjs";

const results = path.resolve(import.meta.dirname, "../.vscode-test/results");
const longOutput = Array.from({ length: 1000 }, (_, index) => `row ${index + 1}: company__user__email = user${index}@example.test`).join("\n");
const longError = Array.from({ length: 18 }, (_, index) => `  File "report.py", line ${index + 1}, in generate_report`).join("\n") + "\nValueError: Missing company";

/** Delivers deterministic host messages through the production listener. */
async function send(page, ...messages) {
  await page.evaluate((events) => { for (const event of events) { window.consoleFixture.send(event); } }, messages);
}

/** Returns the stable execution row without depending on its current expansion state. */
function execution(page, count) { return page.locator(`.outputItem[data-execution="${count}"]`); }

/** Executes a complete host lifecycle while retaining the exact input and result payloads. */
async function complete(page, count, code, text, ok = true) {
  await send(page, { type: "pythonStarted", execution: count, code }, { type: "pythonResult", execution: count, code, text, ok });
}

/** Checks output controls fit their panel and captures the actual rendered output surface. */
async function capture(page, name) {
  const bounds = await page.evaluate(() => {
    const output = document.getElementById("currentOutput");
    return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, outputWidth: output.clientWidth, outputScrollWidth: output.scrollWidth, controls: [...output.querySelectorAll("button")].map((control) => control.getBoundingClientRect().toJSON()) };
  });
  assert.ok(bounds.documentWidth <= bounds.width + 1, JSON.stringify(bounds));
  assert.ok(bounds.outputScrollWidth <= bounds.outputWidth + 1, JSON.stringify(bounds));
  assert.ok(bounds.controls.every((control) => control.x >= 0 && control.right <= bounds.width + 1 && control.height >= 24), JSON.stringify(bounds));
  await page.locator("#currentOutput").screenshot({ path: path.join(results, `console-accordion-${name}.png`) });
}

/** Opens a clean, ready console before each independent scenario. */
async function open(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById("status")?.dataset.ready === "true");
  assert.equal(await page.locator("#currentOutput").isVisible(), false);
}

/** Verifies default expansion, bulk actions, exact log retention, and keyboard controls at each viewport. */
async function exerciseLayout(page, url, width, height) {
  await page.setViewportSize({ width, height });
  await open(page, url);
  await complete(page, 1, "Company.objects.count()", "42");
  await complete(page, 2, "for user in User.objects.select_related('company'):\n    print(user.email)", longOutput);
  await complete(page, 3, "cache.clear()", "");
  assert.equal(await execution(page, 1).getByRole("button").getAttribute("aria-expanded"), "true");
  assert.equal(await execution(page, 2).getByRole("button").getAttribute("aria-expanded"), "false");
  assert.equal(await execution(page, 2).locator(".outputSummary").textContent(), "1,000 lines");
  assert.equal(await execution(page, 2).locator(".result").textContent(), longOutput);
  assert.equal(await execution(page, 3).locator(".result").textContent(), "No output");
  assert.ok(await page.locator("#currentOutput").evaluate((node) => node.scrollHeight < 400));
  await capture(page, `mixed-${width}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(results, `console-accordion-page-${width}.png`), fullPage: true });

  await execution(page, 2).getByRole("button", { name: "In [2] for user in User.objects.select_related('company'):", exact: true }).click();
  assert.equal(await execution(page, 2).locator(".result").isVisible(), true);
  assert.equal(await execution(page, 2).locator(".inputSource").textContent(), "for user in User.objects.select_related('company'):\n    print(user.email)");
  const expandedHeight = await page.locator("#currentOutput").evaluate((node) => node.scrollHeight);
  assert.ok(expandedHeight > 15000, String(expandedHeight));
  const toggle = execution(page, 2).getByRole("button");
  await toggle.press("Enter");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await toggle.evaluate((node) => node === document.activeElement), true);
  await toggle.press("Space");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  const controls = await toggle.getAttribute("aria-controls");
  assert.equal(await execution(page, 2).locator(".outputDetails").getAttribute("id"), controls);
  await page.locator("#currentOutput").hover();
  await page.mouse.wheel(0, 700);
  await page.waitForFunction(() => document.getElementById("currentOutput").scrollTop > 500);
  const sticky = await toggle.boundingBox();
  const toolbar = await page.locator(".outputToolbar").boundingBox();
  assert.ok(sticky.y >= toolbar.y + toolbar.height - 1, JSON.stringify({ sticky, toolbar }));
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");

  await page.getByRole("button", { name: "Collapse all", exact: true }).click();
  assert.equal(await page.locator('.outputHeader[aria-expanded="true"]').count(), 0);
  assert.equal(await page.locator("#collapseOutputs").evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator("#expandOutputs").evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Enter");
  assert.equal(await page.locator('.outputHeader[aria-expanded="true"]').count(), 3);
  assert.equal(await page.locator("#expandOutputs").getAttribute("aria-disabled"), "true");
  await page.getByRole("button", { name: "Collapse all", exact: true }).click();
  await complete(page, 4, "generate_report()", longError, false);
  assert.equal(await execution(page, 4).getByRole("button").getAttribute("aria-expanded"), "true");
  assert.match(await execution(page, 4).locator(".outputStatus").textContent(), /^Error · /);
  await capture(page, `error-${width}`);
  await execution(page, 4).getByRole("button").click();
  await capture(page, `collapsed-${width}`);
  assert.equal(await page.evaluate(() => window.consoleFixture.messages.some((message) => message.type === "runPython")), false);
  console.log(`Output retention, independent/bulk disclosure, keyboard, sticky headers, and errors passed at ${width} × ${height}.`);
}

/** Exercises running choices, timers, carriage returns, reading position, and output cleanup. */
async function exerciseStreaming(page, url) {
  await page.setViewportSize({ width: 768, height: 1024 });
  await open(page, url);
  await send(page, { type: "pythonStarted", execution: 1, code: "import_all_companies()" });
  await execution(page, 1).getByRole("button").click();
  await send(page, { type: "pythonProgress", execution: 1, progress: { output: "10%\r20%\n" } });
  assert.equal(await execution(page, 1).locator(".result").textContent(), "20%\n");
  await page.waitForFunction(() => document.querySelector(".outputStatus").textContent !== "running 0s");
  assert.equal(await execution(page, 1).getByRole("button").getAttribute("aria-expanded"), "false");
  await capture(page, "streaming-collapsed");
  await send(page, { type: "pythonResult", execution: 1, text: longOutput, ok: true });
  assert.equal(await execution(page, 1).getByRole("button").getAttribute("aria-expanded"), "false");
  assert.equal(await execution(page, 1).locator(".result").textContent(), longOutput);
  await send(page, { type: "pythonStarted", execution: 2, code: "print_live_rows()" });
  const toggle = execution(page, 2).getByRole("button");
  await toggle.click();
  await toggle.click();
  const prefix = longOutput.slice(0, 9000);
  await send(page, { type: "pythonProgress", execution: 2, progress: { output: prefix } });
  await page.locator("#currentOutput").hover();
  await page.mouse.wheel(0, -20000);
  await page.waitForFunction(() => document.getElementById("currentOutput").scrollTop === 0);
  await send(page, { type: "pythonProgress", execution: 2, progress: { output: "\nNew row arrived\n" } });
  assert.equal(await page.locator("#currentOutput").evaluate((node) => node.scrollTop), 0);
  await send(page, { type: "pythonResult", execution: 2, text: longOutput, ok: true });
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#currentOutput").evaluate((node) => node.scrollTop), 0);

  await page.getByRole("button", { name: "Clear", exact: true }).click();
  assert.equal(await page.locator("#currentOutput").isVisible(), false);
  assert.equal(await page.locator(".outputItem").count(), 0);
  await send(page, { type: "pythonStarted", execution: 3, code: "debug_print()", debugRun: true });
  assert.equal(await page.locator(".outputItem").count(), 0);
  await send(page, { type: "pythonProgress", execution: 3, progress: { output: "Debug output" } });
  assert.equal(await execution(page, 3).locator(".inputSource").textContent(), "debug_print()");
  await execution(page, 3).getByRole("button").click();
  await send(page, { type: "pythonResult", execution: 3, text: "ValueError: test", ok: false });
  assert.equal(await execution(page, 3).getByRole("button").getAttribute("aria-expanded"), "false");
  assert.match(await execution(page, 3).locator(".outputStatus").textContent(), /^Error/);
  await page.getByRole("button", { name: "Restart Kernel", exact: true }).click();
  assert.equal(await page.locator(".outputItem").count(), 0);
  await complete(page, 1, "print('new session')", "new session");
  assert.equal(await execution(page, 1).getByRole("button").getAttribute("aria-expanded"), "true");
  console.log("Streaming, elapsed status, explicit choices, scroll preservation, Clear, debug output, and Restart passed.");
}

/** Keeps long completions open when a reader has selected output or focused its disclosure. */
async function exerciseReaders(page, url) {
  await open(page, url);
  await send(page, { type: "pythonStarted", execution: 1, code: "print_live_rows()" }, { type: "pythonProgress", execution: 1, progress: { output: "Read this output while the execution is still running" } });
  await execution(page, 1).locator(".result").click({ clickCount: 3 });
  assert.ok(await page.evaluate(() => String(window.getSelection()).length > 0));
  await send(page, { type: "pythonResult", execution: 1, text: longOutput, ok: true });
  assert.equal(await execution(page, 1).getByRole("button").getAttribute("aria-expanded"), "true");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await send(page, { type: "pythonStarted", execution: 2, code: "next_report()" });
  await execution(page, 2).getByRole("button").focus();
  await send(page, { type: "pythonResult", execution: 2, text: longOutput, ok: true });
  assert.equal(await execution(page, 2).getByRole("button").getAttribute("aria-expanded"), "true");
  assert.equal(await execution(page, 2).getByRole("button").evaluate((node) => node === document.activeElement), true);
  console.log("Text selection and keyboard focus prevent an unexpected automatic collapse.");
}

/** Checks theme, contrast, reduced motion, zoom, wide text, and keyboard focus presentation. */
async function exerciseThemes(page, url) {
  for (const theme of ["light", "contrast"]) {
    await open(page, `${url}?theme=${theme}`);
    await complete(page, 1, "print('아주 긴 결과 — ' + 'x' * 4000)", "x".repeat(4000));
    await complete(page, 2, "generate_report()", "ValueError: Missing company", false);
    await execution(page, 1).getByRole("button").click();
    await page.locator("#expandOutputs").focus();
    await page.keyboard.press("Tab");
    assert.equal(await execution(page, 1).getByRole("button").evaluate((node) => node.matches(":focus-visible")), true);
    assert.equal(await execution(page, 1).getByRole("button").evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
    await capture(page, theme);
    await execution(page, 2).getByRole("button").hover();
    const colors = await execution(page, 2).locator(".outputStatus").evaluate((node) => [getComputedStyle(node).color, getComputedStyle(node.closest("button")).backgroundColor]);
    assert.ok(contrastRatio(...colors) >= 4.5, `Error status hover contrast: ${colors.join(" / ")}`);
    await capture(page, `${theme}-error-hover`);
  }
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await capture(page, "forced-colors");
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 780, height: 1200 });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await capture(page, "zoom-200");
  console.log("Light/high-contrast themes, forced colors, 200% zoom, long lines, and visible keyboard focus passed.");
}

/** Calculates WCAG text contrast from computed opaque browser RGB colors. */
function contrastRatio(foreground, background) {
  /** Converts an sRGB color to its relative luminance. */
  function luminance(color) {
    const channels = color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map((value) => Number(value) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
  return (values[1] + 0.05) / (values[0] + 0.05);
}

/** Runs browser regression checks and releases only its own browser and fixture resources. */
async function main() {
  const { chromium } = await import(process.env.DJANGO_SHELL_PLAYWRIGHT || "playwright");
  const fixture = await serveConsoleBrowser();
  let browser, page;
  const errors = [];
  fs.mkdirSync(results, { recursive: true });
  try {
    browser = await chromium.launch({ executablePath: process.env.DJANGO_SHELL_CHROMIUM_EXECUTABLE, headless: true });
    page = await browser.newPage({ locale: "en-US" });
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) { await exerciseLayout(page, fixture.url, width, height); }
    await exerciseStreaming(page, fixture.url);
    await exerciseReaders(page, fixture.url);
    await exerciseThemes(page, fixture.url);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error("Browser errors:", errors);
    await page?.screenshot({ path: path.join(results, "console-accordion-failed.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await fixture.close(); }
}

await main();

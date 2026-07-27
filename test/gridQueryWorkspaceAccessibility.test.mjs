// Static accessibility contracts for the Model Data Query Builder workspace.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../src/modelBrowserHtml.ts", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../media/modelQueryBuilder.css", import.meta.url), "utf8");
const workspaceCss = fs.readFileSync(new URL("../media/modelQueryWorkspace.css", import.meta.url), "utf8");

/** Returns all literal element identifiers declared by the webview source template. */
function ids(source) { return [...source.matchAll(/id="([^"]+)"/g)].map((match) => match[1]); }

test("Query Builder IDs are unique and hidden stage panels are inert", () => {
  const values = ids(html);
  assert.equal(new Set(values).size, values.length, "the webview must not emit duplicate IDs");
  assert.match(html, /id="queryDrawer"[^>]*aria-labelledby="queryBuilderTitle"/);
  for (const panel of ["queryCalculatedValuesPanel", "queryFilterResultsPanel", "queryResultPanel"]) {
    assert.match(html, new RegExp(`id="${panel}"[^>]*hidden inert aria-hidden="true"`));
  }
});

test("Query Builder controls expose tabs, visible labels, and one primary Apply", () => {
  assert.match(html, /id="queryStageNav"[^>]*role="tablist"/);
  assert.match(html, /id="queryInspectorTabs"[^>]*role="tablist"/);
  assert.match(html, /id="queryDrawerResizeHandle"[^>]*role="separator"/);
  assert.match(html, /id="queryDrawerApply"[^>]*aria-describedby="queryDrawerApplyHelp"/);
  assert.equal((html.match(/id="queryApply"/g) || []).length, 0, "the summary never duplicates the drawer Apply action");
});

test("Query Builder validation supplies an invalid state and a retained accessible description", () => {
  const validation = fs.readFileSync(new URL("../media/gridQueryValidationView.js", import.meta.url), "utf8");
  assert.match(validation, /applyQueryValidationAnnotations/);
  assert.match(validation, /aria-invalid/);
  assert.match(validation, /aria-describedby/);
  assert.match(validation, /data-query-control-key/);
});

test("Query Builder tabs select controlled panels and make inactive review panels inert", () => {
  for (const [tab, panel, selected] of [
    ["queryStageFilterRows", "queryFilterRowsPanel", "true"],
    ["queryStageCalculatedValues", "queryCalculatedValuesPanel", "false"],
    ["queryStageFilterResults", "queryFilterResultsPanel", "false"],
    ["queryStageResult", "queryResultPanel", "false"],
    ["queryInspectorMeaning", "queryMeaningPanel", "true"],
    ["queryInspectorProblems", "queryProblemsPanel", "false"],
    ["queryInspectorOrm", "queryOrmPanel", "false"]
  ]) {
    assert.match(html, new RegExp(`id="${tab}"[^>]*aria-controls="${panel}"[^>]*aria-selected="${selected}"`));
  }
  for (const panel of ["queryProblemsPanel", "queryOrmPanel"]) {
    assert.match(html, new RegExp(`id="${panel}"[^>]*hidden inert aria-hidden="true"`));
  }
  assert.match(fs.readFileSync(new URL("../media/gridQueryWorkspace.js", import.meta.url), "utf8"), /panel\.inert = !selected/);
});

test("Query Builder provides focused skip links to every major workspace region", () => {
  for (const [label, target] of [["Skip to query stages", "queryStageNav"], ["Skip to active editor", "queryEditorPane"], ["Skip to query review", "queryReviewPane"], ["Skip to Apply query", "queryDrawerApply"]]) {
    assert.match(html, new RegExp(`data-query-skip-target="${target}"[^>]*>${label}`));
  }
});

test("Query Builder maintains explicit forced-color and reduced-motion contracts", () => {
  assert.match(css, /@media \(forced-colors:active\)/);
  assert.match(css, /\.query-popover/);
  assert.match(css, /\.query-issue-item/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(workspaceCss, /query-focus-mode/);
  assert.match(html, /"modelQueryWorkspace\.css".*"modelQueryControls\.css".*"modelQueryPopover\.css"/);
});

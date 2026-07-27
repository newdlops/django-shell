// Guards the model-only Query Builder shell against legacy bar and unsafe rendering regressions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("model browser declares every stable Query Builder shell target", () => {
  const html = read("src/modelBrowserHtml.ts");
  for (const id of ["querySummaryBand", "queryFilterButton", "queryColumnsButton", "queryModeButton", "queryHumanSummary", "queryDirtyState", "queryValidationState", "queryDrawerToggle", "queryDrawer", "queryBuilderTitle", "queryDrawerResizeHandle", "queryDrawerHeader", "queryUndo", "queryRedo", "queryFocusMode", "queryMoreActions", "queryClose", "queryStageNav", "queryStageSelect", "queryMobilePaneSwitch", "queryEditorPane", "queryFilterRowsPanel", "queryCalculatedValuesPanel", "queryFilterResultsPanel", "queryResultPanel", "queryReviewPane", "queryInspectorTabs", "queryMeaningPanel", "queryProblemsPanel", "queryOrmPanel", "queryDrawerFooter", "queryDrawerStatus", "queryDrawerApply", "queryPopoverLayer", "queryStageFilterRows", "queryStageCalculatedValues", "queryStageFilterResults", "queryStageResult", "queryWhereSection", "queryWhereRoot", "queryComputedSection", "queryComputedList", "queryPostFilterSection", "queryPostFilterRoot", "queryResultSection", "queryGroupBy", "queryOrderBy", "queryPreviewSection", "queryInspectorMeaning", "queryInspectorProblems", "queryInspectorOrm", "queryOrmPreview", "queryIssueSummary", "queryResetDraft", "queryClearDraft"]) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.ok(html.includes('options.mode === "model"'), "the Query Builder is model-mode only");
  assert.ok(html.includes('id="querybar"'), "custom ORM Query keeps its independent editor");
  assert.equal(html.includes('id="aggregatebar"'), false, "legacy aggregate bar is removed from HTML");
  assert.equal(html.includes('id="addFilter"'), false, "legacy inline filter controls are removed from HTML");
  assert.equal(html.includes('id="queryApply"'), false, "the workspace exposes one Apply entry point in its footer");
});

test("Query Builder uses a separate theme-token stylesheet and modular controller", () => {
  const html = read("src/modelBrowserHtml.ts");
  const css = read("media/modelQueryBuilder.css");
  const source = read("media/modelBrowserSource.js");
  const controller = read("media/gridQueryController.js");
  const issueTarget = read("media/gridQueryIssueTarget.js");
  const workspace = read("media/gridQueryWorkspace.js");

  assert.ok(html.includes('"modelQueryBuilder.css"'));
  assert.ok(css.includes("var(--vscode-panel-border)") && css.includes("@media (max-width:639px)"));
  assert.ok(css.includes(".query-more-menu[hidden]{display:none}"), "the hidden recovery menu cannot remain in the accessibility tree");
  assert.ok(source.includes("createQueryController") && source.includes("queryController.onMessage"));
  assert.ok(controller.includes('type: "applyQueryRecipe"') && controller.includes('type: "previewQueryRecipe"'));
  assert.ok(controller.includes("stageForQueryIssue") && issueTarget.includes("filterResults"), "issue navigation routes to the owning visible stage");
  assert.ok(controller.includes("createQueryResultControls"), "Result references use the dedicated persistent renderer");
  assert.equal(controller.includes("resultReferenceSelect"), false, "Result references do not regress to unbounded native selects");
  assert.ok(controller.includes('event.key === "Escape" && uiState.getSnapshot().focusMode'), "Escape exits Focus Builder after popup and menu handlers");
  assert.ok(controller.includes('event.key === "Escape" && !elements.queryDrawer.hidden'), "Escape closes the drawer after higher-priority handlers");
  assert.ok(controller.includes("Draft cleared. Undo is available."), "Clear Draft announces its immediate Undo recovery");
  assert.match(controller, /queueMicrotask\(\(\) => \{ if \(!focusQueryIssue/, "issue focus waits for the destination stage to become visible");
  assert.ok(controller.includes("function requestRender") && controller.includes("function renderMain"), "state transitions request coordinator-owned rendering instead of calling the static renderer directly");
  assert.ok(controller.includes('requestRender("store")') && controller.includes('requestBuilderRender("metadata")'), "store and metadata transitions share the renderer coordinator");
  assert.ok(controller.includes("updateValidation?.()"), "validation refresh updates issue subtrees without replacing editor controls");
  assert.ok(controller.includes('function restoreDraft(reason, restore)') && controller.includes('requestBuilderRender(reason)'), "draft recovery actions refresh persistent predicate and computed editor sections");
  assert.ok(controller.includes('queryUndo.addEventListener("click", undoDraft)') && controller.includes('queryRedo.addEventListener("click", redoDraft)'), "header history controls use the persistent-editor recovery path");
  assert.ok(controller.includes('event.shiftKey) { redoDraft(); } else { undoDraft(); }'), "keyboard history controls use the persistent-editor recovery path");
  assert.match(workspace, /querySelector\("button,input,select,textarea"\)/, "summary actions focus the first editor control rather than a section heading");
  assert.ok(controller.includes("textContent"), "query status is rendered as text, never interpolated HTML");
  assert.ok(controller.includes("Ctrl/Cmd+Enter") === false || controller.includes("event.key === \"Enter\""));
});

test("Model Data no longer imports or emits the legacy filter and column-builder UI", () => {
  const source = read("media/modelBrowserSource.js");

  for (const legacyName of ["gridFilter.js", "gridColumnConditions.js", "gridAggregate.js", "createFilterBar", "createColumnBuilder", 'type: "applyQuery"']) {
    assert.equal(source.includes(legacyName), false, `legacy Model Data UI reference remains: ${legacyName}`);
  }
  assert.ok(source.includes("applyQueryRecipe"), "the Model Data UI sends only the v2 apply action");
});

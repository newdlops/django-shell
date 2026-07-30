// Guards the model-only Query Builder shell against legacy bar and unsafe rendering regressions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("model browser declares every stable Query Builder shell target", () => {
  const html = read("src/modelBrowserHtml.ts");
  for (const id of ["querySummaryBand", "queryFilterButton", "queryColumnsButton", "queryModeButton", "queryHumanSummary", "queryDirtyState", "queryValidationState", "queryAppliedFiltersLabel", "queryAppliedFiltersEmpty", "queryAppliedFilters", "queryAppliedWhere", "queryAppliedPostFilter", "queryDrawerToggle", "queryDrawer", "queryBuilderTitle", "queryDrawerResizeHandle", "queryDrawerHeader", "queryUndo", "queryRedo", "queryFocusMode", "queryMoreActions", "queryClose", "queryStageNav", "queryStageSelect", "queryMobilePaneSwitch", "queryEditorPane", "queryFilterRowsPanel", "queryCalculatedValuesPanel", "queryFilterResultsPanel", "queryResultPanel", "queryReviewPane", "queryInspectorTabs", "queryMeaningPanel", "queryProblemsPanel", "queryOrmPanel", "queryDrawerFooter", "queryDrawerStatus", "queryDrawerApply", "queryPopoverLayer", "queryExamples", "queryStageFilterRows", "queryStageCalculatedValues", "queryStageFilterResults", "queryStageResult", "queryWhereSection", "queryWhereRoot", "queryComputedSection", "queryComputedList", "queryPostFilterSection", "queryPostFilterRoot", "queryResultSection", "queryGroupBy", "queryOrderBy", "queryPreviewSection", "queryInspectorMeaning", "queryInspectorProblems", "queryInspectorOrm", "queryOrmPreview", "queryIssueSummary", "queryResetDraft", "queryClearDraft"]) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.ok(html.includes('options.mode === "model"'), "the Query Builder is model-mode only");
  assert.ok(html.includes('id="querybar"'), "custom ORM Query keeps its independent editor");
  assert.equal(html.includes('id="aggregatebar"'), false, "legacy aggregate bar is removed from HTML");
  assert.equal(html.includes('id="addFilter"'), false, "legacy inline filter controls are removed from HTML");
  assert.equal(html.includes('id="queryApply"'), false, "the workspace exposes one Apply entry point in its footer");
  assert.ok(html.indexOf('id="queryDrawerFooter"') < html.indexOf('id="queryDrawerResizeHandle"') && html.indexOf('id="queryDrawerResizeHandle"') < html.indexOf('id="queryPopoverLayer"'), "resize handle sits on the drawer's lower grid boundary after its footer");
  assert.ok(html.includes('<section id="queryExamples" class="query-examples" aria-label="Query examples" hidden></section>'), "examples mount preserves its exact hidden section contract");
  assert.ok(html.includes('aria-label="Draft differs from applied query">Draft differs</span>'), "dirty state explicitly distinguishes the editable draft");
  assert.ok(html.includes('<span id="queryAppliedFiltersLabel" class="query-applied-filters-label">Applied filters</span><span id="queryAppliedFiltersEmpty" class="query-applied-filters-empty">None</span>'), "summary has a static applied-filter empty state");
  assert.ok(html.includes('<div id="queryAppliedFilters" class="query-applied-filters" role="list" aria-labelledby="queryAppliedFiltersLabel" hidden><span id="queryAppliedWhere" class="query-applied-filter-chip" role="listitem" hidden></span><span id="queryAppliedPostFilter" class="query-applied-filter-chip" role="listitem" hidden></span></div>'), "applied filter chips preserve list semantics and execution order");
  const appliedFilterMarkup = html.slice(html.indexOf('id="queryAppliedFilters"'), html.indexOf("</div></div>", html.indexOf('id="queryAppliedFilters"')));
  assert.doesNotMatch(appliedFilterMarkup, /button|onclick|remove|apply|postMessage/i, "applied-filter chips are static status only");
  assert.ok(html.indexOf('id="queryMoreMenu"') < html.indexOf('id="queryExamples"') && html.indexOf('id="queryExamples"') < html.indexOf('id="queryWorkspace"'), "examples mount remains between the menu anchor and workspace");
  assert.equal((html.match(/id="queryDrawerApply"/g) || []).length, 1, "the drawer retains exactly one Apply control");
  assert.match(read("media/modelQueryBuilder.css"), /\.query-drawer\{display:grid;grid-template-rows:auto auto minmax\(0,1fr\) auto auto;/, "drawer rows end with the footer and lower resize handle");
  assert.match(read("media/modelQueryBuilder.css"), /\.query-drawer>\.query-drawer-header\{grid-row:1\}\.query-drawer>\.query-examples\{grid-row:2\}\.query-drawer>\.query-workspace\{grid-row:3\}\.query-drawer>\.query-drawer-footer\{grid-row:4\}\.query-drawer>\.query-drawer-resize\{grid-row:5\}/, "drawer rows remain explicit");
  assert.equal(html.includes('id="queryApply"'), false, "the legacy Apply control does not return");
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
  assert.ok(controller.includes('"gridwrap"'), "controller collects the grid geometry anchor");
  assert.ok(controller.includes("container: elements.queryDrawer.parentElement") && controller.includes("grid: elements.gridwrap"), "resizer receives its measured container and grid");
  assert.ok(controller.includes("function setQueryFocusMode") && controller.includes("drawerResize.refresh()"), "Focus Builder transitions refresh drawer geometry");
  assert.equal((controller.match(/setQueryFocusMode\(/g) || []).length >= 4, true, "source, click, and Escape paths share Focus Builder transitions");
  assert.ok(controller.includes("function restoreCoordinatorFocus(captured)"), "coordinator focus restoration uses a named explicit-intent helper");
  assert.ok(controller.includes("const intent = focusIntent.consume();") && controller.includes("if (!intent) { return restoreQueryFocus(root, captured); }"), "explicit intent is consumed before the unchanged captured-focus path");
  assert.ok(controller.includes('querySelectorAll?.("[data-query-control-key]")') && controller.includes("control.dataset?.queryControlKey === intent?.controlKey"), "explicit focus lookup requires exact rendered control-key equality");
  assert.ok(controller.includes("Boolean(control?.focus) && control.disabled !== true && control.getAttribute?.(\"aria-disabled\") !== \"true\""), "missing, disabled, and aria-disabled targets are unavailable");
  assert.ok(controller.includes("restoreQueryFocus(root, intent, { reveal: true })"), "available explicit controls are restored with reveal");
  assert.ok(controller.includes("root?.getElementById?.(intent.fallbackId)") && controller.includes("fallback.focus({ preventScroll: true })"), "unavailable targets fall back to the named stage heading without scrolling");
  assert.match(controller, /import \{ buildQueryExamples, createQueryExamplesView, isCanonicalEmptyQueryRecipe \} from "\.\/gridQueryExamples\.js";/, "controller imports all example contracts");
  assert.ok(controller.includes('"queryExamples"'), "controller collects the examples mount");
  for (const id of ["queryAppliedFiltersLabel", "queryAppliedFiltersEmpty", "queryAppliedFilters", "queryAppliedWhere", "queryAppliedPostFilter"]) { assert.ok(controller.includes(`"${id}"`), `controller collects ${id}`); }
  assert.equal((controller.match(/queryAppliedWhere/g) || []).length, 1, "row chip is collected only and has no click, removal, Apply, or host-action path");
  assert.equal((controller.match(/queryAppliedPostFilter/g) || []).length, 1, "result chip is collected only and has no click, removal, Apply, or host-action path");
  assert.ok(controller.includes("const examplesView = createQueryExamplesView({ el: element, mount: elements.queryExamples, onChoose: chooseQueryExample });"), "controller instantiates one examples view");
  assert.ok(controller.includes("const examples = buildQueryExamples({ columns: scope.columns, relations: scope.relations, source });") && controller.includes("examplesView.render({ draft: snapshot.draft, examples, source });"), "each main render derives examples from live schema, relations, source, and draft");
  assert.ok(controller.includes("function sameQuerySource(left, right)") && controller.includes("function chooseQueryExample(candidate)"), "controller has exact source matching and guarded selection helpers");
  assert.ok(controller.includes("const snapshot = store.getSnapshot();") && controller.includes("!isCanonicalEmptyQueryRecipe(snapshot.draft)"), "selection rereads and guards the live draft snapshot");
  assert.ok(controller.includes('status.textContent = "The draft changed; clear it before choosing an example.";') && controller.includes('requestRender("query-example-stale")'), "stale selection announces and requests a normal render without dispatching");
  const chooseStart = controller.indexOf("function chooseQueryExample(candidate)");
  const chooseEnd = controller.indexOf("/** Requests persistent builder refreshes", chooseStart);
  const chooseSource = controller.slice(chooseStart, chooseEnd);
  assert.ok(chooseSource.indexOf('uiState.dispatch({ stage: candidate.stage, type: "SET_ACTIVE_STAGE" });') < chooseSource.indexOf("focusIntent.set({ controlKey: candidate.controlKey, fallbackId: candidate.fallbackId });") && chooseSource.indexOf("focusIntent.set({ controlKey: candidate.controlKey, fallbackId: candidate.fallbackId });") < chooseSource.indexOf('store.dispatch({ recipe: candidate.recipe, type: "REPLACE_DRAFT" });') && chooseSource.indexOf('store.dispatch({ recipe: candidate.recipe, type: "REPLACE_DRAFT" });') < chooseSource.indexOf('requestBuilderRender("query-example")'), "selection stages, sets focus, replaces draft once, then renders in order");
  assert.ok(chooseSource.includes("Review and Apply when ready.") && !/\bpost\(|\bapply\(|rows|commit/i.test(chooseSource), "selection announces explicit Apply and sends no direct host, apply, row, or commit action");
  assert.ok(controller.includes("examplesView.destroy();"), "controller destroys the examples view before coordinator teardown");
  assert.ok(controller.includes("Ctrl/Cmd+Enter") === false || controller.includes("event.key === \"Enter\""));
});

test("Model Data no longer imports or emits the legacy filter and column-builder UI", () => {
  const source = read("media/modelBrowserSource.js");

  for (const legacyName of ["gridFilter.js", "gridColumnConditions.js", "gridAggregate.js", "createFilterBar", "createColumnBuilder", 'type: "applyQuery"']) {
    assert.equal(source.includes(legacyName), false, `legacy Model Data UI reference remains: ${legacyName}`);
  }
  assert.ok(source.includes("applyQueryRecipe"), "the Model Data UI sends only the v2 apply action");
});

test("Model Browser keeps the E2E probe in its isolated QA module", () => {
  const source = read("media/modelBrowserSource.js");
  const probe = read("media/modelQueryBuilderE2eProbe.js");

  assert.match(source, /import \{ runModelQueryBuilderE2eProbe \} from "\.\/modelQueryBuilderE2eProbe\.js";/);
  assert.match(source, /void runModelQueryBuilderE2eProbe\(\{ document, postMessage: \(value\) => vscode\.postMessage\(value\), requestId: message\.requestId \}\)\.catch\(\(\) => vscode\.postMessage\(\{ requestId: message\.requestId, snapshot: \{ error: "Query Builder E2E probe bootstrap failed\." \}, type: "e2eQueryBuilderProbeResult" \}\)\);/);
  assert.equal(source.includes("waitForE2eField"), false, "the production source delegates rather than retaining probe helpers");
  assert.match(probe, /export async function runModelQueryBuilderE2eProbe/);
  assert.match(probe, /AI Assist/);
});

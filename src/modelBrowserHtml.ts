// HTML document builder for the Django model data-browser webview.

import * as vscode from "vscode";

import { webviewAssetUri, webviewStylesheetLinks } from "./webviewAssets";

/** Selects the model-data or custom ORM-query surface chrome. */
export interface ModelBrowserHtmlOptions { mode: "model" | "query"; }

/** Builds the model data-browser webview document. */
export function modelBrowserHtml(webview: vscode.Webview, extensionPath: string, options: ModelBrowserHtmlOptions = { mode: "model" }): string {
  const nonce = String(Date.now());
  const codiconUri = webviewAssetUri(webview, extensionPath, "media", "codicon.css");
  const scriptUri = webviewAssetUri(webview, extensionPath, "media", "dist", "modelBrowser.js");
  const styles = webviewStylesheetLinks(webview, extensionPath, ["uiFoundation.css", "modelBrowser.css", "modelQueryBuilder.css", "modelQueryGuidance.css", "modelQueryWorkspace.css", "modelQueryControls.css", "modelQueryAssistant.css", "modelQueryPopover.css"]);
  const title = options.mode === "query" ? "ORM Query" : "Model Data";
  const placeholder = options.mode === "query" ? "Run a query to inspect its rows." : "Select a model from the Django Shell catalog.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data:; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
<title>${title}</title>
${styles}
<link rel="stylesheet" href="${codiconUri}">
</head>
<body>
<div class="app" data-surface="${options.mode}">
  <header class="topbar" data-overflow-root>
    <span class="title" id="title">${title}</span>
    <span class="subtitle" id="subtitle"></span>
    <span class="spacer"></span>
    <span id="transportInfo" class="transportInfo" title="Active backend transport"></span>
    <select id="transport" class="transport" title="How the browser reaches the Django shell">
      <option value="auto">Link: Auto</option>
      <option value="tcp">Link: Socket</option>
      <option value="pty">Link: Terminal</option>
      <option value="orm">Link: ORM</option>
    </select>
    <span id="browserWideActions" class="browser-actions">
      ${options.mode === "model" ? '<button id="queryDrawerToggle" class="secondary" type="button" aria-controls="queryDrawer" aria-expanded="false">Query Builder</button>' : ""}
      <button id="logToggle" class="secondary" type="button" title="Toggle the query log (Django ORM + SQL)">Query Log</button>
      <button id="reload" class="secondary" type="button">Reload</button>
    </span>
    <span id="browserCompactActions" class="browser-actions browser-actions-compact"></span>
    <button id="browserOverflow" class="secondary overflow-trigger" type="button" hidden aria-label="More model data actions">More</button>
    <div id="browserOverflowMenu" class="overflow-menu" role="menu" hidden aria-label="More model data actions"></div>
  </header>
  <div class="querybar" id="querybar" hidden>
    <div class="query-editor-wrap"><label for="queryinput">Django ORM query</label><textarea id="queryinput" class="queryinput" rows="3" spellcheck="false" aria-describedby="queryHelp" placeholder="User.objects.filter(is_active=True)"></textarea><span id="queryHelp" class="query-help">Runs in the attached live Django shell. Ctrl/Cmd+Enter to run.</span></div>
    <button id="runQuery" type="button">Run query</button><button id="interruptQuery" class="secondary" type="button" hidden aria-hidden="true">Interrupt</button><button id="openQueryConsole" class="secondary" type="button" hidden aria-hidden="true">Open Django Shell</button>
  </div>
  <div class="filterbar" id="filterbar" hidden></div>
  ${options.mode === "model" ? `<section id="querySummaryBand" class="query-summary-band" aria-label="Applied query">
    <button id="queryFilterButton" class="secondary" type="button">Filter rows</button><button id="queryColumnsButton" class="secondary" type="button">Calculated values</button><button id="queryModeButton" class="secondary" type="button">Result</button>
    <span id="queryHumanSummary" class="query-human-summary" tabindex="0"></span><span id="queryDirtyState" class="query-dirty-state" hidden aria-label="Draft differs from applied query">Draft differs</span><span id="queryValidationState" class="query-validation-state" role="status">Checking…</span>
    <div class="query-applied-filter-row"><span id="queryAppliedFiltersLabel" class="query-applied-filters-label">Applied filters</span><span id="queryAppliedFiltersEmpty" class="query-applied-filters-empty">None</span><div id="queryAppliedFilters" class="query-applied-filters" role="list" aria-labelledby="queryAppliedFiltersLabel" hidden><span id="queryAppliedWhere" class="query-applied-filter-chip" role="listitem" hidden></span><span id="queryAppliedPostFilter" class="query-applied-filter-chip" role="listitem" hidden></span></div></div>
  </section>
  <aside id="queryDrawer" class="query-drawer" aria-labelledby="queryBuilderTitle" data-query-builder-root hidden>
    <nav class="query-skip-links" aria-label="Query Builder shortcuts"><a href="#queryStageNav" data-query-skip-target="queryStageNav">Skip to query stages</a><a href="#queryEditorPane" data-query-skip-target="queryEditorPane">Skip to active editor</a><a href="#queryReviewPane" data-query-skip-target="queryReviewPane">Skip to query review</a><a href="#queryDrawerApply" data-query-skip-target="queryDrawerApply">Skip to Apply query</a></nav>
    <header id="queryDrawerHeader" class="query-drawer-header"><div class="query-title-row"><strong id="queryBuilderTitle">Query Builder</strong><span id="queryDraftStatus" class="query-draft-status" role="status"></span><span id="queryDraftAiAssembly" class="query-draft-ai-assembly" role="status" hidden>AI 조립</span><span class="spacer"></span><button id="queryUndo" class="secondary" type="button" disabled>Undo</button><button id="queryRedo" class="secondary" type="button" disabled>Redo</button><button id="queryFocusMode" class="secondary" type="button" aria-pressed="false">Focus Builder</button><button id="queryMoreActions" class="secondary" type="button" aria-haspopup="menu" aria-expanded="false">More actions</button><button id="queryClose" class="secondary" type="button" aria-label="Close Query Builder">Close</button></div><p id="queryDrawerIntro" class="query-section-intro">Draft changes do not affect the grid until Apply succeeds.</p></header>
    <div id="queryMoreMenu" class="query-more-menu" role="menu" hidden><button id="queryResetDraft" role="menuitem" type="button">Reset draft to applied query</button><button id="queryClearDraft" role="menuitem" type="button">Clear draft</button></div>
    <section id="queryExamples" class="query-examples" aria-label="Query examples" hidden></section>
    <div class="query-workspace" id="queryWorkspace"><nav id="queryStageNav" class="query-stage-tabs" aria-label="Query builder stages" role="tablist"><button id="queryStageFilterRows" role="tab" type="button" aria-controls="queryFilterRowsPanel" aria-selected="true" tabindex="0">1. Filter Rows</button><button id="queryStageCalculatedValues" role="tab" type="button" aria-controls="queryCalculatedValuesPanel" aria-selected="false" tabindex="-1">2. Calculated Values</button><button id="queryStageFilterResults" role="tab" type="button" aria-controls="queryFilterResultsPanel" aria-selected="false" tabindex="-1">3. Filter Results</button><button id="queryStageResult" role="tab" type="button" aria-controls="queryResultPanel" aria-selected="false" tabindex="-1">4. Result</button></nav><select id="queryStageSelect" class="query-stage-select" aria-label="Query Builder stage"><option value="filterRows">Filter Rows</option><option value="calculatedValues">Calculated Values</option><option value="filterResults">Filter Results</option><option value="result">Result</option></select><div id="queryEditorPane" class="query-editor-pane"><div id="queryFilterRowsPanel" class="query-stage-panel"><section id="queryWhereSection" class="query-builder-section" aria-labelledby="queryWhereLegend"><h2 id="queryWhereLegend" tabindex="-1">Filter Rows</h2><p class="query-stage-description">Keep only source rows that match these conditions before calculated values are created.</p><div id="queryWhereGuide"></div><div id="queryWhereRoot"></div></section></div><div id="queryCalculatedValuesPanel" class="query-stage-panel" hidden inert aria-hidden="true"><section id="queryComputedSection" class="query-builder-section" aria-labelledby="queryComputedLegend"><h2 id="queryComputedLegend" tabindex="-1">Calculated Values</h2><p class="query-stage-description">Create values that can be displayed, ordered, grouped, or filtered in later stages.</p><div id="queryComputedGuide"></div><div id="queryComputedList"></div></section></div><div id="queryFilterResultsPanel" class="query-stage-panel" hidden inert aria-hidden="true"><section id="queryPostFilterSection" class="query-builder-section" aria-labelledby="queryPostFilterLegend"><h2 id="queryPostFilterLegend" tabindex="-1">Filter Results</h2><p class="query-stage-description">Filter the final values after calculated values are available.</p><div id="queryPostFilterGuide"></div><div id="queryPostFilterRoot"></div></section></div><div id="queryResultPanel" class="query-stage-panel" hidden inert aria-hidden="true"><section id="queryResultSection" class="query-builder-section" aria-labelledby="queryResultLegend"><h2 id="queryResultLegend" tabindex="-1">Result</h2><p class="query-stage-description">Choose whether the grid returns individual rows or summary rows, then set grouping and order.</p><div id="queryResultGuide"></div><div id="queryGroupBy"></div><div id="queryOrderBy"></div></section></div></div><aside id="queryReviewPane" class="query-review-inspector" aria-label="Review query"><div id="queryInspectorTabs" class="query-review-tabs" role="tablist" aria-label="Query review"><button id="queryInspectorMeaning" role="tab" type="button" aria-controls="queryMeaningPanel" aria-selected="true" tabindex="0">Meaning</button><button id="queryInspectorProblems" role="tab" type="button" aria-controls="queryProblemsPanel" aria-selected="false" tabindex="-1">Problems</button><button id="queryInspectorOrm" role="tab" type="button" aria-controls="queryOrmPanel" aria-selected="false" tabindex="-1">Django ORM</button></div><section id="queryPreviewSection" class="query-review-panel" aria-labelledby="queryPreviewLegend"><h2 id="queryPreviewLegend" class="visually-hidden">Preview and validation</h2><div id="queryPreviewGuide"></div><div id="queryMeaningPanel"><div id="queryPlainMeaning" class="query-plain-meaning"></div><div id="queryImplicitBehavior"></div></div><div id="queryProblemsPanel" hidden inert aria-hidden="true"><div id="queryIssueSummary"></div></div><div id="queryOrmPanel" hidden inert aria-hidden="true"><div class="query-preview-actions"><button id="queryCopyOrm" class="secondary" type="button" disabled>Copy ORM</button></div><pre id="queryOrmPreview" class="query-orm-preview" aria-label="Django ORM preview"></pre></div></section></aside></div><div id="queryMobilePaneSwitch" class="query-mobile-pane-switch" hidden></div>
    <footer id="queryDrawerFooter" class="query-drawer-footer"><span id="queryDrawerStatus" class="query-drawer-status" role="status"></span><span id="queryDrawerApplyHelp" class="query-apply-help" role="status"></span><button id="queryDrawerApply" type="button" disabled aria-describedby="queryDrawerApplyHelp">Apply query</button></footer><div id="queryDrawerResizeHandle" class="query-drawer-resize" role="separator" aria-controls="queryDrawer" aria-label="Resize Query Builder" aria-orientation="horizontal" title="Drag or use arrow keys to resize Query Builder" tabindex="0"></div><div id="queryPopoverLayer" class="query-popover-layer"></div>
    <button id="queryInspectorAssistant" role="tab" type="button" aria-controls="queryAssistantPanel" aria-selected="false" tabindex="-1">AI Assist</button>
    <div id="queryAssistantPanel" class="query-assistant-panel" role="tabpanel" aria-labelledby="queryInspectorAssistant" hidden inert aria-hidden="true"></div>
  </aside>` : ""}
  <div class="gridwrap" id="gridwrap"><div class="empty" id="placeholder">${placeholder}</div></div>
  <aside id="detailDrawer" class="detaildrawer" aria-label="Related rows" hidden><div id="detailContent"></div></aside>
  <footer class="statusbar"><span id="status"></span><span id="countinfo"></span><span class="spacer"></span><button id="discard" class="secondary" type="button" disabled hidden>Discard</button><button id="commit" type="button" disabled>Commit</button><button id="count" class="secondary" type="button">Count</button><label class="pagesize">Rows&nbsp;<select id="pageSize" class="transport" title="Rows per page"><option value="50">50</option><option value="100">100</option><option value="500">500</option><option value="1000">1000</option><option value="5000">5000</option><option value="10000">10000</option><option value="all">all (not recommended)</option></select></label><button id="more" class="secondary" type="button" disabled>Load more</button></footer>
  <div class="logpanel" id="logpanel" hidden>
    <div class="logresize" id="logresize" role="separator" aria-label="Resize Query Log" aria-controls="logpanel" aria-orientation="horizontal" tabindex="0" title="Resize Query Log with arrow keys or drag"></div>
    <div class="loghead"><span>Query Log</span><span class="grow"></span><button id="logMode" class="secondary" type="button">View: SQL</button><button id="logClear" class="secondary" type="button">Clear</button></div>
    <div class="logbody mode-sql" id="logbody"></div>
  </div>
  <div class="fieldfinder" id="fieldfinder" hidden><span class="findlabel">Find field</span><span id="fieldfindslot"></span><button id="fieldfindClose" class="linkbtn" type="button" title="Close (Esc)" aria-label="Close field finder"><span class="codicon codicon-close" aria-hidden="true"></span></button></div>
</div>
<div id="politeAnnouncements" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<div id="assertiveAnnouncements" class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"></div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

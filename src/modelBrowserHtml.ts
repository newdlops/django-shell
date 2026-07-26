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
  const styles = webviewStylesheetLinks(webview, extensionPath, ["uiFoundation.css", "modelBrowser.css"]);
  const title = options.mode === "query" ? "ORM Query" : "Model Data";
  const placeholder = options.mode === "query" ? "Run a query to inspect its rows." : "Select a model from the Django Shell catalog.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
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
      <button id="groupToggle" class="secondary" type="button" title="Add computed columns: aggregate / subquery / annotate / window / F-expression, or group-by summaries">+ Column</button>
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
  <div class="filterbar" id="filterbar">
    <button id="addFilter" class="secondary" type="button">+ Filter</button>
    <span class="terms" id="filterterms"></span>
    <span class="activefilters" id="activefilters"></span>
    <span class="grow"></span>
    <button id="applyFilter" type="button">Apply</button>
    <button id="clearFilter" class="secondary" type="button">Clear</button>
  </div>
  <div class="aggbar" id="aggregatebar" hidden>
    <div class="aggrow"><span class="agglabel">Columns</span><span class="aggterms" id="aggregateTerms"></span><button id="addAggregate" class="secondary" type="button">+ column</button></div>
    <div class="aggrow"><span class="agglabel">Group by</span><span class="aggsegs" id="aggregateGroupBy"></span><button id="addGroupBy" class="secondary" type="button">+ field</button></div>
    <div class="aggrow"><span class="aggnote">No group-by → columns are added per row (aggregate / subquery / annotate / window / expr). With group-by → rows collapse into per-group summaries (Aggregate columns only). Uses the filters above as the WHERE clause.</span><span class="grow"></span><button id="runAggregate" type="button">Apply</button><button id="aggregateOff" class="secondary" type="button">Clear</button></div>
  </div>
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

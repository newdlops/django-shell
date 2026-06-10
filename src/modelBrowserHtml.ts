// HTML document builder for the Django model data-browser webview.

import * as path from "path";
import * as vscode from "vscode";

/** Builds the model data-browser webview document. */
export function modelBrowserHtml(webview: vscode.Webview, extensionPath: string): string {
  const nonce = String(Date.now());
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, "media", "dist", "modelBrowser.js")));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
<title>Model Data</title>
<style>
body{margin:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);font-size:var(--vscode-font-size)}
.app{position:relative;display:grid;grid-template-rows:auto auto auto 1fr auto auto;height:100vh;min-height:0}
.fieldfinder{position:absolute;top:40px;right:18px;z-index:50;display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border:1px solid var(--vscode-editorWidget-border,var(--vscode-focusBorder));border-radius:5px;box-shadow:0 2px 10px rgba(0,0,0,.4)}
.fieldfinder[hidden]{display:none}
.findlabel{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}
th.colfound{box-shadow:inset 0 0 0 2px var(--vscode-focusBorder)}
.topbar{grid-row:1;display:flex;align-items:center;gap:10px;height:34px;padding:0 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background))}
.title{font-weight:600}.subtitle{color:var(--vscode-descriptionForeground);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spacer{flex:1}
button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:4px;padding:3px 9px;font:inherit;cursor:pointer}
button.secondary{color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground)}
.transport{font:inherit;font-size:11px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:2px 4px;cursor:pointer}
.pagesize{display:inline-flex;align-items:center;font-size:12px;color:var(--vscode-descriptionForeground);white-space:nowrap}
.transportInfo{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}
.transportInfo .on{color:var(--vscode-terminal-ansiGreen,var(--vscode-charts-green,#3fb950))}
.transportInfo .pty{color:var(--vscode-charts-yellow,#cca700)}
.transportInfo .off{color:var(--vscode-errorForeground)}
button:hover{background:var(--vscode-button-hoverBackground)}
button:disabled{opacity:.5;cursor:default}
.filterbar{grid-row:2;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border)}
.filterbar[hidden]{display:none}
.querybar{grid-row:2;display:flex;gap:8px;align-items:flex-start;padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border)}
.querybar[hidden]{display:none}
.queryinput{flex:1;min-height:46px;resize:vertical;font-family:var(--vscode-editor-font-family);font-size:12px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:3px;padding:4px 6px;outline:none}
.queryinput:focus{border-color:var(--vscode-focusBorder)}
.filterbar .grow{flex:1}
.terms{display:flex;flex-wrap:wrap;gap:6px}
.activefilters{display:flex;align-items:center;gap:4px;flex-wrap:wrap;color:var(--vscode-descriptionForeground);font-size:11px}
.filterchip{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border:1px solid var(--vscode-panel-border);border-radius:10px;background:var(--vscode-editor-inactiveSelectionBackground,transparent);color:var(--vscode-foreground)}
.term{display:inline-flex;align-items:center;gap:4px;padding:2px 4px;border:1px solid var(--vscode-panel-border);border-radius:6px;flex-wrap:wrap}
.term select,.term input{font:inherit;font-size:11px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:3px;padding:1px 3px}
.term input{width:120px}
.term .path{display:inline-flex;align-items:center;gap:3px;flex-wrap:wrap}
.term .valwrap{display:inline-flex;align-items:center;gap:3px}
.term .chips{display:inline-flex;align-items:center;gap:3px;flex-wrap:wrap;max-width:280px}
.term .chipinput{width:90px}
.term .rangewrap input{width:78px}
.term .neg{display:inline-flex;align-items:center;gap:2px;font-size:11px;color:var(--vscode-descriptionForeground)}
.combobox{position:relative;display:inline-flex}
.cbx-input{font:inherit;font-size:11px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:3px;padding:1px 3px;min-width:96px}
.cbx-input:focus{border-color:var(--vscode-focusBorder);outline:none}
.term .cbx-input{width:auto;min-width:96px}
.cbx-list{position:absolute;left:0;top:100%;z-index:40;min-width:140px;max-width:340px;max-height:248px;overflow-y:auto;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border:1px solid var(--vscode-editorWidget-border,var(--vscode-focusBorder));border-radius:3px;box-shadow:0 2px 8px rgba(0,0,0,.35)}
.cbx-opt{padding:2px 8px;white-space:nowrap;cursor:pointer}
.cbx-opt.active,.cbx-opt:hover{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.cbx-group{padding:3px 8px 1px;color:var(--vscode-descriptionForeground);font-size:10px;text-transform:uppercase;letter-spacing:.04em;cursor:default}
.cbx-empty{padding:2px 8px;color:var(--vscode-descriptionForeground);font-style:italic}
.aggbar{grid-row:3;display:flex;flex-direction:column;gap:5px;padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-inactiveSelectionBackground,transparent)}
.aggbar[hidden]{display:none}
.aggrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.aggrow .grow{flex:1}
.agglabel{min-width:66px;color:var(--vscode-descriptionForeground);font-size:11px}
.aggsegs,.aggterms{display:flex;flex-wrap:wrap;gap:6px}
.aggchip,.aggterm{display:inline-flex;align-items:center;gap:4px;padding:2px 5px;border:1px solid var(--vscode-panel-border);border-radius:6px;font-size:11px;flex-wrap:wrap}
.termbody{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}
.pathpick{display:inline-flex;align-items:center;gap:3px;flex-wrap:wrap}
.winwrap{display:inline-flex;align-items:center;gap:3px;flex-wrap:wrap}
.winchip{display:inline-flex;align-items:center;gap:2px;padding:1px 3px;border:1px solid var(--vscode-panel-border);border-radius:5px}
th.annotation{cursor:pointer;color:var(--vscode-charts-purple,var(--vscode-textLink-foreground))}
.aggalias{width:120px;font:inherit;font-size:11px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:3px;padding:1px 3px}
.aggdistinct{display:inline-flex;align-items:center;gap:2px;font-size:11px;color:var(--vscode-descriptionForeground)}
.aggnote{color:var(--vscode-descriptionForeground);font-size:11px;font-style:italic}
.aggresult{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;font-family:var(--vscode-editor-font-family);font-size:12px;border-left:1px solid var(--vscode-panel-border)}
.aggresult th,.aggresult td{border-right:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border);padding:3px 8px;text-align:left;white-space:nowrap;vertical-align:top}
.aggresult th{position:sticky;top:0;z-index:2;background-color:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background))}
.aggresult .agggroupcol{font-weight:600;background-color:var(--vscode-editor-inactiveSelectionBackground,transparent)}
.chipx{background:none;border:none;color:inherit;cursor:pointer;padding:0;font-size:10px;line-height:1;opacity:.7}
.chipx:hover{opacity:1}
th.sortable:hover{color:var(--vscode-textLink-foreground)}
th .sortarrow{margin-left:4px;color:var(--vscode-textLink-foreground)}
.chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid var(--vscode-panel-border);border-radius:12px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px;cursor:pointer}
.gridwrap{grid-row:4;overflow:auto}
table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;font-family:var(--vscode-editor-font-family);font-size:12px;border-left:1px solid var(--vscode-panel-border)}
th,td{border-right:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border);padding:3px 8px;text-align:left;white-space:nowrap;max-width:380px;overflow:hidden;text-overflow:ellipsis;vertical-align:top}
th{position:sticky;top:0;background-color:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background));z-index:2;cursor:pointer}
.colresize{position:absolute;top:0;right:0;width:7px;height:100%;cursor:col-resize;user-select:none;z-index:4}
.colresize:hover{background:var(--vscode-focusBorder)}
.pinned{position:sticky;z-index:1;background-color:var(--vscode-editor-background)}
th.pinned{z-index:3;background-color:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background));box-shadow:1px 0 0 var(--vscode-panel-border)}
td.pinned{background-color:var(--vscode-editor-background);box-shadow:1px 0 0 var(--vscode-panel-border)}
tr:hover td.pinned{background-color:var(--vscode-editor-background);background-image:linear-gradient(var(--vscode-list-hoverBackground),var(--vscode-list-hoverBackground))}
th.rownum,td.rownum{position:sticky;left:0;min-width:46px;padding:3px 6px;text-align:right;color:var(--vscode-descriptionForeground);user-select:none;font-variant-numeric:tabular-nums;box-shadow:1px 0 0 var(--vscode-panel-border)}
th.rownum{z-index:5;background-color:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background));cursor:default}
td.rownum{z-index:2;background-color:var(--vscode-editor-background);cursor:default}
tr:hover td.rownum{background-image:linear-gradient(var(--vscode-list-hoverBackground),var(--vscode-list-hoverBackground))}
.pinbtn{background:none;border:0;color:var(--vscode-descriptionForeground);cursor:pointer;padding:0 4px 0 0;margin:0;font:inherit;opacity:.45}
.pinbtn:hover{opacity:1;color:var(--vscode-foreground)}
.pinbtn.active{opacity:1;color:var(--vscode-focusBorder)}
.loadbtn{background:none;border:0;color:var(--vscode-descriptionForeground);cursor:pointer;padding:0 4px 0 0;margin:0;font:inherit;opacity:.6}
.loadbtn:hover{opacity:1;color:var(--vscode-textLink-foreground)}
.loadbtn.active{opacity:1;color:var(--vscode-charts-green,var(--vscode-textLink-foreground))}
th .pkmark{color:var(--vscode-charts-yellow,var(--vscode-descriptionForeground));margin-left:4px}
th .coltype{display:block;font-weight:400;color:var(--vscode-descriptionForeground);font-size:10px}
th.relcol{cursor:default;color:var(--vscode-textLink-foreground)}
td.relcell{vertical-align:middle}
tr:hover td{background:var(--vscode-list-hoverBackground)}
td.editable{cursor:text}
th.computed{cursor:default;color:var(--vscode-descriptionForeground)}
td.computed{color:var(--vscode-descriptionForeground);font-style:italic}
td.dirty{background-color:var(--vscode-inputValidation-warningBackground,rgba(255,196,0,.14))!important;box-shadow:inset 2px 0 0 var(--vscode-inputValidation-warningBorder,var(--vscode-charts-yellow,#cca700))}
.celledit{width:100%;box-sizing:border-box;font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-focusBorder);border-radius:2px;padding:1px 3px;outline:none}
.fkpick{position:relative}
td:has(.fkpick){overflow:visible}
.fkresults{position:absolute;left:0;top:100%;z-index:30;min-width:100%;max-width:360px;max-height:240px;overflow-y:auto;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border:1px solid var(--vscode-editorWidget-border,var(--vscode-focusBorder));border-radius:2px;box-shadow:0 2px 8px rgba(0,0,0,.35)}
.fkopt{padding:2px 6px;white-space:nowrap;cursor:pointer}
.fkopt.active,.fkopt:hover{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.cellnull{color:var(--vscode-descriptionForeground);font-style:italic}
.tag{color:var(--vscode-descriptionForeground)}
.fk{display:inline-flex;align-items:center;gap:6px}
.linkbtn{background:none;border:0;color:var(--vscode-textLink-foreground);padding:0;cursor:pointer;font:inherit}
.linkbtn:hover{text-decoration:underline;background:none}
.detail>td{white-space:normal;max-width:none;overflow:visible;padding:0}
.nested{position:sticky;left:0;box-sizing:border-box;max-width:calc(100vw - 30px);margin:4px;padding:6px;border-left:2px solid var(--vscode-focusBorder);background:var(--vscode-editor-inactiveSelectionBackground,transparent)}
.nestedscroll{overflow:auto;max-height:40vh;scrollbar-width:none}
.chip{white-space:nowrap;flex:0 0 auto}
.nestedhead{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.nestedhead .grow{flex:1}
.chiprow{display:flex;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;gap:6px;align-items:center;scrollbar-width:none}
.chiprow::-webkit-scrollbar,.nestedscroll::-webkit-scrollbar{display:none;width:0;height:0}
.gridwrap::-webkit-scrollbar,.logbody::-webkit-scrollbar{height:10px;width:10px}
.gridwrap::-webkit-scrollbar-corner,.logbody::-webkit-scrollbar-corner{background:transparent}
.gridwrap::-webkit-scrollbar-thumb,.logbody::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:5px}
.gridwrap::-webkit-scrollbar-thumb:hover,.logbody::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground)}
.logpanel{grid-row:6;display:flex;flex-direction:column;min-height:0;height:var(--log-h,220px);border-top:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background)}
.logpanel[hidden]{display:none}
.logresize{flex:0 0 auto;height:6px;margin-top:-3px;cursor:row-resize;background:transparent}
.logresize:hover,.logresize.dragging{background:var(--vscode-sash-hoverBorder,var(--vscode-focusBorder))}
.loghead{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:4px 12px;border-bottom:1px solid var(--vscode-panel-border);font-size:12px;color:var(--vscode-descriptionForeground)}
.loghead .grow{flex:1}
.logbody{flex:1;min-height:0;overflow:auto;padding:2px 0}
.logbody:empty::after{content:"No commands yet.";display:block;padding:8px 12px;color:var(--vscode-descriptionForeground);font-size:12px}
.logentry{padding:3px 12px;border-bottom:1px solid var(--vscode-panel-border)}
.logentry .meta{color:var(--vscode-descriptionForeground);font-size:11px}
.logentry .sql{display:block;margin-top:3px;padding:4px 8px;border-radius:4px;background:var(--vscode-textCodeBlock-background,var(--vscode-editorWidget-background));font-family:var(--vscode-editor-font-family);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--vscode-foreground)}
.sql-kw{color:var(--vscode-symbolIcon-keywordForeground,#569cd6);font-weight:600}
.sql-ident{color:var(--vscode-symbolIcon-variableForeground,var(--vscode-foreground))}
.sql-str{color:var(--vscode-debugTokenExpression-string,#ce9178)}
.sql-num{color:var(--vscode-debugTokenExpression-number,#b5cea8)}
.sql-param{color:var(--vscode-debugTokenExpression-name,#c586c0)}
.sql-name{color:var(--vscode-foreground)}
.sql-punct{color:var(--vscode-descriptionForeground)}
.sql-time{color:var(--vscode-descriptionForeground);font-style:italic}
.logentry .ormcmd{display:block;margin-top:3px;padding:4px 8px;border-radius:4px;background:var(--vscode-textCodeBlock-background,var(--vscode-editorWidget-background));font-family:var(--vscode-editor-font-family);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--vscode-symbolIcon-variableForeground,var(--vscode-foreground))}
.logbody.mode-sql .ormcmd{display:none}
.logbody.mode-orm .sql{display:none}
.statusbar{grid-row:5;display:flex;align-items:center;gap:10px;padding:5px 12px;border-top:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);font-size:12px}
.empty{padding:24px;color:var(--vscode-descriptionForeground)}
.err{padding:12px;color:var(--vscode-errorForeground);white-space:pre-wrap;font-family:var(--vscode-editor-font-family)}
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <span class="title" id="title">Model Data</span>
    <span class="subtitle" id="subtitle"></span>
    <span class="spacer"></span>
    <span id="transportInfo" class="transportInfo" title="Active backend transport"></span>
    <select id="transport" class="transport" title="How the browser reaches the Django shell">
      <option value="auto">Link: Auto</option>
      <option value="tcp">Link: Socket</option>
      <option value="pty">Link: Terminal</option>
      <option value="orm">Link: ORM</option>
    </select>
    <button id="groupToggle" class="secondary" type="button" title="Add computed columns: aggregate / window / F-expression, or group-by summaries">+ Column</button>
    <button id="logToggle" class="secondary" type="button" title="Toggle the query log (Django ORM + SQL)">Query Log</button>
    <button id="reload" class="secondary" type="button">Reload</button>
  </header>
  <div class="querybar" id="querybar" hidden>
    <textarea id="queryinput" class="queryinput" rows="3" spellcheck="false" placeholder="User.objects.filter(is_active=True)   —   Ctrl/Cmd+Enter to run"></textarea>
    <button id="runQuery" type="button">Run</button>
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
    <div class="aggrow"><span class="aggnote">No group-by → columns are added per row (annotate / window). With group-by → rows collapse into per-group summaries (Aggregate columns only). Uses the filters above as the WHERE clause.</span><span class="grow"></span><button id="runAggregate" type="button">Apply</button><button id="aggregateOff" class="secondary" type="button">Clear</button></div>
  </div>
  <div class="gridwrap" id="gridwrap"><div class="empty" id="placeholder">Select a model from the Django Shell catalog.</div></div>
  <footer class="statusbar"><span id="status"></span><span id="countinfo"></span><span class="spacer"></span><button id="discard" class="secondary" type="button" disabled>Discard</button><button id="commit" type="button" disabled>Commit</button><button id="count" class="secondary" type="button">Count</button><label class="pagesize">Rows&nbsp;<select id="pageSize" class="transport" title="Rows per page"><option value="50">50</option><option value="100">100</option><option value="500">500</option><option value="1000">1000</option><option value="5000">5000</option><option value="10000">10000</option><option value="all">all (not recommended)</option></select></label><button id="more" class="secondary" type="button" disabled>Load more</button></footer>
  <div class="logpanel" id="logpanel">
    <div class="logresize" id="logresize" title="Drag to resize the query log"></div>
    <div class="loghead"><span>Query Log</span><span class="grow"></span><button id="logMode" class="secondary" type="button">View: SQL</button><button id="logClear" class="secondary" type="button">Clear</button></div>
    <div class="logbody mode-sql" id="logbody"></div>
  </div>
  <div class="fieldfinder" id="fieldfinder" hidden><span class="findlabel">Find field</span><span id="fieldfindslot"></span><button id="fieldfindClose" class="linkbtn" type="button" title="Close (Esc)">✕</button></div>
</div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

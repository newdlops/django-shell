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
.app{display:grid;grid-template-rows:auto auto 1fr auto auto;height:100vh;min-height:0}
.topbar{display:flex;align-items:center;gap:10px;height:34px;padding:0 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background))}
.title{font-weight:600}.subtitle{color:var(--vscode-descriptionForeground);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spacer{flex:1}
button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:4px;padding:3px 9px;font:inherit;cursor:pointer}
button.secondary{color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground)}
button:hover{background:var(--vscode-button-hoverBackground)}
button:disabled{opacity:.5;cursor:default}
.filterbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border)}
.filterbar .grow{flex:1}
.terms{display:flex;flex-wrap:wrap;gap:6px}
.term{display:inline-flex;align-items:center;gap:4px;padding:2px 4px;border:1px solid var(--vscode-panel-border);border-radius:6px}
.term select,.term input{font:inherit;font-size:11px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:3px;padding:1px 3px}
.term input{width:120px}
.term .neg{display:inline-flex;align-items:center;gap:2px;font-size:11px;color:var(--vscode-descriptionForeground)}
th.sortable:hover{color:var(--vscode-textLink-foreground)}
th .sortarrow{margin-left:4px;color:var(--vscode-textLink-foreground)}
.chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid var(--vscode-panel-border);border-radius:12px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px;cursor:pointer}
.gridwrap{overflow:auto}
table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;font-family:var(--vscode-editor-font-family);font-size:12px;border-left:1px solid var(--vscode-panel-border)}
th,td{border-right:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border);padding:3px 8px;text-align:left;white-space:nowrap;max-width:380px;overflow:hidden;text-overflow:ellipsis;vertical-align:top}
th{position:sticky;top:0;background-color:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background));z-index:2;cursor:pointer}
.pinned{position:sticky;z-index:1;background-color:var(--vscode-editor-background)}
th.pinned{z-index:3;background-color:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background));box-shadow:1px 0 0 var(--vscode-panel-border)}
td.pinned{background-color:var(--vscode-editor-background);box-shadow:1px 0 0 var(--vscode-panel-border)}
tr:hover td.pinned{background-color:var(--vscode-editor-background);background-image:linear-gradient(var(--vscode-list-hoverBackground),var(--vscode-list-hoverBackground))}
.pinbtn{background:none;border:0;color:var(--vscode-descriptionForeground);cursor:pointer;padding:0 4px 0 0;margin:0;font:inherit;opacity:.45}
.pinbtn:hover{opacity:1;color:var(--vscode-foreground)}
.pinbtn.active{opacity:1;color:var(--vscode-focusBorder)}
th .pkmark{color:var(--vscode-charts-yellow,var(--vscode-descriptionForeground));margin-left:4px}
th .coltype{display:block;font-weight:400;color:var(--vscode-descriptionForeground);font-size:10px}
th.relcol{cursor:default;color:var(--vscode-textLink-foreground)}
td.relcell{vertical-align:middle}
tr:hover td{background:var(--vscode-list-hoverBackground)}
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
.logpanel{display:flex;flex-direction:column;min-height:0;height:220px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background)}
.logpanel[hidden]{display:none}
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
.statusbar{display:flex;align-items:center;gap:10px;padding:5px 12px;border-top:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);font-size:12px}
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
    <button id="logToggle" class="secondary" type="button" title="Toggle the query log (Django ORM + SQL)">Query Log</button>
    <button id="reload" class="secondary" type="button">Reload</button>
  </header>
  <div class="filterbar" id="filterbar">
    <button id="addFilter" class="secondary" type="button">+ Filter</button>
    <span class="terms" id="filterterms"></span>
    <span class="grow"></span>
    <button id="applyFilter" type="button">Apply</button>
    <button id="clearFilter" class="secondary" type="button">Clear</button>
  </div>
  <div class="gridwrap" id="gridwrap"><div class="empty" id="placeholder">Select a model from the Django Shell catalog.</div></div>
  <footer class="statusbar"><span id="status"></span><span id="countinfo"></span><span class="spacer"></span><button id="count" class="secondary" type="button">Count</button><button id="more" class="secondary" type="button" disabled>Load more</button></footer>
  <div class="logpanel" id="logpanel">
    <div class="loghead"><span>Query Log</span><span class="grow"></span><button id="logMode" class="secondary" type="button">View: SQL</button><button id="logClear" class="secondary" type="button">Clear</button></div>
    <div class="logbody mode-sql" id="logbody"></div>
  </div>
</div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

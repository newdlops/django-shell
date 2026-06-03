// HTML document builder for the model catalog sidebar webview.

import * as path from "path";
import * as vscode from "vscode";

/** Builds the model catalog sidebar webview document with a search box and filtered model tree. */
export function modelCatalogHtml(webview: vscode.Webview, extensionPath: string): string {
  const nonce = String(Date.now());
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, "media", "dist", "modelCatalog.js")));
  const codiconUri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, "media", "codicon.css")));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
<link rel="stylesheet" href="${codiconUri}">
<title>Models</title>
<style>
body{margin:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground);font-size:var(--vscode-font-size)}
.codicon{font:normal normal normal 16px/1 codicon;display:inline-block;text-rendering:auto;-webkit-font-smoothing:antialiased;vertical-align:middle}
.cat{display:flex;flex-direction:column;height:100vh}
.searchbox{display:flex;align-items:center;gap:6px;margin:6px;padding:3px 8px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:4px}
.searchbox:focus-within{border-color:var(--vscode-focusBorder)}
.searchbox .codicon{font-size:14px;color:var(--vscode-input-placeholderForeground,var(--vscode-descriptionForeground))}
.search{flex:1;min-width:0;font:inherit;color:var(--vscode-input-foreground);background:transparent;border:0;outline:none}
.list{flex:1;overflow:auto;padding:2px 0}
.row{display:flex;align-items:center;height:22px;cursor:pointer;white-space:nowrap;overflow:hidden;user-select:none;padding-right:8px}
.row:hover{background:var(--vscode-list-hoverBackground)}
.row:active{background:var(--vscode-list-activeSelectionBackground)}
.group{padding-left:4px}
.item{position:relative;padding-left:24px}
.item::before{content:"";position:absolute;left:13px;top:0;bottom:0;border-left:1px solid var(--vscode-tree-indentGuidesStroke,transparent)}
.twistie{flex:0 0 auto;width:16px;text-align:center;color:var(--vscode-icon-foreground,var(--vscode-foreground));transition:transform .08s ease}
.group.expanded .twistie{transform:rotate(90deg)}
.icon{flex:0 0 auto;width:16px;margin:0 6px 0 2px}
.icon.app{color:var(--vscode-symbolIcon-namespaceForeground,var(--vscode-icon-foreground))}
.icon.model{color:var(--vscode-symbolIcon-classForeground,var(--vscode-icon-foreground))}
.gname{font-weight:600;overflow:hidden;text-overflow:ellipsis}
.mname{overflow:hidden;text-overflow:ellipsis}
.count{margin-left:auto;flex:0 0 auto;min-width:16px;text-align:center;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:10px;padding:0 6px;font-size:10px;line-height:16px}
.match{color:var(--vscode-list-highlightForeground,var(--vscode-textLink-foreground));font-weight:700}
.footer{padding:4px 10px;border-top:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);font-size:11px}
.list::-webkit-scrollbar{width:10px}
.list::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:5px}
.list::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground)}
</style>
</head>
<body>
<div class="cat">
  <div class="searchbox"><span class="codicon codicon-search"></span><input id="search" class="search" type="text" placeholder="Search models…" autocomplete="off" spellcheck="false"></div>
  <div id="list" class="list"></div>
  <div id="footer" class="footer"></div>
</div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

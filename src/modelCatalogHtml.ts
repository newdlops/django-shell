// HTML document builder for the accessible model catalog sidebar webview.

import * as vscode from "vscode";

import { webviewAssetUri, webviewStylesheetLinks } from "./webviewAssets";

/** Builds the model catalog sidebar webview document with an accessible search and model tree. */
export function modelCatalogHtml(webview: vscode.Webview, extensionPath: string): string {
  const nonce = String(Date.now());
  const scriptUri = webviewAssetUri(webview, extensionPath, "media", "dist", "modelCatalog.js");
  const codiconUri = webviewAssetUri(webview, extensionPath, "media", "codicon.css");
  const styles = webviewStylesheetLinks(webview, extensionPath, ["uiFoundation.css", "modelCatalog.css"]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
<link rel="stylesheet" href="${codiconUri}">
<title>Models</title>
${styles}
</head>
<body>
<section class="catalog" aria-labelledby="modelsHeading">
  <h2 id="modelsHeading" class="sr-only">Models</h2>
  <div class="searchbox">
    <span class="codicon codicon-search" aria-hidden="true"></span>
    <label class="sr-only" for="modelSearch">Search models</label>
    <input id="modelSearch" class="search" type="search" placeholder="Search models…" autocomplete="off" spellcheck="false" aria-controls="modelTree">
    <button id="clearSearch" class="clear-search" type="button" aria-label="Clear model search" title="Clear search"><span class="codicon codicon-close" aria-hidden="true"></span></button>
  </div>
  <div id="catalogStatus" class="catalog-status" role="status" aria-live="polite" aria-atomic="true"></div>
  <button id="stateAction" class="state-action" type="button" hidden></button>
  <ul id="modelTree" class="list" role="tree" aria-label="Django models" aria-describedby="catalogStatus"></ul>
  <footer id="footer" class="footer"></footer>
</section>
<div id="politeAnnouncements" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<div id="assertiveAnnouncements" class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"></div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

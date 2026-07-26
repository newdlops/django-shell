// HTML document builder for the custom Django shell webview.

import * as vscode from "vscode";

import { webviewAssetUri, webviewStylesheetLinks } from "./webviewAssets";

/** Builds the custom console webview document. */
export function webviewHtml(webview: vscode.Webview, extensionPath: string): string {
  const nonce = String(Date.now());
  const codiconUri = webviewAssetUri(webview, extensionPath, "media", "codicon.css");
  const pythonIconUri = webviewAssetUri(webview, extensionPath, "media", "python.svg");
  const scriptUri = webviewAssetUri(webview, extensionPath, "media", "dist", "customConsole.js");
  const styles = webviewStylesheetLinks(webview, extensionPath, ["uiFoundation.css", "customConsole.css"]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data:; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
<title>Django Shell</title>
<link rel="stylesheet" href="${codiconUri}">
${styles}
</head>
<body>
<div class="shell">
  <header class="topbar"><div class="brand"><span class="title">Django Shell</span><span id="status" class="kernel" role="status" aria-live="polite" aria-atomic="true"><span class="statusDot" aria-hidden="true"></span><span id="statusText">starting</span></span></div><span class="spacer"></span><div class="topActions"><button id="restart" class="secondary" type="button">Restart Kernel</button></div></header>
  <main class="notebook">
    <section id="setupCell" class="cell setupCell" data-auto-minimize="true">
      <div class="prompt"><span class="promptMark">Setup</span></div>
      <div class="body">
        <div class="toolbar"><button id="focusTerminal" class="icon" type="button" title="Focus setup input" aria-label="Focus setup input"><span class="codicon codicon-terminal" aria-hidden="true"></span></button><span class="label">setup terminal</span><span class="grow"></span></div>
        <div id="terminal" class="terminalHost"></div>
        <div class="cellResize" data-resize-target="terminal" role="separator" aria-label="Resize setup terminal" aria-orientation="horizontal" tabindex="0"></div>
      </div>
    </section>
    <section id="pythonCell" class="cell inputCell disabled">
      <div id="inputPrompt" class="prompt"><span class="promptMark">In&nbsp;[&nbsp;]:</span></div>
      <div class="body editor">
        <div class="toolbar"><img class="pythonIcon" src="${pythonIconUri}" alt="" aria-hidden="true"><span class="label">Python</span><div id="pythonTabs" class="pythonTabs" role="tablist"></div><button class="icon" data-action="new-overlay-tab" type="button" title="New overlay tab" aria-label="New overlay tab" disabled><span class="codicon codicon-add" aria-hidden="true"></span></button><span class="grow"></span><select id="debugMode" class="transport" title="Debugger display mode" aria-label="Debugger display mode"><option value="overlay">Debug: Overlay</option><option value="file">Debug: File</option></select><button class="iconText" data-action="debug-shell" type="button" title="Debug current shell" aria-label="Debug current shell" disabled><span class="codicon codicon-debug-start" aria-hidden="true"></span><span class="buttonLabel">Debug</span></button><div class="debugControls" role="toolbar" aria-label="Active debugger controls" hidden><button class="icon" data-debug-control="continue" type="button" title="Continue" aria-label="Continue" disabled><span class="codicon codicon-debug-continue" aria-hidden="true"></span></button><button class="icon" data-debug-control="pause" type="button" title="Pause" aria-label="Pause" disabled><span class="codicon codicon-debug-pause" aria-hidden="true"></span></button><button class="icon" data-debug-control="stepOver" type="button" title="Step Over" aria-label="Step Over" disabled><span class="codicon codicon-debug-step-over" aria-hidden="true"></span></button><button class="icon" data-debug-control="stepInto" type="button" title="Step Into" aria-label="Step Into" disabled><span class="codicon codicon-debug-step-into" aria-hidden="true"></span></button><button class="icon" data-debug-control="stepOut" type="button" title="Step Out" aria-label="Step Out" disabled><span class="codicon codicon-debug-step-out" aria-hidden="true"></span></button><button class="icon" data-debug-control="restart" type="button" title="Restart Debugging" aria-label="Restart Debugging" disabled><span class="codicon codicon-debug-restart" aria-hidden="true"></span></button><button class="icon" data-debug-control="stop" type="button" title="Stop Debugging" aria-label="Stop Debugging" disabled><span class="codicon codicon-debug-stop" aria-hidden="true"></span></button></div><span id="transportInfo" class="transportInfo" title="Active backend transport"></span><select id="transport" class="transport" title="How the console reaches the Django shell" aria-label="Django shell transport"><option value="auto">Link: Auto</option><option value="tcp">Link: Socket</option><option value="pty">Link: Terminal</option><option value="orm">Link: ORM</option></select><button id="clear" class="secondary" type="button">Clear</button></div>
        <div id="editorAnchor" class="editorLauncher"><div id="editorLock" class="editorLock"><img class="pythonIcon" src="${pythonIconUri}" alt="" aria-hidden="true"><span>Complete setup to enable Python input</span></div></div>
        <div class="cellResize" data-resize-target="editor" role="separator" aria-label="Resize Python editor" aria-orientation="horizontal" tabindex="0"></div>
        <div id="currentOutput" class="cellOutput outputHidden"><div id="currentOutputLabel" class="outputLabel">Outputs</div><div id="outputList" class="outputList"></div></div>
      </div>
    </section>
  </main>
</div>
<div id="politeAnnouncements" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<div id="assertiveAnnouncements" class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"></div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

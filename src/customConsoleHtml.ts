// HTML document builder for the custom Django shell webview.

import * as path from "path";
import * as vscode from "vscode";

/** Builds the custom console webview document. */
export function webviewHtml(webview: vscode.Webview, extensionPath: string): string {
  const nonce = String(Date.now());
  const pythonIconUri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, "media", "python.svg")));
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, "media", "dist", "customConsole.js")));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
<title>Django Shell</title>
<style>
body{margin:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
.shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr}
.topbar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;height:36px;padding:0 14px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background))}
.brand{display:flex;align-items:center;gap:10px;min-width:0}.title{font-weight:600}.kernel{display:inline-flex;align-items:center;gap:6px;max-width:42vw;color:var(--vscode-descriptionForeground);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.statusDot{width:7px;height:7px;border-radius:50%;background:var(--vscode-testing-iconQueued,var(--vscode-descriptionForeground))}.kernel[data-ready="true"] .statusDot{background:var(--vscode-testing-iconPassed,var(--vscode-terminal-ansiGreen))}
.spacer{flex:1}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:4px;padding:3px 9px;font:inherit}
button.secondary{color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground)}
button.icon{display:inline-grid;place-items:center;width:24px;height:24px;padding:0;border-radius:5px}
button:hover{background:var(--vscode-button-hoverBackground)}
button:disabled{opacity:.55;cursor:default}
.notebook{width:100%;box-sizing:border-box;margin:0;padding:10px 14px 34px}
.cell{display:grid;grid-template-columns:64px minmax(0,1fr);margin:0 0 8px}
.cell:focus-within .body,.cell:hover .body{border-color:var(--vscode-focusBorder)}
.prompt{box-sizing:border-box;padding:8px 10px 0 0;text-align:right;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family);font-size:12px;white-space:nowrap}.promptMark{display:inline-block;min-width:38px}
.body{border:1px solid transparent;background:var(--vscode-notebook-cellEditorBackground,var(--vscode-editor-background));box-shadow:inset 3px 0 0 transparent}.cell:focus-within .body{box-shadow:inset 3px 0 0 var(--vscode-focusBorder)}
.toolbar{display:flex;align-items:center;gap:7px;height:28px;padding:0 7px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-sideBar-background))}
.toolbar .label{font-size:12px;color:var(--vscode-descriptionForeground)}.toolbar .grow{flex:1}
.transport{font:inherit;font-size:11px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:2px 4px;cursor:pointer}
.transportInfo{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}
.transportInfo .on{color:var(--vscode-terminal-ansiGreen,var(--vscode-charts-green,#3fb950))}.transportInfo .pty{color:var(--vscode-charts-yellow,#cca700)}.transportInfo .off{color:var(--vscode-errorForeground)}
.terminalHost{height:190px;min-height:92px;overflow:hidden;padding:3px 0;background:var(--vscode-terminal-background,var(--vscode-editor-background))}
.terminalHost .xterm,.terminalHost .xterm-screen,.terminalHost .xterm-viewport{height:100%;background:var(--vscode-terminal-background,var(--vscode-editor-background))!important}
.setupCell.minimized .terminalHost{height:34px!important;min-height:34px;opacity:.72;pointer-events:none}.setupCell.minimized .cellResize{display:none}.setupCell.minimized .body{border-color:transparent}
.cellResize{height:9px;cursor:ns-resize;position:relative;background:var(--vscode-notebook-cellEditorBackground,var(--vscode-editor-background))}.cellResize::before{content:"";position:absolute;left:50%;top:4px;width:42px;height:1px;transform:translateX(-50%);background:var(--vscode-panel-border)}.cellResize:hover::before,.cellResize:focus-visible::before{height:2px;background:var(--vscode-focusBorder)}.resizingCell,.resizingCell *{cursor:ns-resize!important;user-select:none}
.result,.editorLauncher{margin:0;box-sizing:border-box;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.45;letter-spacing:0;font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0;tab-size:4}
.editor{display:grid;grid-template-rows:auto}
.editorLauncher{position:relative;height:clamp(240px,38vh,520px);background:var(--vscode-editor-background)}
.pythonIcon{display:inline-block;width:20px;height:20px;object-fit:contain}
.disabled .pythonIcon{opacity:.55}.disabled .editorLauncher{background:var(--vscode-disabledForeground,var(--vscode-editor-background))}
.editorLock{position:absolute;inset:0;display:none;align-items:center;justify-content:center;gap:8px;color:var(--vscode-descriptionForeground);background:color-mix(in srgb,var(--vscode-editor-background) 86%,transparent);font-size:12px;z-index:1}.disabled .editorLock{display:flex}
.hint{padding:5px 10px;border-top:1px solid var(--vscode-panel-border);font-size:12px;color:var(--vscode-descriptionForeground)}
.cellOutput{border-top:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);max-height:min(46vh,420px);overflow:auto}
.outputHidden{display:none}
.outputLabel{padding:6px 10px 0;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family);font-size:12px}
.outputList{display:grid;gap:0;padding:4px 0 8px}.outputItem{border-top:1px solid var(--vscode-panel-border)}
.outputHeader{display:flex;align-items:center;gap:8px;padding:5px 10px 0;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family);font-size:12px}.outputHeader .grow{flex:1}.outputStatus{font-family:var(--vscode-font-family);font-size:11px}.outputItem.running .outputStatus{color:var(--vscode-testing-iconQueued,var(--vscode-descriptionForeground))}
.outputItemLabel{padding:5px 10px 0;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family);font-size:12px}
.inputSource{margin:3px 10px 2px;padding:5px 8px;max-height:260px;overflow:auto;border-left:2px solid var(--vscode-panel-border);background:var(--vscode-textCodeBlock-background,var(--vscode-editorWidget-background));font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.45;white-space:pre-wrap;tab-size:4}
.result{margin:0;padding:4px 10px 8px;white-space:pre;overflow:visible;min-width:max-content;background:var(--vscode-editor-background)}
.result.pending{color:var(--vscode-descriptionForeground);font-style:italic}
.result.error{color:var(--vscode-errorForeground)}
</style>
</head>
<body>
<div class="shell">
  <header class="topbar"><div class="brand"><span class="title">Django Shell</span><span id="status" class="kernel"><span class="statusDot"></span><span id="statusText">starting</span></span></div><span class="spacer"></span><button id="restart" class="secondary" type="button">Restart Kernel</button></header>
  <main class="notebook">
    <section id="setupCell" class="cell setupCell">
      <div class="prompt"><span class="promptMark">Setup</span></div>
      <div class="body">
        <div class="toolbar"><button id="focusTerminal" class="icon" type="button" title="Focus setup input">&gt;</button><span class="label">setup terminal</span><span class="grow"></span></div>
        <div id="terminal" class="terminalHost"></div>
        <div class="cellResize" data-resize-target="terminal" role="separator" aria-label="Resize setup terminal" aria-orientation="horizontal" tabindex="0"></div>
      </div>
    </section>
    <section id="pythonCell" class="cell inputCell disabled">
      <div id="inputPrompt" class="prompt"><span class="promptMark">In&nbsp;[&nbsp;]:</span></div>
      <div class="body editor">
        <div class="toolbar"><img class="pythonIcon" src="${pythonIconUri}" alt="" aria-hidden="true"><span class="label">Python</span><span class="grow"></span><span id="transportInfo" class="transportInfo" title="Active backend transport"></span><select id="transport" class="transport" title="How the console reaches the Django shell"><option value="auto">Link: Auto</option><option value="tcp">Link: Socket</option><option value="pty">Link: Terminal</option><option value="orm">Link: ORM</option></select><button id="clear" class="secondary" type="button">Clear</button></div>
        <div id="editorAnchor" class="editorLauncher"><div id="editorLock" class="editorLock"><img class="pythonIcon" src="${pythonIconUri}" alt="" aria-hidden="true"><span>Complete setup to enable Python input</span></div></div>
        <div class="cellResize" data-resize-target="editor" role="separator" aria-label="Resize Python editor" aria-orientation="horizontal" tabindex="0"></div>
        <div id="currentOutput" class="cellOutput outputHidden"><div id="currentOutputLabel" class="outputLabel">Outputs</div><div id="outputList" class="outputList"></div></div>
      </div>
    </section>
  </main>
</div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

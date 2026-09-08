// Activates only the isolated E2E process's own workbench before input and timing probes.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const WebSocket = require("ws");

let target;

/** Brings the owning test application's single workbench forward without touching other VS Code processes. */
async function focusTestWorkbench(extension) {
  const result = await evaluateTestWorkbench(extension, `electron.app.focus({steal:true});win.show();win.focus();win.webContents.focus();return {ok:true,pid:process.pid,windowId:win.id};`);
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.equal(result.pid, target.pid);
  if (process.platform === "darwin") {
    execFileSync("/usr/bin/osascript", ["-e", `tell application "System Events" to set frontmost of first process whose unix id is ${target.pid} to true`], { timeout: 3000 });
  }
}

/** Saves only the isolated test workbench's rendered pixels for visual regression diagnosis. */
async function captureTestWorkbench(extension, destination) {
  const result = await evaluateTestWorkbench(extension, `const image=await win.webContents.capturePage();return {ok:true,png:image.toPNG().toString("base64")};`);
  assert.equal(result?.ok, true, JSON.stringify(result));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(result.png, "base64"));
}

/** Restores the isolated test window's original bounds after one viewport-specific interaction probe. */
async function withTestWorkbenchSize(extension, width, height, run) {
  assert.ok(width >= 900 && width <= 1800 && height >= 600 && height <= 1200, "Viewport probe dimensions must stay bounded.");
  const result = await evaluateTestWorkbench(extension, `const bounds=win.getBounds();win.setContentSize(${width},${height});return {ok:true,bounds};`);
  assert.equal(result?.ok, true, JSON.stringify(result));
  try { return await run(); }
  finally { await evaluateTestWorkbench(extension, `win.setBounds(${JSON.stringify(result.bounds)});return {ok:true};`); }
}

/** Focuses a real webview cell through Chromium input instead of relying on cross-frame window.focus. */
async function focusTestWebview(extension, point) {
  assert.ok(Number.isFinite(point?.x) && Number.isFinite(point?.y), "Webview focus requires a measured cell point.");
  await focusTestWorkbench(extension);
  await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  const result = await evaluateTestWorkbench(extension, `
    if(!win.isFocused()){electron.app.focus({steal:true});win.show();win.focus();win.webContents.focus();await new Promise(resolve=>setTimeout(resolve,120));}
    const frames=await win.webContents.executeJavaScript('(function(){return Array.from(document.querySelectorAll("iframe.webview")).map(frame=>{const rect=frame.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,visible:getComputedStyle(frame).visibility!=="hidden"&&rect.width>0&&rect.height>0};}).filter(frame=>frame.visible);})()');
    if(frames.length!==1){return {ok:false,reason:"ambiguous-visible-webview",frames};}
    const frame=frames[0],point=${JSON.stringify(point)};
    if(point.x<0||point.y<0||point.x>=frame.width||point.y>=frame.height){return {ok:false,reason:"cell-outside-webview",frame,point};}
    const x=Math.round(frame.x+point.x),y=Math.round(frame.y+point.y);
    const debuggerSession=win.webContents.debugger,ownedSession=!debuggerSession.isAttached();
    if(ownedSession){debuggerSession.attach("1.3");}
    try{
      await debuggerSession.sendCommand("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});
      try{await debuggerSession.sendCommand("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",buttons:1,clickCount:1,x,y});}
      finally{await debuggerSession.sendCommand("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",buttons:0,clickCount:1,x,y});}
    }finally{if(ownedSession){debuggerSession.detach();}}
    await new Promise(resolve=>setTimeout(resolve,150));
    const focusedFrame=await win.webContents.executeJavaScript('({focus:document.hasFocus(),active:document.activeElement&&document.activeElement.tagName,viewport:{width:innerWidth,height:innerHeight}})');
    return {ok:true,x,y,frame,point,zoom:win.webContents.getZoomFactor(),windowFocused:win.isFocused(),contentsFocused:win.webContents.isFocused(),focusedFrame};
  `);
  assert.equal(result?.ok, true, JSON.stringify(result));
  console.log("E2E webview focus:", JSON.stringify(result));
}

/** Executes one test action only after verifying both the parent process and unique workbench. */
async function evaluateTestWorkbench(extension, body) {
  const { findMainPid, findInspectorUrlForPid } = require(path.join(extension.extensionPath, "out", "workbenchInspector.js"));
  if (!target) {
    const pid = findMainPid(); assert.ok(pid, "E2E must identify its own VS Code parent process.");
    const { url } = await findInspectorUrlForPid(pid, 1);
    assert.ok(url, "The isolated E2E process must expose its configured inspector.");
    target = { pid, url };
  }
  const expression = `(async function(){if(process.pid!==${target.pid}){return {ok:false,reason:"wrong-process"};}const req=typeof require==="function"?require:process.mainModule.require.bind(process.mainModule);const electron=req("electron");const windows=electron.BrowserWindow.getAllWindows().filter(win=>!win.isDestroyed()&&/workbench\\.(?:esm\\.)?html/.test(win.webContents.getURL()));if(windows.length!==1){return {ok:false,reason:"ambiguous-test-window",count:windows.length};}const win=windows[0];${body}})()`;
  return evaluate(target.url, expression);
}

/** Evaluates one bounded activation command on the inspector whose process identity was verified. */
function evaluate(url, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("E2E workbench activation timed out.")), 5000);
    /** Retires the test's inspector connection and resolves one activation result. */
    function finish(error, value) {
      if (settled) { return; }
      settled = true; clearTimeout(timer); socket.close();
      if (error) { reject(error); } else { resolve(value); }
    }
    socket.once("open", () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true } })));
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.id !== 1) { return; }
      const error = message.error || message.result?.exceptionDetails;
      finish(error ? new Error(JSON.stringify(error)) : undefined, message.result?.result?.value);
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish(new Error("E2E inspector closed before activation completed.")));
  });
}

module.exports = { focusTestWorkbench, focusTestWebview, captureTestWorkbench, withTestWorkbenchSize };

// Activates only the isolated E2E process's own workbench before input and timing probes.
const assert = require("node:assert/strict");
const path = require("node:path");
const WebSocket = require("ws");

let target;

/** Brings the owning test application's single workbench forward without touching other VS Code processes. */
async function focusTestWorkbench(extension) {
  const { findMainPid, findInspectorUrlForPid } = require(path.join(extension.extensionPath, "out", "workbenchInspector.js"));
  if (!target) {
    const pid = findMainPid(); assert.ok(pid, "E2E must identify its own VS Code parent process.");
    const { url } = await findInspectorUrlForPid(pid, 1);
    assert.ok(url, "The isolated E2E process must expose its configured inspector.");
    target = { pid, url };
  }
  const expression = `(function(){if(process.pid!==${target.pid}){return {ok:false,reason:"wrong-process"};}const req=typeof require==="function"?require:process.mainModule.require.bind(process.mainModule);const electron=req("electron");const windows=electron.BrowserWindow.getAllWindows().filter(win=>!win.isDestroyed()&&/workbench\\.(?:esm\\.)?html/.test(win.webContents.getURL()));if(windows.length!==1){return {ok:false,reason:"ambiguous-test-window",count:windows.length};}const win=windows[0];electron.app.focus({steal:true});win.show();win.focus();win.webContents.focus();return {ok:true,pid:process.pid,windowId:win.id};})()`;
  const result = await evaluate(target.url, expression);
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.equal(result.pid, target.pid);
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
    socket.once("open", () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, includeCommandLineAPI: true, returnByValue: true } })));
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

module.exports = { focusTestWorkbench };

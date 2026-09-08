// Verifies the native recovery notification for blocked terminal input without starting a real shell.
const assert = require("node:assert/strict");
const path = require("node:path");
const { evaluateTestWorkbench, captureTestWorkbench } = require("./focusTestWorkbench.js");

/** Exercises the production input guard and confirms its recovery instruction is visible in VS Code. */
async function assertTerminalRecoveryNotice(extension) {
  const { NotebookPtySession } = require(path.join(extension.extensionPath, "out/notebookPtySession.js"));
  const writes = [], session = new NotebookPtySession({ autoActivateWorkspaceVenv: false, backendRuntimePath: "", cwd: process.cwd(), sessionId: "e2e-terminal-recovery" });
  session.process = { write: (data) => writes.push(data), kill() {} };
  session.retiredResponse = { complete: false, restartRequired: true };
  try {
    session.write("blocked input\r"); session.write("blocked paste\r");
    assert.deepEqual(writes, []);
    const text = "Upload incomplete. Select Restart Kernel to restore input.";
    let visible = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      visible = await evaluateTestWorkbench(extension, `return await win.webContents.executeJavaScript(${JSON.stringify(`Array.from(document.querySelectorAll(".notification-list-item")).filter(node=>{if(!node.textContent.includes(${JSON.stringify(text)})){return false;}const rect=node.getBoundingClientRect();if(rect.height<=0||rect.top<0||rect.bottom>innerHeight||rect.left<0||rect.right>innerWidth){return false;}for(let parent=node;parent;parent=parent.parentElement){if(Number(getComputedStyle(parent).opacity)<0.99||parent.getAnimations().some(animation=>animation.playState==="running")){return false;}}return true;}).map(node=>({text:node.textContent,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height}))`)});`);
      if (visible.length) { break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(visible.length, 1, "blocked input should produce one visible recovery notification");
    await captureTestWorkbench(extension, path.resolve(__dirname, "../../../.vscode-test/results/terminal-recovery-notice.png"));
    await evaluateTestWorkbench(extension, `return await win.webContents.executeJavaScript(${JSON.stringify(`(function(){for(const node of document.querySelectorAll(".notification-list-item")){if(node.textContent.includes(${JSON.stringify(text)})){node.querySelector(".codicon-notifications-clear")?.click();}}return "recovery-notice-closed";})()`)});`);
    console.log("Terminal input recovery notification passed:", JSON.stringify(visible));
  } finally { session.dispose(); }
}

module.exports = { assertTerminalRecoveryNotice };

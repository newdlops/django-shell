// Serves the production console with a deterministic host message bridge for output interaction checks.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import Module, { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const theme = `:root{color-scheme:dark;--vscode-font-family:Arial,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,monospace;--vscode-editor-font-size:12px;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-disabledForeground:#6b6b6b;--vscode-editor-background:#1f1f1f;--vscode-editorGroupHeader-tabsBackground:#181818;--vscode-editorWidget-background:#252526;--vscode-panel-border:#454545;--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-focusBorder:#007fd4;--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#026ec1;--vscode-button-secondaryBackground:#313131;--vscode-list-hoverBackground:#2a2d2e;--vscode-errorForeground:#f48771;--vscode-terminal-ansiGreen:#89d185}
:root[data-theme=light]{color-scheme:light;--vscode-foreground:#333333;--vscode-descriptionForeground:#616161;--vscode-editor-background:#ffffff;--vscode-editorGroupHeader-tabsBackground:#f3f3f3;--vscode-editorWidget-background:#f3f3f3;--vscode-panel-border:#cecece;--vscode-input-background:#ffffff;--vscode-input-foreground:#333333;--vscode-input-border:#cecece;--vscode-button-secondaryBackground:#e5e5e5;--vscode-list-hoverBackground:#e8e8e8;--vscode-errorForeground:#b5200d}
:root[data-theme=contrast]{color-scheme:dark;--vscode-foreground:#ffffff;--vscode-descriptionForeground:#ffffff;--vscode-editor-background:#000000;--vscode-editorGroupHeader-tabsBackground:#000000;--vscode-editorWidget-background:#000000;--vscode-panel-border:#6fc3df;--vscode-focusBorder:#f38518;--vscode-list-hoverBackground:#0f4a85;--vscode-errorForeground:#f48771}`;

/** Resolves VS Code resource URIs while keeping the real HTML, styles, and renderer bundle. */
function fixtureHtml() {
  const original = Module._load;
  let html;
  try {
    Module._load = function (name, ...args) { return name === "vscode" ? { Uri: { file: (value) => value } } : original.call(this, name, ...args); };
    const { webviewHtml } = require(path.join(root, "out/customConsoleHtml.js"));
    html = webviewHtml({ asWebviewUri: (value) => "/" + path.relative(root, value), cspSource: "'self'" }, root);
  } finally { Module._load = original; }
  return html.replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, "").replace("</head>", `<style>${theme}</style><script src="/fixture.js"></script></head>`);
}

/** Simulates host replies without executing Python or contacting an actual Django project. */
function installBridge() {
  const parameters = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = parameters.get("theme") || "dark";
  let state = {};
  window.consoleFixture = {
    messages: [],
    /** Delivers a host event to the production console message handler. */
    send(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
  };
  window.acquireVsCodeApi = () => ({
    getState: () => state,
    setState: (value) => { state = value; },
    /** Captures user actions and provides the initial ready shell snapshot. */
    postMessage(message) {
      window.consoleFixture.messages.push(message);
      if (message.type === "ready") {
        setTimeout(() => {
          window.consoleFixture.send({ type: "terminalStatus", snapshot: { ready: true, mode: "django", state: "ready", text: "Python 3 / Django shell\r\n>>> " } });
          window.consoleFixture.send({ type: "transport", mode: "tcp", active: "tcp" });
        }, 0);
      } else if (message.type === "restart") {
        window.consoleFixture.send({ type: "resetPythonCell" });
      }
    }
  });
}

/** Starts a loopback-only fixture server with explicit cleanup for its owning browser test. */
export async function serveConsoleBrowser() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/") { response.setHeader("Content-Type", "text/html"); response.end(fixtureHtml()); return; }
    if (pathname === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(`(${installBridge.toString()})();`); return; }
    const filename = path.resolve(root, "." + pathname);
    if (!filename.startsWith(root + path.sep) || !pathname.startsWith("/media/") || !fs.existsSync(filename)) { response.writeHead(404); response.end(); return; }
    response.setHeader("Content-Type", filename.endsWith(".css") ? "text/css" : filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream");
    fs.createReadStream(filename).pipe(response);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

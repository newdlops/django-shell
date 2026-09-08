// Serves the production Model Data webview with an isolated, deterministic backend for browser UX checks.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import Module, { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);

/** Returns the production HTML while resolving VS Code asset URIs to this fixture server. */
function fixtureHtml() {
  const original = Module._load;
  let html;
  try {
    Module._load = function (name, ...args) { return name === "vscode" ? { Uri: { file: (value) => value } } : original.call(this, name, ...args); };
    const { modelBrowserHtml } = require(path.join(root, "out/modelBrowserHtml.js"));
    html = modelBrowserHtml({ asWebviewUri: (value) => "/" + path.relative(root, value), cspSource: "'self'" }, root);
  } finally { Module._load = original; }
  return html.replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, "").replace("</head>", `<style>${theme}</style><script src="/fixture.js"></script></head>`);
}

const theme = `:root{--vscode-font-family:Arial,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,monospace;--vscode-editor-font-size:12px;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-disabledForeground:#6b6b6b;--vscode-editor-background:#1f1f1f;--vscode-editorGroupHeader-tabsBackground:#181818;--vscode-editorWidget-background:#252526;--vscode-panel-border:#454545;--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-focusBorder:#007fd4;--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#026ec1;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;--vscode-errorForeground:#f48771;--vscode-inputValidation-errorBorder:#be1100;--vscode-textLink-foreground:#4daafc;--vscode-widget-border:#454545;--vscode-widget-shadow:rgba(0,0,0,.36);--vscode-dropdown-background:#313131;--vscode-dropdown-foreground:#cccccc;--vscode-dropdown-border:#454545}`;

/** Installs a message bridge which never contacts a database or writes application data. */
function installBridge() {
  const columns = [
    { name: "id", type: "AutoField", pk: true },
    { name: "username", label: "Username", type: "CharField" },
    { name: "email", label: "Email address", type: "EmailField" },
    { name: "is_active", label: "Active", type: "BooleanField" },
    { name: "login_count", label: "Login count", type: "IntegerField" },
    { name: "created_at", label: "Created", type: "DateTimeField" },
    { name: "status", label: "Status", type: "IntegerField", choices: [[1, "Pending"], [2, "Active"]] },
    { name: "long_customer_reference", label: "Customer reference from the imported regional account record — 표시 이름이 긴 필드", type: "CharField" }
  ].map((column) => ({ ...column, attname: column.name, editable: false, null: false }));
  const rows = [{ id: 1, username: "alex", email: "alex@example.test", is_active: true, login_count: 12, created_at: "2026-09-08T09:00:00" }, { id: 2, username: "mina", email: "mina@example.test", is_active: false, login_count: 4, created_at: "2026-09-07T09:00:00" }];
  let persisted = {};
  const parameters = new URLSearchParams(location.search);
  window.filterFixture = { messages: [], delay: 30, metadataError: parameters.has("metadata-error"), rejectApply: false };
  /** Delivers one backend reply through the production webview message listener. */
  function reply(message) { setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: message })), window.filterFixture.delay); }
  window.acquireVsCodeApi = () => ({
    getState: () => persisted, setState: (value) => { persisted = value; },
    postMessage(message) {
      window.filterFixture.messages.push(message);
      if (message.type === "ready") {
        reply({ type: "schema", schema: { app: "accounts", model: "User", label: "Users", table: "accounts_user", columns, pk: "id", relations: [] } });
        reply({ type: "rows", revision: 0, rows: { ok: true, rows, hasMore: false } });
        reply({ type: "transport", mode: "tcp", active: "tcp" });
      } else if (message.type === "filterFields") {
        reply({ type: "filterFields", requestId: message.requestId, result: window.filterFixture.metadataError ? { ok: false, error: "Fixture metadata unavailable" } : { ok: true, fields: columns, relations: [], pk: "id" } });
      } else if (message.type === "modelList") {
        reply({ type: "modelList", requestId: message.requestId, result: { ok: true, models: [{ app: "accounts", model: "User" }] } });
      } else if (message.type === "previewQueryRecipe") {
        const issues = message.recipe.where.children.filter((item) => item.kind === "comparison" && !item.lhs?.path).map((item) => ({ nodeId: item.nodeId, severity: "error", message: "Choose a field.", code: "field-required" }));
        reply({ type: "queryRecipePreview", requestId: message.requestId, revision: message.revision, validation: { ok: issues.length === 0, issues, warnings: [], ormPreview: "User.objects.filter(...)" } });
      } else if (message.type === "applyQueryRecipe") {
        if (window.filterFixture.rejectApply) { reply({ type: "queryRecipeRejected", revision: message.revision, issues: [{ severity: "error", code: "fixture-rejected", message: "The server could not apply these filters." }] }); }
        else {
          reply({ type: "queryRecipeApplied", revision: message.revision, recipe: message.recipe });
          reply({ type: "rows", revision: message.revision, rows: { ok: true, rows, hasMore: false } });
        }
      }
    }
  });
}

/** Starts one loopback-only fixture server and exposes deterministic cleanup to the caller. */
export async function serveFilterBrowser() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/") { response.setHeader("Content-Type", "text/html"); response.end(fixtureHtml()); return; }
    if (pathname === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(`(${installBridge.toString()})();`); return; }
    const filename = path.resolve(root, "." + pathname);
    if (!filename.startsWith(root + path.sep) || !pathname.startsWith("/media/") || !fs.existsSync(filename)) { response.writeHead(404); response.end(); return; }
    response.setHeader("Content-Type", filename.endsWith(".css") ? "text/css" : filename.endsWith(".js") ? "text/javascript" : "application/octet-stream");
    fs.createReadStream(filename).pipe(response);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

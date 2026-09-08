// Checks both native VS Code webviews for exact FK selection and JSON array commits with controlled data sources.
const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");
const { focusTestWorkbench } = require("./focusTestWorkbench.js");

/** Runs rendered picker and array controls through each production host without touching an application database. */
async function assertModelIntegrityWebview(extension, surface = "model") {
  const { ModelBrowser } = require(path.join(extension.extensionPath, "out", "modelBrowser.js"));
  const { ModelQueryConsole } = require(path.join(extension.extensionPath, "out", "modelQueryConsole.js"));
  const runtime = new vscode.EventEmitter(), calls = [], lookups = [];
  const text = '[{"ref":9007199254740993,"name":"old"},' + Array.from({ length: 9999 }, (_, index) => JSON.stringify({ ref: index + 2, name: `old ${index + 2}` })).join(",") + ']';
  const rows = [{ id: 1, company_id: "1", data: { t: "json", kind: "array", len: 10000, edit: text, v: text.slice(0, 400) } }];
  const columns = [
    { attname: "id", name: "id", editable: false, null: false, pk: true, type: "AutoField" },
    { attname: "company_id", name: "company", editable: true, null: false, pk: false, type: "CharField", relation: { field: "company", filterField: "code", target: "fixture.Company", single: true } },
    { attname: "data", name: "data", editable: true, null: false, pk: false, type: "JSONField" }
  ];
  const source = {
    modelRuntimeId: () => "integrity-runtime", interruptModelQuery: async () => ({ ok: true }), onDidChangeRuntime: runtime.event,
    setModelTransport() {}, modelTransportInfo: () => ({ active: "tcp", mode: "auto" }),
    listModels: async () => ({ ok: true, models: [{ app: "fixture", model: "Record" }, { app: "fixture", model: "Company" }] }),
    modelSchema: async () => ({ app: "fixture", model: "Record", columns, relations: [], pk: "id", ok: true }),
    modelFilterFields: async () => ({ fields: columns, relations: [], pk: "id", ok: true }),
    modelRows: async () => ({ columns, relations: [], rows: structuredClone(rows), pk: "id", ok: true, hasMore: false, nextOffset: null, orm: "", sql: [] }),
    modelQuery: async () => ({ app: "fixture", model: "Record", database: "archive", resultId: "integrity-result", columns, relations: [], rows: structuredClone(rows), pk: "id", editable: true, ok: true, hasMore: false, nextOffset: null, orm: "", sql: [] }),
    modelLookup: async (query) => {
      lookups.push(query); await new Promise((resolve) => setTimeout(resolve, 150));
      if (query.q === "fail") { throw new Error("Simulated lookup failure"); }
      return { ok: true, rows: query.q === "Beta" ? [{ pk: 2, value: "001", label: "#2 · Beta" }] : [], sql: [], hasMore: false };
    },
    modelCommit: async (query) => {
      calls.push(query);
      for (const [field, value] of Object.entries(query.changes[0].fields)) { rows[0][field] = field === "data" ? { t: "json", kind: "array", len: 10000, edit: value, v: value.slice(0, 400) } : value; }
      return { ok: true, saved: 1, results: [], sql: [], orm: "" };
    }
  };
  const host = surface === "model" ? new ModelBrowser(extension.extensionPath, source) : new ModelQueryConsole(extension.extensionPath, source);
  try {
    let result;
    if (surface === "model") {
      const pending = host.e2eProbeQueryBuilder({ app: "fixture", model: "Record" }, "integrity");
      await focusTestWorkbench(extension);
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
      result = await pending;
    }
    else {
      host.open();
      const deadline = Date.now() + 15000;
      while (!host.panelReady && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 25)); }
      assert.equal(host.panelReady, true);
      await host.handleMessage({ type: "runQuery", code: "Record.objects.all()", useOverlay: false });
      await focusTestWorkbench(extension);
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
      result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listener.dispose(); reject(new Error("Query integrity probe timed out")); }, 30000);
        const listener = host.panel.webview.onDidReceiveMessage((message) => {
          if (message.type !== "e2eQueryBuilderProbeResult" || message.requestId !== "query-integrity") { return; }
          clearTimeout(timer); listener.dispose(); resolve(message.snapshot);
        });
        void host.panel.webview.postMessage({ requestId: "query-integrity", suite: "integrity", type: "e2eQueryBuilderProbe" });
      });
    }
    assert.equal(result.error, undefined, JSON.stringify({ result, calls, lookups }));
    assert.equal(result.exactJson, true); assert.deepEqual(result.fkStates, ["pending", "empty", "error", "selected", "saved"]);
    const edited = text.replace('"name":"old"', '"name":"edited"');
    assert.deepEqual(calls.map((call) => call.changes[0].fields), [{ company_id: "001" }, { data: edited }, { data: edited.replace('"name":"old 51"', '"name":"page edited"') }]);
    assert.equal(result.arrayPageSize, 50); assert.equal(result.arrayPaging, true);
    assert.ok(lookups.every((query) => query.valueField === "code" && query.database === (surface === "query" ? "archive" : undefined)));
    console.log(`${surface} integrity webview passed at ${result.viewport.width} x ${result.viewport.height}`);
  } finally { host.dispose(); runtime.dispose(); }
}

module.exports = { assertModelIntegrityWebview };

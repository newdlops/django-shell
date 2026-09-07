// Verifies rendered main/related model editing and failure recovery in an isolated VS Code webview.

const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

/** Runs the real webview's stability flow against explicitly simulated database outcomes. */
async function assertModelStabilityWebview(extension, surface = "model") {
  const { ModelBrowser } = require(path.join(extension.extensionPath, "out", "modelBrowser.js"));
  const { ModelQueryConsole } = require(path.join(extension.extensionPath, "out", "modelQueryConsole.js"));
  const runtime = new vscode.EventEmitter();
  const calls = [], rows = [{ id: 1, name: "old", notes: "old notes", at: { t: "datetime", v: "2026-09-07T12:00:00.123456+00:00" } }];
  const childRows = [{ id: 2, name: "old child" }];
  const columns = [
    { attname: "id", editable: false, name: "id", null: false, pk: true, type: "AutoField" },
    ...["name", "notes"].map((name) => ({ attname: name, editable: true, name, null: false, pk: false, type: "CharField" })),
    { attname: "at", editable: true, name: "at", null: false, pk: false, type: "DateTimeField" }
  ];
  const childColumns = columns.slice(0, 2);
  const relations = [{ kind: "reverse-fk", name: "children", outerField: "id", queryName: "children", single: false, target: "fixture.Child" }];
  const source = {
    modelRuntimeId: () => "fixture-runtime", interruptModelQuery: async () => ({ ok: true, interrupted: true }),
    onDidChangeRuntime: runtime.event, setModelTransport() {}, modelTransportInfo: () => ({ active: "tcp", mode: "auto" }),
    listModels: async () => ({ models: [{ app: "fixture", model: "Record" }, { app: "fixture", model: "Child" }], ok: true }),
    modelSchema: async () => ({ app: "fixture", model: "Record", columns, relations, pk: "id", table: "fixture_record", ok: true }),
    modelFilterFields: async (_app, model) => ({ fields: model === "Child" ? childColumns : columns, relations: model === "Child" ? [] : relations, pk: "id", ok: true }),
    modelRows: async () => ({ columns, relations, rows: structuredClone(rows), pk: "id", ok: true, hasMore: false, nextOffset: null, orm: "", sql: [] }),
    modelRelated: async () => ({ app: "fixture", model: "Child", database: surface === "query" ? "archive" : undefined, columns: childColumns, rows: structuredClone(childRows), pk: "id", ok: true, hasMore: false, single: false, orm: "", sql: [] }),
    modelQuery: async (request) => {
      if (request.code) { assert.equal(queryRuns++, 0, "save reload must never replay submitted query source"); }
      else { assert.equal(request.resultId, "fixture-result"); }
      return { app: "fixture", model: "Record", database: "archive", resultId: "fixture-result", columns, relations, rows: structuredClone(rows), pk: "id", editable: true, ok: true, hasMore: false, nextOffset: null, orm: "", sql: [] };
    },
    modelCommit: async (query) => {
      calls.push(structuredClone(query));
      const attempt = calls.filter((call) => call.model === query.model).length;
      await new Promise((resolve) => setTimeout(resolve, 200));
      if ((query.model === "Record" && attempt === 2) || (query.model === "Child" && attempt === 1)) { throw new Error("Simulated save transport failure"); }
      const target = query.model === "Child" ? childRows[0] : rows[0];
      for (const [field, value] of Object.entries(query.changes[0].fields)) { target[field] = field === "at" ? { t: "datetime", v: value } : value; }
      return { ok: true, saved: 1, results: [], orm: "", sql: [] };
    }
  };
  let queryRuns = 0;
  const browser = surface === "query" ? new ModelQueryConsole(extension.extensionPath, source) : new ModelBrowser(extension.extensionPath, source);
  try {
    const result = surface === "query" ? await queryProbe(browser) : await browser.e2eProbeQueryBuilder({ app: "fixture", model: "Record" }, "stability");
    assert.equal(result.error, undefined, JSON.stringify({ result, calls }));
    assert.deepEqual(result, { datetimeLabel: "Date and time (UTC+00:00)", newerEditPreserved: true, parentDraftPreserved: true, saveFailureRecovered: true, relatedFailureRecovered: true });
    assert.deepEqual(calls.map((call) => [call.model, call.changes[0].fields]), [
      ["Record", { name: "saved name" }], ["Record", { notes: "newer notes" }], ["Record", { notes: "newer notes" }],
      ["Record", { at: "2026-09-07T12:01:00.123456+00:00" }], ["Child", { name: "saved child" }], ["Child", { name: "saved child" }]
    ]);
    assert.equal(rows[0].name, "saved name", "the parent draft must never be committed by saving a related row");
    if (surface === "query") { assert.equal(queryRuns, 1); assert.ok(calls.every((call) => call.database === "archive")); }
  } finally { browser.dispose(); runtime.dispose(); }
}

/** Runs the same rendered editor interactions through the production ORM Query host. */
async function queryProbe(host) {
  host.open();
  const deadline = Date.now() + 15000;
  while (!host.panelReady && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 25)); }
  assert.equal(host.panelReady, true, "ORM Query webview must send ready");
  await host.handleMessage({ code: "Record.objects.all()", type: "runQuery", useOverlay: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listener.dispose(); reject(new Error("ORM Query stability probe timed out")); }, 30000);
    const listener = host.panel.webview.onDidReceiveMessage((message) => {
      if (message.type === "e2eQueryBuilderProbeProgress") { console.log(`ORM Query probe: ${message.stage}`); }
      if (message.type !== "e2eQueryBuilderProbeResult" || message.requestId !== "query-stability") { return; }
      clearTimeout(timer); listener.dispose(); resolve(message.snapshot);
    });
    void host.panel.webview.postMessage({ requestId: "query-stability", suite: "stability", type: "e2eQueryBuilderProbe" });
  });
}

/** Runs just the changed save flows in a disposable extension-host test window. */
async function run() {
  const extension = vscode.extensions.getExtension(process.env.DJANGO_SHELL_E2E_EXTENSION_ID || "local.django-shell");
  assert.ok(extension, "Django Shell must be loaded before the save stability probe.");
  await extension.activate();
  await assertModelStabilityWebview(extension);
  await assertModelStabilityWebview(extension, "query");
}

module.exports = { assertModelStabilityWebview, run };

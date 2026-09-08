// Verifies linked-model database propagation and retained result ownership across runtime and panel lifetimes.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { deferred, flush, hostHarness } from "./stabilityHostHarness.mjs";
const harness = hostHarness();
const columns = [{ attname: "id", name: "id", type: "AutoField", pk: true }, { attname: "name", type: "CharField", editable: true }, { attname: "company_id", type: "ForeignKey", relation: { field: "company", target: "fixture.Company", filterField: "code" }, editable: true }];

test("Query relation Open preserves its database through two model panels and all panel operations", async () => {
  const requests = [], commands = [];
  const source = { modelTransportInfo: () => ({ active: "tcp", mode: "auto" }), interruptModelQuery: async () => ({ ok: true }) };
  for (const kind of ["modelRows", "modelCount", "modelComputed", "modelAggregate", "modelCommit", "modelRelated", "modelLookup"]) {
    source[kind] = async (query) => { requests.push({ kind, query }); return { ok: true, columns, relations: [], rows: [], values: {}, results: [], saved: 1, hasMore: false, nextOffset: null }; };
  }
  const browser = new harness.ModelBrowser(process.cwd(), source);
  const filename = path.resolve("out/modelQueryConsole.js"), localRequire = createRequire(filename), module = { exports: {} };
  const vscode = { commands: { executeCommand: async (command, target) => { commands.push({ command, target }); await browser.openModel(target); } } };
  const factory = vm.runInThisContext(`(function(exports, require, module, __filename, __dirname) {${fs.readFileSync(filename, "utf8")}\n})`, { filename });
  factory(module.exports, (id) => id === "vscode" ? vscode : localRequire(id), module, filename, path.dirname(filename));
  const query = new module.exports.ModelQueryConsole(process.cwd(), source);
  query.current = { app: "fixture", model: "Record", database: "archive" };
  try {
    await query.handleMessage({ type: "openModel", app: "fixture", model: "Company", filterField: "code", filterPk: "001" });
    const first = [...browser.panels][0];
    assert.equal(commands[0].target.database, "archive"); assert.match(first.panel.title, /\[archive\]/);
    await first.handleMessage({ type: "openModel", app: "fixture", model: "Record", filterPk: "002" });
    const second = [...browser.panels][1]; assert.equal(second.target.database, "archive");
    second.columns = columns;
    await second.loadPage(true); await second.loadComputed("display"); await second.requestCount(); await second.requestAggregate({ aggregates: [] });
    await second.handleMessage({ type: "commitEdits", editorId: "one", commitId: "save", changes: [{ pk: 1, fields: { name: "new" } }] });
    await second.handleMessage({ type: "expandRelated", relation: "company", pk: 1 });
    await second.handleMessage({ type: "lookupRelated", field: "company_id", target: "fixture.Company", requestId: "lookup", q: "Beta" });
    assert.equal(requests.length, 7);
    assert.ok(requests.every(({ query }) => query.database === "archive"), JSON.stringify(requests));
    query.current = undefined;
    await query.handleMessage({ type: "openModel", app: "fixture", model: "Company" });
    assert.equal(commands.length, 1, "mixed or unowned results cannot silently open the default database");
  } finally { browser.dispose(); query.closePanel(); query.queryRun.dispose(); }
});

test("result release reaches the original backend after runtime selection changes", async () => {
  const released = [], source = new harness.LazyRuntimeSource();
  const old = { modelQuery: async () => ({ ok: true, resultId: "owned" }), releaseModelQuery: async (id) => released.push(["old", id]) };
  const current = { releaseModelQuery: async (id) => released.push(["new", id]) };
  const console = { activeBackend: old, onDidChangeRuntime: () => ({ dispose() {} }) };
  source.bind(console);
  await source.modelQuery({ code: "value" }); console.activeBackend = current;
  await source.releaseModelQuery("owned"); await source.releaseModelQuery("owned");
  assert.deepEqual(released, [["old", "owned"]]); source.dispose();
});

test("query hosts release replaced and late results while preserving panel reopen without replay", async () => {
  const released = [], pending = deferred(); let runs = 0;
  const source = { modelTransportInfo: () => ({ active: "tcp", mode: "auto" }), modelRuntimeId: () => "runtime", interruptModelQuery: async () => ({ ok: true }),
    releaseModelQuery: async (id) => released.push(id), modelQuery: async () => ++runs === 3 ? pending.promise : { ok: true, resultId: `result-${runs}`, columns, rows: [], editable: true, app: "fixture", model: "Record", relations: [], hasMore: false } };
  const host = new harness.ModelQueryConsole(process.cwd(), source), panel = () => ({ dispose() {}, webview: { postMessage: async () => true } });
  host.panel = panel(); host.panelReady = true;
  try {
    await host.handleMessage({ type: "runQuery", code: "first", useOverlay: false });
    await host.handleMessage({ type: "runQuery", code: "second", useOverlay: false });
    assert.deepEqual(released, ["result-1"]);
    host.closePanel(); host.panel = panel(); await host.handleMessage({ type: "ready" });
    assert.equal(runs, 2); assert.equal(host.resultId, "result-2");
    const run = host.handleMessage({ type: "runQuery", code: "third", useOverlay: false }); await flush();
    host.closePanel(); pending.resolve({ ok: true, resultId: "orphan", columns, rows: [], relations: [], editable: false });
    await run; await flush();
    assert.deepEqual(released, ["result-1", "result-2", "orphan"]);
  } finally { host.dispose(); }
});

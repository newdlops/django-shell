// Checks relation lookup contracts and response ownership with production hosts and actual grid editor handlers.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { createEditor } from "../media/gridEdit.js";
import { buildEditableRelatedTable } from "../media/gridRelated.js";
import { domFixture } from "./stabilityDomHarness.mjs";
import { deferred, hostHarness } from "./stabilityHostHarness.mjs";
const harness = hostHarness();
const columns = [{ attname: "id", pk: true, editable: false, type: "AutoField" }, { attname: "name", editable: true, type: "CharField" }];
const fk = { attname: "company_id", editable: true, type: "CharField", relation: { field: "company", filterField: "code", target: "fixture.Company", single: true } };

/** Creates a Query host with observable panels, runtime identity, and controlled backend requests. */
function fixture(overrides = {}) {
  const messages = [], commits = [];
  let runtime = "runtime-1", receive;
  const source = { modelRuntimeId: () => runtime, modelTransportInfo: () => ({ active: "tcp", mode: "auto" }), interruptModelQuery: async () => ({ ok: true }),
    modelQuery: async () => ({ app: "fixture", model: "Record", database: "archive", resultId: "retained", columns: [...columns, fk], relations: [], rows: [], editable: true, ok: true, hasMore: false }),
    modelCommit: async (query) => { commits.push(structuredClone(query)); return { ok: true, saved: 1, results: [] }; }, ...overrides };
  const host = new harness.ModelQueryConsole(process.cwd(), source);
  /** Creates a fresh panel boundary without replacing the reusable host. */
  function panel() { return { webview: { postMessage: async (message) => { messages.push(message); receive?.(message); return true; } } }; }
  host.panel = panel(); host.panelReady = true; host.current = { app: "fixture", model: "Record", database: "archive" }; host.columns = [...columns, fk];
  return { host, source, messages, commits, panel, runtime: (value) => { runtime = value; }, receive: (callback) => { receive = callback; }, dispose: () => { host.closePanel(); host.queryRun.dispose(); } };
}

for (const surface of ["model", "query"]) {
  test(`${surface} FK search stages the selected relation value and recovers from errors`, async (t) => {
    const dom = domFixture(), original = globalThis.document;
    globalThis.document = dom.document; t.after(() => { globalThis.document = original; });
    const requests = [], posted = []; let failed = false;
    const lookup = async (request) => { requests.push(request); if (failed) { throw new Error("connection lost"); } return { ok: true, rows: [{ pk: 2, value: "beta-key", label: "#2 · Beta" }], sql: [], hasMore: false }; };
    const f = fixture({ modelLookup: lookup });
    const browser = surface === "model" ? new harness.ModelBrowser(process.cwd(), { modelLookup: lookup, modelTransportInfo: f.source.modelTransportInfo }) : undefined;
    if (browser) { await browser.openModel({ app: "fixture", model: "Record" }); }
    const host = browser ? [...browser.panels][0] : f.host;
    host.columns = [...columns, fk];
    t.after(() => { browser?.dispose(); f.dispose(); });
    const editor = createEditor({ post: (message) => posted.push(message), paintCell: (cell) => { cell.textContent = cell.dataset.staged ?? cell._editval; }, onChange() {}, reload() {}, notify() {} });
    const row = dom.el("tr", { dataset: { pk: "1" }, _pk: 1 }), cell = dom.el("td", { dataset: { attname: "company_id" }, _column: fk, _editval: "alpha-key" });
    row.appendChild(cell);
    /** Sends one real editor request to the host and routes its actual lookup response back. */
    async function lookupFromEditor() {
      editor.editCell(cell);
      const request = posted.at(-1);
      await host.handleMessage(request);
      const response = (browser ? harness.posted : f.messages).findLast((message) => message.type === "lookup" && message.requestId === request.requestId);
      assert.ok(response); editor.onLookup(response); return response;
    }
    await lookupFromEditor();
    assert.equal(requests[0].valueField, "code"); assert.equal(requests[0].database, surface === "query" ? "archive" : undefined);
    cell.querySelector("input").dispatch("keydown", { key: "Enter" });
    editor.commitEdits(); assert.equal(posted.at(-1).changes[0].fields.company_id, "beta-key");
    editor.reset(); failed = true;
    const failure = await lookupFromEditor(); assert.equal(failure.result.ok, false); assert.match(cell.textContent, /Search failed/);
    editor.reset(); failed = false;
    const success = await lookupFromEditor(); assert.equal(success.result.ok, true); assert.match(cell.textContent, /Beta/);
    const current = posted.at(-1), input = cell.querySelector("input");
    input.value = "new search"; input.dispatch("input");
    editor.onLookup({ ...current, result: { ok: true, rows: [{ pk: 99, label: "stale option" }] } });
    assert.doesNotMatch(cell.textContent, /stale option/);
    editor.reset(); input.dispatch("blur"); assert.equal(editor.pendingCount(), 0);
  });
}

for (const replacement of ["panel", "query", "runtime"]) {
  test(`related responses cannot cross a ${replacement} replacement or select the old row for saving`, async (t) => {
    const dom = domFixture(), original = globalThis.document;
    globalThis.document = dom.document; t.after(() => { globalThis.document = original; });
    const old = deferred(), fresh = deferred(); let calls = 0;
    const f = fixture({ modelRelated: () => ++calls === 1 ? old.promise : fresh.promise }); t.after(f.dispose);
    const stale = f.host.handleMessage({ type: "expandRelated", requestId: 1, relation: "children", pk: 1 });
    if (replacement === "panel") { f.host.closePanel(); f.host.panel = f.panel(); }
    if (replacement === "runtime") { f.runtime("runtime-2"); f.host.handleRuntimeChange(); }
    if (replacement !== "panel") { await f.host.handleMessage({ type: "runQuery", code: "Record.objects.all()", useOverlay: false }); }
    const body = dom.el("div", { isConnected: true }), posted = [];
    const pendingRelated = new Map([[1, { body, label: "children", request: { relation: "children", pk: 2 } }]]);
    const renderer = vm.createContext({ pendingRelated, relatedTable: undefined, relRequestId: 1, logSql() {}, buildEditableRelatedTable, el: dom.el, renderValue: (value) => dom.el("span", {}, String(value)), vscode: { postMessage: (message) => posted.push(message) } });
    const source = fs.readFileSync(new URL("../media/modelBrowserSource.js", import.meta.url), "utf8"), start = source.indexOf("function onRelated(message) {");
    vm.runInContext(source.slice(start, source.indexOf("function renderError(", start)), renderer);
    f.receive((message) => { if (message.type === "related") { renderer.onRelated(message); } });
    const current = f.host.handleMessage({ type: "expandRelated", requestId: 1, relation: "children", pk: 2 });
    old.resolve({ ok: true, app: "fixture", model: "Child", pk: "id", columns, rows: [{ id: 11, name: "old child" }] }); await stale;
    assert.equal(pendingRelated.size, 1); assert.doesNotMatch(body.textContent, /old child/);
    fresh.resolve({ ok: true, app: "fixture", model: "Child", database: "archive", pk: "id", columns, rows: [{ id: 22, name: "current child" }] }); await current;
    assert.equal(pendingRelated.size, 0); assert.match(body.textContent, /current child/);
    const cell = body.querySelector("td.editable"); body.querySelector("table").dispatch("dblclick", { target: cell });
    cell.querySelector("input").value = "edited"; cell.querySelector("input").dispatch("blur"); body.querySelector("button").dispatch("click");
    await f.host.handleMessage(posted[0]); assert.equal(f.commits[0].changes[0].pk, 22); assert.equal(f.commits[0].database, "archive");
  });
}

test("relation errors end the current request and obsolete FK lookups never reach a new Query panel", async () => {
  const pending = deferred(), f = fixture({ modelLookup: () => pending.promise, modelRelated: async () => { throw new Error("related connection lost"); } });
  try {
    await f.host.handleMessage({ type: "expandRelated", requestId: 1, relation: "children", pk: 1 });
    assert.equal(f.messages.at(-1).result.ok, false); assert.match(f.messages.at(-1).result.error, /related connection lost/);
    const lookup = f.host.handleMessage({ type: "lookupRelated", requestId: 2, target: fk.relation.target, field: fk.attname, q: "Beta" });
    f.host.closePanel(); f.host.panel = f.panel(); pending.resolve({ ok: true, rows: [{ pk: 2, value: "beta-key", label: "Beta" }] }); await lookup;
    assert.equal(f.messages.some((message) => message.type === "lookup"), false);
  } finally { f.dispose(); }
});

test("opening a linked model filters the alternate field while preserving its exact textual key", async () => {
  const browser = new harness.ModelBrowser(process.cwd(), { modelTransportInfo: () => ({ active: "tcp", mode: "auto" }) });
  try {
    await browser.openModel({ app: "fixture", model: "Company", initialField: "code", initialPk: "001" });
    const panel = [...browser.panels][0];
    assert.deepEqual(panel.filters, [{ field: "code", lookup: "exact", value: "001" }]);
    const filter = panel.appliedRecipe.where.children[0];
    assert.equal(filter.lhs.path, "code"); assert.equal(filter.rhs.value, "001");
  } finally { browser.dispose(); }
});

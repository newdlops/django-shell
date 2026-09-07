// Verifies the production ORM Query host's replay boundaries and correlated grid-save recovery.
import assert from "node:assert/strict";
import test from "node:test";
import { createEditor } from "../media/gridEdit.js";
import { domFixture } from "./stabilityDomHarness.mjs";
import { deferred, flush, hostHarness } from "./stabilityHostHarness.mjs";
const { ModelQueryConsole, LazyRuntimeSource } = hostHarness();
const columns = [{ attname: "id", type: "BigIntegerField", pk: true }, { attname: "name", type: "CharField", editable: true }];

/** Opens the production query host on an observable webview messaging boundary. */
function fixture(overrides = {}) {
  const messages = [], calls = [];
  let runtime = "first-runtime";
  const source = {
    interruptModelQuery: async () => ({ ok: true, interrupted: true }), modelRuntimeId: () => runtime,
    modelTransportInfo: () => ({ active: "tcp", mode: "auto" }), setModelTransport() {},
    modelQuery: async (query) => {
      calls.push(structuredClone(query));
      return { app: "fixture", model: "Record", database: "archive", resultId: "retained-result", columns, editable: true, hasMore: !query.offset, nextOffset: query.offset ? null : 1, ok: true, orm: "", pk: "id", relations: [], rows: [{ id: query.offset ? "9007199254740993" : "9007199254740992", name: "old" }], sql: [] };
    }, ...overrides
  };
  const host = new ModelQueryConsole(process.cwd(), source);
  /** Creates another panel so delayed responses can be checked against its actual identity. */
  const panel = () => ({ webview: { postMessage: async (message) => { messages.push(structuredClone(message)); return true; } } });
  host.panel = panel(); host.panelReady = true;
  return { host, calls, messages, panel, source, runtime: (value) => { runtime = value; }, dispose: () => { host.closePanel(); host.queryRun.dispose(); } };
}

test("only explicit Run sends source code; paging uses a handle and runtime/transport/reopen never replay it", async () => {
  const f = fixture(), code = "Record.objects.create(name='once')\nRecord.objects.all()";
  try {
    await f.host.handleMessage({ type: "runQuery", code, useOverlay: false });
    f.host.handleRuntimeChange(); await flush();
    await f.host.handleMessage({ type: "loadMore" });
    await f.host.handleMessage({ type: "reload" });
    await f.host.handleMessage({ type: "setTransport", mode: "pty" });
    f.host.closePanel(); f.host.panel = f.panel(); await f.host.handleMessage({ type: "ready" });
    assert.equal(f.calls.length, 3); assert.equal(f.calls.filter((query) => query.code !== undefined).length, 1);
    assert.deepEqual(f.calls.map((query) => query.offset), [0, 1, 0]);
    assert.ok(f.calls.slice(1).every((query) => query.resultId === "retained-result" && query.code === undefined));
    assert.equal(new Set(f.calls.map((query) => query.executionId)).size, 3);
    f.runtime("replacement"); f.host.handleRuntimeChange(); await flush();
    assert.equal(f.host.current, undefined); assert.equal(f.host.resultId, undefined);
    await f.host.handleMessage({ type: "reload" }); assert.equal(f.calls.length, 3);
    await f.host.handleMessage({ type: "runQuery", code, useOverlay: false }); assert.equal(f.calls.length, 4);
  } finally { f.dispose(); }
});

test("query cancellation identifies precisely the pending run, including runtime replacement", async () => {
  const pending = deferred(), requests = [], interrupts = [];
  const f = fixture({ modelQuery: (query) => { requests.push(query); return pending.promise; }, interruptModelQuery: async (reason, executionId) => { interrupts.push({ reason, executionId }); return { ok: true, interrupted: true }; } });
  try {
    const run = f.host.handleMessage({ type: "runQuery", code: "slow()", useOverlay: false }); await flush();
    f.runtime("replacement"); f.host.handleRuntimeChange(); await run;
    assert.equal(interrupts.length, 1); assert.equal(interrupts[0].executionId, requests[0].executionId);
    pending.resolve({ ok: true, columns: [], rows: [{ id: 1 }], editable: true }); await flush();
    assert.equal(f.messages.some((message) => message.type === "rows"), false);
  } finally { f.dispose(); }
});

for (const type of ["commitEdits", "commitRelated"]) {
  for (const fail of [false, true]) {
    test(`ORM Query ${type} ${fail ? "failure retains drafts and releases" : "success clears and releases"} only the initiating editor`, async () => {
      const dom = domFixture(), pending = deferred(), commits = [], posted = [];
      const originalDocument = globalThis.document; globalThis.document = dom.document;
      const f = fixture({ modelCommit: (query) => { commits.push(query); return pending.promise; } });
      try {
        f.host.current = { app: "fixture", model: "Record", database: "archive" }; f.host.columns = columns;
        const notices = [], editor = createEditor({ onChange() {}, onCommitStart() {}, onCommitEnd() {}, paintCell() {}, post: (message) => posted.push(message), reload() {}, notify: (text) => notices.push(text) });
        const row = dom.el("tr", { dataset: { pk: "9007199254740993" }, _pk: "9007199254740993" });
        const cell = dom.el("td", { dataset: { attname: "name" }, _column: { type: "CharField" }, _editval: "old" }); row.appendChild(cell);
        editor.editCell(cell); cell.querySelector("input").value = "new"; cell.querySelector("input").dispatch("blur");
        editor.commitEdits(); assert.equal(editor.isCommitting(), true);
        const message = { ...posted[0], type, ...(type === "commitRelated" ? { app: "fixture", model: "Child", database: "archive", columns } : {}) };
        const save = f.host.handleMessage(message);
        if (fail) { pending.reject(new Error("connection lost")); } else { pending.resolve({ ok: true, saved: 1, results: [], orm: "", sql: [] }); }
        await save;
        const response = f.messages.find((message) => message.type === "commit");
        assert.equal(response.editorId, posted[0].editorId); assert.equal(response.commitId, posted[0].commitId);
        assert.equal(editor.handleResult(response), true); assert.equal(editor.isCommitting(), false); assert.equal(editor.pendingCount(), fail ? 1 : 0);
        assert.equal(commits[0].database, "archive"); assert.equal(commits[0].changes[0].pk, "9007199254740993"); assert.equal(commits[0].model, type === "commitRelated" ? "Child" : "Record");
      } finally { globalThis.document = originalDocument; f.dispose(); }
    });
  }
}

test("invalid saves return correlated failures and a closed panel never receives a previous panel's response", async () => {
  const pending = deferred(), f = fixture({ modelCommit: () => pending.promise });
  try {
    await f.host.handleMessage({ type: "commitEdits", editorId: "old-editor", commitId: "old-commit", changes: [] });
    assert.equal(f.messages[0].result.ok, false); assert.equal(f.messages[0].commitId, "old-commit");
    f.host.current = { app: "fixture", model: "Record", database: "archive" };
    const save = f.host.handleMessage({ type: "commitEdits", editorId: "old-editor", commitId: "pending", changes: [{ pk: 1, fields: { name: "new" } }] });
    f.host.closePanel(); f.host.panel = f.panel(); pending.resolve({ ok: true, saved: 1, results: [], orm: "", sql: [] }); await save;
    assert.equal(f.messages.length, 1);
  } finally { f.dispose(); }
});

test("runtime replacement routes Cancel to the query's captured backend and never to the new Console", async () => {
  const source = new LazyRuntimeSource(), pending = deferred(), interrupts = [];
  const oldBackend = { runtimeId: "old", modelQuery: () => pending.promise, interrupt: async (reason, executionId) => { interrupts.push(["old", reason, executionId]); return { ok: true, interrupted: true }; } };
  const replacement = { runtimeId: "new", interrupt: async () => { interrupts.push(["new"]); return { ok: true, interrupted: true }; } };
  const runtime = { activeBackend: oldBackend, onDidChangeRuntime: () => ({ dispose() {} }) };
  source.bind(runtime);
  const query = source.modelQuery({ code: "slow()", executionId: "captured-query" });
  runtime.activeBackend = replacement;
  assert.equal(source.modelRuntimeId(), "new");
  await source.interruptModelQuery("modelQuery.cancel", "captured-query");
  await source.interruptModelQuery("modelQuery.cancel", "unknown");
  await source.interruptModelQuery("modelQuery.cancel");
  pending.resolve({ ok: false }); await query;
  await source.interruptModelQuery("modelQuery.cancel", "captured-query");
  assert.deepEqual(interrupts, [["old", "modelQuery.cancel", "captured-query"]]);
  source.dispose();
});

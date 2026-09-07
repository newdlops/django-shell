// Verifies PTY timeout quarantine, queue cancellation, and runtime exit using real session methods.

import assert from "node:assert/strict";
import test from "node:test";
import { hostHarness, flush, withClock } from "./stabilityHostHarness.mjs";
const harness = hostHarness();
const prefix = "__DJANGO_SHELL_BACKEND_RESPONSE__";

test("expired literal cells retire queued work until the late response and a fresh prompt arrive", async () => withClock(async (clock) => {
  const session = harness.session();
  try {
    const first = session.requestViaPty({ kind: "ormcell", code: "first_query" });
    const second = session.requestViaPty({ kind: "ormcell", code: "second_query" });
    const retired = Promise.allSettled([first, second]);
    clock.advance(35000);
    assert.ok((await retired).every((result) => result.status === "rejected"));
    assert.equal(session.process.writes.length, 1, "the queued second cell must never be sent into an unsynchronized stream");
    const late = prefix + JSON.stringify({ id: "_djs_cell-1", response: { ok: true, rows: ["old"] } }) + "\r\n";
    session.handleOutput(late.slice(0, 15)); session.handleOutput(late.slice(15));
    await assert.rejects(session.requestViaPty({ kind: "ormcell", code: "too_early" }), /Waiting for the previous/);
    session.handleOutput("\r\n>>> ");
    const current = session.requestViaPty({ kind: "ormcell", code: "current_query" });
    let settled = false; current.then(() => { settled = true; });
    session.resolvePtyResponse("_djs_cell-1", { ok: true, rows: ["duplicate"] });
    session.resolvePtyResponse("old-rpc-id", { ok: true, rows: ["wrong"] });
    await flush(); assert.equal(settled, false);
    session.resolvePtyResponse("_djs_cell-2", { ok: true, rows: ["current"] });
    assert.deepEqual(JSON.parse(await current).rows, ["current"]);
    assert.equal(clock.count(), 0);
  } finally { session.dispose(); }
}));

test("timed-out wrapped ORM cells ignore unrelated markers and also require prompt synchronization", async () => withClock(async (clock) => {
  const session = harness.session(); session.cellCapture = false;
  try {
    const result = session.requestViaPty({ kind: "ormcell", code: "multi\nline" });
    const failed = assert.rejects(result, /timed out/), id = [...session.ptyRequests.keys()][0];
    clock.advance(35000); await failed;
    session.resolvePtyResponse("_djs_cell-1", { ok: true });
    session.handleOutput(">>> ");
    await assert.rejects(session.requestViaPty({ kind: "ormcell", code: "blocked" }), /Waiting/);
    session.handleOutput(prefix + JSON.stringify({ id, response: { ok: true } }) + "\r\n>>> ");
    const next = session.requestViaPty({ kind: "ormcell", code: "fresh" });
    session.resolvePtyResponse([...session.ptyRequests.keys()][0], { ok: true });
    assert.equal(JSON.parse(await next).ok, true);
  } finally { session.dispose(); }
}));

test("restart cancels active and queued requests without writing old work to the replacement process", async () => {
  const session = harness.session(), previous = session.process;
  const first = session.requestViaPty({ kind: "execute", code: "active" });
  const second = session.requestViaPty({ kind: "execute", code: "queued" });
  const paced = session.writePacedPtyRequest("upload", "upload\r", 90000, "fixture");
  const results = Promise.allSettled([first, second, paced]);
  session.restart();
  assert.ok((await results).every((result) => result.status === "rejected"));
  assert.equal(previous.killed, true); assert.deepEqual(session.process.writes, []);
  session.cellCapture = true;
  const fresh = session.requestViaPty({ kind: "execute", code: "fresh" });
  session.resolvePtyResponse("_djs_cell-1", { ok: true });
  assert.equal(JSON.parse(await fresh).ok, true);
  session.dispose();
});

test("dispose settles every waiter and prevents subsequent writes or process starts", async () => {
  const session = harness.session(), previous = session.process;
  const results = Promise.allSettled([session.requestViaPty({ kind: "execute", code: "active" }), session.requestViaPty({ kind: "execute", code: "queued" })]);
  session.dispose();
  assert.ok((await results).every((result) => result.status === "rejected"));
  const processes = harness.processes.length;
  session.start(); session.restart(); session.write("must not reach a dead shell");
  await assert.rejects(session.requestViaPty({ kind: "execute", code: "late" }), /no longer available/);
  assert.equal(harness.processes.length, processes); assert.equal(previous.writes.length, 1);
  assert.equal(session.snapshot().ready, false);
});

test("restart cancels paced upload timers before any remaining lines can reach the new shell", async () => withClock(async (clock) => {
  const session = harness.session(), previous = session.process;
  const upload = session.writePacedPtyRequest("upload", "first\rsecond\rthird\r", 90000, "fixture");
  const rejected = assert.rejects(upload, /cancelled/);
  assert.equal(previous.writes.length, 1);
  session.restart(); await rejected; clock.advance(90000);
  assert.equal(previous.writes.length, 1); assert.deepEqual(session.process.writes, []);
  assert.equal(clock.count(), 0); session.dispose();
}));

for (const exitCode of [0, 1]) {
  test(`PTY exit ${exitCode} detaches the backend, settles work, and supports a fresh restart`, async () => {
    const session = harness.session(), snapshots = [];
    session.started = false; session.start(); session.onDidChange((snapshot) => snapshots.push(snapshot));
    const process = session.process;
    const settled = Promise.allSettled([session.requestViaPty({ kind: "execute", code: "active" }), session.requestViaPty({ kind: "execute", code: "queued" })]);
    process.exitCallback({ exitCode, signal: exitCode ? 9 : 0 });
    assert.ok((await settled).every((result) => result.status === "rejected"));
    assert.equal(session.backend, undefined); assert.equal(session.process, undefined);
    assert.equal(snapshots.at(-1).ready, false); assert.equal(snapshots.at(-1).state, "closed");
    process.dataCallback("late old output"); assert.equal(session.snapshot().text, "");
    session.restart(); assert.ok(session.process); assert.notEqual(session.process, process);
    assert.equal(session.snapshot().ready, false); session.dispose();
  });
}

test("idle terminal output stays bounded while split response markers remain recognizable", async () => {
  const session = harness.session();
  session.handleOutput("ordinary output\n".repeat(10000));
  assert.ok(session.ptyRequestBuffer.length < prefix.length);
  session.handleOutput(prefix + "null\n");
  session.dispose();
});

test("cancelling a queued PTY query leaves the Console owner untouched and removes only that query", async () => {
  const session = harness.session(), controller = new AbortController();
  try {
    const consoleCell = session.requestViaPty({ kind: "execute", code: "console owns terminal" });
    const query = session.requestViaPty({ kind: "query", code: "must never execute", executionId: "queued" }, controller.signal);
    const cancelled = assert.rejects(query, /cancelled/); controller.abort(); await cancelled;
    assert.equal(session.process.writes.length, 1); assert.equal(session.process.writes.includes("\x03"), false);
    session.resolvePtyResponse("_djs_cell-1", { ok: true }); await consoleCell; await flush();
    assert.equal(session.process.writes.length, 1);
  } finally { session.dispose(); }
});

test("active query cancellation sends Ctrl-C once and keeps ownership until its matching response", async () => {
  const session = harness.session(), controller = new AbortController();
  try {
    const query = session.requestViaPty({ kind: "query", code: "slow query", executionId: "running" }, controller.signal);
    const id = [...session.ptyRequests.keys()][0];
    controller.abort(); assert.equal(session.process.writes.at(-1), "\x03");
    const next = session.requestViaPty({ kind: "execute", code: "next console" });
    assert.equal(session.process.writes.length, 2);
    session.resolvePtyResponse(id, { ok: false, error: "cancelled" }); await query; await flush();
    assert.equal(session.process.writes.length, 3);
    controller.abort(); assert.equal(session.process.writes.length, 3);
    session.resolvePtyResponse("_djs_cell-1", { ok: true }); await next;
  } finally { session.dispose(); }
});

// Tests delivery-aware fallback, isolated parallel-read contexts, and bounded interrupt sockets.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { deferred, flush, withClock } from "./stabilityHostHarness.mjs";
const require = createRequire(import.meta.url);
const net = require("node:net");
const { BackendClient } = require("../out/backendClient.js");

test("oversized input is rejected before either transport can execute it", async () => {
  let sockets = 0, fallbacks = 0;
  await withSocket(() => { sockets++; }, () => undefined, async () => {
    const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "fixture" }, undefined, async () => { fallbacks++; return JSON.stringify({ ok: true }); });
    const result = await client.execute("x".repeat(4 * 1024 * 1024 + 1));
    assert.equal(result.ok, false); assert.match(result.stderr || result.error, /input limit/);
    assert.equal(sockets, 0); assert.equal(fallbacks, 0);
  });
});

test("oversized responses close the socket and never replay a submitted operation", async () => {
  let fallbacks = 0;
  await withSocket((socket) => socket.emit("connect"), (socket) => queueMicrotask(() => socket.emit("data", "x".repeat(16 * 1024 * 1024 + 1))), async (sockets) => {
    const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "fixture" }, undefined, async () => { fallbacks++; return JSON.stringify({ ok: true }); });
    const result = await client.execute("counter += 1");
    assert.equal(result.ok, false); assert.match(result.stderr || result.error, /not retried/);
    assert.equal(sockets[0].destroyed, true); assert.equal(fallbacks, 0);
  });
});

/** Replaces the socket boundary while retaining the production client request and error handling. */
async function withSocket(connect, write, run) {
  const original = net.createConnection, sockets = [];
  net.createConnection = () => {
    const socket = new EventEmitter(); socket.destroyed = false;
    socket.setEncoding = () => undefined; socket.end = () => undefined;
    socket.destroy = () => { socket.destroyed = true; };
    socket.write = (wire) => write(socket, JSON.parse(wire));
    sockets.push(socket); queueMicrotask(() => connect(socket)); return socket;
  };
  try { await run(sockets); } finally { net.createConnection = original; }
}

for (const kind of ["execute", "query", "commit"]) {
  test(`${kind} never replays over PTY after a request was sent and the response was lost`, async () => {
    let sent = 0, fallbacks = 0;
    await withSocket((socket) => socket.emit("connect"), (socket) => { sent += 1; queueMicrotask(() => socket.emit("close")); }, async () => {
      const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "fixture" }, undefined, async () => { fallbacks += 1; return JSON.stringify({ ok: true }); });
      client.setTransportMode("auto");
      const result = kind === "execute" ? await client.execute("counter += 1") : kind === "query" ? await client.modelQuery({ code: "mutating_query()", limit: 50, offset: 0 }) : await client.modelCommit({ app: "fixture", model: "Record", changes: [{ pk: 1, fields: { name: "new" } }] });
      assert.equal(result.ok, false); assert.match(result.error || result.stderr, /not retried/);
      assert.equal(sent, 1); assert.equal(fallbacks, 0);
    });
  });
}

test("connection failure before sending still uses the terminal once", async () => {
  let sent = 0, fallbacks = 0;
  await withSocket((socket) => socket.emit("error", new Error("ECONNREFUSED")), () => { sent += 1; }, async () => {
    const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "fixture" }, undefined, async () => { fallbacks += 1; return JSON.stringify({ ok: true }); });
    assert.equal((await client.execute("safe_first_attempt")).ok, true);
    assert.equal(sent, 0); assert.equal(fallbacks, 1);
  });
});

for (const completionOrder of [[0, 1], [1, 0]]) {
  test(`parallel read contexts survive completion order ${completionOrder.join(" → ")} without affecting idle requests`, async () => {
    let fallbacks = 0;
    const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "fixture" }, undefined, async () => { fallbacks += 1; return JSON.stringify({ ok: true, columns: [], relations: [] }); });
    client.setTransportMode("auto"); client.markSocketUnavailable();
    const gates = [deferred(), deferred()];
    const reads = gates.map((gate) => client.withParallelModelReads(true, async () => { await gate.promise; return client.modelSchema("fixture", "Record"); }));
    assert.equal((await client.modelSchema("fixture", "Record")).ok, true, "an unrelated idle read never inherits another request's busy flag");
    for (const index of completionOrder) {
      gates[index].resolve();
      assert.equal((await reads[index]).ok, false, "this busy read retains its own socket-only policy across await");
    }
    assert.equal((await client.modelSchema("fixture", "Record")).ok, true); assert.equal(fallbacks, 2);
    const nested = await client.withParallelModelReads(true, () => client.withParallelModelReads(false, () => client.modelSchema("fixture", "Record")));
    assert.equal(nested.ok, false);
    await assert.rejects(client.withParallelModelReads(true, async () => { throw new Error("read failed"); }), /read failed/);
    assert.equal((await client.modelSchema("fixture", "Record")).ok, true);
  });
}

test("an interrupt socket that connects but never answers is closed at its response deadline", async () => withClock(async (clock) => {
  await withSocket((socket) => socket.emit("connect"), () => undefined, async (sockets) => {
    const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "fixture" });
    const pending = client.interrupt("modelQuery.cancel", "test-query"); await flush();
    clock.advance(4000); const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.interrupted, false);
    assert.equal(sockets[0].destroyed, true); assert.equal(clock.count(), 0);
  });
}));

test("forced Terminal reads fail promptly while Python owns the stream instead of enqueueing ORM cells", async () => {
  let fallbacks = 0;
  const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "fixture" }, undefined, async () => { fallbacks += 1; return JSON.stringify({ ok: true }); });
  client.setTransportMode("pty");
  const result = await client.withParallelModelReads(true, () => client.modelRows({ app: "fixture", model: "Record", limit: 50, offset: 0 }));
  assert.equal(result.ok, false); assert.match(result.error, /second backend connection/); assert.equal(fallbacks, 0);
});

test("a query cancelled while its backend feature loads is never submitted after the loader completes", async () => {
  const feature = deferred(), requests = [];
  await withSocket((socket) => socket.emit("connect"), (socket, request) => {
    requests.push(request); queueMicrotask(() => socket.emit("data", JSON.stringify({ ok: true, interrupted: true }) + "\n"));
  }, async () => {
    const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "fixture" });
    client.setModelBrowserFeatureLoader(() => feature.promise);
    const query = client.modelQuery({ code: "write_after_load()", executionId: "loading-query" });
    const cancelled = assert.rejects(query, /cancelled before execution/);
    await client.interrupt("modelQuery.cancel", "loading-query"); feature.resolve(); await cancelled;
    assert.deepEqual(requests.map(({ kind, executionId }) => [kind, executionId]), [["interrupt", "loading-query"]]);
  });
});

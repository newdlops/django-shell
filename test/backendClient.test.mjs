// Unit tests for backend client transport error handling.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import net from "node:net";
import test from "node:test";

const require = createRequire(import.meta.url);
const { BackendClient } = require("../out/backendClient.js");

test("preserves debugpy transport errors in execution results", async () => {
  const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "t" });
  client.setTransportMode("pty");

  const result = await client.debugpy("print('debugpy')");

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Terminal transport is unavailable/);
});

test("retries the socket after a transient failure instead of disabling it for the session", async () => {
  let connections = 0;
  let failNext = true;
  const server = net.createServer((socket) => {
    connections += 1;
    if (failNext) {
      failNext = false;
      socket.destroy();
      return;
    }
    socket.on("data", () => socket.end(`${JSON.stringify({ ok: true, version: "3.11" })}\n`));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const client = new BackendClient({ host: "127.0.0.1", port, token: "t" }, undefined, async () => {
    throw new Error("suppressed metadata must not reach the PTY fallback");
  });
  client.setTransportMode("orm");
  try {
    const failed = await client.environment();
    assert.equal(failed.ok, false);
    assert.equal(connections, 1);

    // Within the retry cooldown the socket is skipped entirely instead of paying another doomed connect.
    const cooled = await client.environment();
    assert.equal(cooled.ok, false);
    assert.equal(connections, 1);

    // Re-selecting a transport clears the transient cooldown so the recovered socket is probed again.
    client.setTransportMode("orm");
    const recovered = await client.environment();
    assert.equal(recovered.ok, true);
    assert.equal(connections, 2);

    // A remote shell's unreachable loopback stays off permanently, surviving transport re-selection.
    client.markSocketUnavailable();
    client.setTransportMode("orm");
    const remote = await client.environment();
    assert.equal(remote.ok, false);
    assert.equal(connections, 2);
  } finally {
    server.close();
  }
});

test("pins debug cell executes to the PTY while the socket keeps serving parallel reads", async () => {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.on("data", (chunk) => {
      const kind = JSON.parse(chunk.toString()).kind;
      const body = kind === "models" ? { ok: true, models: [] } : { ok: true, stdout: "", result: "" };
      socket.end(`${JSON.stringify(body)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const ptyPayloads = [];
  const client = new BackendClient({ host: "127.0.0.1", port, token: "t" }, undefined, async (payload) => {
    ptyPayloads.push(payload);
    return `${JSON.stringify({ ok: true, stdout: "", result: "" })}\n`;
  });
  client.setTransportMode("auto");
  try {
    // A debug run (breakpointLines present) must execute on the interactive main thread via the PTY.
    const debugged = await client.execute("x = 1", "/cell.py", 0, "x = 1", [1]);
    assert.equal(debugged.ok, true);
    assert.equal(connections, 0);
    assert.equal(ptyPayloads.length, 1);
    assert.deepEqual(ptyPayloads[0].breakpointLines, [1]);

    // The deliberate PTY routing must not start the socket cooldown: parallel reads keep using the socket.
    const models = await client.withParallelModelReads(true, () => client.models());
    assert.equal(models.ok, true);
    assert.equal(connections, 1);

    // A plain execute without debug metadata still uses the socket.
    const plain = await client.execute("x = 2");
    assert.equal(plain.ok, true);
    assert.equal(connections, 2);
    assert.equal(ptyPayloads.length, 1);
  } finally {
    server.close();
  }
});

test("routes remote parallel model reads through a forwarded tunnel endpoint", async () => {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.on("data", () => socket.end(`${JSON.stringify({ ok: true, models: [{ app: "db", label: "company", model: "Company", table: "db_company" }] })}\n`));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const tunnelPort = server.address().port;
  // Endpoint port 9 is the remote pod's loopback: unreachable from here, exactly like an SSH/kubectl shell.
  const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "t" }, undefined, async () => {
    throw new Error("parallel reads must use the tunnel, not the busy PTY");
  });
  client.setTransportMode("orm");
  client.markSocketUnavailable();
  try {
    const blocked = await client.withParallelModelReads(true, () => client.models());
    assert.equal(blocked.ok, false);
    assert.equal(connections, 0);

    client.useForwardedEndpoint("127.0.0.1", tunnelPort);
    const models = await client.withParallelModelReads(true, () => client.models());
    assert.equal(models.ok, true);
    assert.equal(models.models[0].model, "Company");
    assert.equal(connections, 1);
  } finally {
    server.close();
  }
});

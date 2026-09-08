// Verifies concurrent E2E reservations avoid occupied inspectors and release leases after completion or failure.
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { withInspectorPort } from "./e2e/inspectorPort.mjs";

/** Listens on one ephemeral loopback port for conflict-selection coverage. */
function listen() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("E2E inspector selection skips an occupied port without closing its owner", async () => {
  const server = await listen();
  try {
    const occupied = server.address().port;
    await withInspectorPort(async (selected) => {
      assert.equal(selected, occupied + 1);
      assert.equal(server.listening, true);
    }, { end: occupied + 2, start: occupied });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("concurrent reservations remain distinct before either VS Code inspector starts", async () => {
  const probe = await listen(), start = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const range = { start, end: start + 2 };
  await withInspectorPort(async (first) => {
    await withInspectorPort(async (second) => {
      assert.notEqual(first, second);
      await assert.rejects(withInspectorPort(async () => assert.fail("both slots are reserved"), range), /No available E2E inspector/);
    }, range);
    await withInspectorPort(async (second) => assert.notEqual(first, second), range);
  }, range);
  await withInspectorPort(async (port) => assert.equal(port, start), range);
});

test("a failed E2E run releases its inspector reservation", async () => {
  const probe = await listen(), start = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const range = { start, end: start + 1 };
  await assert.rejects(withInspectorPort(async () => { throw new Error("controlled launch failure"); }, range), /controlled launch failure/);
  await withInspectorPort(async (port) => assert.equal(port, start), range);
});

test("another runner process cannot reuse a reserved inspector, and process termination releases the lease", { timeout: 10000 }, async () => {
  const probe = await listen(), start = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const range = { start, end: start + 2 };
  const moduleUrl = new URL("./e2e/inspectorPort.mjs", import.meta.url).href;
  const source = `import { withInspectorPort } from ${JSON.stringify(moduleUrl)}; await withInspectorPort(async port => { process.send({port}); await new Promise(() => {}); }, ${JSON.stringify(range)});`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let exited = false;
  const exit = once(child, "exit").then(() => { exited = true; });
  try {
    const [message] = await Promise.race([once(child, "message"), exit.then(() => { throw new Error("Reservation child exited before reporting its port."); })]);
    assert.equal(message.port, start);
    await withInspectorPort(async (port) => assert.equal(port, start + 1), range);
    child.kill(); await exit;
    await withInspectorPort(async (port) => assert.equal(port, start), range);
  } finally { if (!exited) { child.kill(); await exit; } }
});

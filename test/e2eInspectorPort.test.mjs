// Verifies E2E inspector-port selection avoids occupied loopback ports.
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { findAvailableInspectorPort } from "./e2e/inspectorPort.mjs";

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
    const selected = await findAvailableInspectorPort({ end: occupied + 2, start: occupied });
    assert.equal(selected, occupied + 1);
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

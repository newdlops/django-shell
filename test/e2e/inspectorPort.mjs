// Finds an available Node inspector port inside the range scanned by workbench E2E helpers.
import net from "node:net";

export const INSPECTOR_PORT_END = 9269;
export const INSPECTOR_PORT_START = 9229;

/** Returns an available loopback port from the scanner range without disturbing an existing inspector. */
export async function findAvailableInspectorPort({ end = INSPECTOR_PORT_END, start = INSPECTOR_PORT_START } = {}) {
  for (let port = start; port < end; port += 1) {
    if (await canBind(port)) { return port; }
  }
  throw new Error(`No available Node inspector port in ${start}..${end - 1}.`);
}

/** Probes one loopback port by binding and immediately closing a disposable server. */
async function canBind(port) {
  if (await acceptsConnection(port)) { return false; }
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Returns whether a loopback port already has a listening owner, including a reuse-address listener. */
function acceptsConnection(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let finished = false;
    const finish = (value) => { if (finished) { return; } finished = true; socket.setTimeout(0); socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(200, () => finish(false));
  });
}

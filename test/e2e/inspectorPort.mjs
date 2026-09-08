// Holds an OS-owned companion socket so concurrent E2E runners cannot select the same inspector port.
import net from "node:net";

export const INSPECTOR_PORT_END = 9269;
export const INSPECTOR_PORT_START = 9229;

/** Retains a companion-port lease for the entire run; process exit also releases it automatically. */
export async function withInspectorPort(run, { end = INSPECTOR_PORT_END, start = INSPECTOR_PORT_START } = {}) {
  const count = end - start;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1024 || count < 1 || end + count > 65536) {
    throw new Error("Invalid E2E inspector and companion-port range.");
  }
  for (let port = start; port < end; port += 1) {
    let lease;
    try { lease = await listen(port + count); }
    catch (error) { if (error.code === "EADDRINUSE") { continue; } throw error; }
    try {
      if (await canBind(port)) { return await run(port); }
    } finally { await new Promise((resolve) => lease.close(resolve)); }
  }
  throw new Error(`No available E2E inspector reservation in ${start}..${end - 1}.`);
}

/** Binds one companion port with no persisted lock files and immediately closes any incoming connection. */
function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** Probes the actual inspector port while its companion reservation excludes other cooperating runners. */
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

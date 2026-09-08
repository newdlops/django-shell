// Covers remote bootstrap fallback ordering and ORM feature loading without waiting for a socket tunnel.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { deferred, flush, hostHarness, withClock } from "./stabilityHostHarness.mjs";

const harness = hostHarness();
const needsInline = "__DJANGO_SHELL_BACKEND_NEEDS_INLINE__\r\n>>> ";
const runtime = path.resolve("python/django_shell_backend.py");

/** Creates a session with the actual packaged backend source and a selected transport mode. */
function sessionFixture(mode = "orm") {
  const session = harness.session(); session.options.backendRuntimePath = runtime;
  session.client.setTransportMode(mode); session.client.markSocketUnavailable();
  return session;
}

test("remote attachment prefers the small receiver and retains a one-time fallback for unsupported terminals", () => {
  const session = sessionFixture(), modes = [];
  try {
    session.client = undefined;
    session.writeBootstrap = (command) => modes.push(command.mode);
    session.outputTail = "__DJANGO_SHELL_BACKEND_NEEDS_INLINE__\r\n"; session.inspectMarkers();
    assert.deepEqual(modes, []);
    session.outputTail = needsInline; session.inspectMarkers();
    assert.deepEqual(modes, ["seed"]); assert.equal(session.isRemoteTerminalBackend(), true);
    session.outputTail = ">>> "; session.inspectMarkers(); assert.deepEqual(modes, ["seed"]);
    session.outputTail = needsInline; session.inspectMarkers();
    assert.deepEqual(modes, ["seed", "cache"]);
    session.outputTail = needsInline; session.inspectMarkers(); assert.deepEqual(modes, ["seed", "cache", "inline"]);
    session.outputTail = needsInline; session.inspectMarkers(); assert.deepEqual(modes, ["seed", "cache", "inline"]);
  } finally { session.dispose(); }
});

test("a cached remote backend still uses a tunnel and lazy feature loading instead of local loopback", () => {
  const session = sessionFixture(), forward = deferred(), forwards = [];
  try {
    session.client = undefined; session.bootstrapCacheProbed = true;
    session.forwardBackendSocket = (port, client) => { forwards.push(port); assert.equal(client.remoteSocketUnavailable, true); return forward.promise; };
    session.outputTail = '__DJANGO_SHELL_BACKEND_READY__{"host":"127.0.0.1","port":54321,"token":"fixture","ipython":true,"cellCapture":true}\r\n';
    session.inspectMarkers();
    assert.equal(session.snapshot().ready, true); assert.equal(session.isRemoteTerminalBackend(), true);
    assert.deepEqual(forwards, [54321]); assert.equal(typeof session.client.featureLoader, "function");
    assert.deepEqual(session.process.writes, []);
  } finally { session.dispose(); forward.resolve(); }
});

for (const mode of ["orm", "pty"]) {
  test(`${mode} cache hits complete before a pending tunnel without sending the feature payload`, async () => {
    const session = sessionFixture(mode), forward = deferred(), requests = [];
    try {
      session.writePacedPtyRequest = async (id, command, timeout, kind) => { requests.push({ command, kind }); return JSON.stringify({ ok: true, reused: true }); };
      await session.deliverModelBrowserFeature(session.client, forward.promise);
      assert.equal(requests.length, 1); assert.equal(requests[0].kind, "featureCache");
      assert.ok(requests[0].command.length < 600); assert.doesNotMatch(requests[0].command, /\.append\(/);
    } finally { session.dispose(); forward.resolve(); }
  });
}

test("a remote ORM cache miss uploads through the serialized PTY while a tunnel is pending", async () => {
  const session = sessionFixture(), forward = deferred(), requests = [];
  try {
    session.writePacedPtyRequest = async (id, command, timeout, kind) => {
      requests.push({ command, kind }); return JSON.stringify({ ok: kind === "featureLoad", reused: false });
    };
    await session.deliverModelBrowserFeature(session.client, forward.promise);
    assert.deepEqual(requests.map((item) => item.kind), ["featureCache", "featureLoad"]);
    assert.match(requests[1].command, /\.append\(/); assert.match(requests[1].command, /digest/);
  } finally { session.dispose(); forward.resolve(); }
});

test("a tunnel that becomes available during the cache probe carries the feature upload", async () => {
  const session = sessionFixture(), forward = deferred(), requests = [];
  try {
    session.client.loadFeature = async (data, digest) => {
      if (!data) { throw new Error("tunnel pending"); }
      requests.push({ data, digest }); return { ok: true };
    };
    session.writePacedPtyRequest = async () => JSON.stringify({ ok: false });
    await session.deliverModelBrowserFeature(session.client, forward.promise);
    assert.equal(requests.length, 1); assert.ok(requests[0].data.length > 1000); assert.match(requests[0].digest, /^[a-f0-9]{64}$/);
  } finally { session.dispose(); forward.resolve(); }
});

test("Socket mode preserves its out-of-band preference while the tunnel starts", async () => {
  const session = sessionFixture("tcp"), forward = deferred(), requests = [];
  try {
    session.client.loadFeature = async (data) => { requests.push(data); return { ok: Boolean(data) }; };
    const loading = session.deliverModelBrowserFeature(session.client, forward.promise);
    await flush(); assert.deepEqual(requests, []);
    forward.resolve(); await loading;
    assert.equal(requests.length, 2); assert.equal(requests[0], undefined); assert.ok(requests[1].length > 1000);
    assert.deepEqual(session.process.writes, []);
  } finally { session.dispose(); forward.resolve(); }
});

test("a session replacement during the cache probe cannot upload old code into the new shell", async () => {
  const session = sessionFixture(), forward = deferred(), probe = deferred(), requests = [];
  try {
    session.writePacedPtyRequest = async (id, command, timeout, kind) => { requests.push(kind); return probe.promise; };
    const loading = session.deliverModelBrowserFeature(session.client, forward.promise);
    const rejected = assert.rejects(loading, /session restarted/);
    await flush(); session.client = new harness.BackendClient({ host: "127.0.0.1", port: 9, token: "replacement" });
    probe.resolve(JSON.stringify({ ok: false })); await rejected;
    assert.deepEqual(requests, ["featureCache"]); assert.deepEqual(session.process.writes, []);
  } finally { session.dispose(); forward.resolve(); }
});

test("restarting cancels the remaining paced cache probe lines", async () => withClock(async (clock) => {
  const session = sessionFixture(); session.client = undefined;
  const old = session.process;
  session.writeInlineBootstrapPaced("first\rsecond\rthird\r");
  assert.deepEqual(old.writes, ["first\r"]);
  session.restart(); clock.advance(1000);
  assert.deepEqual(old.writes, ["first\r"]); assert.deepEqual(session.process.writes, []);
  assert.equal(session.isRemoteTerminalBackend(), false); session.dispose();
}));

test("an explicit bootstrap failure cannot trigger another source upload when a prompt follows", () => {
  const session = sessionFixture(), modes = [], failures = [];
  try {
    session.onDidData((data) => failures.push(data));
    session.client = undefined; session.bootstrapSeedTried = true;
    session.writeBootstrap = (command) => modes.push(command.mode);
    session.outputTail = '__DJANGO_SHELL_BACKEND_FAILED__{"error":"Traceback (most recent call last): upload timed out"}\r\n';
    session.inspectMarkers(); assert.equal(session.snapshot().state, "failed");
    session.outputTail += ">>> "; session.inspectMarkers();
    session.outputTail = "Traceback (most recent call last): upload timed out\r\n>>> "; session.inspectMarkers();
    assert.deepEqual(modes, []);
    assert.equal(failures.length, 1); assert.match(failures[0], /upload timed out/);
  } finally { session.dispose(); }
});

test("incomplete capability data quarantines the terminal until restart, including late responses and prompts", async () => withClock(async () => {
  const session = sessionFixture(), process = session.process;
  try {
    const frame = { id: "broken-upload", header: "{}", data: "source" };
    const pending = session.writePacedPtyRequest(frame.id, "read_capability()\r", 60000, "capability.grid", frame);
    await flush(); session.write("user_query\r");
    session.handleOutput('__DJANGO_SHELL_BACKEND_RESPONSE__{"id":"broken-upload","response":{"ok":false,"restartRequired":true}}\r\n>>> ');
    assert.equal(JSON.parse(await pending).restartRequired, true);
    assert.deepEqual(process.writes, ["read_capability()\r"]);
    session.handleOutput('__DJANGO_SHELL_BACKEND_RESPONSE__{"id":"broken-upload","response":{"ok":true}}\r\n>>> ');
    session.handleOutput("late bytes\r\n>>> ");
    await assert.rejects(session.requestViaPty({ kind: "execute", code: "new_query" }), /Restart the shell/);
    assert.deepEqual(process.writes, ["read_capability()\r"]);
    session.restart(); assert.equal(session.retiredResponse, undefined);
  } finally { session.dispose(); }
}));

test("an incomplete receiver response arriving after the host timeout cannot reopen the terminal queue", async () => withClock(async (clock) => {
  const session = sessionFixture();
  try {
    const frame = { id: "late-upload", header: "{}", data: "source" };
    const pending = session.writePacedPtyRequest(frame.id, "read_capability()\r", 60000, "capability.grid", frame);
    const rejected = assert.rejects(pending, /timed out/); await flush(); clock.advance(60001); await rejected;
    session.handleOutput('__DJANGO_SHELL_BACKEND_RESPONSE__{"id":"late-upload","response":{"ok":false,"restartRequired":true}}\r\n>>> ');
    assert.equal(session.retiredResponse?.restartRequired, true);
    await assert.rejects(session.requestViaPty({ kind: "execute", code: "new_query" }), /Restart the shell/);
    assert.deepEqual(session.process.writes, ["read_capability()\r"]);
  } finally { session.dispose(); }
}));

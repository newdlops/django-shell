// Validates capability composition, independent readiness, and acknowledged raw upload ordering.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import zlib from "node:zlib";
import { PYTHON } from "./modelBrowserHelpers.mjs";
import { deferred, flush, withClock } from "./stabilityHostHarness.mjs";

const require = createRequire(import.meta.url);
const { backendCapabilityPayload } = require("../out/backendCapabilities.js");
const { BackendCapabilityLoader } = require("../out/backendCapabilityLoader.js");
const { BackendUploadChannel } = require("../out/backendUploadChannel.js");
const { readBackendSource } = require("../out/backendBootstrap.js");
const runtime = path.resolve("python/django_shell_backend.py"), source = readBackendSource(runtime);
const features = ["base", "grid", "schema", "inspection", "query", "models", "commit", "execution", "extras"];

/** Builds one input-ready marker without exposing payloads as Python commands. */
function marker(id, stage, size) { return '__DJANGO_SHELL_UPLOAD_READY__' + JSON.stringify({ id, stage, size }) + '\r\n'; }

test("execution capabilities follow the actual terminal or socket route, including progress and plain-shell cells", async () => {
  const { BackendClient } = require("../out/backendClient.js"), requested = [];
  const endpoint = { host: "127.0.0.1", port: 1, token: "fixture", cellCapture: true, ipython: true };
  const client = new BackendClient(endpoint, undefined, async () => JSON.stringify({ ok: true, result: "fixture" }));
  client.setCapabilityLoader(async (feature) => { requested.push(feature); }); client.setTransportMode("pty");
  await client.execute("2 + 3"); assert.equal(requested.pop(), "base");
  await client.execute("sum(item.pk for item in Model.objects.all())"); assert.equal(requested.pop(), "execution");
  await client.execute("dir()"); assert.equal(requested.pop(), "inspection");
  endpoint.ipython = false;
  await client.execute("x = 1\nx + 2"); assert.equal(requested.pop(), "execution");
  client.socketRequest = async () => JSON.stringify({ ok: true, result: "fixture" });
  client.useForwardedEndpoint("127.0.0.1", 1); client.setTransportMode("auto");
  await client.execute("len([1, 2])"); assert.equal(requested.pop(), "execution");
  assert.equal(client.transport, "tcp");
});

test("base contains Console and catalog support while model grids, queries, saves, and debugging remain deferred", () => {
  const base = backendCapabilityPayload(runtime, source, "base");
  const code = zlib.inflateSync(Buffer.from(base.data, "base64")).toString();
  assert.match(code, /def start\(/); assert.match(code, /def _browse_models\(/); assert.match(code, /def _pty_install_capture\(/);
  assert.doesNotMatch(code, /def _browse_commit\(|def _browse_query\(|def _start_native_debugger\(|def _browse_rows\(/);
  assert.ok(base.data.length < 40000);
  assert.ok(backendCapabilityPayload(runtime, source, "grid").data.length < 12000);
  assert.throws(() => backendCapabilityPayload(runtime, source + '\n# stale', "base"), /index is stale/);
});

test("all indexed capabilities install once without replacing live state or locks", { skip: !PYTHON }, () => {
  const packets = features.map((feature) => backendCapabilityPayload(runtime, source, feature));
  const script = ["import base64, json, zlib", `packets = json.loads(${JSON.stringify(JSON.stringify(packets))})`, "scope = {}",
    "exec(zlib.decompress(base64.b64decode(packets[0]['data'])), scope)",
    "state = scope['_STATE']; lock = scope['_EXECUTION_LOCK']; retained = scope['_QUERY_RESULTS']", "results = []",
    "scope['_backend_cache_write'] = lambda *args: None",
    "for packet in packets[1:]:", "    results.append(scope['_install_backend_capability'](packet))",
    "again = scope['_install_backend_capability'](packets[1])",
    "print(json.dumps({'results': results, 'again': again, 'state': state is scope['_STATE'], 'lock': lock is scope['_EXECUTION_LOCK'], 'retained': retained is scope['_QUERY_RESULTS'], 'loaded': sorted(state['capabilities'])}))"].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-"], { input: script, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const data = JSON.parse(result.stdout);
  assert.ok(data.results.every((item) => item.ok), JSON.stringify(data.results));
  assert.equal(data.again.reused, true); assert.equal(data.state, true); assert.equal(data.lock, true); assert.equal(data.retained, true);
  assert.deepEqual(data.loaded, features.toSorted());
});

test("capability requests share uploads while a pending optional load leaves base ready", async () => {
  const upload = deferred(), requests = [], client = { runtimeId: "fixture", loadFeature: async () => { throw new Error("no tunnel"); } };
  const loader = new BackendCapabilityLoader(runtime, client, () => true, async (frame, command) => { requests.push({ frame, command }); return upload.promise; });
  const first = loader.ensure("grid"), second = loader.ensure("grid");
  assert.equal(first, second); await loader.ensure("base"); await flush();
  assert.equal(requests.length, 1); assert.ok(requests[0].command.length < 200);
  assert.equal(requests[0].command.includes(requests[0].frame.data), false);
  assert.equal(requests[0].command.includes(JSON.parse(requests[0].frame.header).digest), false);
  upload.resolve(JSON.stringify({ ok: true })); await first;
});

test("capability upload failure retries only that capability and cannot continue in a replacement session", async () => {
  let current = true, count = 0;
  const client = { runtimeId: "fixture", loadFeature: async () => { throw new Error("no tunnel"); } };
  const loader = new BackendCapabilityLoader(runtime, client, () => current, async () => { count++; return JSON.stringify({ ok: count > 1, error: "fixture failure" }); });
  await assert.rejects(loader.ensure("grid"), /fixture failure/); await loader.ensure("grid"); assert.equal(count, 2);
  current = false; await assert.rejects(loader.ensure("schema"), /runtime changed/); assert.equal(count, 2);
  await assert.rejects(loader.ensure("base"), /runtime changed/);
  await assert.rejects(loader.ensure("grid"), /runtime changed/);
});

test("a socket cache response from a replaced runtime cannot complete capability readiness", async () => {
  const probe = deferred(); let current = true, uploads = 0;
  const client = { runtimeId: "fixture", loadFeature: async () => probe.promise };
  const loader = new BackendCapabilityLoader(runtime, client, () => current, async () => { uploads++; return '{"ok":true}'; });
  const pending = loader.ensure("grid"); await flush(); current = false; probe.resolve({ ok: true });
  await assert.rejects(pending, /runtime changed/); assert.equal(uploads, 0);
});

test("raw uploads wait for matching acknowledgements, ignore duplicates, and preserve manual input", async () => withClock(async (clock) => {
  const writes = [], channel = new BackendUploadChannel((data) => writes.push(data));
  const frame = { id: "current", header: '{"size":20000}', data: "a".repeat(20000) };
  channel.stage(frame); assert.equal(channel.holdInput("user_query\r"), true); assert.deepEqual(writes, []);
  channel.accept(marker("old", "header", frame.header.length));
  channel.accept(marker("current", "payload", frame.data.length)); assert.deepEqual(writes, []);
  const header = marker("current", "header", frame.header.length);
  channel.accept(header.slice(0, 20)); channel.accept(header.slice(20)); channel.accept(header);
  assert.deepEqual(writes, [frame.header]);
  channel.accept(marker("current", "payload", frame.data.length)); clock.advance(1);
  assert.equal(writes.slice(1).join(""), frame.data);
  channel.finish("old"); assert.equal(channel.active, true);
  channel.finish("current"); assert.equal(writes.at(-1), "user_query\r"); assert.equal(channel.active, false);
}));

test("cancelling a raw upload prevents pending chunks or old input from reaching the replacement runtime", async () => withClock(async (clock) => {
  const writes = [], channel = new BackendUploadChannel((data) => writes.push(data));
  channel.stage({ id: "old", header: "h", data: "x".repeat(50000) });
  channel.accept(marker("old", "header", 1)); channel.accept(marker("old", "payload", 50000)); channel.holdInput("old query\r");
  const before = writes.length; channel.cancel(); channel.stage({ id: "new", header: "new header", data: "new payload" });
  clock.advance(1000); channel.accept(marker("old", "payload", 50000));
  assert.equal(writes.length, before); channel.finish(); assert.equal(writes.length, before);
}));

test("incomplete upload responses discard held input while fully received checksum failures allow a retry", () => {
  const writes = [], channel = new BackendUploadChannel((data) => writes.push(data));
  for (const response of ['{"ok":false,"restartRequired":true}', 'invalid response']) {
    channel.stage({ id: "upload", header: "header", data: "data" }); channel.holdInput("pending_query\r");
    assert.equal(channel.finish("upload", response), false);
    assert.equal(channel.active, false); assert.deepEqual(writes, []);
  }
  channel.stage({ id: "retryable", header: "header", data: "data" }); channel.holdInput("next_query\r");
  assert.equal(channel.finish("retryable", '{"ok":false,"error":"Checksum mismatch"}'), true);
  assert.deepEqual(writes, ["next_query\r"]);
});

test("the Python receiver distinguishes interrupted frames from complete validation failures", { skip: !PYTHON }, () => {
  const file = path.resolve("python/backend_parts/02_stream_upload.pyfrag");
  const script = ["import json, pathlib, traceback", "responses = []", "scope = {'traceback': traceback, '_RESPONSE_PREFIX': 'fixture'}",
    `exec(pathlib.Path(${JSON.stringify(file)}).read_text(), scope)`,
    "scope['_print_marker'] = lambda prefix, value: responses.append(value['response'])",
    "scope['_pty_history_scrub'] = lambda *args: None",
    "for failure in (TimeoutError, EOFError, KeyboardInterrupt, ValueError):",
    "    def fail(*args):", '        """Raises one controlled receiver failure before installing any source."""', "        raise failure('fixture')",
    "    scope['_djs_read_upload'] = fail", "    scope['_load_capability_from_stdin']('grid', 2, 'request')",
    "print(json.dumps([{'ok': row['ok'], 'restart': bool(row.get('restartRequired'))} for row in responses]))"].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-"], { input: script, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), [true, true, true, false].map((restart) => ({ ok: false, restart })));
});

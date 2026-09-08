// Checks real backend socket admission and bounded UTF-8 output without a running application database.
import assert from "node:assert/strict";
import test from "node:test";
import { HAS_DJANGO, runBackend } from "./modelBrowserHelpers.mjs";
import { setup } from "./criticalBackendFixtures.mjs";

test("backend capture and response limits preserve valid JSON and report truncation", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(), "mod._BACKEND_CAPTURE_BYTES = 1024", "mod._BACKEND_RESPONSE_BYTES = 2048",
    "result = mod._browse_query({}, {'code': \"print('서울' * 2000)\\n[1]\"})", "wire = mod._encode_backend_response({'ok': True, 'value': 'x' * 4096})",
    "print(json.dumps({'ok': result['ok'], 'output': result['stdout'], 'wire': json.loads(wire), 'bytes': len(wire)}))"]);
  assert.equal(result.ok, true); assert.match(result.output, /Output truncated/); assert.doesNotMatch(result.output, /�/);
  assert.ok(Buffer.byteLength(result.output) < 1100); assert.equal(result.wire.ok, false); assert.match(result.wire.error, /may have executed/); assert.ok(result.bytes < 2048);
});

test("response encoding and capture tolerate surrogate-escaped Python text", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(), "capture = mod._BoundedTextCapture()", "capture.write(chr(0xdcff))",
    "wire = mod._encode_backend_response({'value': chr(0xdcff), 'output': capture.getvalue()})", "print(wire.decode('utf-8'))"]);
  assert.equal(result.value, "\udcff"); assert.equal(result.output, "\\udcff");
});

test("backend input deadlines, frame limits, and reserved control slots survive blocked work", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(), "import socket, threading, time", "mod._BACKEND_HANDSHAKES = 2", "mod._BACKEND_WORKERS = 1", "mod._BACKEND_CONTROLS = 1", "mod._BACKEND_READ_SECONDS = 0.15", "mod._BACKEND_REQUEST_BYTES = 256",
    "server = mod._Server(('127.0.0.1', 0), mod._Handler)", "server.namespace = {}; server.token = 'fixture'; server.initial_names = set()", "thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()",
    "def send(request):", '    """Sends one request to the isolated server and reads its bounded reply."""',
    "    with socket.create_connection(server.server_address, timeout=2) as client:", "        client.sendall(json.dumps(request).encode() + b'\\n')", "        with client.makefile('rb') as reader: return json.loads(reader.readline())",
    "try:", "    unauthorized = send({'kind': 'execute', 'token': 'wrong', 'code': 'changed = True'})", "    oversized = send({'token': 'fixture', 'padding': 'x' * 300})",
    "    server.workers.acquire()", "    try:", "        busy = send({'kind': 'complete', 'token': 'fixture', 'code': '1'})", "        control = send({'kind': 'progress', 'token': 'fixture'})", "    finally: server.workers.release()",
    "    idle = [socket.create_connection(server.server_address, timeout=2) for _ in range(2)]", "    deadline = time.monotonic() + 2",
    "    while len(server.pending) < 2 and time.monotonic() < deadline: time.sleep(0.005)", "    admitted = len(server.pending)",
    "    for client in idle:", "        with client.makefile('rb') as reader: assert json.loads(reader.readline())['ok'] is False", "        client.close()",
    "    deadline = time.monotonic() + 2", "    while server.pending and time.monotonic() < deadline: time.sleep(0.005)", "    recovered = send({'kind': 'complete', 'token': 'fixture', 'code': '1'})",
    "    print(json.dumps({'unauthorized': unauthorized['ok'], 'executed': 'changed' in server.namespace, 'oversized': oversized['ok'], 'busy': busy['ok'], 'control': control['ok'], 'idle': admitted, 'pending': len(server.pending), 'recovered': recovered['ok']}))",
    "finally:", "    server.shutdown(); server.server_close(); thread.join(timeout=2)"]);
  assert.deepEqual(result, { unauthorized: false, executed: false, oversized: false, busy: false, control: true, idle: 2, pending: 0, recovered: true });
});

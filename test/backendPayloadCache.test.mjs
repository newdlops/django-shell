// Exercises remote payload reuse, invalidation, and untrusted or unavailable cache storage in fresh Python processes.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { PYTHON } from "./modelBrowserHelpers.mjs";

const require = createRequire(import.meta.url);
const { backendFeaturePayload, buildCachedBackendBootstrapCommand, buildInlineBackendBootstrapCommand } = require("../out/backendBootstrap.js");
const { backendPayloadDigest } = require("../out/backendPayloadCache.js");
const cacheSource = fs.readFileSync("python/backend_parts/01_payload_cache.pyfrag", "utf8");
const featureLoader = fs.readFileSync("python/backend_parts/30_debug_progress.pyfrag", "utf8").split("\ndef _stage_debugpy_bundle(")[0];

/** Creates a disposable runtime whose startup records the current token without opening a socket. */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-cache-test-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const runtime = path.join(root, "backend.py");
  fs.writeFileSync(runtime, ["# Bootstrap cache fixture.", "import os, threading, traceback", cacheSource,
    "def start(namespace, token):", '    """Records a fresh shell attachment."""', "    namespace['attached_token'] = token",
    "def _pty_history_scrub(visible):", '    """Keeps the standalone fixture independent of IPython."""', "    pass", featureLoader,
    "# --- Model data browser", "def _browse_models():", '    """Returns the isolated fixture catalog."""', "    return {'ok': True}", ""].join("\n"));
  return { root, runtime };
}

/** Runs one isolated interpreter so a successful reuse cannot come from an existing Python module. */
function runPython(root, lines) {
  const script = ["import json, os, tempfile", `tempfile.tempdir = ${JSON.stringify(root)}`, ...lines].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8", timeout: 8000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

/** Executes each generated terminal line in the same shell namespace. */
function commandLines(command) {
  return [`for line in ${JSON.stringify(command.command)}.split('\\r'):`, "    if line: exec(line, namespace)"];
}

/** Loads only the test runtime's core for feature cache requests. */
function coreLines(runtime) {
  return [`source = open(${JSON.stringify(runtime)}, encoding='utf-8').read()`, "namespace = {}", "exec(source.split('# --- Model data browser')[0], namespace)"];
}

test("remote bootstrap reuses exact source across processes with a fresh token and short input lines", { skip: !PYTHON }, (t) => {
  const { root, runtime } = fixture(t);
  const inline = buildInlineBackendBootstrapCommand(runtime, "first-token");
  const probe = buildCachedBackendBootstrapCommand(runtime, "second-token");
  const first = runPython(root, ["namespace = {}", ...commandLines(inline), "print(json.dumps({'token': namespace['attached_token']}))"]);
  const second = runPython(root, ["namespace = {}", ...commandLines(probe), "print(json.dumps({'token': namespace.get('attached_token')}))"]);
  assert.equal(first.token, "first-token"); assert.equal(second.token, "second-token");
  assert.ok(probe.bytes < inline.bytes);
  assert.ok(probe.command.split("\r").every((line) => Buffer.byteLength(line) < 1024));
  const payloads = runPython(root, ["import base64, zlib", "root = os.path.join(tempfile.gettempdir(), 'django-shell-backend-' + str(getattr(os, 'getuid', lambda: 'user')()))",
    "print(json.dumps({'files': os.listdir(root), 'tokenStored': b'first-token' in zlib.decompress(base64.b64decode(open(os.path.join(root, 'core.b64'), 'rb').read()))}))"]);
  assert.deepEqual(payloads.files, ["core.b64"]); assert.equal(payloads.tokenStored, false);
});

test("core cache misses and source version changes cleanly request inline delivery", { skip: !PYTHON }, (t) => {
  const { root, runtime } = fixture(t);
  const oldInline = buildInlineBackendBootstrapCommand(runtime, "old");
  const missing = runPython(root, ["namespace = {}", ...commandLines(buildCachedBackendBootstrapCommand(runtime, "missing")),
    "print(json.dumps({'attached': 'attached_token' in namespace}))"]);
  assert.equal(missing.attached, false);
  runPython(root, ["namespace = {}", ...commandLines(oldInline), "print('{}')"]);
  fs.appendFileSync(runtime, "\n# This feature-only change leaves the cached core valid.\n");
  const unchanged = runPython(root, ["namespace = {}", ...commandLines(buildCachedBackendBootstrapCommand(runtime, "same-core")),
    "print(json.dumps({'token': namespace.get('attached_token')}))"]);
  assert.equal(unchanged.token, "same-core");
  fs.writeFileSync(runtime, fs.readFileSync(runtime, "utf8").replace("# Bootstrap cache fixture.", "# Changed core version."));
  const changed = runPython(root, ["namespace = {}", ...commandLines(buildCachedBackendBootstrapCommand(runtime, "new")),
    "print(json.dumps({'attached': 'attached_token' in namespace}))"]);
  assert.equal(changed.attached, false);
});

test("feature probes reuse only matching payloads and consumed staged chunks are always removed", { skip: !PYTHON }, (t) => {
  const { root, runtime } = fixture(t), data = backendFeaturePayload(runtime), digest = backendPayloadDigest(data);
  const first = runPython(root, [...coreLines(runtime), `data = ${JSON.stringify(data)}; digest = ${JSON.stringify(digest)}`,
    "load = namespace['_load_feature']", "missing = load({'digest': digest})",
    "bad = load({'data': data, 'digest': '0' * 64})", "uploaded = load({'data': data, 'digest': digest})",
    "staged = {'chunks': [data]}", "reused = load({'partsKey': 'chunks', 'digest': digest}, staged)",
    "print(json.dumps({'missing': missing['ok'], 'bad': bad['ok'], 'uploaded': uploaded, 'reused': reused, 'staged': staged}))"]);
  assert.equal(first.missing, false); assert.equal(first.bad, false);
  assert.deepEqual(first.uploaded, { ok: true, reused: false }); assert.deepEqual(first.reused, { ok: true, reused: true }); assert.deepEqual(first.staged, {});
  const second = runPython(root, [...coreLines(runtime), `result = namespace['_load_feature']({'digest': ${JSON.stringify(digest)}})`,
    "print(json.dumps({'result': result, 'loaded': '_browse_models' in namespace}))"]);
  assert.deepEqual(second, { result: { ok: true, reused: true }, loaded: true });
  const stale = runPython(root, [...coreLines(runtime), "result = namespace['_load_feature']({'digest': '0' * 64})",
    "print(json.dumps({'ok': result['ok'], 'loaded': '_browse_models' in namespace}))"]);
  assert.deepEqual(stale, { ok: false, loaded: false });
});

for (const unsafe of ["corrupt", "oversized", "symlink", "fifo", "directory"]) {
  test(`core cache rejects ${unsafe} entries without executing or blocking`, { skip: !PYTHON || (unsafe === "fifo" && process.platform === "win32") }, (t) => {
    const { root, runtime } = fixture(t), data = "untrusted code";
    const result = runPython(root, [...coreLines(runtime), "target = namespace['_backend_cache_path']('core')",
      ...(unsafe === "symlink" ? ["os.symlink(__file__ if '__file__' in globals() else '/dev/null', target)"] :
        unsafe === "fifo" ? ["os.mkfifo(target)"] : unsafe === "directory" ? ["os.mkdir(target)"] :
          [`open(target, 'wb').write(${unsafe === "oversized" ? "b'x' * (2 * 1024 * 1024)" : JSON.stringify(data) + ".encode()"})`]),
      ...commandLines(buildCachedBackendBootstrapCommand(runtime, "untrusted")),
      "print(json.dumps({'attached': 'attached_token' in namespace, 'feature': namespace['_backend_cache_read']('core', '0' * 64)}))"]);
    assert.deepEqual(result, { attached: false, feature: null });
  });
}

test("unavailable cache storage does not prevent inline startup or feature installation", { skip: !PYTHON }, (t) => {
  const { root, runtime } = fixture(t), data = backendFeaturePayload(runtime), digest = backendPayloadDigest(data);
  const result = runPython(root, ["root = os.path.join(tempfile.gettempdir(), 'django-shell-backend-' + str(getattr(os, 'getuid', lambda: 'user')()))",
    "open(root, 'w').write('occupied')", "namespace = {}", ...commandLines(buildInlineBackendBootstrapCommand(runtime, "no-cache")),
    `feature = namespace['_djs_backend_module']._load_feature({'data': ${JSON.stringify(data)}, 'digest': ${JSON.stringify(digest)}})`,
    "print(json.dumps({'token': namespace.get('attached_token'), 'feature': feature['ok']}))"]);
  assert.deepEqual(result, { token: "no-cache", feature: true });
});

test("feature installation is shared when multiple requests arrive before its definitions exist", { skip: !PYTHON }, (t) => {
  const { root, runtime } = fixture(t);
  const result = runPython(root, [...coreLines(runtime), "import base64, concurrent.futures, zlib",
    "source = 'import time\\nhits.append(1)\\ntime.sleep(0.05)\\ndef _browse_models():\\n    return {}\\n'",
    "data = base64.b64encode(zlib.compress(source.encode())).decode()", "namespace['hits'] = []",
    "with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:",
    "    results = list(pool.map(lambda _: namespace['_load_feature']({'data': data}), range(4)))",
    "print(json.dumps({'hits': len(namespace['hits']), 'ok': all(result['ok'] for result in results), 'reused': sum(result['reused'] for result in results)}))"]);
  assert.deepEqual(result, { hits: 1, ok: true, reused: 3 });
});

test("cache writes reject shared directory permissions without modifying its contents", { skip: !PYTHON || process.platform === "win32" }, (t) => {
  const { root, runtime } = fixture(t);
  const result = runPython(root, [...coreLines(runtime), "target = namespace['_backend_cache_path']('core')", "os.chmod(os.path.dirname(target), 0o777)",
    "namespace['_backend_cache_write']('core', 'ignored')", "print(json.dumps({'written': os.path.exists(target)}))"]);
  assert.deepEqual(result, { written: false });
});

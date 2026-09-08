// Verifies idle query-cache expiry, explicit ownership, active-page pinning, and retention budgets.
import assert from "node:assert/strict";
import test from "node:test";
import { HAS_DJANGO, runBackend } from "./modelBrowserHelpers.mjs";
import { setup } from "./criticalBackendFixtures.mjs";

test("cache accounting avoids custom size and iteration hooks on retained containers", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(),
    "class Owned(list):", '    """Rejects user-code execution during cache accounting."""',
    "    def __sizeof__(self):", '        """Raises if the cache invokes a custom size hook."""', "        raise RuntimeError('size hook executed')",
    "    def __iter__(self):", '        """Raises if the cache invokes a custom iteration hook."""', "        raise RuntimeError('iteration hook executed')",
    "value = Owned([{'nested': {'x' * 4096}}])", "size = mod._query_retained_bytes({'value': value})", "print(json.dumps({'size': size}))"]);
  assert.ok(result.size >= 4096);
});

test("retained results expire while idle without any later query", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(), "import gc, weakref, time", "mod._QUERY_RESULT_TTL = 0.04", "namespace = {}",
    "class Owned(list):", '    """Allows observing an otherwise unreferenced retained value."""', "    pass",
    "value = Owned([bytearray(1024 * 1024)])", "reference = weakref.ref(value)", "handle = mod._query_remember_result(namespace, value, 'value', None)", "del value",
    "deadline = time.monotonic() + 2", "while reference() is not None and time.monotonic() < deadline: time.sleep(0.02); gc.collect()",
    "print(json.dumps({'released': reference() is None, 'entries': len(mod._QUERY_RESULTS), 'timer': mod._QUERY_CACHE_TIMER is None}))"]);
  assert.deepEqual(result, { released: true, entries: 0, timer: true });
});

test("cache release checks namespace ownership and active page expiry waits until the page finishes", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(), "import time", "namespace = {}", "mod._QUERY_RESULT_TTL = 0.1", "handle = mod._query_remember_result(namespace, [1, 2], '[1, 2]', None)",
    "mod._query_forget_result(handle, {})", "foreign_retained = handle in mod._QUERY_RESULTS",
    "with mod._query_cached_result(namespace, handle):", "    time.sleep(0.15)", "    pinned = handle in mod._QUERY_RESULTS",
    "mod._run_request(namespace, 'fixture', {'token': 'fixture', 'kind': 'releaseQuery', 'resultId': handle}, set())",
    "print(json.dumps({'foreignRetained': foreign_retained, 'pinned': pinned, 'released': handle not in mod._QUERY_RESULTS, 'timer': mod._QUERY_CACHE_TIMER is None}))"]);
  assert.deepEqual(result, { foreignRetained: true, pinned: true, released: true, timer: true });
});

test("cache rejects oversized owned values and evicts older entries to respect its total budget", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(), "mod._QUERY_RESULT_BYTES = 4096", "mod._QUERY_CACHE_BYTES = 7500", "namespace = {}", "rejected = False",
    "try: mod._query_remember_result(namespace, [bytearray(8192)], 'large', None)", "except ValueError: rejected = True",
    "handles = [mod._query_remember_result(namespace, [bytearray(3000)], 'value', None) for _ in range(3)]",
    "print(json.dumps({'rejected': rejected, 'oldEvicted': handles[0] not in mod._QUERY_RESULTS, 'latestRetained': handles[-1] in mod._QUERY_RESULTS, 'bytes': sum(record['bytes'] for record in mod._QUERY_RESULTS.values())}))"]);
  assert.equal(result.rejected, true); assert.equal(result.oldEvicted, true); assert.equal(result.latestRetained, true); assert.ok(result.bytes <= 7500);
});

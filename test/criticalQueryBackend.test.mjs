// Exercises query cancellation ownership and non-replaying result handles against the real Python backend.
import assert from "node:assert/strict";
import test from "node:test";
import { HAS_DJANGO, runBackend } from "./modelBrowserHelpers.mjs";
import { setup, recordModel, threadedFixture } from "./criticalBackendFixtures.mjs";

test("cancelling a running query stops at its own checkpoint before the next database write and releases the lock", { skip: !HAS_DJANGO }, (t) => {
  const code = 'entered.set()\ngate.wait(2)\nRecord.objects.create(pk=1, name="must not be stored")\nRecord.objects.all()';
  const result = runBackend([...threadedFixture(t), "def query_cell():", '    """Runs one identified query on an independent backend thread."""',
    `    outcomes['query'] = mod._run_request(namespace, 'fixture', {'token': 'fixture', 'kind': 'query', 'executionId': 'running-query', 'code': ${JSON.stringify(code)}}, set())`,
    "thread = threading.Thread(target=query_cell, daemon=True); thread.start(); assert entered.wait(2)",
    "interrupt = mod._interrupt_execution({'executionId': 'running-query', 'reason': 'modelQuery.cancel'})",
    "gate.set(); thread.join(3); assert not thread.is_alive()", "lock_free = mod._EXECUTION_LOCK.acquire(blocking=False)", "if lock_free: mod._EXECUTION_LOCK.release()",
    "fresh = mod._browse_query(namespace, {'code': '42', 'executionId': 'fresh'})",
    "print(json.dumps({'interrupt': interrupt, 'queryOk': outcomes['query']['ok'], 'count': Record.objects.count(), 'lockFree': lock_free, 'fresh': fresh['ok']}))"]);
  assert.equal(result.queryOk, false); assert.equal(result.count, 0); assert.equal(result.lockFree, true); assert.equal(result.fresh, true);
  assert.equal(result.interrupt.ok, true);
  if (!result.interrupt.interrupted) { assert.match(result.interrupt.message, /not yet stopped/); }
});

test("query cancellation leaves the Console cell running and prevents the queued query from executing", { skip: !HAS_DJANGO }, (t) => {
  const consoleCode = 'Record.objects.create(pk=1, name="console first")\nentered.set()\ngate.wait(2)\nRecord.objects.create(pk=2, name="console second")';
  const queryCode = 'Record.objects.create(pk=3, name="cancelled query")\nRecord.objects.all()';
  const result = runBackend([...threadedFixture(t), "def console_cell():", '    """Owns the shared lock while the query waits."""',
    `    outcomes['console'] = mod._run_request(namespace, 'fixture', {'token': 'fixture', 'kind': 'execute', 'code': ${JSON.stringify(consoleCode)}}, set())`,
    "def query_cell():", '    """Submits a query with an independent cancellation identity."""',
    `    outcomes['query'] = mod._run_request(namespace, 'fixture', {'token': 'fixture', 'kind': 'query', 'executionId': 'queued-query', 'code': ${JSON.stringify(queryCode)}}, set())`,
    "console_thread = threading.Thread(target=console_cell, daemon=True); console_thread.start(); assert entered.wait(2)",
    "query_thread = threading.Thread(target=query_cell, daemon=True); query_thread.start()",
    "interrupt = mod._interrupt_execution({'executionId': 'queued-query', 'reason': 'modelQuery.cancel'})",
    "gate.set(); console_thread.join(3); query_thread.join(3)", "assert not console_thread.is_alive() and not query_thread.is_alive()",
    "print(json.dumps({'interrupt': interrupt, 'consoleOk': outcomes['console']['ok'], 'queryOk': outcomes['query']['ok'], 'names': list(Record.objects.order_by('pk').values_list('name', flat=True))}))"]);
  assert.equal(result.interrupt.interrupted, true); assert.equal(result.consoleOk, true); assert.equal(result.queryOk, false);
  assert.deepEqual(result.names, ["console first", "console second"]);
});

test("cancellation arriving before its query prevents submission and an absent ID never cancels Console", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(), "namespace = {'writes': []}",
    "cancel = mod._interrupt_execution({'executionId': 'future-query', 'reason': 'modelQuery.cancel'})",
    "query = mod._browse_query(namespace, {'code': 'writes.append(1)\\nwrites', 'executionId': 'future-query'})",
    "missing = mod._interrupt_execution({'reason': 'modelQuery.cancel'})",
    "print(json.dumps({'cancel': cancel, 'queryOk': query['ok'], 'missing': missing, 'writes': namespace['writes']}))"]);
  assert.equal(result.cancel.interrupted, true); assert.equal(result.queryOk, false); assert.equal(result.missing.ok, false); assert.deepEqual(result.writes, []);
});

test("paging and refreshing retained query results execute a leading database write only once", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(), ...recordModel(), "with connections['default'].schema_editor() as schema: schema.create_model(Record)",
    "Record.objects.bulk_create([Record(pk=index, name=str(index)) for index in range(1, 4)])", "namespace = {'Record': Record}",
    "first = mod._browse_query(namespace, {'code': \"Record.objects.create(pk=4, name='created once')\\nRecord.objects.order_by('pk')\", 'limit': 2})",
    "second = mod._browse_query(namespace, {'resultId': first['resultId'], 'offset': first['nextOffset'], 'limit': 2})",
    "Record.objects.filter(pk=1).update(name='updated outside query')",
    "refresh = mod._browse_query(namespace, {'resultId': first['resultId'], 'offset': 0, 'limit': 2})",
    "mod._QUERY_RESULTS.clear()",
    "expired = mod._browse_query(namespace, {'resultId': first['resultId'], 'code': \"Record.objects.create(pk=5, name='must not replay')\\nRecord.objects.all()\"})",
    "print(json.dumps({'first': first, 'second': second, 'refresh': refresh, 'expired': expired, 'count': Record.objects.count()}))"]);
  assert.equal(result.first.ok, true, result.first.error); assert.equal(result.second.ok, true, result.second.error);
  assert.deepEqual([...result.first.rows, ...result.second.rows].map((row) => row.id), [1, 2, 3, 4]);
  assert.equal(result.refresh.rows[0].name, "updated outside query"); assert.equal(result.count, 4);
  assert.equal(result.expired.ok, false); assert.match(result.expired.error, /Use Run/);
});

test("iterator pages advance once, preserve lookahead, and reuse cached refreshes", { skip: !HAS_DJANGO }, () => {
  const code = 'def values():\n    for i in range(5):\n        visits.append(i)\n        yield i\nvalues()';
  const result = runBackend([...setup(), "namespace = {'visits': []}", `first = mod._browse_query(namespace, {'code': ${JSON.stringify(code)}, 'limit': 2})`,
    "second = mod._browse_query(namespace, {'resultId': first['resultId'], 'offset': 2, 'limit': 2})",
    "refresh = mod._browse_query(namespace, {'resultId': first['resultId'], 'offset': 0, 'limit': 2})",
    "last = mod._browse_query(namespace, {'resultId': first['resultId'], 'offset': 4, 'limit': 2})",
    "print(json.dumps({'pages': [first, second, last], 'refresh': refresh, 'visits': namespace['visits']}))"]);
  assert.deepEqual(result.pages.flatMap((page) => page.rows.map((row) => row.value)), [0, 1, 2, 3, 4]);
  assert.deepEqual(result.visits, [0, 1, 2, 3, 4]); assert.deepEqual(result.refresh.rows, result.pages[0].rows); assert.equal(result.pages[2].hasMore, false);
});

test("mixed-database model lists remain readonly even when each displayed page contains one database", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(undefined, "{name: {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'} for name in ['default', 'archive']}"), ...recordModel(),
    "for alias in ['default', 'archive']:", "    with connections[alias].schema_editor() as schema: schema.create_model(Record)", "    Record.objects.using(alias).create(pk=1, name=alias)",
    "namespace = {'Record': Record}", "first = mod._browse_query(namespace, {'code': \"[Record.objects.using('default').get(pk=1), Record.objects.using('archive').get(pk=1)]\", 'limit': 1})",
    "second = mod._browse_query(namespace, {'resultId': first['resultId'], 'offset': 1, 'limit': 1})", "print(json.dumps([first, second]))"]);
  for (const page of result) { assert.equal(page.ok, true, page.error); assert.equal(page.editable, false); assert.ok(page.columns.every((column) => !column.editable)); }
});

test("retained model-instance lists refresh edited values without executing their construction again", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(), ...recordModel(), "with connections['default'].schema_editor() as schema: schema.create_model(Record)",
    "Record.objects.create(pk=1, name='old')", "namespace = {'Record': Record, 'runs': []}",
    "first = mod._browse_query(namespace, {'code': \"runs.append(1)\\nlist(Record.objects.all())\"})",
    "Record.objects.filter(pk=1).update(name='edited')", "refresh = mod._browse_query(namespace, {'resultId': first['resultId']})",
    "print(json.dumps({'first': first, 'refresh': refresh, 'runs': namespace['runs']}))"]);
  assert.equal(result.first.editable, true); assert.equal(result.refresh.rows[0].name, "edited"); assert.deepEqual(result.runs, [1]);
});

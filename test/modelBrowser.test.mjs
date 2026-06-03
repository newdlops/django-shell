// Verifies the additive Django model data-browser backend kinds.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import test from "node:test";

const PYTHON = pythonExecutable();
const HAS_DJANGO = PYTHON ? childProcess.spawnSync(PYTHON, ["-c", "import django"], { encoding: "utf8" }).status === 0 : false;

test("serializes non-primitive cells into JSON-safe tagged values", { skip: !PYTHON }, () => {
  const payload = runBackend([
    "import datetime, decimal, uuid, json",
    "cell = mod._browse_cell",
    "out = {",
    "  'none': cell(None), 'int': cell(7), 'str': cell('x'), 'bool': cell(True),",
    "  'decimal': cell(decimal.Decimal('1.50')),",
    "  'date': cell(datetime.date(2026, 6, 3))['t'],",
    "  'uuid': cell(uuid.UUID('12345678123456781234567812345678'))['t'],",
    "  'bytes': cell(b'abcdef')['t'], 'bytes_len': cell(b'abcdef')['len'],",
    "  'json': cell({'a': 1})['t'],",
    "  'order_default': mod._browse_order(None, ['id', 'name'], 'id'),",
    "  'order_desc': mod._browse_order([{'field': 'name', 'desc': True}], ['id', 'name'], 'id'),",
    "  'order_reject': mod._browse_order([{'field': 'evil; drop'}], ['id'], 'id'),",
    "  'limit_cap': mod._browse_limit(9999), 'limit_default': mod._browse_limit(None),",
    "}",
    "print(json.dumps(out))"
  ]);
  assert.equal(payload.none, null);
  assert.equal(payload.int, 7);
  assert.deepEqual(payload.decimal, { t: "decimal", v: "1.50" });
  assert.equal(payload.date, "datetime");
  assert.equal(payload.uuid, "uuid");
  assert.equal(payload.bytes, "bytes");
  assert.equal(payload.bytes_len, 6);
  assert.equal(payload.json, "json");
  assert.deepEqual(payload.order_default, ["id"]);
  assert.deepEqual(payload.order_desc, ["-name"]);
  assert.deepEqual(payload.order_reject, ["id"]);
  assert.equal(payload.limit_cap, 200);
  assert.equal(payload.limit_default, 50);
});

test("returns graceful errors for unknown models without Django configured", { skip: !PYTHON }, () => {
  const payload = runBackend([
    "import json",
    "out = {}",
    "for kind in ('models', 'schema', 'rows', 'related'):",
    "    resp = mod._run_request({}, 't', {'token': 't', 'kind': kind, 'app': 'x', 'model': 'Y', 'relation': 'z'}, set())",
    "    json.dumps(resp)",
    "    out[kind] = bool(resp.get('ok'))",
    "print(json.dumps(out))"
  ]);
  for (const kind of ["models", "schema", "rows", "related"]) {
    assert.equal(payload[kind], false, `${kind} should fail gracefully`);
  }
});

test("reads rows with a single query and keeps foreign keys as raw ids", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User, Group; from django.db import connection, reset_queries",
    "g1 = Group.objects.create(name='admins'); g2 = Group.objects.create(name='staff')",
    "u = User.objects.create(username='ada', password='x'); u.groups.add(g1, g2)",
    "def call(kind, **kw): return mod._run_request({}, 't', {'token': 't', 'kind': kind, **kw}, set())",
    "reset_queries()",
    "page1 = call('rows', app='auth', model='Permission', limit=3)",
    "queries = len(connection.queries)",
    "page2 = call('rows', app='auth', model='Permission', limit=3, cursor=page1['nextCursor'])",
    "single = call('related', app='auth', model='Permission', relation='content_type', pk=__import__('django.contrib.auth.models', fromlist=['Permission']).Permission.objects.first().pk)",
    "many = call('related', app='auth', model='User', relation='groups', pk=u.pk)",
    "schema = call('schema', app='auth', model='Permission')",
    "cols = {c['attname']: c for c in schema['columns']}",
    "ids1 = sorted(r['id'] for r in page1['rows']); ids2 = sorted(r['id'] for r in page2['rows'])",
    "print(json.dumps({",
    "  'queries': queries, 'fk_is_id': 'content_type_id' in page1['rows'][0],",
    "  'fk_target': cols['content_type_id']['relation']['target'],",
    "  'has_more': page1['hasMore'], 'disjoint': not set(ids1) & set(ids2), 'progress': min(ids2) > max(ids1),",
    "  'single_ok': single['ok'] and single['single'] and len(single['rows']) == 1,",
    "  'many': sorted(r['name'] for r in many['rows']),",
    "}))"
  ]);
  assert.equal(payload.queries, 1, "row page must be a single SELECT (no N+1, no JOIN)");
  assert.equal(payload.fk_is_id, true);
  assert.equal(payload.fk_target, "contenttypes.ContentType");
  assert.equal(payload.has_more, true);
  assert.equal(payload.disjoint, true);
  assert.equal(payload.progress, true);
  assert.equal(payload.single_ok, true);
  assert.deepEqual(payload.many, ["admins", "staff"]);
});

test("filters and sorts via allowlists and counts on demand", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User; from django.db import connection, reset_queries",
    "[User.objects.create(username=f'user{i}', password='x', is_staff=(i % 2 == 0)) for i in range(5)]",
    "def call(kind, **kw): return mod._run_request({}, 't', {'token': 't', 'kind': kind, **kw}, set())",
    "reset_queries()",
    "staff = call('rows', app='auth', model='User', filters=[{'field': 'is_staff', 'lookup': 'exact', 'value': True}])",
    "staff_queries = len(connection.queries)",
    "count = call('count', app='auth', model='User', filters=[{'field': 'is_staff', 'lookup': 'exact', 'value': True}])",
    "icontains = call('rows', app='auth', model='User', filters=[{'field': 'username', 'lookup': 'icontains', 'value': 'user1'}])",
    "negate = call('rows', app='auth', model='User', filters=[{'field': 'is_staff', 'lookup': 'exact', 'value': True, 'negate': True}])",
    "sorted_desc = call('rows', app='auth', model='User', order=[{'field': 'username', 'desc': True}], limit=2)",
    "injected = call('rows', app='auth', model='User', filters=[{'field': 'evil; DROP', 'lookup': 'exact', 'value': 1}, {'field': 'username', 'lookup': 'badlookup', 'value': 'x'}])",
    "print(json.dumps({",
    "  'staff_queries': staff_queries, 'staff_count': len(staff['rows']), 'count': count['count'],",
    "  'icontains': [r['username'] for r in icontains['rows']],",
    "  'negate': sorted(r['username'] for r in negate['rows']),",
    "  'sorted_desc': [r['username'] for r in sorted_desc['rows']], 'sorted_offset': sorted_desc['nextOffset'],",
    "  'injected_rows': len(injected['rows']), 'injected_ok': injected['ok'],",
    "}))"
  ]);
  assert.equal(payload.staff_queries, 1, "filtered page must stay a single query");
  assert.equal(payload.staff_count, 3);
  assert.equal(payload.count, 3, "count must match the filtered rows");
  assert.deepEqual(payload.icontains, ["user1"]);
  assert.deepEqual(payload.negate, ["user1", "user3"]);
  assert.deepEqual(payload.sorted_desc, ["user4", "user3"]);
  assert.equal(payload.sorted_offset, 2, "non-pk sort falls back to offset pagination");
  assert.equal(payload.injected_ok, true);
  assert.equal(payload.injected_rows, 5, "unknown field/lookup terms are ignored, never injected");
});

test("commits staged edits atomically and rolls back the whole batch on a validation error", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=False, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User",
    "u1 = User.objects.create(username='ada', password='x', is_staff=False)",
    "u2 = User.objects.create(username='bob', password='x', is_staff=False)",
    "def commit(changes): return mod._run_request({}, 't', {'token': 't', 'kind': 'commit', 'app': 'auth', 'model': 'User', 'changes': changes}, set())",
    "ok = commit([{'pk': u1.pk, 'fields': {'username': 'ada2', 'is_staff': 'true'}}, {'pk': u2.pk, 'fields': {'first_name': 'Bob'}}])",
    "u1.refresh_from_db(); u2.refresh_from_db()",
    "applied = {'username': u1.username, 'is_staff': u1.is_staff, 'first_name': u2.first_name}",
    "bad = commit([{'pk': u1.pk, 'fields': {'username': ''}}, {'pk': u2.pk, 'fields': {'first_name': 'ROLLBACK'}}])",
    "u1.refresh_from_db(); u2.refresh_from_db()",
    "rejected = commit([{'pk': u1.pk, 'fields': {'id': 999, 'bogus': 'x'}}])",
    "u1.refresh_from_db()",
    "print(json.dumps({",
    "  'ok': ok['ok'], 'saved': ok['saved'], 'commit_queries': len(ok['sql']), 'applied': applied,",
    "  'bad_ok': bad['ok'], 'bad_saved': bad['saved'], 'after_bad': {'u1': u1.username, 'u2': u2.first_name},",
    "  'bad_results': bad['results'], 'rejected_saved': rejected['saved'], 'pk_unchanged': u1.pk != 999,",
    "}))"
  ]);
  assert.equal(payload.ok, true);
  assert.equal(payload.saved, 2);
  assert.ok(payload.commit_queries >= 2, "commit issues queries only at commit time");
  assert.deepEqual(payload.applied, { username: "ada2", is_staff: true, first_name: "Bob" });
  assert.equal(payload.bad_ok, false);
  assert.equal(payload.bad_saved, 0);
  assert.deepEqual(payload.after_bad, { u1: "ada2", u2: "Bob" }, "failed batch saves nothing (atomic rollback)");
  assert.ok(payload.bad_results.some((row) => row.fieldErrors && row.fieldErrors.username));
  assert.equal(payload.rejected_saved, 0, "non-editable/unknown fields are ignored");
  assert.equal(payload.pk_unchanged, true);
});

/** Runs Python that loads the backend module as `mod` and prints one JSON line. */
function runBackend(lines) {
  const header = [
    "import importlib.util",
    `path = ${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec = importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)"
  ];
  const result = childProcess.spawnSync(PYTHON, ["-c", [...header, ...lines].join("\n")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
}

/** Returns the first runnable Python interpreter for backend tests. */
function pythonExecutable() {
  const candidates = [process.env.DJANGO_SHELL_E2E_PYTHON, process.env.DJLS_E2E_BASE_PYTHON, "/Users/lky/.asdf/installs/python/3.11.15/bin/python3.11", "/usr/bin/python3", "python3"].filter(Boolean);
  return candidates.find((candidate) => childProcess.spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0);
}

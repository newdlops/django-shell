// Verifies the additive Django model data-browser backend kinds.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { BackendClient } = require("../out/backendClient.js");
const { buildComputedOrm, buildRowsOrm, __test: ormBuilders } = require("../out/modelOrm.js");
const PYTHON = pythonExecutable();
const HAS_DJANGO = PYTHON ? childProcess.spawnSync(PYTHON, ["-c", "import django"], { encoding: "utf8" }).status === 0 : false;
const SUPPORT_LAYER_CELL = /apps\.get_model\(|django\.apps|__import__\("django\.apps"|json\.dumps|_djs_backend_module/;

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
    "for kind in ('models', 'schema', 'rows', 'related', 'lookup', 'query'):",
    "    resp = mod._run_request({}, 't', {'token': 't', 'kind': kind, 'app': 'x', 'model': 'Y', 'relation': 'z', 'q': 'a', 'code': '1/0'}, set())",
    "    json.dumps(resp)",
    "    out[kind] = bool(resp.get('ok'))",
    "print(json.dumps(out))"
  ]);
  for (const kind of ["models", "schema", "rows", "related", "lookup", "query"]) {
    assert.equal(payload[kind], false, `${kind} should fail gracefully`);
  }
});

test("binds app-registry model names for ORM cells even when model autoimport is disabled", { skip: !PYTHON }, () => {
  const payload = runBackend([
    "import json, os, sys, types",
    "os.environ.pop('DJANGO_SHELL_AUTOIMPORT_MODELS', None)",
    "class FiStaCompanySearchResult:",
    "    pass",
    "class Apps:",
    "    ready = True",
    "    def get_models(self):",
    "        return [FiStaCompanySearchResult]",
    "apps = Apps()",
    "django_module = types.ModuleType('django')",
    "django_apps_module = types.ModuleType('django.apps')",
    "django_apps_module.apps = apps",
    "sys.modules['django'] = django_module",
    "sys.modules['django.apps'] = django_apps_module",
    "namespace = {}",
    "count = mod._autoimport_registered_models(namespace)",
    "print(json.dumps({",
    "  'count': count,",
    "  'bound': namespace.get('FiStaCompanySearchResult') is FiStaCompanySearchResult,",
    "  'modelCell': mod._pty_looks_like_model_cell('FiStaCompanySearchResult._base_manager.order_by(\\'pk\\')[0:51]'),",
    "  'plainCell': mod._pty_looks_like_model_cell('len(globals())'),",
    "}))"
  ]);

  assert.equal(payload.count, 1);
  assert.equal(payload.bound, true);
  assert.equal(payload.modelCell, true);
  assert.equal(payload.plainCell, false);
});

test("parses unannotated property filters as Python-side predicates without model annotations", { skip: !PYTHON }, () => {
  const payload = runBackend([
    "import json",
    "class Field:",
    "    attname = 'id'",
    "    def get_internal_type(self):",
    "        return 'IntegerField'",
    "class Meta:",
    "    concrete_fields = [Field()]",
    "class Company:",
    "    _meta = Meta()",
    "    @property",
    "    def display_name(self):",
    "        return 'Acme'",
    "parsed = mod._browse_filter_term(Company, {'field': 'display_name', 'lookup': 'icontains', 'value': 'ac'}, {'id'}, {})",
    "obj = Company()",
    "print(json.dumps({'property': parsed[-1], 'match': mod._browse_property_filter_match(obj, {'field': 'display_name', 'lookup': 'icontains', 'value': 'ac', 'negate': False})}))"
  ]);

  assert.equal(payload.property, "display_name");
  assert.equal(payload.match, true);
});

test("streams Python-side property filters across chunk boundaries without dropping matches", { skip: !PYTHON }, () => {
  const payload = runBackend([
    "import json",
    "class Row:",
    "    def __init__(self, pk):",
    "        self.pk = pk",
    "    @property",
    "    def flag(self):",
    "        return self.pk in (1001, 1002, 2001)",
    "class FakeQuerySet:",
    "    def __init__(self, rows):",
    "        self.rows = rows",
    "        self.calls = []",
    "    def iterator(self, chunk_size=None):",
    "        self.calls.append(chunk_size)",
    "        return iter(self.rows)",
    "qs = FakeQuerySet([Row(pk) for pk in range(1, 2505)])",
    "terms = [{'field': 'flag', 'lookup': 'exact', 'value': True, 'negate': False}]",
    "matches = [obj.pk for obj in mod._browse_python_filter_iter(qs, terms)]",
    "window = [obj.pk for obj in mod._browse_islice(mod._browse_python_filter_iter(qs, terms), 1, 3)]",
    "print(json.dumps({'calls': qs.calls, 'matches': matches, 'window': window}))"
  ]);

  assert.deepEqual(payload.calls, [1000, 1000]);
  assert.deepEqual(payload.matches, [1001, 1002, 2001]);
  assert.deepEqual(payload.window, [1002, 2001]);
});

test("builds visible ORM cells with bare model names, not app-registry plumbing", () => {
  const columns = [
    { attname: "name", computed: false, type: "CharField" },
    { attname: "is_active", computed: false, type: "BooleanField" },
    { attname: "has_paid_subscription", annotated: false, computed: true, type: "property" },
    { attname: "staff_alias", annotated: true, computed: true, type: "property" }
  ];
  const relations = [{ kind: "m2m", name: "members", single: false, target: "db.Member" }];
  const cells = [
    buildRowsOrm({ app: "db", columns, filters: [{ field: "name", lookup: "icontains", value: "acme" }], limit: 50, model: "Company", order: [{ desc: true, field: "name" }] }),
    buildComputedOrm("db", "Company", "has_paid_subscription", undefined, undefined, 50, columns),
    ormBuilders.buildCountOrm("db", "Company", undefined, columns),
    ormBuilders.buildLookupOrm("db", "Company", "acme", ["password"], 20),
    ormBuilders.buildRelatedOrm("db", "Company", 7, "members", 10),
    ormBuilders.buildCommitOrm("db", "Company", [{ pk: 7, fields: { name: "Acme" } }], columns)
  ];
  const pythonPropertyCell = buildRowsOrm({ app: "db", columns, filters: [{ field: "has_paid_subscription", lookup: "exact", value: "true" }], limit: 50, model: "Company" });

  assert.equal(cells[0], 'Company._base_manager.filter(**{"name__icontains": "acme"}).order_by(\'-name\')[0:51]');
  assert.match(pythonPropertyCell, /import itertools as _it/);
  assert.match(pythonPropertyCell, /\.iterator\(chunk_size=1000\)/);
  assert.match(pythonPropertyCell, /getattr\(__o, "has_paid_subscription", None\)/);
  assert.match(buildRowsOrm({ app: "db", columns, filters: [{ field: "staff_alias", lookup: "exact", value: "true" }, { field: "rel:members", lookup: "isnull", value: "false" }], limit: 50, model: "Company", relations }), /annotate\(djs_staff_alias=/);
  assert.match(buildRowsOrm({ app: "db", columns, filters: [{ field: "staff_alias", lookup: "exact", value: "true" }, { field: "rel:members", lookup: "isnull", value: "false" }], limit: 50, model: "Company", relations }), /\.filter\(\*\*\{"djs_staff_alias__exact": True\}\)\.filter\(\*\*\{"members__isnull": False\}\)\.distinct\(\)/);
  // Relation-traversal paths pass through as parameterized filter() kwargs (distinct guards to-many spans); pk filters too.
  const traversalCell = buildRowsOrm({ app: "db", columns, filters: [{ field: "owner__name", lookup: "icontains", value: "ac" }], limit: 50, model: "Company" });
  assert.match(traversalCell, /\.filter\(\*\*\{"owner__name__icontains": "ac"\}\)\.distinct\(\)/);
  assert.match(buildRowsOrm({ app: "db", columns, filters: [{ field: "pk", lookup: "exact", value: 7 }], limit: 50, model: "Company" }), /\.filter\(\*\*\{"pk__exact": "7"\}\)/);
  // An unsafe traversal segment is dropped entirely, never injected.
  assert.doesNotMatch(buildRowsOrm({ app: "db", columns, filters: [{ field: "owner__evil; DROP", lookup: "exact", value: "x" }], limit: 50, model: "Company" }), /owner__evil/);
  // Relation-existence from the new UI arrives as the bare query name — it must still add .distinct() for a to-many relation.
  const bareExistence = buildRowsOrm({ app: "db", columns, filters: [{ field: "members", lookup: "isnull", value: "false" }], limit: 50, model: "Company", relations });
  assert.match(bareExistence, /\.filter\(\*\*\{"members__isnull": False\}\)\.distinct\(\)/);
  // A reverse relation maps the _set accessor to its query name so the ORM keyword is valid.
  const reverseRel = [{ kind: "reverse-fk", name: "order_set", queryName: "order", single: false, target: "db.Order" }];
  assert.match(buildRowsOrm({ app: "db", columns, filters: [{ field: "order", lookup: "isnull", value: "false" }], limit: 50, model: "Company", relations: reverseRel }), /\.filter\(\*\*\{"order__isnull": False\}\)\.distinct\(\)/);
  for (const cell of [...cells, pythonPropertyCell, traversalCell]) {
    assert.match(cell, /\bCompany\._base_manager\b/);
    assert.doesNotMatch(cell, SUPPORT_LAYER_CELL);
  }
  assert.equal(ormBuilders.buildModelsOrm(), "len(apps.get_models())");
  assert.equal(ormBuilders.buildInspectOrm(), "len(globals())");
});

test("keeps remote ORM metadata functional through pure Python inspection probe cells", async () => {
  const typed = [];
  const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "t" }, undefined, async (payload) => {
    typed.push(payload.code);
    if (payload.code === "len(apps.get_models())") {
      return `${JSON.stringify({ models: { models: [{ app: "db", label: "company", model: "Company", table: "db_company" }], ok: true }, ok: true, result: "1" })}\n`;
    }
    if (payload.code === "len(globals())") {
      return `${JSON.stringify({ ok: true, result: "3", runtime: { loadedModuleCount: 1, variables: [{ name: "Company", preview: "<class>", type: "type" }] } })}\n`;
    }
    throw new Error(`unexpected PTY code: ${payload.code}`);
  });
  client.setTransportMode("orm");
  client.markSocketUnavailable();

  const models = await client.models();
  const inspection = await client.inspect();

  assert.deepEqual(typed, ["len(apps.get_models())", "len(globals())"]);
  assert.equal(models.ok, true);
  assert.equal(models.models[0].model, "Company");
  assert.equal(inspection.ok, true);
  assert.equal(inspection.variables[0].name, "Company");
  for (const cell of typed) {
    assert.doesNotMatch(cell ?? "", SUPPORT_LAYER_CELL);
  }
});

test("builds runtime child inspection as pure Python probe cells", async () => {
  const typed = [];
  const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "t" }, undefined, async (payload) => {
    typed.push(payload.code);
    if (payload.code === "dir(company)") {
      return `${JSON.stringify({ inspect: { children: [{ name: "name", path: [{ name: "name", op: "attr" }], preview: "<attribute>", type: "attribute" }] }, ok: true, result: "None" })}\n`;
    }
    if (payload.code === "len(companies)") {
      return `${JSON.stringify({ inspect: { children: [{ name: "[0]", path: [{ index: 0, op: "index" }], preview: "<Company>", type: "Company" }] }, ok: true, result: "1" })}\n`;
    }
    if (payload.code === "dir(list((company.legal_partner_relation_set).all())[0])") {
      return `${JSON.stringify({ inspect: { children: [{ name: "id", path: [{ name: "id", op: "attr" }], preview: "7", type: "int" }] }, ok: true, result: "None" })}\n`;
    }
    throw new Error(`unexpected PTY code: ${payload.code}`);
  });
  client.setTransportMode("orm");
  client.markSocketUnavailable();

  const objectChildren = await client.children([{ name: "company", op: "name" }], "object");
  const collectionChildren = await client.children([{ name: "companies", op: "name" }], "collection");
  const relatedChild = await client.children([{ name: "company", op: "name" }, { name: "legal_partner_relation_set", op: "attr" }, { index: 0, op: "all_index" }], "object");

  assert.deepEqual(typed, ["dir(company)", "len(companies)", "dir(list((company.legal_partner_relation_set).all())[0])"]);
  assert.equal(objectChildren.ok, true);
  assert.equal(collectionChildren.ok, true);
  assert.equal(relatedChild.ok, true);
  for (const cell of typed) {
    assert.doesNotMatch(cell ?? "", SUPPORT_LAYER_CELL);
  }
});

test("keeps Django model attname fields visible in inspection children", { skip: !PYTHON }, () => {
  const payload = runBackend([
    "import json",
    "class Field:",
    "    def __init__(self, name, attname=None, accessor=None, auto_created=False, concrete=True):",
    "        self.name = name",
    "        self.attname = attname or name",
    "        self.accessor = accessor",
    "        self.auto_created = auto_created",
    "        self.concrete = concrete",
    "    def get_accessor_name(self):",
    "        return self.accessor",
    "class Meta:",
    "    def get_fields(self):",
    "        return [Field('id'), Field('owner', 'owner_id'), Field('projects', accessor='projects', auto_created=True, concrete=False)]",
    "class Instance:",
    "    _meta = Meta()",
    "    @property",
    "    def display_name(self):",
    "        return 'Acme'",
    "inst = Instance()",
    "inst.id = 7",
    "inst.owner_id = 42",
    "inst.owner = 'owner-object'",
    "inst.projects = ['p1']",
    "children = mod._browse_children_of(inst, [{'op': 'name', 'name': 'inst'}], 20)",
    "socket_children = mod._inspect_value_children(inst, [{'op': 'name', 'name': 'inst'}])",
    "print(json.dumps({",
    "  'orm_names': [child['name'] for child in children],",
    "  'socket_names': [child['name'] for child in socket_children],",
    "  'orm_paths': [child['path'][-1]['name'] for child in children],",
    "}))"
  ]);

  assert.deepEqual(payload.orm_names, ["id", "owner_id", "owner", "projects", "display_name"]);
  assert.ok(payload.socket_names.includes("owner_id"));
  assert.ok(payload.socket_names.includes("owner"));
  assert.deepEqual(payload.orm_paths, payload.orm_names);
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
    "from django.contrib.auth.models import User, Group; from django.db import connection, reset_queries; from django.db.models import F",
    "[User.objects.create(username=f'user{i}', password='x', is_staff=(i % 2 == 0)) for i in range(5)]",
    "group = Group.objects.create(name='ops')",
    "User.objects.get(username='user1').groups.add(group)",
    "User.djshell_annotations = {'staff_alias': F('is_staff')}",
    "def call(kind, **kw): return mod._run_request({}, 't', {'token': 't', 'kind': kind, **kw}, set())",
    "reset_queries()",
    "staff = call('rows', app='auth', model='User', filters=[{'field': 'is_staff', 'lookup': 'exact', 'value': True}])",
    "staff_queries = len(connection.queries)",
    "count = call('count', app='auth', model='User', filters=[{'field': 'is_staff', 'lookup': 'exact', 'value': True}])",
    "annotated = call('rows', app='auth', model='User', filters=[{'field': 'staff_alias', 'lookup': 'exact', 'value': True}])",
    "has_group = call('rows', app='auth', model='User', filters=[{'field': 'rel:groups', 'lookup': 'isnull', 'value': False}])",
    "no_group = call('count', app='auth', model='User', filters=[{'field': 'rel:groups', 'lookup': 'isnull', 'value': True}])",
    "icontains = call('rows', app='auth', model='User', filters=[{'field': 'username', 'lookup': 'icontains', 'value': 'user1'}])",
    "negate = call('rows', app='auth', model='User', filters=[{'field': 'is_staff', 'lookup': 'exact', 'value': True, 'negate': True}])",
    "sorted_desc = call('rows', app='auth', model='User', order=[{'field': 'username', 'desc': True}], limit=2)",
    "injected = call('rows', app='auth', model='User', filters=[{'field': 'evil; DROP', 'lookup': 'exact', 'value': 1}, {'field': 'username', 'lookup': 'badlookup', 'value': 'x'}])",
    "print(json.dumps({",
    "  'staff_queries': staff_queries, 'staff_count': len(staff['rows']), 'count': count['count'],",
    "  'annotated': sorted(r['username'] for r in annotated['rows']),",
    "  'has_group': [r['username'] for r in has_group['rows']], 'no_group_count': no_group['count'],",
    "  'icontains': [r['username'] for r in icontains['rows']],",
    "  'negate': sorted(r['username'] for r in negate['rows']),",
    "  'sorted_desc': [r['username'] for r in sorted_desc['rows']], 'sorted_offset': sorted_desc['nextOffset'],",
    "  'injected_rows': len(injected['rows']), 'injected_ok': injected['ok'],",
    "}))"
  ]);
  assert.equal(payload.staff_queries, 1, "filtered page must stay a single query");
  assert.equal(payload.staff_count, 3);
  assert.equal(payload.count, 3, "count must match the filtered rows");
  assert.deepEqual(payload.annotated, ["user0", "user2", "user4"]);
  assert.deepEqual(payload.has_group, ["user1"]);
  assert.equal(payload.no_group_count, 4);
  assert.deepEqual(payload.icontains, ["user1"]);
  assert.deepEqual(payload.negate, ["user1", "user3"]);
  assert.deepEqual(payload.sorted_desc, ["user4", "user3"]);
  assert.equal(payload.sorted_offset, 2, "non-pk sort falls back to offset pagination");
  assert.equal(payload.injected_ok, true);
  assert.equal(payload.injected_rows, 5, "unknown field/lookup terms are ignored, never injected");
});

test("filters across relation-traversal paths with the filterfields tree and rejects invalid segments", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User, Group, Permission",
    "ops = Group.objects.create(name='ops'); dev = Group.objects.create(name='dev')",
    "alice = User.objects.create(username='alice', password='x'); bob = User.objects.create(username='bob', password='x'); carol = User.objects.create(username='carol', password='x')",
    "alice.groups.add(ops); bob.groups.add(dev); carol.groups.add(ops)",
    "alice.user_permissions.add(Permission.objects.filter(content_type__app_label='auth').first())",
    "def call(kind, **kw): return mod._run_request({}, 't', {'token': 't', 'kind': kind, **kw}, set())",
    "tree = call('filterfields', app='auth', model='User')",
    "ops_users = call('rows', app='auth', model='User', filters=[{'field': 'groups__name', 'lookup': 'exact', 'value': 'ops'}])",
    "deep = call('rows', app='auth', model='User', filters=[{'field': 'user_permissions__content_type__app_label', 'lookup': 'exact', 'value': 'auth'}])",
    "reverse = call('rows', app='auth', model='Group', filters=[{'field': 'user__username', 'lookup': 'exact', 'value': 'bob'}])",
    "from django.db import connection, reset_queries",
    "reset_queries()",
    "pk_one = call('rows', app='auth', model='User', filters=[{'field': 'pk', 'lookup': 'exact', 'value': bob.pk}])",
    "pk_queries = len(connection.queries)",
    "exists = call('rows', app='auth', model='User', filters=[{'field': 'groups', 'lookup': 'isnull', 'value': False}])",
    "ops_count = call('count', app='auth', model='User', filters=[{'field': 'groups__name', 'lookup': 'exact', 'value': 'ops'}])",
    "bad = call('rows', app='auth', model='User', filters=[{'field': 'groups__evil; DROP', 'lookup': 'exact', 'value': 'x'}, {'field': 'nope__bad', 'lookup': 'exact', 'value': 1}])",
    "print(json.dumps({",
    "  'tree_relations': sorted(r['name'] for r in tree['relations']),",
    "  'tree_groups_target': next((r['target'] for r in tree['relations'] if r['name'] == 'groups'), None),",
    "  'ops_users': sorted(r['username'] for r in ops_users['rows']), 'ops_distinct': '.distinct()' in ops_users['orm'],",
    "  'deep': sorted(r['username'] for r in deep['rows']),",
    "  'reverse': sorted(r['name'] for r in reverse['rows']),",
    "  'pk_one': [r['username'] for r in pk_one['rows']], 'pk_queries': pk_queries, 'pk_db_side': any('WHERE' in (q.get('sql') or '').upper() for q in pk_one['sql']),",
    "  'exists': sorted(set(r['username'] for r in exists['rows'])), 'ops_count': ops_count['count'],",
    "  'bad_rows': len(bad['rows']), 'bad_ok': bad['ok'],",
    "}))"
  ]);
  assert.deepEqual(payload.tree_relations, ["groups", "user_permissions"], "reverse/M2M relations use filter query names, not _set accessors");
  assert.equal(payload.tree_groups_target, "auth.Group");
  assert.deepEqual(payload.ops_users, ["alice", "carol"], "forward M2M traversal filters across the relation");
  assert.equal(payload.ops_distinct, true, "a to-many traversal adds .distinct()");
  assert.deepEqual(payload.deep, ["alice"], "three-level traversal (m2m → fk → field) resolves");
  assert.deepEqual(payload.reverse, ["dev"], "reverse traversal from the related model works");
  assert.deepEqual(payload.pk_one, ["bob"], "pk filter (FK-link drill-in) targets one row");
  assert.equal(payload.pk_db_side, true, "pk filter resolves to a DB WHERE lookup, not a Python @property full-table scan");
  assert.equal(payload.pk_queries, 1, "pk filter stays a single query");
  assert.deepEqual(payload.exists, ["alice", "bob", "carol"], "relation-as-terminal isnull filters existence");
  assert.equal(payload.ops_count, 2, "count matches the distinct traversal rows");
  assert.equal(payload.bad_ok, true);
  assert.equal(payload.bad_rows, 3, "invalid traversal segments are rejected, never injected");
});

test("a boolean filter across a relation traversal stays Django-valid in ORM/Terminal mode (capitalized True/False)", { skip: !HAS_DJANGO }, () => {
  // ORM/Terminal mode reconstructs the filter as a literal ORM cell; on a traversal path the column type is unknown,
  // so the value reaches Django uncoerced. The value control must emit "True"/"False" — Django rejects lowercase "true".
  const cols = [{ attname: "id", name: "id", pk: true, type: "AutoField" }];
  const goodExpr = buildRowsOrm({ app: "auth", columns: cols, filters: [{ field: "user__is_active", lookup: "exact", value: "True" }], limit: 50, model: "Group" });
  const lowerExpr = buildRowsOrm({ app: "auth", columns: cols, filters: [{ field: "user__is_active", lookup: "exact", value: "true" }], limit: 50, model: "Group" });
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User, Group",
    "from django.core.exceptions import ValidationError",
    "def ev(expr):",
    "    try:",
    "        list(eval(expr)); return 'ok'",
    "    except ValidationError: return 'validationerror'",
    "    except Exception as e: return type(e).__name__",
    `print(json.dumps({'good': ev(${JSON.stringify(goodExpr)}), 'lower': ev(${JSON.stringify(lowerExpr)})}))`
  ]);
  assert.equal(payload.good, "ok", "capitalized True is accepted by Django BooleanField across a traversal");
  assert.equal(payload.lower, "validationerror", "lowercase true raises — confirms the value control must emit True/False");
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

test("looks up foreign-key candidates by text and pk in one query, exposing all fields unless excluded", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User; from django.db import connection, reset_queries",
    "ada = User.objects.create(username='ada', password='topsecret', first_name='Ada')",
    "[User.objects.create(username=f'user{i}', password='x') for i in range(3)]",
    "def call(**kw): return mod._run_request({}, 't', {'token': 't', 'kind': 'lookup', 'app': 'auth', 'model': 'User', **kw}, set())",
    "reset_queries()",
    "by_text = call(q='ada')",
    "text_queries = len(connection.queries)",
    "by_pk = call(q=str(ada.pk))",
    "empty = call(q='', limit=2)",
    "masked = call(q='ada', exclude=['password'])",
    "print(json.dumps({",
    "  'text_queries': text_queries, 'ok': by_text['ok'], 'text_pk': by_text['rows'][0]['pk'] == ada.pk,",
    "  'default_exposes_all': any('topsecret' in r['label'] for r in by_text['rows']),",
    "  'pk_in': ada.pk in [r['pk'] for r in by_pk['rows']],",
    "  'masked_hidden': all('topsecret' not in r['label'] for r in masked['rows']),",
    "  'masked_keeps_text': any('ada' in r['label'] for r in masked['rows']),",
    "  'empty_len': len(empty['rows']), 'empty_more': empty['hasMore'],",
    "}))"
  ]);
  assert.equal(payload.ok, true);
  assert.equal(payload.text_queries, 1, "a lookup must be a single SELECT");
  assert.equal(payload.text_pk, true);
  assert.equal(payload.default_exposes_all, true, "by default every text field is exposed (no built-in masking)");
  assert.equal(payload.pk_in, true, "a numeric query matches the primary key");
  assert.equal(payload.masked_hidden, true, "fields named in exclude are dropped from search and labels");
  assert.equal(payload.masked_keeps_text, true, "non-excluded text fields still label the candidate");
  assert.equal(payload.empty_len, 2, "empty query returns a bounded first page");
  assert.equal(payload.empty_more, true, "hasMore signals more candidates beyond the page");
});

test("tabulates custom ORM query results, editable only for single-model instance querysets", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User; from django.db import connection, reset_queries",
    "[User.objects.create(username=f'user{i}', password='x', is_staff=(i % 2 == 0)) for i in range(4)]",
    "ns = {'User': User}",
    "def call(code, **kw): return mod._run_request(ns, 't', {'token': 't', 'kind': 'query', 'code': code, **kw}, set())",
    "reset_queries()",
    "qs = call('User.objects.all()')",
    "qs_queries = len(connection.queries)",
    "paged = call('User.objects.all()', limit=2)",
    "vals = call(\"User.objects.values('id', 'username')\")",
    "flat = call(\"User.objects.values_list('username', flat=True)\")",
    "multi = call('staff = User.objects.filter(is_staff=True)\\nstaff')",
    "reuse = call('staff.count()')",
    "boom = call('1/0')",
    "scalar = call('User.objects.count()')",
    "print(json.dumps({",
    "  'qs_ok': qs['ok'], 'qs_editable': qs['editable'], 'qs_model': qs.get('model'), 'qs_app': qs.get('app'), 'qs_pk': qs.get('pk'),",
    "  'qs_relations': [r['name'] for r in qs.get('relations', [])],",
    "  'paged_rows': len(paged['rows']), 'paged_more': paged['hasMore'],",
    "  'qs_cols': 'username' in [c['attname'] for c in qs['columns']], 'qs_rows': len(qs['rows']), 'qs_queries': qs_queries,",
    "  'vals_ok': vals['ok'], 'vals_editable': vals['editable'], 'vals_cols': [c['attname'] for c in vals['columns']],",
    "  'flat_cols': [c['attname'] for c in flat['columns']], 'flat_rows': len(flat['rows']),",
    "  'multi_ok': multi['ok'], 'multi_rows': len(multi['rows']), 'multi_editable': multi['editable'],",
    "  'reuse_ok': reuse['ok'], 'reuse_value': reuse['rows'][0]['value'] if reuse['rows'] else None,",
    "  'boom_ok': boom['ok'], 'boom_err': bool(boom.get('error')),",
    "  'scalar_cols': [c['attname'] for c in scalar['columns']], 'scalar_value': scalar['rows'][0]['value'],",
    "}))"
  ]);
  assert.equal(payload.qs_ok, true);
  assert.equal(payload.qs_editable, true);
  assert.equal(payload.qs_model, "User");
  assert.equal(payload.qs_app, "auth");
  assert.equal(payload.qs_pk, "id");
  assert.equal(payload.qs_cols, true);
  assert.equal(payload.qs_rows, 4);
  assert.equal(payload.qs_queries, 1, "instance queryset tabulation is a single SELECT");
  assert.ok(payload.qs_relations.includes("groups"), "instance queryset results expose reverse/M2M relations like the model browser");
  assert.equal(payload.paged_rows, 2, "the requested page size is honored");
  assert.equal(payload.paged_more, true, "hasMore signals additional rows beyond the page");
  assert.equal(payload.vals_ok, true);
  assert.equal(payload.vals_editable, false, ".values() result is read-only");
  assert.deepEqual(payload.vals_cols, ["id", "username"]);
  assert.deepEqual(payload.flat_cols, ["username"], "values_list(flat=True) becomes one column");
  assert.equal(payload.flat_rows, 4);
  assert.equal(payload.multi_ok, true);
  assert.equal(payload.multi_rows, 2, "multi-line code tabulates the final expression");
  assert.equal(payload.multi_editable, true);
  assert.equal(payload.reuse_ok, true, "assignments from earlier queries persist in the namespace");
  assert.equal(payload.reuse_value, 2);
  assert.equal(payload.boom_ok, false);
  assert.equal(payload.boom_err, true, "a failing expression returns an error, not a crash");
  assert.deepEqual(payload.scalar_cols, ["value"]);
  assert.equal(payload.scalar_value, 4, "a scalar result becomes a single value cell");
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

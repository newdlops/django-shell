// Verifies conditional Aggregate, Annotate, and Subquery columns in ORM reconstruction and the Django socket backend.

import assert from "node:assert/strict";
import test from "node:test";

import { __test as conditionUi } from "../media/gridColumnConditions.js";
import { HAS_DJANGO, buildRowsOrm, ormBuilders, runBackend } from "./modelBrowserHelpers.mjs";

const USER_COLUMNS = [
  { attname: "id", pk: true, type: "AutoField" },
  { attname: "username", type: "CharField" },
  { attname: "first_name", type: "CharField" },
  { attname: "is_staff", type: "BooleanField" }
];
const USER_RELATIONS = [{ kind: "m2m", name: "groups", queryName: "groups", single: false, target: "auth.Group" }];

test("offers type-aware condition lookups and requires complete literal values", () => {
  const allowed = ["exact", "icontains", "gt", "in", "isnull", "range", "date", "year", "length", "trim"];

  assert.equal(conditionUi.MAX_CONDITIONS, 8);
  assert.deepEqual(conditionUi.lookupsForTerminal({ role: "relation" }, allowed), ["isnull"]);
  assert.deepEqual(conditionUi.lookupsForTerminal({ role: "field", type: "BooleanField" }, allowed), ["exact", "isnull"]);
  assert.deepEqual(conditionUi.lookupsForTerminal({ role: "field", type: "CharField" }, allowed), ["exact", "icontains", "in", "isnull", "trim", "length"]);
  assert.equal(conditionUi.defaultLookup({ role: "field", type: "CharField" }, ["exact", "icontains"]), "icontains");
  assert.equal(conditionUi.inputTypeFor("DateTimeField"), "datetime-local");
  assert.equal(conditionUi.literalValueComplete("range", "1,2"), true);
  assert.equal(conditionUi.literalValueComplete("range", "1,"), false);
  assert.equal(conditionUi.literalValueComplete("in", " , "), false);
  assert.equal(conditionUi.permitsExpressionRhs("exact"), true);
  assert.equal(conditionUi.permitsExpressionRhs("isnull"), false);
});

test("reconstructs all/any conditional aggregates with literal, F, and negated predicates", () => {
  const all = {
    join: "all",
    terms: [
      { field: "username", fieldType: "CharField", lookup: "icontains", rhs: { kind: "value", value: "op" } },
      { field: "is_staff", fieldType: "BooleanField", lookup: "exact", rhs: { kind: "value", value: true } }
    ]
  };
  const any = {
    join: "any",
    terms: [
      { field: "username", lookup: "exact", rhs: { field: "first_name", kind: "field" } },
      { field: "id", fieldType: "AutoField", lookup: "gt", negate: true, rhs: { kind: "value", value: 2 } }
    ]
  };
  const orm = buildRowsOrm({
    annotations: [
      { alias: "all_count", conditions: all, distinct: true, field: "groups", func: "count", kind: "aggregate" },
      { alias: "any_count", conditions: any, distinct: true, field: "groups", func: "count", kind: "aggregate" }
    ],
    app: "auth",
    columns: USER_COLUMNS,
    limit: 50,
    model: "User",
    relations: USER_RELATIONS
  });

  assert.match(orm, /all_count=models\.Count\("groups", distinct=True, filter=\(models\.Q\(\*\*\{"username__icontains": "op"\}\) & models\.Q\(\*\*\{"is_staff__exact": True\}\)\)\)/);
  assert.match(orm, /any_count=models\.Count\("groups", distinct=True, filter=\(models\.Q\(\*\*\{"username__exact": models\.F\("first_name"\)\}\) \| ~models\.Q\(\*\*\{"id__gt": 2\}\)\)\)/);
  assert.doesNotMatch(orm, /\n/, "conditional ORM cells stay executable as one shell line");

  const grouped = ormBuilders.buildAggregateOrm({
    aggregates: [{ alias: "conditional", conditions: any, field: "pk", func: "count" }],
    app: "auth",
    columns: USER_COLUMNS,
    groupBy: ["is_staff"],
    model: "User",
    relations: USER_RELATIONS
  });
  assert.equal(grouped, 'User._base_manager.values("is_staff").annotate(conditional=models.Count("pk", filter=(models.Q(**{"username__exact": models.F("first_name")}) | ~models.Q(**{"id__gt": 2})))).order_by("is_staff")[0:1001]');

  const exists = ormBuilders.buildAggregateOrm({
    aggregates: [{ alias: "has_ops", conditions: { terms: [{ field: "username", lookup: "startswith", rhs: { kind: "value", value: "op" } }] }, func: "exists" }],
    app: "auth",
    columns: USER_COLUMNS,
    model: "User"
  });
  assert.equal(exists, '[{"has_ops": User._base_manager.filter(models.Q(**{"username__startswith": "op"})).exists()}]', "a missing join defaults to an AND group for conditional exists");
});

test("wraps a raw annotation in Case/When without changing its safe expression", () => {
  const orm = buildRowsOrm({
    annotations: [{
      alias: "staff_name",
      conditions: { join: "all", terms: [{ field: "is_staff", fieldType: "BooleanField", lookup: "exact", rhs: { kind: "value", value: true } }] },
      expression: 'models.F("username")',
      kind: "annotate"
    }],
    app: "auth",
    columns: USER_COLUMNS,
    limit: 50,
    model: "User",
    relations: USER_RELATIONS
  });

  assert.equal(orm, 'User._base_manager.annotate(staff_name=models.Case(models.When(models.Q(**{"is_staff__exact": True}), then=models.F("username")), default=models.Value(None))).order_by(\'pk\')[0:51]');
});

test("keeps Subquery correlation outside an OR group and prefixes M2M through-table paths", () => {
  const custom = buildRowsOrm({
    annotations: [{
      alias: "candidate",
      conditions: {
        join: "any",
        terms: [
          { field: "name", lookup: "startswith", rhs: { kind: "value", value: "o" } },
          { field: "name", lookup: "exact", rhs: { field: "first_name", kind: "outer" } }
        ]
      },
      field: "name",
      filterField: "name",
      kind: "subquery",
      orderBy: [{ field: "name" }],
      outerField: "username",
      target: "auth.Group"
    }],
    app: "auth",
    columns: USER_COLUMNS,
    limit: 50,
    model: "User",
    relations: USER_RELATIONS
  });
  const correlation = '.filter(**{"name": models.OuterRef("username")})';
  const condition = '.filter((models.Q(**{"name__startswith": "o"}) | models.Q(**{"name__exact": models.OuterRef("first_name")})))';

  assert.ok(custom.indexOf(correlation) >= 0, "the custom-model correlation is present");
  assert.ok(custom.indexOf(condition) > custom.indexOf(correlation), "the OR group cannot bypass the correlation predicate");

  const m2m = buildRowsOrm({
    annotations: [{
      alias: "matching_group",
      conditions: {
        join: "all",
        terms: [
          { field: "name", lookup: "iexact", rhs: { kind: "value", value: "ops" } },
          { field: "name", lookup: "exact", rhs: { field: "name", kind: "field" } }
        ]
      },
      field: "name",
      kind: "subquery",
      orderBy: [{ field: "name" }],
      relation: "groups",
      relationKind: "m2m",
      throughOwner: "User",
      throughRelation: "groups",
      throughSource: "user",
      throughTarget: "group"
    }],
    app: "auth",
    columns: USER_COLUMNS,
    limit: 50,
    model: "User",
    relations: USER_RELATIONS
  });

  assert.match(m2m, /\.filter\(\*\*\{"user_id": models\.OuterRef\("pk"\)\}\)\.filter\(\(models\.Q\(\*\*\{"group__name__iexact": "ops"\}\) & models\.Q\(\*\*\{"group__name__exact": models\.F\("group__name"\)\}\)\)\)/);
  assert.match(m2m, /\.values\("group__name"\)\[:1\]/);
  assert.doesNotMatch(m2m, /\n/);
});

test("drops an entire column spec for malformed, empty, oversized, or injected conditions", () => {
  const validTerm = { field: "username", lookup: "exact", rhs: { kind: "value", value: "x" } };
  const annotations = [
    { alias: "bad_malformed", conditions: "not-a-group", distinct: true, field: "groups", func: "count", kind: "aggregate" },
    { alias: "bad_empty", conditions: { join: "all", terms: [] }, expression: 'models.F("username")', kind: "annotate" },
    { alias: "bad_many", conditions: { join: "any", terms: Array.from({ length: 9 }, () => validTerm) }, field: "name", filterField: "name", kind: "subquery", outerField: "username", target: "auth.Group" },
    { alias: "bad_injected", conditions: { join: "all", terms: [{ field: "username); import os #", lookup: "exact", rhs: { kind: "value", value: "x" } }] }, distinct: true, field: "groups", func: "count", kind: "aggregate" },
    { alias: "good", expression: 'models.F("username")', kind: "annotate" }
  ];
  const orm = buildRowsOrm({ annotations, app: "auth", columns: USER_COLUMNS, limit: 50, model: "User", relations: USER_RELATIONS });

  assert.equal(orm, 'User._base_manager.annotate(good=models.F("username")).order_by(\'pk\')[0:51]');
  assert.doesNotMatch(orm, /bad_|import os/);

  const grouped = ormBuilders.buildAggregateOrm({
    aggregates: [
      { alias: "bad_empty", conditions: { join: "all", terms: [] }, field: "pk", func: "count" },
      { alias: "good", field: "pk", func: "count" }
    ],
    app: "auth",
    columns: USER_COLUMNS,
    groupBy: ["is_staff"],
    model: "User",
    relations: USER_RELATIONS
  });
  assert.equal(grouped, 'User._base_manager.values("is_staff").annotate(good=models.Count("pk")).order_by("is_staff")[0:1001]');
});

test("executes conditional columns and rejects invalid groups in one Django socket fixture", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User, Group, Permission",
    "ops = Group.objects.create(name='ops'); dev = Group.objects.create(name='dev')",
    "u0 = User.objects.create(username='ops', first_name='ops', password='x', is_staff=True)",
    "u1 = User.objects.create(username='dev', first_name='mismatch', password='x', is_staff=False)",
    "u2 = User.objects.create(username='none', first_name='none', password='x', is_staff=True)",
    "u0.groups.add(ops, dev); u1.groups.add(ops)",
    "def call(kind='rows', model='User', **kw): return mod._run_request({}, 't', {'token': 't', 'kind': kind, 'app': 'auth', 'model': model, **kw}, set())",
    "value = lambda field, lookup, item: {'field': field, 'lookup': lookup, 'rhs': {'kind': 'value', 'value': item}}",
    "outer = lambda field, lookup, rhs: {'field': field, 'lookup': lookup, 'rhs': {'kind': 'outer', 'field': rhs}}",
    "per_row = call(annotations=[{'kind': 'aggregate', 'func': 'count', 'field': 'groups', 'alias': 'ops_count', 'conditions': {'join': 'all', 'terms': [value('groups__name', 'startswith', 'o')]}}])",
    "raw = call(annotations=[{'kind': 'annotate', 'expression': \"models.F('username')\", 'alias': 'staff_name', 'conditions': {'join': 'all', 'terms': [value('is_staff', 'exact', True)]}}])",
    "m2m = call(annotations=[{'kind': 'subquery', 'relation': 'groups', 'field': 'name', 'orderBy': [{'field': 'name'}], 'alias': 'dev_group', 'conditions': {'join': 'all', 'terms': [value('name', 'startswith', 'd')]}}])",
    "custom = call(annotations=[{'kind': 'subquery', 'target': 'auth.Group', 'filterField': 'name', 'outerField': 'username', 'field': 'name', 'alias': 'outer_match', 'conditions': {'join': 'all', 'terms': [outer('name', 'exact', 'first_name')]}}])",
    "auth_perm = Permission.objects.filter(content_type__app_label='auth').order_by('pk').first()",
    "content_perm = Permission.objects.filter(content_type__app_label='contenttypes').order_by('pk').first()",
    "relation_spec = {'kind': 'subquery', 'relation': 'content_type', 'field': 'app_label', 'alias': 'auth_app', 'conditions': {'join': 'all', 'terms': [value('app_label', 'exact', 'auth')]}}",
    "auth_relation = call(model='Permission', filters=[{'field': 'pk', 'lookup': 'exact', 'value': auth_perm.pk}], annotations=[relation_spec])",
    "content_relation = call(model='Permission', filters=[{'field': 'pk', 'lookup': 'exact', 'value': content_perm.pk}], annotations=[relation_spec])",
    "grouped = call(kind='aggregate', groupBy=['is_staff'], aggregates=[{'kind': 'aggregate', 'func': 'count', 'field': 'pk', 'alias': 'starts_o', 'conditions': {'join': 'all', 'terms': [value('username', 'startswith', 'o')]}}])",
    "conditional_exists = call(kind='aggregate', aggregates=[{'func': 'exists', 'alias': 'has_ops', 'conditions': {'terms': [value('username', 'startswith', 'o')]}}])",
    "bad_rows = call(annotations=[",
    "  {'kind': 'aggregate', 'func': 'count', 'field': 'groups', 'alias': 'bad_empty', 'conditions': {'join': 'all', 'terms': []}},",
    "  {'kind': 'annotate', 'expression': \"models.F('username')\", 'alias': 'bad_injected', 'conditions': {'join': 'all', 'terms': [value('username); import os #', 'exact', 'ops')]}},",
    "  {'kind': 'subquery', 'target': 'auth.Group', 'filterField': 'name', 'outerField': 'username', 'field': 'name', 'alias': 'bad_many', 'conditions': {'join': 'any', 'terms': [value('name', 'exact', 'ops')] * 9}},",
    "])",
    "bad_aggregate = call(kind='aggregate', aggregates=[{'func': 'count', 'field': 'pk', 'alias': 'bad_total', 'conditions': {'join': 'all', 'terms': []}}])",
    "annotation_names = lambda response: [column['attname'] for column in response.get('columns', []) if column.get('annotation')]",
    "print(json.dumps({",
    "  'per_row': {row['username']: row['ops_count'] for row in per_row['rows']},",
    "  'raw': {row['username']: row['staff_name'] for row in raw['rows']},",
    "  'm2m': {row['username']: row['dev_group'] for row in m2m['rows']},",
    "  'custom': {row['username']: row['outer_match'] for row in custom['rows']},",
    "  'relation': [auth_relation['rows'][0]['auth_app'], content_relation['rows'][0]['auth_app']],",
    "  'grouped': {str(row['is_staff']).lower(): row['starts_o'] for row in grouped['rows']},",
    "  'conditional_exists': conditional_exists['rows'][0]['has_ops'],",
    "  'bad_row_ok': bad_rows['ok'], 'bad_row_columns': annotation_names(bad_rows),",
    "  'bad_row_has_values': any(any(name.startswith('bad_') for name in row) for row in bad_rows['rows']),",
    "  'bad_aggregate_ok': bad_aggregate['ok'], 'bad_aggregate_rows': bad_aggregate.get('rows', []),",
    "}))"
  ]);

  assert.deepEqual(payload.per_row, { dev: 1, none: 0, ops: 1 }, "Count uses its Q predicate and avoids M2M multiplication");
  assert.deepEqual(payload.raw, { dev: null, none: "none", ops: "ops" }, "raw Annotate is null outside its Case/When predicate");
  assert.deepEqual(payload.m2m, { dev: null, none: null, ops: "dev" }, "M2M conditions execute against the related model through its join table");
  assert.deepEqual(payload.custom, { dev: null, none: null, ops: "ops" }, "a custom-model condition can compare against an outer-row field");
  assert.deepEqual(payload.relation, ["auth", null], "a non-M2M relation Subquery keeps its correlation and target predicate");
  assert.deepEqual(payload.grouped, { false: 0, true: 1 }, "the aggregate endpoint applies conditional Count inside each group");
  assert.equal(payload.conditional_exists, true, "global conditional exists applies its predicate in both transports");
  assert.equal(payload.bad_row_ok, true);
  assert.deepEqual(payload.bad_row_columns, [], "every malformed conditional annotation is dropped as a whole");
  assert.equal(payload.bad_row_has_values, false, "an invalid condition never widens into an unconditional column");
  assert.equal(payload.bad_aggregate_ok, false, "an invalid aggregate condition never widens into an unconditional global count");
  assert.deepEqual(payload.bad_aggregate_rows, []);
});

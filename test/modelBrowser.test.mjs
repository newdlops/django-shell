// Verifies the additive Django model data-browser backend kinds. (Filter/transform-specific tests live in
// modelBrowserFilters.test.mjs; shared helpers in modelBrowserHelpers.mjs.)

import assert from "node:assert/strict";
import test from "node:test";

import { BackendClient, HAS_DJANGO, PYTHON, buildComputedOrm, buildRowsOrm, ormBuilders, runBackend } from "./modelBrowserHelpers.mjs";

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

test("builds single-line injection-proof aggregate ORM cells (grouped, global, exists, distinct)", () => {
  const cols = [
    { attname: "id", computed: false, pk: true, type: "AutoField" },
    { attname: "amount", computed: false, type: "IntegerField" },
    { attname: "status", computed: false, type: "CharField" }
  ];
  const grouped = ormBuilders.buildAggregateOrm({ aggregates: [{ alias: "amount_sum", field: "amount", func: "sum" }, { alias: "n", field: "*", func: "count" }], app: "db", columns: cols, groupBy: ["status"], model: "Company" });
  const globalAgg = ormBuilders.buildAggregateOrm({ aggregates: [{ alias: "avg_amount", field: "amount", func: "avg" }], app: "db", columns: cols, groupBy: [], model: "Company" });
  const distinctAgg = ormBuilders.buildAggregateOrm({ aggregates: [{ alias: "d", distinct: true, field: "status", func: "count" }], app: "db", columns: cols, model: "Company" });
  const existsOnly = ormBuilders.buildAggregateOrm({ aggregates: [{ alias: "any", func: "exists" }], app: "db", columns: cols, model: "Company" });
  const mixed = ormBuilders.buildAggregateOrm({ aggregates: [{ alias: "n", field: "*", func: "count" }, { alias: "any", func: "exists" }], app: "db", columns: cols, model: "Company" });
  const injected = ormBuilders.buildAggregateOrm({ aggregates: [{ alias: "x", field: "amount); import os #", func: "sum" }], app: "db", columns: cols, groupBy: ["status; DROP TABLE"], model: "Company" });
  // No usable spec survives (exists-only with a group-by, or all fields invalid) → a degenerate empty aggregate the parser maps to an error.
  const groupedExistsOnly = ormBuilders.buildAggregateOrm({ aggregates: [{ alias: "any", func: "exists" }], app: "db", columns: cols, groupBy: ["status"], model: "Company" });
  const allInvalidFields = ormBuilders.buildAggregateOrm({ aggregates: [{ alias: "x", field: "ghost", func: "sum" }], app: "db", columns: cols, model: "Company" });

  const relCount = ormBuilders.buildAggregateOrm({ aggregates: [{ alias: "g", distinct: true, field: "members", func: "count" }], app: "db", columns: cols, groupBy: ["status"], model: "Company", relations: [{ kind: "m2m", name: "members", queryName: "members", single: false, target: "db.Member" }] });
  const computedCols = [{ attname: "id", computed: false, pk: true, type: "AutoField" }, { annotated: false, attname: "score", computed: true, type: "property" }];

  assert.equal(groupedExistsOnly, "[Company._base_manager.aggregate()]");
  assert.equal(allInvalidFields, "[Company._base_manager.aggregate()]");
  assert.equal(relCount, 'Company._base_manager.values("status").annotate(g=models.Count("members", distinct=True)).order_by("status")[0:1001]');
  // A lookup on an aggregate alias becomes a HAVING (.filter after .annotate), not a WHERE.
  const havingAgg = ormBuilders.buildAggregateOrm({ aggregates: [{ alias: "n", field: "*", func: "count" }], app: "db", columns: cols, filters: [{ field: "n", lookup: "gte", value: "5" }], groupBy: ["status"], model: "Company" });
  assert.equal(havingAgg, 'Company._base_manager.values("status").annotate(n=models.Count("pk")).filter(**{"n__gte": 5}).order_by("status")[0:1001]');
  // FK drill-in: a traversal group-by and Count/Sum over a relation path are emitted as the joined path.
  const drill = ormBuilders.buildAggregateOrm({ aggregates: [{ alias: "n", distinct: true, field: "orders__id", func: "count" }, { alias: "rev", field: "orders__amount", func: "sum" }], app: "db", columns: cols, groupBy: ["category__name"], model: "Company" });
  assert.match(drill, /\.values\("category__name"\)/);
  assert.match(drill, /n=models\.Count\("orders__id", distinct=True\)/);
  assert.match(drill, /rev=models\.Sum\("orders__amount"\)/);
  assert.doesNotMatch(drill, /\n/, "the FK-drill aggregate cell stays single-line");
  // Computed-@property aggregates are routed to the socket Python scan, never an ORM cell.
  assert.equal(ormBuilders.aggregatesNeedPython([{ field: "score", func: "avg" }], computedCols), true);
  assert.equal(ormBuilders.aggregatesNeedPython([{ field: "id", func: "count" }], computedCols), false);
  assert.equal(ormBuilders.aggregatesNeedPython([{ func: "exists" }], computedCols), false);
  assert.equal(grouped, 'Company._base_manager.values("status").annotate(amount_sum=models.Sum("amount"), n=models.Count("pk")).order_by("status")[0:1001]');
  assert.equal(globalAgg, '[Company._base_manager.aggregate(avg_amount=models.Avg("amount"))]');
  assert.equal(distinctAgg, '[Company._base_manager.aggregate(d=models.Count("status", distinct=True))]');
  assert.equal(existsOnly, '[{"any": Company._base_manager.exists()}]');
  assert.equal(mixed, '[dict(Company._base_manager.aggregate(n=models.Count("pk")), **{"any": Company._base_manager.exists()})]');
  // Unknown group-by/aggregate fields are dropped (never injected); with nothing left it falls back to an empty global aggregate.
  assert.doesNotMatch(injected, /DROP|import os/);
  for (const cell of [grouped, globalAgg, distinctAgg, existsOnly, mixed, injected]) {
    assert.doesNotMatch(cell, /\n/, "aggregate cells must stay single-line so they type into any shell (plain REPL has no multi-line cells)");
    assert.match(cell, /\bCompany\._base_manager\b/);
    assert.doesNotMatch(cell, SUPPORT_LAYER_CELL);
  }
});

test("adds per-row annotation columns to the rows ORM cell (raw annotate, relation Count, window, F-expression)", () => {
  const cols = [{ attname: "id", computed: false, pk: true, type: "AutoField" }, { attname: "amount", computed: false, type: "IntegerField" }, { attname: "is_staff", computed: false, type: "BooleanField" }];
  const rels = [{ kind: "m2m", name: "groups", queryName: "groups", single: false, target: "auth.Group" }];
  const raw = buildRowsOrm({ annotations: [{ alias: "copy", expression: 'models.F("amount")', kind: "annotate" }], app: "auth", columns: cols, limit: 50, model: "User" });
  const subquery = buildRowsOrm({ annotations: [{ alias: "first_group", expression: 'models.Subquery(User.groups.through.objects.filter(user_id=models.OuterRef("pk")).order_by("group__name").values("group__name")[:1])', kind: "annotate" }], app: "auth", columns: cols, limit: 50, model: "User" });
  const easySubquery = buildRowsOrm({ annotations: [{ alias: "first_group_easy", field: "name", kind: "subquery", orderBy: [{ field: "name" }], relation: "groups", relationKind: "m2m", target: "auth.Group", throughOwner: "User", throughRelation: "groups", throughSource: "user", throughTarget: "group" }], app: "auth", columns: cols, limit: 50, model: "User" });
  const customSubquery = buildRowsOrm({ annotations: [{ alias: "matching_group", field: "name", filterField: "name", kind: "subquery", orderBy: [{ field: "id" }], outerField: "amount", target: "auth.Group" }], app: "auth", columns: cols, limit: 50, model: "User" });
  const relCount = buildRowsOrm({ annotations: [{ alias: "gc", distinct: true, field: "groups", func: "count", kind: "aggregate" }], app: "auth", columns: cols, limit: 50, model: "User", relations: rels });
  const win = buildRowsOrm({ annotations: [{ alias: "rn", field: undefined, func: "row_number", kind: "window", orderBy: [{ desc: true, field: "id" }], partitionBy: ["is_staff"] }], app: "auth", columns: cols, limit: 50, model: "User" });
  const expr = buildRowsOrm({ annotations: [{ alias: "a10", kind: "expr", left: "amount", op: "+", right: 10 }], app: "auth", columns: cols, limit: 50, model: "User" });
  const injected = buildRowsOrm({ annotations: [{ alias: "bad", field: "x); import os #", func: "sum", kind: "aggregate" }], app: "auth", columns: cols, limit: 50, model: "User" });
  const injectedRaw = buildRowsOrm({ annotations: [{ alias: "bad", expression: "models.Value(1); import os", kind: "annotate" }], app: "auth", columns: cols, limit: 50, model: "User" });

  assert.match(raw, /\.annotate\(copy=models\.F\("amount"\)\)/);
  assert.match(subquery, /\.annotate\(first_group=models\.Subquery\(User\.groups\.through\.objects\.filter\(user_id=models\.OuterRef\("pk"\)\)\.order_by\("group__name"\)\.values\("group__name"\)\[:1\]\)\)/);
  assert.match(easySubquery, /\.annotate\(first_group_easy=models\.Subquery\(User\.groups\.through\.objects\.filter\(\*\*\{"user_id": models\.OuterRef\("pk"\)\}\)\.order_by\("group__name"\)\.values\("group__name"\)\[:1\]\)\)/);
  assert.match(customSubquery, /\.annotate\(matching_group=models\.Subquery\(Group\._base_manager\.filter\(\*\*\{"name": models\.OuterRef\("amount"\)\}\)\.order_by\("id"\)\.values\("name"\)\[:1\]\)\)/);
  const keywordAlias = buildRowsOrm({ annotations: [{ alias: "class", field: "groups", func: "count", kind: "aggregate" }], app: "auth", columns: cols, limit: 50, model: "User", relations: rels });
  const constExpr = buildRowsOrm({ annotations: [{ alias: "k", kind: "expr", left: "5", op: "/", right: "0" }], app: "auth", columns: cols, limit: 50, model: "User" });
  const propCols = [...cols, { annotated: false, attname: "flag", computed: true, type: "property" }];
  const propFilterAnn = buildRowsOrm({ annotations: [{ alias: "gc", field: "groups", func: "count", kind: "aggregate" }], app: "auth", columns: propCols, filters: [{ field: "flag", lookup: "exact", value: "true" }], limit: 50, model: "User", relations: rels });

  assert.match(relCount, /\.annotate\(gc=models\.Count\("groups", distinct=True\)\)/);
  assert.match(win, /\.annotate\(rn=models\.Window\(models\.functions\.RowNumber\(\), partition_by=\[models\.F\("is_staff"\)\], order_by=\[models\.F\("id"\)\.desc\(\)\]\)\)/);
  assert.match(expr, /\.annotate\(a10=models\.F\("amount"\) \+ 10\)/);
  assert.doesNotMatch(injected, /import os/);
  assert.doesNotMatch(injected, /\.annotate\(/, "an unsafe annotation field is dropped, never emitted");
  assert.doesNotMatch(injectedRaw, /import os/);
  assert.doesNotMatch(injectedRaw, /\.annotate\(/, "an unsafe raw annotate expression is dropped, never emitted");
  // A Python-keyword alias would be a raw `class=` SyntaxError in the cell — it falls back to a safe generated name.
  assert.doesNotMatch(keywordAlias, /\(class=/);
  assert.match(keywordAlias, /\.annotate\(groups_count=models\.Count\("groups"\)\)/);
  // A constant-only F-expression (no field) is dropped (it isn't a valid annotation and `5/0` would crash the cell).
  assert.doesNotMatch(constExpr, /\.annotate\(/);
  // A @property filter streams a multi-line cell; the annotation must still be applied (transport parity with the socket path).
  assert.match(propFilterAnn, /_prop_ok/);
  assert.match(propFilterAnn, /\.annotate\(gc=models\.Count\("groups"\)\)/);
  // A lookup on an annotation alias filters AFTER .annotate() (HAVING), not as a WHERE clause before it.
  const having = buildRowsOrm({ annotations: [{ alias: "gc", field: "groups", func: "count", kind: "aggregate" }], app: "auth", columns: cols, filters: [{ field: "gc", lookup: "gte", value: "2" }], limit: 50, model: "User", relations: rels });
  assert.match(having, /\.annotate\(gc=models\.Count\("groups"\)\)\.filter\(\*\*\{"gc__gte": 2\}\)\.order_by/);
  // count >= 1 must emit the int 1, not the bool True (numeric-first coercion for aggregate HAVING values).
  const havingOne = buildRowsOrm({ annotations: [{ alias: "gc", field: "groups", func: "count", kind: "aggregate" }], app: "auth", columns: cols, filters: [{ field: "gc", lookup: "gte", value: "1" }], limit: 50, model: "User", relations: rels });
  assert.match(havingOne, /\.filter\(\*\*\{"gc__gte": 1\}\)/);
  assert.doesNotMatch(havingOne, /gc__gte": True/);
  // A lookup on a window column is dropped — SQL can't filter a window function.
  const winFilter = buildRowsOrm({ annotations: [{ alias: "rn", func: "row_number", kind: "window", orderBy: [{ field: "id" }], partitionBy: ["is_staff"] }], app: "auth", columns: cols, filters: [{ field: "rn", lookup: "lte", value: "1" }], limit: 50, model: "User" });
  assert.match(winFilter, /\.annotate\(rn=models\.Window/);
  assert.doesNotMatch(winFilter, /rn__lte/);
  for (const cell of [raw, subquery, easySubquery, customSubquery, relCount, win, expr, injected, injectedRaw]) {
    assert.doesNotMatch(cell, /\n/, "annotation row cells must stay single-line");
    assert.match(cell, /\bUser\._base_manager\b/);
    assert.doesNotMatch(cell, SUPPORT_LAYER_CELL);
  }
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

test("aggregates with allowlisted group-by/fields, computes global + exists, and rejects injection", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User; from django.db import connection, reset_queries",
    "[User.objects.create(username=f'user{i}', password='x', is_staff=(i % 2 == 0)) for i in range(5)]",
    "def call(**kw): return mod._run_request({}, 't', {'token': 't', 'kind': 'aggregate', 'app': 'auth', 'model': 'User', **kw}, set())",
    "reset_queries()",
    "grouped = call(groupBy=['is_staff'], aggregates=[{'func': 'count', 'field': '*', 'alias': 'n'}])",
    "grouped_queries = len(connection.queries)",
    "glob = call(aggregates=[{'func': 'count', 'field': '*', 'alias': 'total'}, {'func': 'exists', 'alias': 'any'}, {'func': 'max', 'field': 'id', 'alias': 'max_id'}])",
    "glob_cols = [c['attname'] for c in glob['columns']]",
    "filtered = call(filters=[{'field': 'is_staff', 'lookup': 'exact', 'value': True}], aggregates=[{'func': 'count', 'field': 'id', 'alias': 'staff'}])",
    "distinct = call(aggregates=[{'func': 'count', 'field': 'is_staff', 'alias': 'kinds', 'distinct': True}])",
    "exists_grouped = call(groupBy=['is_staff'], aggregates=[{'func': 'exists', 'alias': 'any'}])",
    "bad = call(groupBy=['evil; DROP'], aggregates=[{'func': 'sum', 'field': 'nope); import os', 'alias': 'x'}])",
    "empty = call(filters=[{'field': 'username', 'lookup': 'exact', 'value': 'nobody'}], aggregates=[{'func': 'exists', 'alias': 'any'}])",
    "print(json.dumps({",
    "  'grouped_ok': grouped['ok'], 'grouped_queries': grouped_queries, 'grouped_cols': [c['attname'] for c in grouped['columns']],",
    "  'grouped_total': sum(r['n'] for r in grouped['rows']), 'grouped_rows': len(grouped['rows']), 'grouped_echo': grouped.get('groupBy'),",
    "  'global_total': glob['rows'][0]['total'], 'global_any': glob['rows'][0]['any'], 'global_has_max': 'max_id' in glob['rows'][0], 'global_cols': glob_cols,",
    "  'filtered_staff': filtered['rows'][0]['staff'], 'distinct_kinds': distinct['rows'][0]['kinds'],",
    "  'exists_grouped_ok': exists_grouped['ok'],",
    "  'bad_ok': bad['ok'], 'empty_any': empty['rows'][0]['any'],",
    "}))"
  ]);
  assert.equal(payload.grouped_ok, true);
  assert.equal(payload.grouped_queries, 1, "a grouped aggregate is a single GROUP BY query");
  assert.deepEqual(payload.grouped_cols, ["is_staff", "n"]);
  assert.equal(payload.grouped_total, 5, "group counts sum to the row total");
  assert.equal(payload.grouped_rows, 2);
  assert.deepEqual(payload.grouped_echo, ["is_staff"]);
  assert.equal(payload.global_total, 5);
  assert.equal(payload.global_any, true);
  assert.equal(payload.global_has_max, true);
  assert.deepEqual(payload.global_cols, ["total", "max_id", "any"], "global aggregate columns are non-exists first then exists (matches ORM-mode dict order)");
  assert.equal(payload.filtered_staff, 3, "filters apply as the WHERE clause");
  assert.equal(payload.distinct_kinds, 2, "count distinct collapses to the distinct value count");
  assert.equal(payload.exists_grouped_ok, false, "exists alone in grouped mode leaves no aggregate to compute");
  assert.equal(payload.bad_ok, false, "all-invalid group-by/aggregate fields are rejected, never injected");
  assert.equal(payload.empty_any, false, "exists is false when no rows match the filter");
});

test("aggregates drill through FK relations (traversal group-by + Count over a relation path), rejecting bad segments", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import Permission",
    "def agg(**kw): return mod._run_request({}, 't', {'token': 't', 'kind': 'aggregate', 'app': 'auth', 'model': 'Permission', **kw}, set())",
    "def rows(**kw): return mod._run_request({}, 't', {'token': 't', 'kind': 'rows', 'app': 'auth', 'model': 'Permission', **kw}, set())",
    "grouped = agg(groupBy=['content_type__app_label'], aggregates=[{'func': 'count', 'field': '*', 'alias': 'n'}])",
    "grouped_total = sum(r['n'] for r in grouped['rows'])",
    "drill_rows = rows(annotations=[{'kind': 'aggregate', 'func': 'count', 'field': 'content_type__permission', 'alias': 'siblings', 'distinct': True}], limit=3)",
    "drill_cols = [c['attname'] for c in drill_rows['columns'] if c.get('annotation')]",
    "bad = agg(groupBy=['content_type__evil); import os'], aggregates=[{'func': 'sum', 'field': 'content_type__nope);drop', 'alias': 'x'}])",
    "print(json.dumps({",
    "  'grouped_ok': grouped['ok'], 'grouped_cols': [c['attname'] for c in grouped['columns']], 'grouped_total': grouped_total,",
    "  'grouped_orm': '.values(' in grouped['orm'] and 'content_type__app_label' in grouped['orm'],",
    "  'drill_ok': drill_rows['ok'], 'drill_cols': drill_cols, 'drill_has': bool(drill_rows['rows']) and 'siblings' in drill_rows['rows'][0],",
    "  'bad_ok': bad['ok'], 'bad_rows': len(bad['rows']),",
    "}))"
  ]);
  assert.equal(payload.grouped_ok, true);
  assert.deepEqual(payload.grouped_cols, ["content_type__app_label", "n"], "group-by drills through the content_type FK to app_label");
  assert.ok(payload.grouped_total > 0, "the grouped counts cover every permission");
  assert.equal(payload.grouped_orm, true);
  assert.equal(payload.drill_ok, true);
  assert.deepEqual(payload.drill_cols, ["siblings"], "a per-row Count over a relation traversal becomes an annotation column");
  assert.equal(payload.drill_has, true);
  assert.equal(payload.bad_ok, false, "an unsafe traversal segment is rejected, never injected");
});

test("to-many aggregates count distinct (no JOIN fan-out) and reject Sum/Avg over a to-many relation", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User, Group, Permission",
    "g1 = Group.objects.create(name='a'); g2 = Group.objects.create(name='b')",
    "u = User.objects.create(username='u0', password='x'); u.groups.add(g1, g2)",
    "u.user_permissions.add(*list(Permission.objects.all()[:3]))",
    "def rows(**kw): return mod._run_request({}, 't', {'token': 't', 'kind': 'rows', 'app': 'auth', 'model': 'User', **kw}, set())",
    "fanout = rows(annotations=[{'kind': 'aggregate', 'func': 'count', 'field': 'groups', 'alias': 'g'}, {'kind': 'aggregate', 'func': 'count', 'field': 'user_permissions', 'alias': 'p'}])",
    "row0 = next((r for r in fanout['rows'] if r['username'] == 'u0'), {})",
    "summ = rows(annotations=[{'kind': 'aggregate', 'func': 'sum', 'field': 'groups__id', 'alias': 'gsum'}])",
    "summ_cols = [c['attname'] for c in summ['columns'] if c.get('annotation')]",
    "print(json.dumps({",
    "  'g': row0.get('g'), 'p': row0.get('p'), 'distinct_orm': 'distinct=True' in fanout['orm'], 'sum_dropped': 'gsum' not in summ_cols,",
    "}))"
  ]);
  assert.equal(payload.g, 2, "Count over a to-many relation is distinct (not multiplied by the sibling to-many join)");
  assert.equal(payload.p, 3);
  assert.equal(payload.distinct_orm, true, "the to-many Count is forced distinct in the logged ORM");
  assert.equal(payload.sum_dropped, true, "Sum over a to-many relation is rejected (JOIN fan-out can't be de-duplicated)");
});

test("aggregates Count over relations and reduces @property aggregates with a Python scan, merged by group", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User, Group",
    "User.doubled = property(lambda self: self.id * 2)",
    "ops = Group.objects.create(name='ops'); dev = Group.objects.create(name='dev'); name_match = Group.objects.create(name='user2')",
    "users = [User.objects.create(username=f'user{i}', password='x', is_staff=(i % 2 == 0)) for i in range(5)]",
    "users[0].groups.add(ops); users[2].groups.add(ops, dev)",
    "def call(**kw): return mod._run_request({}, 't', {'token': 't', 'kind': 'aggregate', 'app': 'auth', 'model': 'User', **kw}, set())",
    "rel = call(groupBy=['is_staff'], aggregates=[{'func': 'count', 'field': 'groups', 'alias': 'g', 'distinct': True}])",
    "rel_map = {str(r['is_staff']).lower(): r['g'] for r in rel['rows']}",
    "prop = call(aggregates=[{'func': 'avg', 'field': 'doubled', 'alias': 'avg_d'}, {'func': 'count', 'field': 'doubled', 'alias': 'cnt'}, {'func': 'max', 'field': 'doubled', 'alias': 'max_d'}])",
    "mixed = call(groupBy=['is_staff'], aggregates=[{'func': 'sum', 'field': 'doubled', 'alias': 'sum_d'}, {'func': 'count', 'field': 'groups', 'alias': 'g', 'distinct': True}])",
    "mixed_map = {str(r['is_staff']).lower(): [r['sum_d'], r['g']] for r in mixed['rows']}",
    "prop_only = call(groupBy=['is_staff'], aggregates=[{'func': 'sum', 'field': 'doubled', 'alias': 'sum_d'}])",
    "prop_only_order = [r['is_staff'] for r in prop_only['rows']]",
    "User.mixedp = property(lambda self: self.id if self.id % 2 else 'x')",
    "het = call(aggregates=[{'func': 'avg', 'field': 'mixedp', 'alias': 'avg_m'}, {'func': 'count', 'field': 'mixedp', 'alias': 'cnt_m'}, {'func': 'sum', 'field': 'mixedp', 'alias': 'sum_m'}])",
    "print(json.dumps({",
    "  'rel_ok': rel['ok'], 'rel_cols': [c['attname'] for c in rel['columns']], 'rel_map': rel_map,",
    "  'prop_scan': prop.get('pythonScan'), 'avg_d': prop['rows'][0]['avg_d'], 'cnt': prop['rows'][0]['cnt'], 'max_d': prop['rows'][0]['max_d'],",
    "  'mixed_scan': mixed.get('pythonScan'), 'mixed_cols': [c['attname'] for c in mixed['columns']], 'mixed_map': mixed_map,",
    "  'prop_only_order': prop_only_order, 'het_avg': het['rows'][0]['avg_m'], 'het_cnt': het['rows'][0]['cnt_m'], 'het_sum': het['rows'][0]['sum_m'],",
    "}))"
  ]);
  assert.equal(payload.rel_ok, true);
  assert.deepEqual(payload.rel_cols, ["is_staff", "g"]);
  assert.deepEqual(payload.rel_map, { false: 0, true: 2 }, "Count over a reverse/M2M relation counts distinct related rows per group");
  assert.equal(payload.prop_scan, true, "a @property aggregate marks the response as a Python scan");
  assert.equal(payload.avg_d, 6, "avg of doubled = id*2 over ids 1..5");
  assert.equal(payload.cnt, 5);
  assert.equal(payload.max_d, 10);
  assert.equal(payload.mixed_scan, true);
  assert.deepEqual(payload.mixed_cols, ["is_staff", "sum_d", "g"]);
  assert.deepEqual(payload.mixed_map, { false: [12, 0], true: [18, 2] }, "DB relation-count and Python @property-sum merge into the same group rows");
  assert.deepEqual(payload.prop_only_order, [false, true], "@property-only grouped rows are ordered by the group-by (matching the DB path), not iteration order");
  assert.equal(payload.het_avg, 3, "mixed-type @property avg divides the sum by the summable count, not the total non-null count");
  assert.equal(payload.het_cnt, 5);
  assert.equal(payload.het_sum, 9);
});

test("adds per-row annotation columns to the rows view and forces offset pagination for window functions", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User, Group",
    "ops = Group.objects.create(name='ops'); dev = Group.objects.create(name='dev'); name_match = Group.objects.create(name='user2')",
    "users = [User.objects.create(username=f'user{i}', password='x', is_staff=(i % 2 == 0)) for i in range(4)]",
    "users[0].groups.add(ops); users[1].groups.add(ops, dev)",
    "def call(**kw): return mod._run_request({}, 't', {'token': 't', 'kind': 'rows', 'app': 'auth', 'model': 'User', **kw}, set())",
    "rc = call(annotations=[{'kind': 'aggregate', 'func': 'count', 'field': 'groups', 'alias': 'gc', 'distinct': True}])",
    "rc_cols = [c for c in rc['columns'] if c.get('annotation')]",
    "rc_map = {r['username']: r['gc'] for r in rc['rows']}",
    "win = call(limit=2, annotations=[{'kind': 'window', 'func': 'row_number', 'partitionBy': ['is_staff'], 'orderBy': [{'field': 'id'}], 'alias': 'rn'}])",
    "win_map = {r['username']: r['rn'] for r in call(annotations=[{'kind': 'window', 'func': 'row_number', 'partitionBy': ['is_staff'], 'orderBy': [{'field': 'id'}], 'alias': 'rn'}])['rows']}",
    "raw = call(annotations=[{'kind': 'annotate', 'expression': \"models.F('username')\", 'alias': 'uname'}])",
    "subq = call(annotations=[{'kind': 'annotate', 'expression': \"models.Subquery(User.groups.through.objects.filter(user_id=models.OuterRef('pk')).order_by('group__name').values('group__name')[:1])\", 'alias': 'first_group'}])",
    "subq_easy = call(annotations=[{'kind': 'subquery', 'relation': 'groups', 'field': 'name', 'orderBy': [{'field': 'name'}], 'alias': 'first_group_easy'}])",
    "subq_custom = call(annotations=[{'kind': 'subquery', 'target': 'auth.Group', 'filterField': 'name', 'outerField': 'username', 'field': 'name', 'alias': 'matching_group'}])",
    "expr = call(annotations=[{'kind': 'expr', 'op': '+', 'left': 'id', 'right': 100, 'alias': 'idp'}])",
    "inj = call(annotations=[{'kind': 'aggregate', 'func': 'sum', 'field': 'evil); import os', 'alias': 'x'}])",
    "inj_cols = [c for c in inj['columns'] if c.get('annotation')]",
    "raw_inj = call(annotations=[{'kind': 'annotate', 'expression': \"models.Value(1); import os\", 'alias': 'x'}])",
    "raw_inj_cols = [c for c in raw_inj['columns'] if c.get('annotation')]",
    "kw = call(annotations=[{'kind': 'aggregate', 'func': 'count', 'field': 'groups', 'alias': 'class', 'distinct': True}])",
    "kw_cols = [c['attname'] for c in kw['columns'] if c.get('annotation')]",
    "having = call(annotations=[{'kind': 'aggregate', 'func': 'count', 'field': 'groups', 'alias': 'gc', 'distinct': True}], filters=[{'field': 'gc', 'lookup': 'gte', 'value': '2'}])",
    "having_users = sorted(r['username'] for r in having['rows'])",
    "having1 = call(annotations=[{'kind': 'aggregate', 'func': 'count', 'field': 'groups', 'alias': 'gc', 'distinct': True}], filters=[{'field': 'gc', 'lookup': 'gte', 'value': '1'}])",
    "having1_users = sorted(r['username'] for r in having1['rows'])",
    "having1_orm_int = 'gc__gte=1' in having1['orm']",
    "scalar = call(annotations=[{'kind': 'window', 'func': 'rank', 'partitionBy': 123, 'orderBy': 456, 'alias': 'r'}])",
    "print(json.dumps({",
    "  'kw_ok': kw['ok'], 'kw_cols': kw_cols, 'scalar_ok': scalar['ok'], 'having_users': having_users,",
    "  'having1_users': having1_users, 'having1_orm_int': having1_orm_int,",
    "  'rc_ok': rc['ok'], 'rc_col': (rc_cols[0]['attname'] if rc_cols else None), 'rc_col_ann': (rc_cols[0].get('annotation') if rc_cols else None), 'rc_map': rc_map,",
    "  'win_keyset': win['nextCursor'], 'win_offset': win['nextOffset'], 'win_map': win_map,",
    "  'raw_map': {r['username']: r['uname'] for r in raw['rows']}, 'subq_map': {r['username']: r['first_group'] for r in subq['rows']}, 'subq_easy_map': {r['username']: r['first_group_easy'] for r in subq_easy['rows']}, 'subq_custom_map': {r['username']: r['matching_group'] for r in subq_custom['rows']},",
    "  'idp': {r['username']: r['idp'] for r in expr['rows']},",
    "  'inj_ok': inj['ok'], 'inj_cols': len(inj_cols), 'raw_inj_ok': raw_inj['ok'], 'raw_inj_cols': len(raw_inj_cols),",
    "}))"
  ]);
  assert.equal(payload.rc_ok, true);
  assert.equal(payload.rc_col, "gc", "the relation Count annotation appears as an extra column");
  assert.equal(payload.rc_col_ann, true);
  assert.deepEqual(payload.rc_map, { user0: 1, user1: 2, user2: 0, user3: 0 }, "Count('groups', distinct=True) is computed per row");
  assert.equal(payload.win_keyset, null, "window functions force offset pagination (no keyset cursor)");
  assert.equal(payload.win_offset, 2, "window functions paginate by offset");
  assert.deepEqual(payload.win_map, { user0: 1, user1: 1, user2: 2, user3: 2 }, "RowNumber partitions by is_staff, ordered by id");
  assert.deepEqual(payload.raw_map, { user0: "user0", user1: "user1", user2: "user2", user3: "user3" }, "raw annotate can add a plain F() column");
  assert.deepEqual(payload.subq_map, { user0: "ops", user1: "dev", user2: null, user3: null }, "raw annotate supports Subquery/OuterRef expressions");
  assert.deepEqual(payload.subq_easy_map, payload.subq_map, "the structured Subquery builder matches the raw Subquery/OuterRef expression");
  assert.deepEqual(payload.subq_custom_map, { user0: null, user1: null, user2: "user2", user3: null }, "the structured Subquery builder can compare unrelated model fields");
  assert.deepEqual(payload.idp, { user0: 101, user1: 102, user2: 103, user3: 104 }, "F('id') + 100 per row");
  assert.equal(payload.inj_ok, true);
  assert.equal(payload.inj_cols, 0, "an unsafe annotation field is dropped, never injected");
  assert.equal(payload.raw_inj_ok, true);
  assert.equal(payload.raw_inj_cols, 0, "an unsafe raw annotate expression is dropped, never injected");
  assert.equal(payload.kw_ok, true);
  assert.deepEqual(payload.kw_cols, ["groups_count"], "a Python-keyword alias is sanitized to a safe generated name");
  assert.equal(payload.scalar_ok, true, "a malformed scalar partitionBy/orderBy is dropped, not crashed");
  assert.deepEqual(payload.having_users, ["user1"], "a lookup on an annotation column filters rows as HAVING (only user1 has >=2 groups)");
  assert.deepEqual(payload.having1_users, ["user0", "user1"], "count >= 1 filters as HAVING over the integer value");
  assert.equal(payload.having1_orm_int, true, "the HAVING value 1 is logged as the int 1, not the bool True or string '1'");
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
    "outer = call('(\\n User.objects.all()\\n)')",
    "semi = call('named = User.objects.all(); named')",
    "reuse = call('staff.count()')",
    "boom = call('1/0')",
    "scalar = call('User.objects.count()')",
    "print(json.dumps({",
    "  'qs_ok': qs['ok'], 'qs_editable': qs['editable'], 'qs_model': qs.get('model'), 'qs_app': qs.get('app'), 'qs_pk': qs.get('pk'), 'qs_result': qs.get('result'),",
    "  'qs_relations': [r['name'] for r in qs.get('relations', [])],",
    "  'paged_rows': len(paged['rows']), 'paged_more': paged['hasMore'],",
    "  'qs_cols': 'username' in [c['attname'] for c in qs['columns']], 'qs_rows': len(qs['rows']), 'qs_queries': qs_queries,",
    "  'vals_ok': vals['ok'], 'vals_editable': vals['editable'], 'vals_cols': [c['attname'] for c in vals['columns']], 'vals_result': vals.get('result'),",
    "  'flat_cols': [c['attname'] for c in flat['columns']], 'flat_rows': len(flat['rows']), 'flat_result': flat.get('result'),",
    "  'multi_ok': multi['ok'], 'multi_rows': len(multi['rows']), 'multi_editable': multi['editable'], 'multi_result': multi.get('result'),",
    "  'outer_result': outer.get('result'), 'semi_result': semi.get('result'),",
    "  'reuse_ok': reuse['ok'], 'reuse_value': reuse['rows'][0]['value'] if reuse['rows'] else None,",
    "  'boom_ok': boom['ok'], 'boom_err': bool(boom.get('error')),",
    "  'scalar_cols': [c['attname'] for c in scalar['columns']], 'scalar_value': scalar['rows'][0]['value'], 'scalar_result': scalar.get('result'),",
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
  assert.deepEqual(payload.qs_result, { endLine: 1, expression: "User.objects.all()", kind: "queryset", label: "QuerySet[auth.User]", startLine: 1 });
  assert.ok(payload.qs_relations.includes("groups"), "instance queryset results expose reverse/M2M relations like the model browser");
  assert.equal(payload.paged_rows, 2, "the requested page size is honored");
  assert.equal(payload.paged_more, true, "hasMore signals additional rows beyond the page");
  assert.equal(payload.vals_ok, true);
  assert.equal(payload.vals_editable, false, ".values() result is read-only");
  assert.deepEqual(payload.vals_cols, ["id", "username"]);
  assert.equal(payload.vals_result.label, "Values QuerySet[auth.User]");
  assert.deepEqual(payload.flat_cols, ["username"], "values_list(flat=True) becomes one column");
  assert.equal(payload.flat_rows, 4);
  assert.equal(payload.flat_result.label, "Values-list QuerySet[auth.User]");
  assert.equal(payload.multi_ok, true);
  assert.equal(payload.multi_rows, 2, "multi-line code tabulates the final expression");
  assert.equal(payload.multi_editable, true);
  assert.deepEqual(payload.multi_result, { endLine: 2, expression: "staff", kind: "queryset", label: "QuerySet[auth.User]", startLine: 2 }, "the backend identifies the exact final expression without evaluating it twice");
  assert.deepEqual(payload.outer_result, { endLine: 3, expression: "User.objects.all()", kind: "queryset", label: "QuerySet[auth.User]", startLine: 1 }, "outer parentheses remain inside the confirmed result range");
  assert.deepEqual(payload.semi_result, { endLine: 1, expression: "named", kind: "queryset", label: "QuerySet[auth.User]", startLine: 1 }, "a semicolon-delimited final expression stays on its physical source line");
  assert.equal(payload.reuse_ok, true, "assignments from earlier queries persist in the namespace");
  assert.equal(payload.reuse_value, 2);
  assert.equal(payload.boom_ok, false);
  assert.equal(payload.boom_err, true, "a failing expression returns an error, not a crash");
  assert.deepEqual(payload.scalar_cols, ["value"]);
  assert.equal(payload.scalar_value, 4, "a scalar result becomes a single value cell");
  assert.deepEqual(payload.scalar_result, { endLine: 1, expression: "User.objects.count()", kind: "scalar", label: "int", startLine: 1 });
});

// Verifies exact app, primary-key, and database ownership through real Django reads and saves.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { HAS_DJANGO, runBackend } from "./modelBrowserHelpers.mjs";
import { setup, recordModel } from "./criticalBackendFixtures.mjs";
const require = createRequire(import.meta.url);
const { buildCommitOrm, buildRowsOrm, buildRelatedOrm } = require("../out/modelOrm.js");
const { parseModelRowsResponse, parseModelQueryResponse, parseOrmQueryResponse, parseModelRelatedResponse } = require("../out/modelBackend.js");
const columns = [{ attname: "id", type: "BigIntegerField", pk: true }, { attname: "name", type: "CharField", editable: true }];

test("legacy ORM reads and saves resolve the requested app despite a conflicting imported model name", { skip: !HAS_DJANGO }, () => {
  const rows = buildRowsOrm({ app: "critical_beta", model: "Record", columns, limit: 50, offset: 0 });
  const commit = buildCommitOrm("critical_beta", "Record", [{ pk: 1, fields: { name: "edited beta" } }], columns);
  const result = runBackend([...setup(["critical_alpha", "critical_beta"]),
    "def model_for(label):", '    """Creates identically named models in different apps."""',
    "    return type('Record', (models.Model,), {'__module__': label, 'Meta': type('Meta', (), {'app_label': label}), 'name': models.CharField(max_length=100)})",
    "Alpha = model_for('critical_alpha'); Beta = model_for('critical_beta')", "with connections['default'].schema_editor() as schema:", "    schema.create_model(Alpha); schema.create_model(Beta)",
    "Alpha.objects.create(pk=1, name='alpha'); Beta.objects.create(pk=1, name='beta')", "namespace = {}; mod._autoimport_bind_models(namespace, apps)",
    `value, _ = mod._browse_eval_last(namespace, ${JSON.stringify(rows)})`, "selected = value.model._meta.label", `exec(${JSON.stringify(commit)}, namespace)`,
    "print(json.dumps({'selected': selected, 'alpha': Alpha.objects.get(pk=1).name, 'beta': Beta.objects.get(pk=1).name}))"]);
  assert.deepEqual(result, { selected: "critical_beta.Record", alpha: "alpha", beta: "edited beta" });
});

for (const mode of ["socket", "orm"]) {
  test(`${mode} preserves adjacent unsafe integer primary keys through JSON and edits only the selected row`, { skip: !HAS_DJANGO }, () => {
    const fixture = [...setup(), ...recordModel(), "with connections['default'].schema_editor() as schema: schema.create_model(Record)",
      "Record.objects.bulk_create([Record(pk=9007199254740992, name='first'), Record(pk=9007199254740993, name='second')])"];
    const response = runBackend([...fixture, "grid = mod._browse_tabulate(Record.objects.all(), 0, 50)",
      "payload = mod._browse_rows({}, {'app': 'critical_fixture', 'model': 'Record', 'limit': 50})", "print(json.dumps({'wire': json.dumps(payload), 'captured': json.dumps({'grid': grid})}))"]);
    const parsed = mode === "socket" ? parseModelRowsResponse(response.wire) : parseOrmQueryResponse(response.captured, 50, 0);
    const selected = parsed.rows.find((row) => row.name === "second");
    assert.equal(selected.id, "9007199254740993");
    const changes = [{ pk: selected.id, fields: { name: "edited second" } }];
    const commit = mode === "socket" ? `outcome = mod._browse_commit(json.loads(${JSON.stringify(JSON.stringify({ app: "critical_fixture", model: "Record", changes }))}))` : `exec(${JSON.stringify(buildCommitOrm("critical_fixture", "Record", changes, columns))})`;
    const result = runBackend([...fixture, commit, "print(json.dumps([[str(row.pk), row.name] for row in Record.objects.order_by('pk')]))"]);
    assert.deepEqual(result, [["9007199254740992", "first"], ["9007199254740993", "edited second"]]);
  });

  test(`${mode} saves an explicit archive QuerySet back to archive and preserves default`, { skip: !HAS_DJANGO }, () => {
    const fixture = [...setup(undefined, "{name: {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'} for name in ['default', 'archive']}"), ...recordModel(),
      "for alias in ['default', 'archive']:", "    with connections[alias].schema_editor() as schema: schema.create_model(Record)", "    Record.objects.using(alias).create(pk=1, name=alias)"];
    const wire = runBackend([...fixture, "query = mod._browse_query({'Record': Record}, {'code': \"Record.objects.using('archive').all()\"})", "print(json.dumps({'wire': json.dumps(query)}))"]);
    const query = parseModelQueryResponse(wire.wire);
    assert.equal(query.ok, true, query.error); assert.equal(query.database, "archive"); assert.equal(query.rows[0].name, "archive");
    const changes = [{ pk: query.rows[0].id, fields: { name: "edited archive" } }];
    const commit = mode === "socket" ? `outcome = mod._browse_commit(json.loads(${JSON.stringify(JSON.stringify({ app: query.app, model: query.model, database: query.database, changes }))}))\nassert outcome['ok'], outcome` : buildCommitOrm(query.app, query.model, changes, columns, query.database);
    const result = runBackend([...fixture, `exec(${JSON.stringify(commit)})`, "print(json.dumps({alias: Record.objects.using(alias).get(pk=1).name for alias in ['default', 'archive']}))"]);
    assert.deepEqual(result, { default: "default", archive: "edited archive" });
  });
}

test("related reads retain the source database and related model identity in both transports", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(undefined, "{name: {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'} for name in ['default', 'archive']}"), ...recordModel(),
    "class Child(models.Model):", '    """Provides related rows with duplicate primary keys across databases."""',
    "    parent = models.ForeignKey(Record, on_delete=models.CASCADE, related_name='children')", "    name = models.CharField(max_length=100)",
    "    class Meta:", '        """Registers the related fixture."""', "        app_label = 'critical_fixture'", "for alias in ['default', 'archive']:",
    "    with connections[alias].schema_editor() as schema:", "        schema.create_model(Record); schema.create_model(Child)", "    Record.objects.using(alias).create(pk=1, name=alias)", "    Child.objects.using(alias).create(pk=1, parent_id=1, name=alias + ' child')",
    "related = mod._browse_related({'app': 'critical_fixture', 'model': 'Record', 'pk': 1, 'relation': 'children', 'database': 'archive'})",
    `value, _ = mod._browse_eval_last({}, ${JSON.stringify(buildRelatedOrm("critical_fixture", "Record", 1, "children", 50, "archive"))})`,
    "print(json.dumps({'wire': json.dumps(related), 'orm': list(value.values_list('name', flat=True))}))"]);
  const parsed = parseModelRelatedResponse(result.wire);
  assert.equal(parsed.database, "archive"); assert.equal(parsed.app, "critical_fixture"); assert.equal(parsed.model, "Child"); assert.equal(parsed.pk, "id");
  assert.equal(parsed.rows[0].name, "archive child"); assert.deepEqual(result.orm, ["archive child"]);
});

test("unsafe signed integers and choice values cross the JSON boundary exactly", { skip: !HAS_DJANGO }, () => {
  const result = runBackend(["import json", "print(json.dumps([mod._browse_cell(-9007199254740993), mod._browse_jsonable(9007199254740993), mod._browse_cell(True), mod._browse_cell(42)]))"]);
  assert.deepEqual(result, ["-9007199254740993", "9007199254740993", true, 42]);
});

test("large primary keys survive cursor paging, FK lookup, and field choices", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(), ...recordModel(), "with connections['default'].schema_editor() as schema: schema.create_model(Record)",
    "Record.objects.bulk_create([Record(pk=9007199254740992, name='first'), Record(pk=9007199254740993, name='second')])",
    "first = mod._browse_rows({}, {'app': 'critical_fixture', 'model': 'Record', 'limit': 1})",
    "second = mod._browse_rows({}, {'app': 'critical_fixture', 'model': 'Record', 'limit': 1, 'cursor': json.loads(json.dumps(first['nextCursor']))})",
    "lookup = mod._browse_lookup({'app': 'critical_fixture', 'model': 'Record', 'q': 'second'})",
    "field = models.BigIntegerField(choices=[(9007199254740993, 'Second')])",
    "print(json.dumps({'first': first, 'second': second, 'lookup': lookup, 'choices': mod._browse_field_choices(field)}))"]);
  assert.equal(result.first.nextCursor, "9007199254740992"); assert.equal(result.second.rows[0].id, "9007199254740993");
  assert.equal(result.lookup.rows[0].pk, "9007199254740993"); assert.equal(result.choices[0][0], "9007199254740993");
});

test("implicit replica reads preserve the configured write router when saved", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(undefined, "{name: {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'} for name in ['default', 'replica']}"), ...recordModel(),
    "class Router:", '    """Separates implicit reads from writes."""',
    "    def db_for_read(self, model, **hints):", '        """Reads the replica."""', "        return 'replica'",
    "    def db_for_write(self, model, **hints):", '        """Writes the primary."""', "        return 'default'",
    "settings.DATABASE_ROUTERS = [Router()]", "for alias in ['default', 'replica']:", "    with connections[alias].schema_editor() as schema: schema.create_model(Record)",
    "    Record.objects.using(alias).create(pk=1, name=alias)", "query = mod._browse_query({'Record': Record}, {'code': 'Record.objects.all()'})",
    "commit = mod._browse_commit({'app': query['app'], 'model': query['model'], 'database': query.get('database'), 'changes': [{'pk': 1, 'fields': {'name': 'edited primary'}}]})",
    "print(json.dumps({'query': query, 'commit': commit, 'names': {alias: Record.objects.using(alias).get(pk=1).name for alias in ['default', 'replica']}}))"]);
  assert.equal(result.query.rows[0].name, "replica"); assert.equal(result.query.database, null); assert.equal(result.commit.ok, true, result.commit.error);
  assert.deepEqual(result.names, { default: "edited primary", replica: "replica" });
});

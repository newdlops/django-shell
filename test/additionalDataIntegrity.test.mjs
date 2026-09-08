// Verifies database provenance and exact scalar types across Socket, ORM, Recipe, and PTY tabulation.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { setup } from "./criticalBackendFixtures.mjs";
import { HAS_DJANGO, runBackend, ormBuilders, buildRowsOrm, buildComputedOrm } from "./modelBrowserHelpers.mjs";
const require = createRequire(import.meta.url);
const { createEmptyModelQueryRecipe } = require("../out/modelQueryRecipe.js");
const { ModelQueryMetadataIndex } = require("../out/modelQueryRecipeMetadata.js");
const recipeOrm = require("../out/modelQueryRecipeOrm.js");

/** Registers one isolated model in the process-local fixture app. */
function meta() { return ["    class Meta:", '        """Registers an isolated scalar-edit fixture."""', "        app_label = 'critical_fixture'"]; }

/** Executes the actual requested save path and keeps validation failures observable. */
function save(mode, model, fields, columns) {
  const changes = [{ pk: 1, fields }];
  return mode === "socket" ? [`outcome = mod._browse_commit(json.loads(${JSON.stringify(JSON.stringify({ app: "critical_fixture", model, changes }))}))`] : ["try:",
    `    exec(${JSON.stringify(ormBuilders.buildCommitOrm("critical_fixture", model, changes, columns))})`, "    outcome = {'ok': True}",
    "except Exception as error:", "    outcome = {'ok': False, 'error': str(error)}"];
}

for (const mode of ["socket", "orm"]) {
  test(`${mode} preserves JSON scalar types, quoted strings, containers, and large integers`, { skip: !HAS_DJANGO }, () => {
    for (const input of ['123', 'false', 'null', '"hello"', '"123"', '"false"', '9007199254740993', '{"ref":9007199254740993}', '[1,true,"x"]']) {
      const result = runBackend([...setup(), "class Document(models.Model):", '    """Stores every JSON shape for editing."""', "    data = models.JSONField(null=True, blank=True)", ...meta(),
        "with connections['default'].schema_editor() as schema: schema.create_model(Document)", "Document.objects.create(pk=1, data=12)",
        ...save(mode, "Document", { data: input }, [{ attname: "data", type: "JSONField", null: true }]),
        `expected = json.loads(${JSON.stringify(input)})`, "stored = Document.objects.get(pk=1).data",
        "print(json.dumps({'ok': outcome['ok'], 'equal': stored == expected, 'type': type(stored).__name__, 'expectedType': type(expected).__name__}))"]);
      assert.deepEqual(result, { ok: true, equal: true, type: result.expectedType, expectedType: result.expectedType }, input);
    }
  });

  test(`${mode} saves valid fixed-point decimals and rejects excess precision atomically`, { skip: !HAS_DJANGO }, () => {
    for (const [input, expected] of [["0.10", "0.10"], ["1.23", "1.23"], ["-999.99", "-999.99"], ["2.50", "2.50"], ["1.234", "9.99"]]) {
      const result = runBackend([...setup(), "class Price(models.Model):", '    """Stores an exact fixed-point amount."""', "    amount = models.DecimalField(max_digits=10, decimal_places=2)", ...meta(),
        "with connections['default'].schema_editor() as schema: schema.create_model(Price)", "Price.objects.create(pk=1, amount='9.99')",
        ...save(mode, "Price", { amount: input }, [{ attname: "amount", type: "DecimalField" }]),
        "print(json.dumps({'ok': outcome['ok'], 'amount': str(Price.objects.get(pk=1).amount)}))"]);
      assert.deepEqual(result, { ok: input !== "1.234", amount: expected });
    }
  });
}

test("all editable tabulation paths retain JSON scalar editor text and cheap array metadata", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(), "class Document(models.Model):", '    """Exposes typed JSON fields through every model result shape."""', "    data = models.JSONField(null=True, blank=True)", ...meta(),
    "with connections['default'].schema_editor() as schema: schema.create_model(Document)", "Document.objects.bulk_create([Document(pk=1, data='123'), Document(pk=2, data=9007199254740993), Document(pk=3, data=False), Document(pk=4, data=[9007199254740993])])",
    "queryset = Document.objects.order_by('pk')", "request = {'app': 'critical_fixture', 'model': 'Document'}",
    "pages = [mod._browse_rows({}, request), mod._browse_tabulate(queryset, 0, 50), mod._browse_tabulate(list(queryset), 0, 50), mod._pty_tabulate_result(queryset)]",
    "print(json.dumps({'pages': [[row['data'] for row in page['rows']] for page in pages], 'single': mod._browse_tabulate_single(queryset[0])['rows'][0]['data']}))"]);
  for (const page of result.pages) {
    assert.deepEqual(page.map((cell) => cell.edit), ['"123"', '9007199254740993', 'false', '[9007199254740993]']);
    assert.equal(page[3].kind, "array"); assert.equal(page[3].len, 1);
  }
  assert.equal(result.single.edit, '"123"');
});

test("explicit database survives rows, properties, count, aggregate, and Recipe execution", { skip: !HAS_DJANGO }, () => {
  const source = { app: "critical_fixture", model: "Record" };
  const columns = [{ attname: "id", name: "id", type: "AutoField", pk: true, editable: false, null: false }, { attname: "name", name: "name", type: "CharField", pk: false, editable: true, null: false }, { attname: "display", name: "display", type: "property", computed: true, editable: false, null: true }];
  const metadata = new ModelQueryMetadataIndex(); metadata.setCatalog([source]); metadata.addColumns(source, columns);
  metadata.addTree(source, { ok: true, pk: "id", fields: columns.filter((column) => !column.computed), relations: [] });
  const recipe = createEmptyModelQueryRecipe(source), context = { database: "archive", columns, limit: 50, metadata, relations: [], source, transport: "orm" };
  const rowCell = recipeOrm.buildRecipeRowsOrm(recipe, context), countCell = recipeOrm.buildRecipeCountOrm(recipe, context);
  assert.equal(rowCell.validation.ok, true); assert.equal(countCell.validation.ok, true);
  const fixture = [...setup(undefined, "{name: {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'} for name in ['default', 'archive']}"),
    "class Record(models.Model):", '    """Distinguishes database selection in data and property values."""', "    name = models.CharField(max_length=100)",
    "    @property", "    def display(self):", '        """Returns the actual instance database beside its value."""', "        return self._state.db + ':' + self.name", ...meta(),
    "for alias in ['default', 'archive']:", "    with connections[alias].schema_editor() as schema: schema.create_model(Record)", "    Record.objects.using(alias).create(pk=1, name=alias)",
    "Record.objects.using('archive').create(pk=2, name='archive second')", "request = {'app': 'critical_fixture', 'model': 'Record', 'database': 'archive'}", "namespace = {'Record': Record, 'models': models, 'apps': apps}"];
  const result = runBackend([...fixture,
    `recipe = json.loads(${JSON.stringify(JSON.stringify(recipe))})`, "rows = mod._browse_rows(namespace, request)", "recipe_rows = mod._browse_rows(namespace, dict(request, recipe=recipe))",
    "count_results = [mod._browse_count(request), mod._browse_count(dict(request, recipe=recipe))]", "counts = [result['count'] for result in count_results]",
    "properties = mod._browse_computed(namespace, dict(request, field='display'))",
    "aggregate = mod._browse_aggregate(dict(request, aggregates=[{'func': 'count', 'field': 'pk', 'alias': 'total'}]))",
    `orm_rows, _ = mod._browse_eval_last(namespace, ${JSON.stringify(buildRowsOrm({ ...source, database: "archive", columns, limit: 50 }))})`,
    `orm_count, _ = mod._browse_eval_last(namespace, ${JSON.stringify(ormBuilders.buildCountOrm(source.app, source.model, [], columns, [], "archive"))})`,
    `orm_properties, _ = mod._browse_eval_last(namespace, ${JSON.stringify(buildComputedOrm(source.app, source.model, "display", [], [], 50, columns, [], [], "archive"))})`,
    `orm_aggregate, _ = mod._browse_eval_last(namespace, ${JSON.stringify(ormBuilders.buildAggregateOrm({ ...source, database: "archive", columns, aggregates: [{ func: "count", field: "pk", alias: "total" }] }))})`,
    `recipe_orm_rows, _ = mod._browse_eval_last(namespace, ${JSON.stringify(rowCell.cell)})`, `recipe_orm_count, _ = mod._browse_eval_last(namespace, ${JSON.stringify(countCell.cell)})`,
    "audit_results = [rows, recipe_rows, aggregate] + count_results",
    "print(json.dumps({'rows': [row['name'] for row in rows['rows']], 'recipeRows': [row['name'] for row in recipe_rows['rows']], 'counts': counts, 'properties': properties['values'], 'aggregate': aggregate['rows'][0]['total'], 'ormRows': [row.name for row in orm_rows], 'ormCount': orm_count, 'ormProperties': orm_properties, 'ormAggregate': orm_aggregate, 'recipeOrmRows': [row.name for row in recipe_orm_rows], 'recipeOrmCount': recipe_orm_count, 'ormLogs': [result['orm'] for result in audit_results], 'sqlCounts': [len(result['sql']) for result in audit_results], 'propertyQueries': properties['queryCount']}))"]);
  assert.deepEqual(result.rows, ["archive", "archive second"]);
  for (const field of ["recipeRows", "ormRows", "recipeOrmRows"]) { assert.deepEqual(result[field], result.rows); }
  assert.deepEqual(result.counts, [2, 2]); assert.equal(result.ormCount, 2); assert.equal(result.recipeOrmCount, 2);
  assert.equal(result.properties["1"], "archive:archive"); assert.equal(result.ormProperties[0].value, "archive:archive");
  assert.equal(result.aggregate, 2); assert.equal(result.ormAggregate[0].total, 2);
  assert.ok(result.ormLogs.every((log) => log.includes(".using('archive')")));
  assert.ok(result.sqlCounts.every((count) => count > 0)); assert.equal(result.propertyQueries, 1);
});

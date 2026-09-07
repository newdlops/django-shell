// Exercises model properties through Recipe rows, lazy backend reads, and ORM/Terminal transport.

import assert from "node:assert/strict";
import test from "node:test";
import { BackendClient, HAS_DJANGO, runBackend } from "./modelBrowserHelpers.mjs";
import { createEmptyModelQueryRecipe } from "../out/modelQueryRecipe.js";
import { ModelQueryMetadataIndex } from "../out/modelQueryRecipeMetadata.js";
import { buildRecipeComputedOrm } from "../out/modelQueryRecipeOrm.js";
import { parseOrmComputedResponse } from "../out/modelBackend.js";

const SOURCE = { app: "property_fixture", model: "Record" };
const PROPERTY_NAMES = ["display_name", "django_cached", "python_cached", "declared_score", "broken", "zero", "flag", "blank", "missing"];
const COLUMNS = [
  { attname: "code", editable: false, name: "code", null: false, pk: true, type: "CharField" },
  { attname: "rank", editable: true, name: "rank", null: false, pk: false, type: "IntegerField" },
  ...PROPERTY_NAMES.map((name) => ({ annotated: name === "declared_score", attname: name, computed: true, editable: false, name, null: true, pk: false, type: "property" }))
];
const SETUP = [
  "import json, sys, types, functools",
  "from django.conf import settings",
  "app_module = types.ModuleType('property_fixture'); app_module.__file__ = '/tmp/property_fixture.py'; sys.modules['property_fixture'] = app_module",
  "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['property_fixture'])",
  "import django; django.setup()",
  "from django.db import connection, models",
  "from django.utils.functional import cached_property",
  "reads = []",
  "class PropertyMixin:",
  '    """Provides an inherited property with observable evaluations."""',
  "    @property",
  "    def display_name(self):",
  '        """Returns a label including a recipe annotation when available."""',
  "        reads.append(self.pk)",
  "        return self.pk + ':' + str(getattr(self, 'score', self.rank))",
  "class Record(PropertyMixin, models.Model):",
  '    """Represents bounded rows with ordinary and cached properties."""',
  "    code = models.CharField(primary_key=True, max_length=20)",
  "    rank = models.IntegerField()",
  "    class Meta:",
  '        """Registers the test model in the isolated application."""',
  "        app_label = 'property_fixture'",
  "    @cached_property",
  "    def django_cached(self):",
  '        """Returns a Django-cached display value."""',
  "        return 'django:' + self.pk",
  "    @functools.cached_property",
  "    def python_cached(self):",
  '        """Returns a Python-cached display value."""',
  "        return 'python:' + self.pk",
  "    @property",
  "    def broken(self):",
  '        """Models a property that cannot be evaluated for a row."""',
  "        raise ValueError('unavailable')",
  "    declared_score = property(lambda self: self.broken)",
  "    zero = property(lambda self: 0)",
  "    flag = property(lambda self: False)",
  "    blank = property(lambda self: '')",
  "    missing = property(lambda self: None)",
  "    djshell_annotations = {'declared_score': models.F('rank') * 10}",
  "with connection.schema_editor() as editor: editor.create_model(Record)",
  "Record.objects.bulk_create([Record(code=code, rank=rank) for rank, code in enumerate(['007', '008', '009', '010'])])"
];

/** Creates a recipe whose selected rows depend on WHERE, an annotation, result filtering, and descending order. */
function recipe() {
  const value = createEmptyModelQueryRecipe(SOURCE);
  value.where.children.push({ kind: "comparison", lhs: { kind: "field", path: "rank" }, lookup: "gte", negated: false, nodeId: "rank-filter", rhs: { kind: "literal", value: 1 } });
  value.computed.push({ alias: "score", enabled: true, expression: { kind: "binary", left: { kind: "field", path: "rank" }, operator: "*", right: { kind: "literal", value: 2 } }, kind: "formula", nodeId: "score-expression", outputType: "integer" });
  value.postFilter.children.push({ kind: "comparison", lhs: { alias: "score", kind: "computed" }, lookup: "gte", negated: false, nodeId: "score-filter", rhs: { kind: "literal", value: 4 } });
  value.orderBy.push({ direction: "desc", nodeId: "score-order", ref: { alias: "score", kind: "computed" } });
  return value;
}

/** Builds trusted compiler metadata for the isolated Django model. */
function context(limit = 1) {
  const metadata = new ModelQueryMetadataIndex();
  metadata.setCatalog([SOURCE]);
  metadata.addTree(SOURCE, { fields: COLUMNS.filter((column) => !column.computed), ok: true, pk: "code", relations: [] });
  metadata.addColumns(SOURCE, COLUMNS);
  return { columns: COLUMNS, limit, metadata, relations: [], source: SOURCE, transport: "orm" };
}

/** Converts a JavaScript fixture into a JSON-loaded Python expression. */
function pythonJson(value) { return `json.loads(${JSON.stringify(JSON.stringify(value))})`; }

test("Recipe rows keep inherited and cached property columns without evaluating getters", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...SETUP,
    `request = ${pythonJson({ ...SOURCE, limit: 1, recipe: recipe() })}`,
    "rows = mod._browse_rows({}, request)",
    "print(json.dumps({'rows': rows, 'reads': reads}))"
  ]);
  assert.equal(result.rows.ok, true, JSON.stringify(result.rows));
  assert.deepEqual(result.rows.rows, [{ code: "010", rank: 3, score: 6 }]);
  assert.deepEqual(result.rows.columns.filter((column) => column.computed).map((column) => column.attname).sort(), [...PROPERTY_NAMES].sort());
  assert.ok(result.rows.columns.filter((column) => column.computed).every((column) => column.editable === false));
  assert.deepEqual(result.reads, [], "schema and rows must never eagerly evaluate properties");
});

test("Recipe property reads match the displayed page and preserve cached, annotated, and falsy values", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...SETUP,
    `request = ${pythonJson({ ...SOURCE, filters: [{ field: "code", lookup: "exact", value: "007" }], limit: 1, recipe: recipe() })}`,
    `values = {field: mod._browse_computed({}, dict(request, field=field)) for field in ${pythonJson(PROPERTY_NAMES)}}`,
    "print(json.dumps({'values': values, 'reads': reads}))"
  ]);
  const expected = { display_name: "010:6", django_cached: "django:010", python_cached: "python:010", declared_score: 30, broken: null, zero: 0, flag: false, blank: "", missing: null };
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(result.values[field].ok, true, JSON.stringify(result.values[field]));
    assert.deepEqual(result.values[field].values, { "010": value }, field);
    assert.equal(result.values[field].rowCount, 1);
  }
  assert.equal(result.values.declared_score.annotated, true);
  assert.equal(result.values.declared_score.queryCount, 1);
  assert.deepEqual(result.reads, ["010"], "no lookahead row or legacy-filter match is evaluated");
});

test("property endpoints reject invalid recipes, summary mode, and non-property access before querying", { skip: !HAS_DJANGO }, () => {
  const invalid = [
    ...["code", "save", "__class__", "unknown", "pk"].map((field) => ({ ...SOURCE, field, recipe: recipe() })),
    { ...SOURCE, field: "display_name", recipe: { ...createEmptyModelQueryRecipe(SOURCE), mode: "summary" } },
    { ...SOURCE, field: "display_name", recipe: { ...recipe(), source: { app: "other", model: "Record" } } },
    { ...SOURCE, field: "display_name", recipe: [] }
  ];
  const result = runBackend([...SETUP,
    "from django.test.utils import CaptureQueriesContext",
    "with CaptureQueriesContext(connection) as captured:",
    `    results = [mod._browse_computed({}, request) for request in ${pythonJson(invalid)}]`,
    "print(json.dumps({'results': results, 'queries': len(captured), 'reads': reads}))"
  ]);
  assert.equal(result.queries, 0);
  assert.deepEqual(result.reads, []);
  for (const response of result.results) {
    assert.equal(response.ok, false);
    assert.ok(response.error);
    assert.deepEqual(response.values, {});
  }
});

test("compiled ORM property reads execute the same bounded recipe for every property type", { skip: !HAS_DJANGO }, () => {
  const cells = Object.fromEntries(PROPERTY_NAMES.map((field) => {
    const compiled = buildRecipeComputedOrm(recipe(), field, context());
    assert.equal(compiled.validation.ok, true, JSON.stringify(compiled.validation));
    return [field, compiled.cell];
  }));
  const result = runBackend([...SETUP,
    `cells = ${pythonJson(cells)}`,
    "results = {field: mod._browse_query(globals(), {'code': code, 'limit': 1}) for field, code in cells.items()}",
    "print(json.dumps({'results': results, 'reads': reads}))"
  ]);
  const expected = { display_name: "010:6", django_cached: "django:010", python_cached: "python:010", declared_score: 30, broken: null, zero: 0, flag: false, blank: "", missing: null };
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(result.results[field].ok, true, JSON.stringify(result.results[field]));
    const parsed = parseOrmComputedResponse(JSON.stringify({ grid: result.results[field], ok: true }));
    assert.deepEqual(parsed.values, { "010": value }, field);
  }
  assert.deepEqual(result.reads, ["010"]);
});

test("ORM and Terminal clients route Recipe property loads through validated cells and reject broad fallbacks", async () => {
  for (const mode of ["orm", "pty"]) {
    const calls = [];
    const client = new BackendClient({ host: "127.0.0.1", port: 9, token: "fixture" }, undefined, async (payload) => {
      calls.push(payload);
      return JSON.stringify({ grid: { rows: [{ pk: "010", value: "010:6" }] }, ok: true });
    });
    client.setTransportMode(mode);
    const query = { ...SOURCE, columns: COLUMNS, field: "display_name", limit: 1, recipe: recipe(), recipeMetadata: context().metadata.toBundle() };
    const result = await client.modelComputed(query);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.values, { "010": "010:6" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "ormcell");
    assert.equal(calls[0].code, buildRecipeComputedOrm(recipe(), "display_name", context()).cell);
    for (const changes of [{ field: "save" }, { recipe: { ...recipe(), source: { app: "other", model: "Record" } } }, { recipeMetadata: { catalog: [], models: {} } }]) {
      const rejected = await client.modelComputed({ ...query, ...changes });
      assert.equal(rejected.ok, false);
      assert.ok(rejected.error);
    }
    assert.equal(calls.length, 1, "invalid property reads never become a legacy broad query");
  }
});

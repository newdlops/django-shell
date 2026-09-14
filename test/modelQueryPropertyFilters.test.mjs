// Verifies property filtering through real Django execution, pagination, count, and both Recipe transports.
import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyModelQueryRecipe } from "../out/modelQueryRecipe.js";
import { ModelQueryMetadataIndex } from "../out/modelQueryRecipeMetadata.js";
import { buildRecipeRowsOrm, buildRecipeComputedOrm, buildRecipeCountOrm } from "../out/modelQueryRecipeOrm.js";
import { validateModelQueryRecipe } from "../out/modelQueryRecipeValidation.js";
import { MODEL_QUERY_PROPERTY_LOOKUPS } from "../out/modelQueryPropertyFilter.js";
import { lookupsForField, rhsKindsFor } from "../media/gridPredicateValue.js";
import { resolveFieldExplorer } from "../media/gridFieldExplorerOptions.js";
import { propertyValueType } from "../media/gridPropertyPredicateValue.js";
import { HAS_DJANGO, runBackend } from "./modelBrowserHelpers.mjs";

const SOURCE = { app: "property_filters", model: "Record" };
const COLUMNS = [
  { name: "code", attname: "code", type: "CharField", pk: true, null: false, editable: false },
  { name: "rank", attname: "rank", type: "IntegerField", pk: false, null: false, editable: false },
  ...["label", "odd", "doubled", "declared", "broken", "missing", "blank", "amount"].map((name) => ({ name, attname: name, type: "property", computed: true, annotated: name === "declared", pk: false, null: true, editable: false }))
];
const SETUP = [
  "import ast, json, sys, types",
  "from decimal import Decimal",
  "from django.conf import settings",
  "app = types.ModuleType('property_filters'); app.__file__ = '/tmp/property_filters.py'; sys.modules['property_filters'] = app",
  "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['property_filters'])",
  "import django; django.setup()",
  "from django.db import models, connection",
  "from django.utils.functional import cached_property",
  "reads = []",
  "class Record(models.Model):",
  '    """Provides root properties with observable reads and a SQL-backed property."""',
  "    code = models.CharField(primary_key=True, max_length=10)",
  "    rank = models.IntegerField()",
  "    class Meta:",
  '        """Registers the isolated fixture."""',
  "        app_label = 'property_filters'",
  "    @cached_property",
  "    def odd(self):",
  '        """Records the candidate rows evaluated by the filter."""',
  "        reads.append(self.pk)",
  "        return self.rank % 2 == 1",
  "    @property",
  "    def broken(self):",
  '        """Raises to test fail-closed filtering, including negated conditions."""',
  "        raise ValueError('unavailable')",
  "    label = property(lambda self: 'Row:' + self.code)",
  "    doubled = property(lambda self: self.rank * 2)",
  "    amount = property(lambda self: Decimal(self.rank) / 10)",
  "    declared = property(lambda self: self.broken)",
  "    missing = property(lambda self: None)",
  "    blank = property(lambda self: '')",
  "    djshell_annotations = {'declared': models.F('rank') * 10}",
  "with connection.schema_editor() as editor: editor.create_model(Record)",
  "Record.objects.bulk_create([Record(code=str(rank).zfill(2), rank=rank) for rank in range(8)])",
  "def evaluate_cell(code):",
  '    """Executes a generated ORM cell with the same statement/final-expression contract as IPython."""',
  "    tree = ast.parse(code)",
  "    exec(compile(ast.Module(body=tree.body[:-1], type_ignores=[]), '<fixture>', 'exec'), globals())",
  "    return eval(compile(ast.Expression(tree.body[-1].value), '<fixture>', 'eval'), globals())"
];

/** Constructs trusted root metadata with properties separate from concrete field trees. */
function context(extra = {}) {
  const metadata = new ModelQueryMetadataIndex();
  metadata.setCatalog([SOURCE]);
  metadata.addTree(SOURCE, { ok: true, fields: COLUMNS.filter((item) => !item.computed), relations: [], pk: "code" });
  metadata.addColumns(SOURCE, COLUMNS);
  return { columns: COLUMNS, metadata, source: SOURCE, transport: "orm", limit: 1, relations: [], ...extra };
}

/** Builds one typed property or concrete-field condition without guessing scalar types. */
function comparison(path, lookup, value, nodeId = "condition", negated = false) {
  return { kind: "comparison", lhs: { kind: "field", path }, lookup, negated, nodeId, rhs: lookup === "in" ? { kind: "list", values: value } : lookup === "range" ? { kind: "range", lower: value[0], upper: value[1] } : { kind: "literal", value } };
}

/** Makes a root AND recipe from independent typed comparisons. */
function recipe(...conditions) { const result = createEmptyModelQueryRecipe(SOURCE); result.where.children = conditions; return result; }

/** Serializes one JSON fixture into a Python expression without executable interpolation. */
function py(value) { return `json.loads(${JSON.stringify(JSON.stringify(value))})`; }

/** Requires successful compilation before executing the generated cell. */
function cell(result) { assert.equal(result.validation.ok, true, JSON.stringify(result.validation.issues)); return result.cell; }

test("property selection and pasted lookups use root metadata and the same scalar lookup contract as execution", async () => {
  const properties = COLUMNS.filter((item) => item.computed);
  const loadTree = async () => ({ fields: COLUMNS.filter((item) => !item.computed), relations: [{ name: "parent", target: "property_filters.Record" }] });
  const listed = await resolveFieldExplorer({ source: SOURCE, properties, loadTree });
  assert.deepEqual(listed.items.filter((item) => item.group === "Model properties").map((item) => item.path), properties.map((item) => item.name));
  assert.equal((await resolveFieldExplorer({ source: SOURCE, properties, loadTree, query: "label__icontains" })).items[0].lookup, "icontains");
  assert.equal((await resolveFieldExplorer({ source: SOURCE, properties, loadTree, query: "parent__label__exact" })).items.length, 0);
  assert.deepEqual(lookupsForField({ type: "property" }), MODEL_QUERY_PROPERTY_LOOKUPS);
  assert.deepEqual(rhsKindsFor({ field: { type: "property" }, lookup: "exact" }), ["literal"]);
  assert.equal(propertyValueType({ kind: "literal", value: "001" }, "gt", "number"), "text", "saved and restored JSON values take precedence over an old editor type");
  assert.equal(propertyValueType({ kind: "literal", value: false }, "exact", "number"), "boolean");
  assert.equal(propertyValueType({ kind: "list", values: [] }, "in", "boolean"), "boolean", "empty lists retain the user's selected type");
});

test("property filters preserve cursor and ordered offset pages, accurate count, and lazy property values", { skip: !HAS_DJANGO }, () => {
  const query = recipe(comparison("rank", "gte", 1, "db"), comparison("odd", "exact", true, "property"));
  const ordered = { ...query, orderBy: [{ nodeId: "order", direction: "desc", ref: { kind: "field", path: "rank" } }] };
  const cells = {
    first: cell(buildRecipeRowsOrm(query, context())), next: cell(buildRecipeRowsOrm(query, context({ cursor: "01" }))),
    offset: cell(buildRecipeRowsOrm(ordered, context({ offset: 1 }))), count: cell(buildRecipeCountOrm(query, context())),
    values: cell(buildRecipeComputedOrm(query, "doubled", context({ limit: 3 }))), sqlValues: cell(buildRecipeComputedOrm(query, "declared", context({ limit: 3 })))
  };
  const result = runBackend([...SETUP,
    `request = {**${py(SOURCE)}, 'recipe': ${py(query)}, 'limit': 1}`,
    "first = mod._browse_recipe_rows({}, request)",
    "next_page = mod._browse_recipe_rows({}, {**request, 'cursor': first.get('nextCursor')})",
    `offset = mod._browse_recipe_rows({}, {**request, 'recipe': ${py(ordered)}, 'offset': 1})`,
    "count = mod._browse_recipe_count(request)",
    "values = mod._browse_recipe_computed({}, {**request, 'field': 'doubled', 'limit': 3})",
    "sql_values = mod._browse_recipe_computed({}, {**request, 'field': 'declared', 'limit': 3})",
    `cells = ${py(cells)}`,
    "orm = {key: evaluate_cell(code) for key, code in cells.items()}",
    "for key in ('first', 'next', 'offset'): orm[key] = [obj.pk for obj in orm[key]]",
    "print(json.dumps({'first': first, 'next': next_page, 'offset': offset, 'count': count, 'values': values, 'sqlValues': sql_values, 'orm': orm}))"
  ]);
  for (const key of ["first", "next", "offset", "count", "values", "sqlValues"]) { assert.equal(result[key].ok, true, JSON.stringify(result[key])); }
  assert.deepEqual(result.first.rows.map((row) => row.code), ["01"]);
  assert.equal(result.first.nextCursor, "01"); assert.equal(result.first.hasMore, true);
  assert.deepEqual(result.next.rows.map((row) => row.code), ["03"]);
  assert.deepEqual(result.offset.rows.map((row) => row.code), ["05"]); assert.equal(result.offset.nextOffset, 2);
  assert.equal(result.count.count, 4);
  assert.deepEqual(result.values.values, { "01": 2, "03": 6, "05": 10 });
  assert.deepEqual(result.sqlValues.values, { "01": 10, "03": 30, "05": 50 });
  assert.deepEqual(result.orm, { first: ["01", "03"], next: ["03", "05"], offset: ["05", "03"], count: 4, values: [{ pk: "01", value: 2 }, { pk: "03", value: 6 }, { pk: "05", value: 10 }], sqlValues: [{ pk: "01", __djs: 10 }, { pk: "03", __djs: 30 }, { pk: "05", __djs: 50 }] });
});

test("typed property comparisons and declared SQL annotations agree across both execution paths", { skip: !HAS_DJANGO }, () => {
  const cases = [
    [comparison("label", "icontains", "row:05"), ["05"]], [comparison("label", "iexact", "ROW:03"), ["03"]],
    [comparison("doubled", "gte", 12), ["06", "07"]], [comparison("doubled", "range", [6, 10]), ["03", "04", "05"]],
    [comparison("doubled", "in", [2, 10]), ["01", "05"]], [comparison("doubled", "exact", "2"), []],
    [comparison("odd", "exact", false), ["00", "02", "04", "06"]], [comparison("odd", "exact", "false"), []],
    [comparison("missing", "isnull", true), Array.from({ length: 8 }, (_, index) => `0${index}`)],
    [comparison("missing", "exact", null), Array.from({ length: 8 }, (_, index) => `0${index}`)],
    [comparison("blank", "blank", null), Array.from({ length: 8 }, (_, index) => `0${index}`)], [comparison("blank", "not_blank", null), []],
    [comparison("broken", "isnull", true), []], [comparison("broken", "exact", 0, "condition", true), []],
    [comparison("doubled", "gte", "wrong type", "condition", true), []], [comparison("declared", "gte", 60), ["06", "07"]],
    [comparison("amount", "exact", 0.3), ["03"]], [comparison("amount", "gte", 0.3), ["03", "04", "05", "06", "07"]],
    [comparison("amount", "range", [0.2, 0.4]), ["02", "03", "04"]], [comparison("amount", "in", [0.1, 0.4]), ["01", "04"]]
  ];
  const requests = cases.map(([condition]) => ({ ...SOURCE, recipe: recipe(condition), limit: 30 }));
  const cells = requests.map((request) => cell(buildRecipeRowsOrm(request.recipe, context({ limit: 30 }))));
  const result = runBackend([...SETUP,
    `requests, cells = ${py(requests)}, ${py(cells)}`,
    "backend = [mod._browse_recipe_rows({}, request) for request in requests]",
    "orm = [[obj.pk for obj in evaluate_cell(code)] for code in cells]",
    "print(json.dumps({'backend': backend, 'orm': orm}))"
  ]);
  cases.forEach(([, expected], index) => { assert.equal(result.backend[index].ok, true, JSON.stringify(result.backend[index])); assert.deepEqual(result.backend[index].rows.map((row) => row.code), expected, `backend ${index}`); assert.deepEqual(result.orm[index], expected, `ORM ${index}`); });
  assert.equal(result.backend[cases.findIndex(([item]) => item.lhs.path === "declared")].issues.length, 0, "SQL-backed properties do not claim to scan Python values");
});

test("unsupported property contexts fail before executing SQL or evaluating getters", { skip: !HAS_DJANGO }, () => {
  const basic = recipe(comparison("odd", "exact", true));
  const invalid = [
    { ...basic, where: { ...basic.where, join: "or" } }, { ...basic, where: { ...basic.where, negated: true } },
    recipe({ ...basic.where, nodeId: "nested" }), { ...basic, mode: "summary" },
    { ...createEmptyModelQueryRecipe(SOURCE), postFilter: { ...basic.where, nodeId: "post-root" } },
    recipe({ ...basic.where.children[0], rhs: { kind: "field", path: "rank" } }), recipe(comparison("odd", "year", 2026)),
    { ...basic, orderBy: [{ nodeId: "order", direction: "asc", ref: { kind: "field", path: "odd" } }] },
    recipe(comparison("save", "exact", true)), recipe(comparison("__class__", "exact", true)),
    { ...basic, computed: [{ kind: "window", nodeId: "rank-window", alias: "row_rank", enabled: true, function: "row_number", partitionBy: [], orderBy: [{ nodeId: "window-order", direction: "asc", ref: { kind: "field", path: "rank" } }] }] }
  ];
  for (const query of invalid) { assert.equal(validateModelQueryRecipe(query, context()).ok, false, JSON.stringify(query)); assert.equal(buildRecipeRowsOrm(query, context()).cell, ""); }
  const result = runBackend([...SETUP,
    "from django.test.utils import CaptureQueriesContext",
    `requests = [{**${py(SOURCE)}, 'recipe': query} for query in ${py(invalid)}]`,
    "with CaptureQueriesContext(connection) as captured:",
    "    responses = [mod._browse_recipe_rows({}, request) for request in requests]",
    "print(json.dumps({'responses': responses, 'reads': reads, 'queries': len(captured)}))"
  ]);
  assert.equal(result.queries, 0); assert.deepEqual(result.reads, []);
  for (const response of result.responses) { assert.equal(response.ok, false, JSON.stringify(response)); assert.deepEqual(response.rows, []); }
});

test("ORM grids preserve model schema for empty matches and never duplicate cached properties as annotations", { skip: !HAS_DJANGO }, () => {
  const query = recipe(comparison("rank", "gte", 5, "db"), comparison("odd", "exact", true, "property"));
  query.computed.push({ alias: "score", enabled: true, kind: "formula", nodeId: "score", expression: { kind: "binary", left: { kind: "field", path: "rank" }, operator: "*", right: { kind: "literal", value: 3 } }, outputType: "integer" });
  const empty = recipe(comparison("label", "exact", "no-match"));
  const cells = [cell(buildRecipeRowsOrm(query, context())), cell(buildRecipeRowsOrm(empty, context()))];
  const result = runBackend([...SETUP,
    `grids = [mod._pty_tabulate_result(evaluate_cell(code)) for code in ${py(cells)}]`,
    "print(json.dumps({'grids': grids, 'reads': reads}))"
  ]);
  assert.deepEqual(result.reads, ["05", "06", "07"], "DB predicates narrow candidates before bounded property lookahead");
  for (const grid of result.grids) {
    assert.equal(grid.pk, "code"); assert.equal(grid.model, "Record");
    assert.equal(grid.columns.filter((column) => column.attname === "odd").length, 1);
    assert.equal(grid.columns.find((column) => column.attname === "odd").computed, true);
    assert.equal(grid.columns.some((column) => column.attname.startsWith("__djs")), false);
  }
  assert.deepEqual(result.grids[0].rows.map((row) => [row.code, row.score]), [["05", 15], ["07", 21]]);
  assert.deepEqual(result.grids[1].rows, []);
});

// Exercises backend Recipe v2 atomic validation before any live-model query can be evaluated.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import test from "node:test";
import { backendPythonDirectory } from "./backendComposedSourceHelper.mjs";
import { HAS_DJANGO, runBackend } from "./modelBrowserHelpers.mjs";

const backend = path.join(backendPythonDirectory(), "django_shell_backend.py");

/** Validates one request in an isolated backend process without requiring a Django project. */
function validate(request) {
  const script = `import importlib.util,json; s=importlib.util.spec_from_file_location('b',${JSON.stringify(backend)}); b=importlib.util.module_from_spec(s); s.loader.exec_module(b); print(json.dumps(b._browse_recipe_validate(json.loads(${JSON.stringify(JSON.stringify(request))}))[\"issues\"]))`;
  const result = childProcess.spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("malformed Recipe payload returns an issue before source-model access", () => {
  const issues = validate({ app: "db", model: "Company", recipe: [] });
  assert.equal(issues[0].code, "RECIPE_SHAPE_INVALID");
});

test("source mismatch cannot become an unfiltered broad query", () => {
  const issues = validate({ app: "db", model: "Company", recipe: { version: 2, source: { app: "other", model: "Else" } } });
  assert.equal(issues[0].code, "RECIPE_SOURCE_MISMATCH");
});

/** Projects raw FK/O2O attnames as the target scalar type used by filter metadata and correlation checks. */
test("filter metadata preserves raw relation paths while exposing their real target scalar types", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json, uuid",
    "import sys, types",
    "from django.conf import settings",
    "app_module = types.ModuleType('metadata_projection'); app_module.__file__ = '/tmp/metadata_projection.py'; sys.modules['metadata_projection'] = app_module",
    "settings.configure(DEBUG=False, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['metadata_projection'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.db import models",
    "class Company(models.Model):",
    "    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)",
    "    class Meta: app_label = 'metadata_projection'",
    "class ValuationHistory(models.Model):",
    "    company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name='valuation_history_set', related_query_name='valuation_history')",
    "    class Meta: app_label = 'metadata_projection'",
    "class CompanyProfile(models.Model):",
    "    company = models.OneToOneField(Company, on_delete=models.CASCADE)",
    "    class Meta: app_label = 'metadata_projection'",
    "valuation_column = next(column for column in mod._browse_columns(ValuationHistory) if column['attname'] == 'company_id')",
    "profile_column = next(column for column in mod._browse_columns(CompanyProfile) if column['attname'] == 'company_id')",
    "target_tree = mod._browse_filter_field_tree(ValuationHistory)",
    "outer_tree = mod._browse_filter_field_tree(Company)",
    "target_leaf = next(field for field in target_tree['fields'] if field['attname'] == 'company_id')",
    "reverse = next(relation for relation in outer_tree['relations'] if relation['name'] == 'valuation_history')",
    "print(json.dumps({'profile': profile_column, 'reverse': reverse, 'target': target_leaf, 'valuation': valuation_column}))"
  ]);

  for (const column of [payload.valuation, payload.profile]) {
    assert.equal(column.attname, "company_id");
    assert.equal(column.name, "company");
    assert.equal(column.type, "UUIDField");
    assert.equal(column.relation.target, "metadata_projection.Company");
  }
  assert.equal(payload.target.type, "UUIDField");
  assert.deepEqual({ filterField: payload.reverse.filterField, outerField: payload.reverse.outerField, target: payload.reverse.target }, { filterField: "company_id", outerField: "pk", target: "metadata_projection.ValuationHistory" });
});

test("rows endpoint executes nested v2 Q without falling back to legacy filters", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User",
    "User.objects.create(username='alpha', password='x', is_staff=False)",
    "User.objects.create(username='beta', password='x', is_staff=True)",
    "recipe = {'version': 2, 'source': {'app': 'auth', 'model': 'User'}, 'mode': 'rows', 'where': {'kind': 'group', 'nodeId': 'where-root', 'join': 'and', 'negated': False, 'children': [{'kind': 'comparison', 'nodeId': 'staff', 'lhs': {'kind': 'field', 'path': 'is_staff'}, 'lookup': 'exact', 'negated': False, 'rhs': {'kind': 'literal', 'value': False}}, {'kind': 'group', 'nodeId': 'names', 'join': 'or', 'negated': False, 'children': [{'kind': 'comparison', 'nodeId': 'alpha', 'lhs': {'kind': 'field', 'path': 'username'}, 'lookup': 'exact', 'negated': False, 'rhs': {'kind': 'literal', 'value': 'alpha'}}, {'kind': 'comparison', 'nodeId': 'missing', 'lhs': {'kind': 'field', 'path': 'username'}, 'lookup': 'exact', 'negated': False, 'rhs': {'kind': 'literal', 'value': 'missing'}}]}]}, 'computed': [], 'postFilter': {'kind': 'group', 'nodeId': 'post-root', 'join': 'and', 'negated': False, 'children': []}, 'groupBy': [], 'orderBy': []}",
    "response = mod._run_request({}, 't', {'token': 't', 'kind': 'rows', 'app': 'auth', 'model': 'User', 'recipe': recipe, 'filters': [{'field': 'username', 'lookup': 'exact', 'value': 'beta'}]}, set())",
    "print(json.dumps({'ok': response['ok'], 'issues': response.get('issues'), 'recipeVersion': response.get('recipeVersion'), 'rows': [row['username'] for row in response.get('rows', [])]}))"
  ]);

  assert.equal(payload.ok, true);
  assert.equal(payload.recipeVersion, 2);
  assert.deepEqual(payload.rows, ["alpha"]);
  assert.deepEqual(payload.issues, []);
});

test("summary and count reproduce the complete v2 aggregate recipe", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User",
    "User.objects.create(username='alpha', password='x', is_staff=False)",
    "User.objects.create(username='beta', password='x', is_staff=True)",
    "recipe = {'version': 2, 'source': {'app': 'auth', 'model': 'User'}, 'mode': 'summary', 'where': {'kind': 'group', 'nodeId': 'where-root', 'join': 'and', 'negated': False, 'children': []}, 'computed': [{'kind': 'aggregate', 'nodeId': 'total-node', 'alias': 'total', 'enabled': True, 'function': 'count', 'field': {'kind': 'all'}, 'distinct': 'auto', 'filter': {'kind': 'group', 'nodeId': 'aggregate-filter', 'join': 'and', 'negated': False, 'children': []}}], 'postFilter': {'kind': 'group', 'nodeId': 'post-root', 'join': 'and', 'negated': False, 'children': []}, 'groupBy': [], 'orderBy': []}",
    "summary = mod._run_request({}, 't', {'token': 't', 'kind': 'aggregate', 'app': 'auth', 'model': 'User', 'recipe': recipe}, set())",
    "count = mod._run_request({}, 't', {'token': 't', 'kind': 'count', 'app': 'auth', 'model': 'User', 'recipe': recipe}, set())",
    "print(json.dumps({'summary': summary, 'count': count}))"
  ]);

  assert.equal(payload.summary.ok, true);
  assert.equal(payload.summary.recipeVersion, 2);
  assert.equal(payload.summary.rows[0].total, 2);
  assert.equal(payload.count.ok, true);
  assert.equal(payload.count.count, 1, "global summary always reports one result row");
});

test("scalar model subquery uses mandatory correlation outside its inner WHERE", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import Group, User",
    "Group.objects.create(name='alpha')",
    "User.objects.create(username='alpha', password='x')",
    "User.objects.create(username='beta', password='x')",
    "recipe = {'version': 2, 'source': {'app': 'auth', 'model': 'User'}, 'mode': 'rows', 'where': {'kind': 'group', 'nodeId': 'where-root', 'join': 'and', 'negated': False, 'children': []}, 'computed': [{'kind': 'scalarSubquery', 'nodeId': 'subquery-node', 'alias': 'group_name', 'enabled': True, 'source': {'kind': 'model', 'target': {'app': 'auth', 'model': 'Group'}}, 'correlations': [{'nodeId': 'subquery-correlation', 'targetPath': 'name', 'outerPath': 'username'}], 'where': {'kind': 'group', 'nodeId': 'inner-where', 'join': 'and', 'negated': False, 'children': []}, 'select': {'kind': 'field', 'field': {'kind': 'field', 'path': 'name'}}, 'orderBy': [], 'onEmpty': {'kind': 'literal', 'value': None}, 'outputType': 'text'}], 'postFilter': {'kind': 'group', 'nodeId': 'post-root', 'join': 'and', 'negated': False, 'children': []}, 'groupBy': [], 'orderBy': []}",
    "response = mod._run_request({}, 't', {'token': 't', 'kind': 'rows', 'app': 'auth', 'model': 'User', 'recipe': recipe}, set())",
    "print(json.dumps({'ok': response['ok'], 'issues': response.get('issues'), 'rows': {row['username']: row['group_name'] for row in response.get('rows', [])}}))"
  ]);

  assert.equal(payload.ok, true);
  assert.deepEqual(payload.rows, { alpha: "alpha", beta: null });
  assert.ok(payload.issues.some((issue) => issue.code === "SUBQUERY_IMPLICIT_ORDER" && issue.severity === "warning"));
});

/** Executes a reverse relation scalar subquery with its metadata-derived correlation and explicit inner order. */
test("scalar relation subquery resolves query identity and correlates each outer row", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json, sys, types",
    "from django.conf import settings",
    "app_module = types.ModuleType('relation_recipe'); app_module.__file__ = '/tmp/relation_recipe.py'; sys.modules['relation_recipe'] = app_module",
    "settings.configure(DEBUG=False, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['relation_recipe'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.db import connection, models",
    "class Company(models.Model):",
    "    class Meta: app_label = 'relation_recipe'",
    "class ValuationHistory(models.Model):",
    "    company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name='valuation_history_set', related_query_name='valuation_history')",
    "    rank = models.IntegerField()",
    "    class Meta: app_label = 'relation_recipe'",
    "with connection.schema_editor() as schema_editor: schema_editor.create_model(Company); schema_editor.create_model(ValuationHistory)",
    "first = Company.objects.create(); second = Company.objects.create()",
    "ValuationHistory.objects.bulk_create([ValuationHistory(company=first, rank=1), ValuationHistory(company=first, rank=2), ValuationHistory(company=second, rank=3)])",
    "mod._browse_resolve_model = lambda request: Company",
    "recipe = {'version': 2, 'source': {'app': 'relation_recipe', 'model': 'Company'}, 'mode': 'rows', 'where': {'kind': 'group', 'nodeId': 'where-root', 'join': 'and', 'negated': False, 'children': []}, 'computed': [{'kind': 'scalarSubquery', 'nodeId': 'latest-node', 'alias': 'latest_rank', 'enabled': True, 'source': {'kind': 'relation', 'relation': 'valuation_history'}, 'correlations': [], 'where': {'kind': 'group', 'nodeId': 'latest-where', 'join': 'and', 'negated': False, 'children': []}, 'select': {'kind': 'field', 'field': {'kind': 'field', 'path': 'rank'}}, 'orderBy': [{'nodeId': 'latest-order', 'ref': {'kind': 'field', 'path': 'rank'}, 'direction': 'desc'}], 'onEmpty': {'kind': 'literal', 'value': None}, 'outputType': 'auto'}], 'postFilter': {'kind': 'group', 'nodeId': 'post-root', 'join': 'and', 'negated': False, 'children': []}, 'groupBy': [], 'orderBy': []}",
    "response = mod._run_request({}, 't', {'token': 't', 'kind': 'rows', 'app': 'relation_recipe', 'model': 'Company', 'recipe': recipe}, set())",
    "print(json.dumps({'issues': response.get('issues'), 'ok': response['ok'], 'rows': {row['id']: row['latest_rank'] for row in response.get('rows', [])}}))"
  ]);

  assert.equal(payload.ok, true);
  assert.deepEqual(payload.rows, { 1: 2, 2: 3 });
  assert.ok(!payload.issues.some((issue) => issue.code === "SUBQUERY_IMPLICIT_ORDER"));
});

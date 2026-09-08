// Exercises alternate foreign keys, exact JSON edits, date uniqueness, and query projection fidelity with real Django.
import assert from "node:assert/strict";
import test from "node:test";
import { HAS_DJANGO, runBackend, ormBuilders } from "./modelBrowserHelpers.mjs";
import { setup } from "./criticalBackendFixtures.mjs";
import { parseJsonExact, stringifyJsonExact } from "../media/gridJson.js";

/** Defines temporary Django model metadata without touching an installed project or database. */
function meta() { return ["    class Meta:", '        """Registers an isolated regression model."""', "        app_label = 'critical_fixture'"]; }

/** Executes the actual selected save transport and exposes failure without masking database state. */
function save(mode, model, changes, columns, database) {
  const request = JSON.stringify({ app: "critical_fixture", model, changes, ...(database ? { database } : {}) });
  return mode === "socket" ? [`outcome = mod._browse_commit(json.loads(${JSON.stringify(request)}))`] : ["try:",
    `    exec(${JSON.stringify(ormBuilders.buildCommitOrm("critical_fixture", model, changes, columns, database))})`, "    outcome = {'ok': True}",
    "except Exception as error:", "    outcome = {'ok': False, 'error': str(error)}"];
}

for (const [fieldType, codes] of [["IntegerField", [2, 1]], ["CharField", ["alpha-key", "beta-key"]], ["CharField", ["1", "001"]], ["BigIntegerField", ["9007199254740992", "9007199254740993"]]]) {
  for (const relationType of ["ForeignKey", "OneToOneField"]) {
    test(`${relationType} to ${fieldType} (${codes[1]}) preserves relation keys in reads, lookups, saves, and database selection`, { skip: !HAS_DJANGO }, () => {
      const fixture = [...setup(undefined, "{name: {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'} for name in ['default', 'archive']}"),
        "class Company(models.Model):", '    """Stores unique relation values distinct from display primary keys."""',
        `    code = models.${fieldType}(unique=True${fieldType === "CharField" ? ", max_length=100" : ""})`, "    name = models.CharField(max_length=100)", ...meta(),
        "class Record(models.Model):", '    """References a target unique field and permits empty relations."""',
        `    company = models.${relationType}(Company, to_field='code', on_delete=models.CASCADE, null=True, blank=True, related_name='records')`, ...meta(),
        "for alias in ['default', 'archive']:", "    with connections[alias].schema_editor() as schema: schema.create_model(Company); schema.create_model(Record)",
        `    Company.objects.using(alias).create(pk=1, code=${JSON.stringify(codes[0])}, name=alias + ' Alpha')`,
        `    Company.objects.using(alias).create(pk=2, code=${JSON.stringify(codes[1])}, name=alias + ' Beta')`,
        `    Record.objects.using(alias).create(pk=1, company_id=${JSON.stringify(codes[1])})`, "    Record.objects.using(alias).create(pk=2)"];
      const lookupCode = ormBuilders.buildLookupOrm("critical_fixture", "Company", "Beta", [], 20, "archive", "code");
      const read = runBackend([...fixture,
        "schema = mod._browse_columns(Record)", "request = {'app': 'critical_fixture', 'model': 'Record', 'pk': 1, 'relation': 'company', 'database': 'archive'}",
        "related = mod._browse_related(request)", "empty = mod._browse_related(dict(request, pk=2))",
        "lookup = mod._browse_lookup({'app': 'critical_fixture', 'model': 'Company', 'q': 'Beta', 'valueField': 'code', 'database': 'archive'})",
        `orm_lookup, _ = mod._browse_eval_last({}, ${JSON.stringify(lookupCode)})`,
        `orm_related, _ = mod._browse_eval_last({}, ${JSON.stringify(ormBuilders.buildRelatedOrm("critical_fixture", "Record", 1, "company", 20, "archive"))})`,
        "print(json.dumps({'schema': schema, 'related': related, 'empty': empty, 'lookup': lookup, 'ormLookup': mod._browse_tabulate(orm_lookup, 0, 20), 'ormRelated': orm_related.name}))"]);
      assert.equal(read.related.ok, true, read.related.error); assert.equal(read.related.rows[0].name, "archive Beta");
      assert.equal(read.ormRelated, "archive Beta"); assert.deepEqual(read.empty.rows, []);
      assert.equal(read.schema.find((column) => column.attname === "company_id").relation.filterField, "code");
      assert.equal(read.lookup.ok, true, read.lookup.error);
      assert.deepEqual(read.ormLookup.rows, read.lookup.rows);
      const candidate = read.lookup.rows[0]; assert.equal(candidate.pk, 2); assert.equal(String(candidate.value), String(codes[1]));
      for (const mode of ["socket", "orm"]) {
        const result = runBackend([...fixture, `Record.objects.using('archive').filter(pk=1).update(company_id=${JSON.stringify(codes[0])})`,
          ...save(mode, "Record", [{ pk: 1, fields: { company_id: String(candidate.value) } }], read.schema, "archive"),
          "print(json.dumps({'ok': outcome['ok'], 'name': Record.objects.using('archive').get(pk=1).company.name, 'default': Record.objects.using('default').get(pk=1).company.name}))"]);
        assert.deepEqual(result, { ok: true, name: "archive Beta", default: "default Beta" });
      }
    });
  }
}

for (const mode of ["socket", "orm"]) {
  test(`${mode} rejects malformed structured JSON without writing any row`, { skip: !HAS_DJANGO }, () => {
    const result = runBackend([...setup(), "class Document(models.Model):", '    """Supplies two rows for atomic structured-edit validation."""', "    data = models.JSONField()", ...meta(),
      "with connections['default'].schema_editor() as schema: schema.create_model(Document)", "Document.objects.bulk_create([Document(pk=1, data={'old': 1}), Document(pk=2, data={'old': 2})])",
      ...save(mode, "Document", [{ pk: 1, fields: { data: '{"new":1}' } }, { pk: 2, fields: { data: '{"broken":' } }], [{ attname: "data", type: "JSONField" }]),
      "print(json.dumps({'ok': outcome['ok'], 'values': list(Document.objects.order_by('pk').values_list('data', flat=True))}))"]);
    assert.equal(result.ok, false); assert.deepEqual(result.values, [{ old: 1 }, { old: 2 }]);
  });

  test(`${mode} checks partial date uniqueness on the selected write database`, { skip: !HAS_DJANGO }, () => {
    const result = runBackend([...setup(undefined, "{name: {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'} for name in ['default', 'archive']}"),
      "class Article(models.Model):", '    """Validates date uniqueness on an explicit non-default database."""',
      "    title = models.CharField(max_length=100, unique_for_date='published')", "    published = models.DateField()", ...meta(),
      "for alias in ['default', 'archive']:", "    with connections[alias].schema_editor() as schema: schema.create_model(Article)",
      "Article.objects.using('archive').bulk_create([Article(pk=1, title='duplicate', published='2026-09-08'), Article(pk=2, title='other', published='2026-09-08')])",
      ...save(mode, "Article", [{ pk: 2, fields: { title: "duplicate" } }], [{ attname: "title", type: "CharField" }], "archive"),
      "print(json.dumps({'ok': outcome['ok'], 'titles': list(Article.objects.using('archive').order_by('pk').values_list('title', flat=True)), 'default': Article.objects.count()}))"]);
    assert.deepEqual(result, { ok: false, titles: ["duplicate", "other"], default: 0 });
  });

  test(`${mode} retains exact nested JSON integers when one other value changes`, { skip: !HAS_DJANGO }, () => {
    const before = '{"ref":9007199254740993,"negative":-9007199254740993,"items":[9007199254740995,{"label":"old"}],"text":"9007199254740993"}';
    const value = parseJsonExact(before); value.items[1].label = "edited";
    const edits = stringifyJsonExact(value);
    const result = runBackend([...setup(), "class Document(models.Model):", '    """Stores mixed JSON values with exact integer identifiers."""', "    data = models.JSONField()", ...meta(),
      "with connections['default'].schema_editor() as schema: schema.create_model(Document)", `Document.objects.create(pk=1, data=json.loads(${JSON.stringify(before)}))`,
      ...save(mode, "Document", [{ pk: 1, fields: { data: edits } }], [{ attname: "data", type: "JSONField" }]),
      "print(json.dumps({'ok': outcome['ok'], 'value': json.dumps(Document.objects.get(pk=1).data)}))"]);
    assert.equal(result.ok, true); assert.deepEqual(parseJsonExact(result.value), value);
  });

  for (const period of ["date", "month", "year"]) {
    test(`${mode} enforces unique_for_${period} on partial and batch edits before saving`, { skip: !HAS_DJANGO }, () => {
      const columns = [{ attname: "title", type: "CharField" }, { attname: "published", type: "DateField" }];
      const fixture = [...setup(), "calls = []", "class Article(models.Model):", '    """Requires date-scoped title uniqueness independently of database constraints."""',
        `    title = models.CharField(max_length=100, unique_for_${period}='published')`, "    published = models.DateField(null=True, blank=True)", ...meta(),
        "    def save(self, *args, **kwargs):", '        """Records whether preflight validation allowed a database save."""',
        "        calls.append(self.pk); return super().save(*args, **kwargs)",
        "with connections['default'].schema_editor() as schema: schema.create_model(Article)",
        "Article.objects.bulk_create([Article(pk=1, title='duplicate', published='2026-09-08'), Article(pk=2, title='other', published='2026-09-08'), Article(pk=3, title='duplicate', published='2025-10-09')])"];
      const cases = [
        [{ pk: 2, fields: { title: "duplicate" } }],
        [{ pk: 3, fields: { published: "2026-09-08" } }],
        [{ pk: 2, fields: { title: "duplicate", published: "2026-09-08" } }],
        [{ pk: 1, fields: { title: "new collision" } }, { pk: 2, fields: { title: "new collision" } }]
      ];
      for (const changes of cases) {
        const result = runBackend([...fixture, ...save(mode, "Article", changes, columns),
          "print(json.dumps({'ok': outcome['ok'], 'calls': calls, 'titles': list(Article.objects.order_by('pk').values_list('title', flat=True))}))"]);
        assert.equal(result.ok, false, JSON.stringify(changes)); assert.deepEqual(result.calls, []);
        assert.deepEqual(result.titles, ["duplicate", "other", "duplicate"]);
      }
      const valid = runBackend([...fixture, ...save(mode, "Article", [{ pk: 1, fields: { title: "other" } }, { pk: 2, fields: { title: "duplicate" } }], columns),
        "print(json.dumps({'ok': outcome['ok'], 'titles': list(Article.objects.order_by('pk').values_list('title', flat=True))}))"]);
      assert.equal(valid.ok, true); assert.deepEqual(valid.titles, ["other", "duplicate", "duplicate"]);
    });
  }
}

test("programmatic structured edits reject already imprecise JavaScript integers", () => {
  assert.throws(() => ormBuilders.editValue({ type: "JSONField" }, { ref: 9007199254740992 }), /large integers as JSON text/);
});

test("query projections keep tuple field order, named rows, flat values, and model annotations", { skip: !HAS_DJANGO }, () => {
  const result = runBackend([...setup(), "class Record(models.Model):", '    """Supplies concrete fields beside computed query columns."""', "    name = models.CharField(max_length=30)", ...meta(),
    "with connections['default'].schema_editor() as schema: schema.create_model(Record)", "Record.objects.create(pk=1, name='first')", "namespace = {'Record': Record, 'Value': models.Value}",
    "base = \"Record.objects.annotate(marker=Value('tag')).order_by('pk')\"",
    "queries = [base + suffix for suffix in [\".values_list('marker', 'id')\", \".values_list('id', 'marker', named=True)\", \".values_list('marker', flat=True)\", \".values('marker', 'id')\", '', \".filter(pk=99).values_list('marker', 'id', named=True)\"]]",
    "print(json.dumps([mod._browse_query(namespace, {'code': code}) for code in queries]))"]);
  for (const page of result) { assert.equal(page.ok, true, page.error); }
  assert.deepEqual(result[0].rows, [{ marker: "tag", id: 1 }]); assert.deepEqual(result[0].columns.map((column) => column.attname), ["marker", "id"]);
  assert.deepEqual(result[1].rows, [{ id: 1, marker: "tag" }]); assert.deepEqual(result[1].columns.map((column) => column.attname), ["id", "marker"]);
  assert.deepEqual(result[2].rows, [{ marker: "tag" }]); assert.deepEqual(result[3].rows, result[0].rows);
  assert.equal(result[4].rows[0].marker, "tag"); assert.equal(result[4].columns.find((column) => column.attname === "marker").editable, false);
  assert.equal(result[4].editable, true); assert.deepEqual(result[5].rows, []); assert.deepEqual(result[5].columns.map((column) => column.attname), ["marker", "id"]);
});

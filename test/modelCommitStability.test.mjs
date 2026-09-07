// Verifies identical validation and routed atomic saves through the real Django backend and generated ORM.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { HAS_DJANGO, runBackend } from "./modelBrowserHelpers.mjs";
import { temporalStoredValue } from "../media/gridTemporalEdit.js";

const require = createRequire(import.meta.url);
const { buildCommitOrm } = require("../out/modelOrm.js");
const { parseOrmCommitResponse } = require("../out/modelBackend.js");
const columns = [
  { attname: "name", type: "CharField" }, { attname: "balance", type: "IntegerField" },
  { attname: "at", type: "DateTimeField", null: true }, { attname: "protected", type: "CharField" }
];

/** Executes one save against an isolated model with validators, custom clean/save, and a read replica router. */
function commit(mode, changes, alias = "default", sharded = false) {
  const orm = buildCommitOrm("stability_fixture", "Record", changes, columns);
  const request = JSON.stringify(JSON.stringify({ app: "stability_fixture", model: "Record", changes }));
  return runBackend([
    "import json, sys, types, datetime",
    "from django.conf import settings",
    "app = types.ModuleType('stability_fixture'); app.__file__ = '/tmp/stability_fixture.py'; sys.modules['stability_fixture'] = app",
    "class Router:",
    '    """Keeps reads on an unavailable replica to expose accidental replica-based writes."""',
    "    def db_for_read(self, model, **hints):",
    '        """Selects the replica unless callers explicitly select the primary."""',
    "        return 'replica'",
    "    def db_for_write(self, model, **hints):",
    '        """Selects one write alias, optionally rejecting instance-dependent sharding."""',
    `        return 'other' if ${sharded ? "True" : "False"} and getattr(hints.get('instance'), 'pk', None) == 2 else ${JSON.stringify(alias)}`,
    "db = {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}",
    "settings.configure(USE_TZ=True, TIME_ZONE='Asia/Seoul', DATABASES={key: dict(db) for key in ['default', 'other', 'replica']}, DATABASE_ROUTERS=[Router()], INSTALLED_APPS=['stability_fixture'])",
    "import django; django.setup()",
    "from django.core.exceptions import ValidationError",
    "from django.core.validators import MinValueValidator",
    "from django.db import connections, models",
    "calls = []",
    "class Record(models.Model):",
    '    """Provides real Django field and model validation plus an injected write failure."""',
    "    name = models.CharField(max_length=40, default='old')",
    "    balance = models.IntegerField(default=5, validators=[MinValueValidator(0)])",
    "    at = models.DateTimeField(null=True, blank=True)",
    "    updated = models.DateTimeField(auto_now=True)",
    "    protected = models.CharField(max_length=40, default='keep', editable=False)",
    "    class Meta:",
    '        """Registers the isolated test model."""',
    "        app_label = 'stability_fixture'",
    "    def clean(self):",
    '        """Rejects a model-level business rule independently of field metadata."""',
    "        if self.name == 'forbidden': raise ValidationError({'name': 'Forbidden name.'})",
    "    def save(self, *args, **kwargs):",
    '        """Fails the second update after the first has reached the database."""',
    "        calls.append(self.pk)",
    "        if self.pk == 2 and self.name == 'fail_save': raise RuntimeError('injected save failure')",
    "        return super().save(*args, **kwargs)",
    `alias = ${JSON.stringify(alias)}`,
    "with connections[alias].schema_editor() as schema: schema.create_model(Record)",
    "initial = datetime.datetime(2026, 9, 7, 12, 0, 0, 123456, tzinfo=datetime.timezone.utc)",
    "Record.objects.using(alias).bulk_create([Record(pk=1, at=initial), Record(pk=2, at=initial)])",
    "before = list(Record.objects.using(alias).order_by('pk').values_list('updated', flat=True))",
    ...(mode === "socket" ? [`outcome = mod._browse_commit(json.loads(${request}))`] : [
      "try:", `    exec(${JSON.stringify(orm)})`, "    outcome = {'ok': True, 'saved': len(_prepared)}",
      "except Exception as error:", "    outcome = {'ok': False, 'saved': 0, 'error': type(error).__name__}"
    ]),
    "rows = list(Record.objects.using(alias).order_by('pk').values('id', 'name', 'balance', 'protected', 'at'))",
    "unchanged = before == list(Record.objects.using(alias).order_by('pk').values_list('updated', flat=True))",
    "print(json.dumps({'ok': outcome['ok'], 'saved': outcome.get('saved', 0), 'rows': rows, 'calls': calls, 'autoFieldsUnchanged': unchanged}, default=lambda value: value.isoformat()))"
  ]);
}

for (const mode of ["socket", "orm"]) {
  test(`${mode} rejects field validators and Model.clean before any save`, { skip: !HAS_DJANGO }, () => {
    for (const bad of [{ balance: "-1" }, { name: "forbidden" }]) {
      const result = commit(mode, [{ pk: 1, fields: { name: "prepared" } }, { pk: 2, fields: bad }]);
      assert.equal(result.ok, false);
      assert.deepEqual(result.rows.map((row) => [row.name, row.balance]), [["old", 5], ["old", 5]]);
      assert.deepEqual(result.calls, []);
    }
  });

  test(`${mode} protects readonly fields and saves only edited fields on the write database`, { skip: !HAS_DJANGO }, () => {
    const result = commit(mode, [{ pk: 1, fields: { id: 999, protected: "changed", bogus: "ignored", balance: "6" } }], "other");
    assert.equal(result.ok, true); assert.equal(result.saved, 1);
    assert.equal(result.rows[0].id, 1); assert.equal(result.rows[0].protected, "keep");
    assert.equal(result.rows[0].balance, 6); assert.equal(result.autoFieldsUnchanged, true);
    const ignored = commit(mode, [{ pk: 1, fields: { id: 999, protected: "changed", bogus: "ignored" } }]);
    assert.equal(ignored.saved, 0); assert.deepEqual(ignored.calls, []);
  });

  for (const alias of ["default", "other"]) {
    test(`${mode} rolls back the entire ${alias} database transaction when the second save fails`, { skip: !HAS_DJANGO }, () => {
      const result = commit(mode, [{ pk: 1, fields: { name: "new" } }, { pk: 2, fields: { name: "fail_save" } }], alias);
      assert.equal(result.ok, false); assert.deepEqual(result.calls, [1, 2]);
      assert.deepEqual(result.rows.map((row) => row.name), ["old", "old"]);
    });
  }

  test(`${mode} rejects a commit spanning instance-dependent database routes before saving`, { skip: !HAS_DJANGO }, () => {
    const result = commit(mode, [{ pk: 1, fields: { name: "new" } }, { pk: 2, fields: { name: "new" } }], "default", true);
    assert.equal(result.ok, false); assert.deepEqual(result.calls, []);
  });

  test(`${mode} stores a one-minute datetime edit without a timezone shift or precision loss`, { skip: !HAS_DJANGO }, () => {
    const value = temporalStoredValue("DateTimeField", "2026-09-07T12:00:00.123456+00:00", "2026-09-07T12:01");
    const result = commit(mode, [{ pk: 1, fields: { at: value } }]);
    assert.equal(result.ok, true); assert.equal(result.rows[0].at, "2026-09-07T12:01:00.123456+00:00");
  });
}

test("ORM commit parsing reports the actual saved count, including ignored changes", () => {
  assert.equal(parseOrmCommitResponse(JSON.stringify({ ok: true, result: "0" }), 3).saved, 0);
  assert.equal(parseOrmCommitResponse(JSON.stringify({ ok: false, traceback: "ValidationError" }), 3).saved, 0);
});

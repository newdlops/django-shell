// Verifies that collection-valued model cells round-trip through grid editing without becoming strings.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { __test as arrayEditor } from "../media/gridArrayEdit.js";
import { HAS_DJANGO, PYTHON, runBackend } from "./modelBrowserHelpers.mjs";

const require = createRequire(import.meta.url);
const { __test: ormBuilders } = require("../out/modelOrm.js");

test("serializes collection cells as editable JSON rather than Python repr text", { skip: !PYTHON }, () => {
  const payload = runBackend([
    "import json",
    "cell = mod._browse_cell(['alpha', {'enabled': True}])",
    "print(json.dumps(cell))"
  ]);

  assert.equal(payload.t, "json");
  assert.deepEqual(JSON.parse(payload.edit), ["alpha", { enabled: true }]);
  assert.equal(payload.v, payload.edit, "short values use the same preview and full editor text");
});

test("exposes ArrayField base choices and type metadata for item controls", { skip: !PYTHON }, () => {
  const payload = runBackend([
    "import json",
    "class ChoiceField:",
    "    choices = [('new', 'New'), ('done', 'Done')]",
    "    null = False",
    "class ArrayField:",
    "    attname = name = 'states'",
    "    base_field = ChoiceField()",
    "    choices = None",
    "    editable = True",
    "    is_relation = primary_key = False",
    "    null = False",
    "class Meta:",
    "    concrete_fields = [ArrayField()]",
    "class Model:",
    "    _meta = Meta()",
    "print(json.dumps(mod._browse_columns(Model)[0]))"
  ]);

  assert.deepEqual(payload.arrayItem, { choices: [["new", "New"], ["done", "Done"]], null: false, type: "ChoiceField" });
});

test("models scalar and object arrays for row-based editing", () => {
  assert.deepEqual(arrayEditor.parseEditableArray({ type: "ArrayField" }, "[\"a\", 2]"), { items: ["a", 2], nullValue: false });
  assert.deepEqual(arrayEditor.parseEditableArray({ type: "ArrayField" }, ""), { items: [], nullValue: true });
  assert.equal(arrayEditor.parseEditableArray({ type: "JSONField" }, "{\"a\": 1}"), undefined);
  assert.deepEqual(arrayEditor.arrayShape([{ name: "a" }, { active: true, name: "b" }]), { keys: ["name", "active"], kind: "object" });
  assert.equal(arrayEditor.coerceInput("42", 1), 42);
  assert.equal(arrayEditor.coerceInput("false", true), false);
});

test("commits a JSON array edit as an array instead of a JSON string", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=False, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=[], USE_TZ=True)",
    "import django; django.setup()",
    "from django.db import connection, models",
    "class Entry(models.Model):",
    "    values = models.JSONField(default=list)",
    "    class Meta:",
    "        app_label = 'array_edit_test'",
    "with connection.schema_editor() as schema_editor: schema_editor.create_model(Entry)",
    "entry = Entry.objects.create(values=['old', {'count': 1}])",
    "mod._browse_resolve_model = lambda request: Entry",
    "edit_text = mod._browse_cell(entry.values)['v'].replace('old', 'new')",
    "result = mod._browse_commit({'changes': [{'pk': entry.pk, 'fields': {'values': edit_text}}]})",
    "entry.refresh_from_db()",
    "print(json.dumps({'ok': result['ok'], 'saved': result['saved'], 'value': entry.values, 'is_list': isinstance(entry.values, list)}))"
  ]);

  assert.deepEqual(payload, { is_list: true, ok: true, saved: 1, value: ["new", { count: 1 }] });
});

test("reconstructs array and JSON edits as typed Python literals in ORM mode", () => {
  const columns = [
    { attname: "tags", null: false, type: "ArrayField" },
    { attname: "metadata", null: false, type: "JSONField" }
  ];
  const orm = ormBuilders.buildCommitOrm("db", "Entry", [{
    fields: { metadata: "{\"enabled\": true}", tags: "[\"alpha\", 2, null]" },
    pk: 7
  }], columns);

  assert.match(orm, /_o0\.tags = \["alpha", 2, None\]/);
  assert.match(orm, /_o0\.metadata = \{"enabled": True\}/);
});

// Executes a bounded Recipe v2 ORM cell against a real in-memory Django fixture when available.

import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyModelQueryRecipe } from "../out/modelQueryRecipe.js";
import { ModelQueryMetadataIndex } from "../out/modelQueryRecipeMetadata.js";
import { buildRecipeRowsOrm } from "../out/modelQueryRecipeOrm.js";
import { HAS_DJANGO, runBackend } from "./modelBrowserHelpers.mjs";

const SOURCE = { app: "auth", model: "User" };
const COLUMNS = [
  { attname: "id", editable: false, name: "id", null: false, pk: true, type: "AutoField" },
  { attname: "username", editable: true, name: "username", null: false, pk: false, type: "CharField" },
  { attname: "is_staff", editable: true, name: "is_staff", null: false, pk: false, type: "BooleanField" }
];

/** Constructs trusted static metadata matching the Django auth User fixture. */
function context() {
  const metadata = new ModelQueryMetadataIndex();
  metadata.setCatalog([SOURCE]);
  metadata.addTree(SOURCE, { fields: COLUMNS.map((column) => ({ attname: column.attname, name: column.name, null: column.null, pk: column.pk, type: column.type })), ok: true, pk: "id", relations: [] });
  metadata.addColumns(SOURCE, COLUMNS);
  return { columns: COLUMNS, limit: 50, metadata, relations: [], source: SOURCE, transport: "orm" };
}

test("evaluates a nested Recipe v2 rows query through the generated app-registry cell", { skip: !HAS_DJANGO }, () => {
  const recipe = createEmptyModelQueryRecipe(SOURCE);
  recipe.where.children.push(
    { kind: "comparison", lhs: { kind: "field", path: "is_staff" }, lookup: "exact", negated: false, nodeId: "q-1", rhs: { kind: "literal", value: true } },
    { kind: "comparison", lhs: { kind: "field", path: "username" }, lookup: "icontains", negated: false, nodeId: "q-2", rhs: { kind: "literal", value: "ops" } }
  );
  const compiled = buildRecipeRowsOrm(recipe, context());
  assert.equal(compiled.validation.ok, true);
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'])",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User",
    "from django.db import models",
    "User.objects.create(username='ops-admin', password='x', is_staff=True)",
    "User.objects.create(username='ops-reader', password='x', is_staff=False)",
    `rows = list(eval(${JSON.stringify(compiled.cell)}))`,
    "print(json.dumps([row.username for row in rows]))"
  ]);
  assert.deepEqual(payload, ["ops-admin"]);
});

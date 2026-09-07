// Creates isolated registered Django apps and disposable models for critical data-integrity regressions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Registers only process-local fixture apps and explicitly selected SQLite databases. */
export function setup(apps = ["critical_fixture"], databases = "{'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}") {
  return ["import json, sys, types", "from django.conf import settings", `for label in ${JSON.stringify(apps)}:`,
    "    app = types.ModuleType(label); app.__file__ = '/tmp/' + label + '.py'; sys.modules[label] = app",
    `settings.configure(INSTALLED_APPS=${JSON.stringify(apps)}, DATABASES=${databases}, USE_TZ=True, DEFAULT_AUTO_FIELD='django.db.models.AutoField')`,
    "import django; django.setup()", "from django.apps import apps", "from django.db import models, connections"];
}

/** Defines a model with an exact 64-bit primary key and one editable name. */
export function recordModel() {
  return ["class Record(models.Model):", '    """Stores a fixture row with an exact primary key."""', "    id = models.BigIntegerField(primary_key=True)",
    "    name = models.CharField(max_length=100)", "    class Meta:", '        """Registers the isolated model."""', "        app_label = 'critical_fixture'"];
}

/** Runs threaded Django work against a temporary database shared by its isolated connections. */
export function threadedFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-query-regression-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return [...setup(undefined, `{'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ${JSON.stringify(path.join(dir, "rows.sqlite3"))}}}`), ...recordModel(),
    "with connections['default'].schema_editor() as schema: schema.create_model(Record)",
    "import threading", "entered = threading.Event(); gate = threading.Event(); outcomes = {}", "namespace = {'Record': Record, 'entered': entered, 'gate': gate}"];
}

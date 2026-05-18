// Unit tests for lightweight Django workspace discovery.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  discoverDjangoPrelude,
  findDjangoSettingsModules,
  parseDjangoSettingsModule
} = require("../out/djangoProject.js");

test("parses Django settings from manage.py style source", () => {
  const source = "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'project.settings')";

  assert.equal(parseDjangoSettingsModule(source), "project.settings");
});

test("discovers multiple Django settings module candidates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-project-"));
  try {
    fs.writeFileSync(
      path.join(root, "manage.py"),
      "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'project.settings')\n"
    );
    fs.mkdirSync(path.join(root, "project"));
    fs.writeFileSync(path.join(root, "project", "__init__.py"), "");
    fs.writeFileSync(path.join(root, "project", "settings.py"), "");
    fs.mkdirSync(path.join(root, "tenant"));
    fs.mkdirSync(path.join(root, "tenant", "settings"));
    fs.writeFileSync(path.join(root, "tenant", "__init__.py"), "");
    fs.writeFileSync(path.join(root, "tenant", "settings", "__init__.py"), "");
    fs.writeFileSync(path.join(root, "tenant", "settings", "local.py"), "");

    const candidates = await findDjangoSettingsModules(root);

    assert.deepEqual(candidates, ["project.settings", "tenant.settings.local"]);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("discovers settings in first-level project subpackages without deep scanning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-project-"));
  try {
    fs.writeFileSync(
      path.join(root, "manage.py"),
      "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'project.staff.settings')\n"
    );
    fs.mkdirSync(path.join(root, "project", "staff"), { recursive: true });
    fs.mkdirSync(path.join(root, "project", "common", "settings"), { recursive: true });
    fs.writeFileSync(path.join(root, "project", "__init__.py"), "");
    fs.writeFileSync(path.join(root, "project", "staff", "__init__.py"), "");
    fs.writeFileSync(path.join(root, "project", "staff", "settings.py"), "");
    fs.writeFileSync(path.join(root, "project", "common", "__init__.py"), "");
    fs.writeFileSync(path.join(root, "project", "common", "settings", "local.py"), "");

    const candidates = await findDjangoSettingsModules(root);

    assert.deepEqual(candidates, ["project.common.settings.local", "project.staff.settings"]);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("discovers workspace venv, settings, and model import lines", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-project-"));
  try {
    fs.writeFileSync(
      path.join(root, "manage.py"),
      "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'project.settings')\n"
    );
    fs.mkdirSync(path.join(root, ".venv"));
    fs.writeFileSync(path.join(root, ".venv", "pyvenv.cfg"), "");
    fs.mkdirSync(path.join(root, "books"));
    fs.writeFileSync(path.join(root, "books", "__init__.py"), "");
    fs.writeFileSync(
      path.join(root, "books", "models.py"),
      "from django.db import models\n\nclass Book(models.Model):\n    pass\n"
    );

    const result = await discoverDjangoPrelude(root);

    assert.equal(result.settingsModule, "project.settings");
    assert.equal(result.virtualEnv, path.join(root, ".venv"));
    assert.ok(result.imports.includes("from books.models import Book"));
    assert.ok(result.imports.includes("from django.conf import settings"));
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("lets runtime settings override source settings for editor prelude", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-project-"));
  try {
    fs.writeFileSync(
      path.join(root, "manage.py"),
      "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'source.settings')\n"
    );

    const result = await discoverDjangoPrelude(root, { settingsModule: "runtime.settings" });

    assert.equal(result.settingsModule, "runtime.settings");
    assert.ok(result.imports.includes('os.environ.setdefault("DJANGO_SETTINGS_MODULE", "runtime.settings")'));
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("adds selected settings and bootstrap import graph lines to editor prelude", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-project-"));
  try {
    fs.writeFileSync(
      path.join(root, "manage.py"),
      "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'project.settings')\n"
    );
    fs.mkdirSync(path.join(root, "project"));
    fs.writeFileSync(path.join(root, "project", "__init__.py"), "");
    fs.writeFileSync(path.join(root, "project", "settings.py"), "from .bootstrap import *\nfrom . import extra\n");
    fs.writeFileSync(
      path.join(root, "project", "bootstrap.py"),
      "import collections as collections_alias\nfrom .nested import Thing\nfrom .wild import *\n"
    );
    fs.writeFileSync(path.join(root, "project", "extra.py"), "");
    fs.writeFileSync(path.join(root, "project", "nested.py"), "class Thing:\n    pass\n");
    fs.writeFileSync(path.join(root, "project", "wild.py"), "class Wild:\n    pass\n");

    const result = await discoverDjangoPrelude(root);

    assert.ok(result.imports.includes("import project.settings as _django_shell_selected_settings"));
    assert.ok(result.imports.includes("from project.bootstrap import *"));
    assert.ok(result.imports.includes("from project import extra"));
    assert.ok(result.imports.includes("import collections as collections_alias"));
    assert.ok(result.imports.includes("from project.nested import Thing"));
    assert.ok(result.imports.includes("from project.wild import *"));
    assert.ok(result.diagnostics.settingsImportFiles >= 4);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

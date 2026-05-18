// Unit tests for Django shell child process environment construction.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  buildShellEnv,
  describeShellEnvironment,
  formatShellEnvironment
} = require("../out/env.js");

test("describes workspace virtualenv activation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-env-"));
  try {
    const venv = path.join(root, ".venv");
    fs.mkdirSync(venv);
    fs.writeFileSync(path.join(venv, "pyvenv.cfg"), "");

    const info = describeShellEnvironment(root, { autoActivateWorkspaceVenv: true });

    assert.equal(info.virtualEnv, venv);
    assert.equal(info.pathPrefix, path.join(venv, process.platform === "win32" ? "Scripts" : "bin"));
    assert.match(formatShellEnvironment(info), /Django Shell process environment/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("can leave workspace virtualenv activation disabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-env-"));
  try {
    const venv = path.join(root, "venv");
    fs.mkdirSync(venv);
    fs.writeFileSync(path.join(venv, "pyvenv.cfg"), "");

    const info = describeShellEnvironment(root, { autoActivateWorkspaceVenv: false });
    const env = buildShellEnv(root, { autoActivateWorkspaceVenv: false });

    assert.equal(info.virtualEnv, undefined);
    assert.equal(env.VIRTUAL_ENV, process.env.VIRTUAL_ENV);
    assert.equal(String(env.PYTHONPATH).split(path.delimiter)[0], root);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("uses detected Django settings as a default shell environment value", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-env-"));
  const previous = process.env.DJANGO_SETTINGS_MODULE;
  try {
    delete process.env.DJANGO_SETTINGS_MODULE;
    fs.writeFileSync(
      path.join(root, "manage.py"),
      "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'project.settings')\n"
    );

    const info = describeShellEnvironment(root, { autoActivateWorkspaceVenv: false });
    const env = buildShellEnv(root, { autoActivateWorkspaceVenv: false });

    assert.equal(info.djangoSettingsModule, "project.settings");
    assert.equal(env.DJANGO_SETTINGS_MODULE, "project.settings");
  } finally {
    if (previous === undefined) {
      delete process.env.DJANGO_SETTINGS_MODULE;
    } else {
      process.env.DJANGO_SETTINGS_MODULE = previous;
    }
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("uses selected Django settings ahead of detected source settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "django-shell-env-"));
  try {
    fs.writeFileSync(
      path.join(root, "manage.py"),
      "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'source.settings')\n"
    );

    const env = buildShellEnv(root, {
      autoActivateWorkspaceVenv: false,
      djangoSettingsModule: "selected.settings"
    });

    assert.equal(env.DJANGO_SETTINGS_MODULE, "selected.settings");
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

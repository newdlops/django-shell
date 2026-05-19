// Verifies Python backend runtime inspection edge cases.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import test from "node:test";

const PYTHON = pythonExecutable();

test("inspects dataclass fields and properties as explicit children only", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, json",
    "from dataclasses import dataclass",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "property_reads=0",
    "@dataclass(slots=True)",
    "class Person:",
    "    first: str",
    "    last: str",
    "    @property",
    "    def full(self):",
    "        global property_reads",
    "        property_reads += 1",
    "        return self.first + ' ' + self.last",
    "namespace={'Person': Person, 'person': Person('Ada', 'Lovelace')}",
    "initial=set(namespace)",
    "inspect=mod._run_request(namespace, 'tok', {'token':'tok','kind':'inspect','lightweight':True}, initial)",
    "after_inspect=property_reads",
    "children=mod._run_request(namespace, 'tok', {'token':'tok','kind':'children','path':[{'op':'name','name':'person'}]}, initial)",
    "class_children=mod._run_request(namespace, 'tok', {'token':'tok','kind':'children','path':[{'op':'name','name':'Person'}]}, initial)",
    "print(json.dumps({'afterInspect':after_inspect,'afterChildren':property_reads,'children':{v['name']:v['preview'] for v in children['children']},'classChildren':[v['name'] for v in class_children['children']]}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.afterInspect, 0);
  assert.equal(payload.afterChildren, 1);
  assert.equal(payload.children.first, "'Ada'");
  assert.equal(payload.children.last, "'Lovelace'");
  assert.equal(payload.children.full, "'Ada Lovelace'");
  assert.ok(payload.classChildren.includes("first"));
  assert.ok(payload.classChildren.includes("full"));
});

function pythonExecutable() {
  const candidates = [process.env.DJANGO_SHELL_E2E_PYTHON, process.env.DJLS_E2E_BASE_PYTHON, "/Users/lky/.asdf/installs/python/3.11.15/bin/python3.11", "/usr/bin/python3", "python3"].filter(Boolean);
  return candidates.find((candidate) => childProcess.spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0);
}

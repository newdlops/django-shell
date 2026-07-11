// Verifies Python backend runtime inspection edge cases.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import test from "node:test";

const PYTHON = pythonExecutable();

test("bounds hidden prelude inspection without scanning loaded modules", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, json",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "namespace={('symbol_%04d' % index): index for index in range(2505)}",
    "namespace['_private']='skip'",
    "namespace['_djs_internal']='skip'",
    "initial=set(namespace)",
    "module_scans=[]",
    "mod._inspect_modules=lambda: module_scans.append(True) or []",
    "prelude=mod._run_request(namespace,'tok',{'token':'tok','kind':'prelude'},initial)",
    "prelude_scans=len(module_scans)",
    "full=mod._run_request(namespace,'tok',{'token':'tok','kind':'inspect'},initial)",
    "print(json.dumps({'fullCount':len(full['variables']),'fullScans':len(module_scans),'names':[prelude['variables'][0]['name'],prelude['variables'][-1]['name']],'ok':prelude['ok'],'preludeCount':len(prelude['variables']),'preludeModules':prelude['modules'],'preludeScans':prelude_scans}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.ok, true);
  assert.equal(payload.preludeCount, 1400, "large shell namespaces have a fixed prelude summary budget");
  assert.deepEqual(payload.names, ["symbol_0000", "symbol_1399"]);
  assert.deepEqual(payload.preludeModules, []);
  assert.equal(payload.preludeScans, 0, "hidden prelude requests never enumerate sys.modules");
  assert.equal(payload.fullScans, 1, "only an explicitly visible runtime inspection scans modules");
  assert.equal(payload.fullCount, 2507);
});

test("autoimport observes loaded model modules without importing or invoking dynamic module hooks", { skip: !PYTHON }, () => {
  const script = [
    "import builtins, importlib.util, json, sys, types",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "hooks={'dir':0,'getattr':0}",
    "attempted=[]",
    "class HookedModule(types.ModuleType):",
    "    def __dir__(self): hooks['dir'] += 1; return super().__dir__()",
    "    def __getattr__(self, name): hooks['getattr'] += 1; raise AttributeError(name)",
    "loaded=types.ModuleType('loaded_app.models')",
    "loaded.LoadedClass=type('LoadedClass',(),{'__module__':'loaded_app.models'})",
    "hooked=HookedModule('hooked_app.models')",
    "hooked.__dict__['HookedClass']=type('HookedClass',(),{'__module__':'hooked_app.models'})",
    "apps=types.SimpleNamespace(ready=True,get_models=lambda: [],get_app_configs=lambda: [types.SimpleNamespace(name='loaded_app'),types.SimpleNamespace(name='hooked_app'),types.SimpleNamespace(name='missing_app')])",
    "django=types.ModuleType('django'); django.__path__=[]",
    "django_apps=types.ModuleType('django.apps'); django_apps.apps=apps",
    "django_conf=types.ModuleType('django.conf'); django_conf.settings=object()",
    "django_db=types.ModuleType('django.db'); django_db.__path__=[]",
    "django_models=types.ModuleType('django.db.models'); django_db.models=django_models",
    "sys.modules.update({'django':django,'django.apps':django_apps,'django.conf':django_conf,'django.db':django_db,'django.db.models':django_models,'loaded_app.models':loaded,'hooked_app.models':hooked})",
    "original_import=builtins.__import__",
    "def tracked_import(name, *args, **kwargs):",
    "    if name.startswith(('loaded_app','hooked_app','missing_app')): attempted.append(name)",
    "    return original_import(name, *args, **kwargs)",
    "builtins.__import__=tracked_import",
    "try:",
    "    namespace={} ; count=mod._autoimport_django_namespace(namespace)",
    "finally:",
    "    builtins.__import__=original_import",
    "print(json.dumps({'attempted':attempted,'count':count,'hooks':hooks,'hookedBound':namespace.get('HookedClass') is hooked.HookedClass,'loadedBound':namespace.get('LoadedClass') is loaded.LoadedClass,'missingLoaded':'missing_app.models' in sys.modules}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.deepEqual(payload.attempted, [], "autoimport never imports candidate application modules");
  assert.deepEqual(payload.hooks, { dir: 0, getattr: 0 }, "module discovery uses vars(module), not dynamic enumeration");
  assert.equal(payload.missingLoaded, false);
  assert.equal(payload.loadedBound, true);
  assert.equal(payload.hookedBound, true);
  assert.ok(payload.count >= 2);
});

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
    "after_children=property_reads",
    "property_children=mod._run_request(namespace, 'tok', {'token':'tok','kind':'children','path':[{'op':'name','name':'person'},{'op':'attr','name':'full'}]}, initial)",
    "class_children=mod._run_request(namespace, 'tok', {'token':'tok','kind':'children','path':[{'op':'name','name':'Person'}]}, initial)",
    "print(json.dumps({'afterInspect':after_inspect,'afterChildren':after_children,'afterProperty':property_reads,'children':{v['name']:v['preview'] for v in children['children']},'classChildren':[v['name'] for v in class_children['children']],'propertyOk':property_children['ok'],'propertyChildren':{v['name']:v['preview'] for v in property_children['children']}}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.afterInspect, 0);
  assert.equal(payload.afterChildren, 0);
  assert.equal(payload.afterProperty, 1);
  assert.equal(payload.children.first, "'Ada'");
  assert.equal(payload.children.last, "'Lovelace'");
  assert.equal(payload.children.full, "<property>");
  assert.equal(payload.propertyOk, true);
  assert.equal(payload.propertyChildren.value, "'Ada Lovelace'");
  assert.ok(payload.classChildren.includes("first"));
  assert.ok(payload.classChildren.includes("full"));
});

test("inspects regular object dict, slots, class fields, and properties without dropping fields", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, json",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "reads=0",
    "class Base:",
    "    __slots__ = ('base_slot',)",
    "class Regular(Base):",
    "    __slots__ = ('slot_value', '__dict__')",
    "    class_value = 'shared'",
    "    hinted: int",
    "    def __init__(self):",
    "        self.instance_value = 11",
    "        self.slot_value = 22",
    "        self.base_slot = 33",
    "        self.hinted = 44",
    "    @property",
    "    def computed(self):",
    "        global reads",
    "        reads += 1",
    "        return self.instance_value + self.slot_value",
    "    @property",
    "    def broken(self):",
    "        raise RuntimeError('boom')",
    "    def public_method(self):",
    "        return 'method'",
    "obj = Regular()",
    "namespace={'obj': obj}",
    "initial=set()",
    "inspect=mod._run_request(namespace, 'tok', {'token':'tok','kind':'inspect','lightweight':True}, initial)",
    "after_inspect=reads",
    "children=mod._run_request(namespace, 'tok', {'token':'tok','kind':'children','path':[{'op':'name','name':'obj'}]}, initial)",
    "variable=[v for v in inspect['variables'] if v['name'] == 'obj'][0]",
    "print(json.dumps({'afterInspect': after_inspect, 'afterChildren': reads, 'childCount': variable.get('childCount'), 'children': {v['name']: v['preview'] for v in children['children']}}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.afterInspect, 0);
  assert.equal(payload.afterChildren, 0);
  assert.equal(payload.childCount, null);
  assert.equal(payload.children.instance_value, "11");
  assert.equal(payload.children.slot_value, "22");
  assert.equal(payload.children.base_slot, "33");
  assert.equal(payload.children.hinted, "44");
  assert.equal(payload.children.class_value, "'shared'");
  assert.equal(payload.children.computed, "<property>");
  assert.equal(payload.children.broken, "<property>");
  assert.match(payload.children.public_method, /^callable /);
});

test("shows datetime values and Django reverse relations in object inspection", { skip: !PYTHON }, () => {
  const script = [
    "import datetime, importlib.util, json",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "class Field:",
    "    def __init__(self, name, attname=None, accessor=None, auto_created=False, concrete=True):",
    "        self.name = name",
    "        self.attname = attname or name",
    "        self.accessor = accessor",
    "        self.auto_created = auto_created",
    "        self.concrete = concrete",
    "    def get_accessor_name(self):",
    "        return self.accessor",
    "class Meta:",
    "    app_label = 'db'",
    "    object_name = 'Company'",
    "    db_table = 'db_company'",
    "    pk = Field('id')",
    "    def get_fields(self, include_hidden=False):",
    "        return [Field('id'), Field('created_at'), Field('orders', accessor='orders', auto_created=True, concrete=False), Field('hidden', accessor='hidden+', auto_created=True, concrete=False)]",
    "class Company:",
    "    _meta = Meta()",
    "    @property",
    "    def label(self):",
    "        return 'Company ' + str(self.id)",
    "    @property",
    "    def broken_label(self):",
    "        raise RuntimeError('label failed')",
    "class Manager:",
    "    def __init__(self, items):",
    "        self.items = items",
    "    def all(self):",
    "        return self.items",
    "class Order:",
    "    def __init__(self, name):",
    "        self.name = name",
    "company = Company()",
    "company.id = 1",
    "company.created_at = datetime.datetime(2026, 6, 7, 12, 30)",
    "company.annotated_total = 7",
    "manager = Manager([Order('primary')])",
    "children = mod._inspect_value_children(company, [{'op':'name','name':'company'}])",
    "debug_values = {k: mod._preview_value(v) for k, v in mod._debug_model_value_map(company).items()}",
    "date_children = mod._inspect_value_children(company.created_at, [{'op':'name','name':'company'},{'op':'attr','name':'created_at'}])",
    "manager_children = mod._browse_children_of(manager, [{'op':'name','name':'manager'}])",
    "resolved = mod._resolve_path({'manager': manager}, manager_children[0]['path'])",
    "matched, probe_value, probe_error = mod._pty_inspect_probe_target('dir(list((manager).all())[0])', {'manager': manager})",
    "class Broken:",
    "    @property",
    "    def child(self):",
    "        raise RuntimeError('child failed')",
    "broken_matched, broken_value, broken_error = mod._pty_inspect_probe_target('dir(broken.child)', {'broken': Broken()})",
    "broken_children = mod._browse_children_of(broken_value, [])",
    "print(json.dumps({",
    "  'children': {v['name']: v['preview'] for v in children},",
    "  'debugValues': debug_values,",
    "  'dateChildren': {v['name']: v['preview'] for v in date_children},",
    "  'managerPathOp': manager_children[0]['path'][-1]['op'],",
    "  'resolvedName': resolved.name,",
    "  'probeMatched': matched,",
    "  'probeName': getattr(probe_value, 'name', None),",
    "  'probeError': probe_error,",
    "  'brokenMatched': broken_matched,",
    "  'brokenError': broken_error,",
    "  'brokenChildren': {v['name']: v['preview'] for v in broken_children},",
    "}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.children.created_at, "2026-06-07 12:30:00");
  assert.equal(payload.children.annotated_total, "7");
  assert.equal(payload.children.label, "'Company 1'");
  assert.match(payload.children.broken_label, /label failed/);
  assert.equal(payload.children.orders, "<attribute>");
  assert.equal(Object.hasOwn(payload.children, "hidden"), false);
  assert.equal(payload.debugValues.annotated_total, "7");
  assert.equal(payload.debugValues.label, "'Company 1'");
  assert.equal(Object.hasOwn(payload.debugValues, "orders"), false);
  assert.equal(payload.dateChildren.value, "2026-06-07 12:30:00");
  assert.equal(payload.managerPathOp, "all_index");
  assert.equal(payload.resolvedName, "primary");
  assert.equal(payload.probeMatched, true);
  assert.equal(payload.probeName, "primary");
  assert.equal(payload.probeError, null);
  assert.equal(payload.brokenMatched, true);
  assert.equal(payload.brokenError, null);
  assert.match(payload.brokenChildren.value, /child failed/);
});

test("keeps ORM-mode runtime inspection uncapped", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, json",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "namespace={f'name_{index}': index for index in range(4800)}",
    "namespace['_djs_initial_names'] = set()",
    "mod._STATE['server'] = type('Server', (), {'namespace': namespace})()",
    "returned = mod._pty_orm_inspect()",
    "runtime = mod._STATE['pty_raw_metadata']['runtime']",
    "print(json.dumps({'returned': returned, 'count': len(runtime['variables']), 'first': runtime['variables'][0]['name'], 'last': runtime['variables'][-1]['name']}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.returned, null);
  assert.equal(payload.count, 4800);
  assert.equal(payload.first, "name_0");
  assert.equal(payload.last, "name_999");
});

test("chunks oversized PTY inspection markers without dropping metadata", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, json",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "variables=[{'name': f'name_{index}', 'preview': 'x' * 500, 'type': 'str'} for index in range(3000)]",
    "response={'ok': True, 'runtime': {'loadedModuleCount': 1, 'variables': variables}}",
    "marker=mod._pty_cell_marker('cell', response)",
    "payloads=[json.loads(line[len(mod._RESPONSE_PREFIX):]) for line in marker.splitlines()]",
    "rebuilt=''.join(payload['chunk']['data'] for payload in sorted(payloads, key=lambda item: item['chunk']['index']))",
    "decoded=json.loads(rebuilt)",
    "print(json.dumps({'chunks': len(payloads), 'count': len(decoded['runtime']['variables']), 'last': decoded['runtime']['variables'][-1]['name']}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.chunks > 1);
  assert.equal(payload.count, 3000);
  assert.equal(payload.last, "name_2999");
});

test("emits an error marker when forcing a cell result's repr raises (lazy QuerySet hitting the DB)", { skip: !PYTHON }, () => {
  // Regression: a cell whose statement only built a lazy value (error_in_exec is None) but whose repr
  // raises when _post forces it must surface as the cell's error, not escape post_run_cell -- an escape
  // skips the response marker, hanging the ORM read and double-faulting via ExecutionResult.__repr__.
  const script = [
    "import importlib.util, json, io, sys",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "class Events:",
    "    def __init__(self): self.cb={}",
    "    def register(self, name, fn): self.cb[name]=fn",
    "class Shell: pass",
    "class Boom:",
    "    def __repr__(self): raise RuntimeError('kaboom-from-repr')",
    "class Info:",
    "    def __init__(self, raw): self.raw_cell=raw",
    "class Result:",
    "    def __init__(self, value): self.result=value; self.error_in_exec=None; self.error_before_exec=None",
    "shell=Shell(); shell.user_ns={}; shell.events=Events()",
    "mod._pty_install_ipython_capture(shell)",
    "pre=shell.events.cb['pre_run_cell']; post=shell.events.cb['post_run_cell']",
    "real=sys.stdout; buf=io.StringIO(); sys.stdout=buf; escaped=None",
    "try:",
    "    pre(Info('boom'))",
    "    post(Result(Boom()))",
    "except Exception as exc:",
    "    escaped=repr(exc)",
    "finally:",
    "    sys.stdout=real",
    "markers=[line for line in buf.getvalue().splitlines() if line.startswith(mod._RESPONSE_PREFIX)]",
    "resp=json.loads(markers[0][len(mod._RESPONSE_PREFIX):])['response'] if markers else None",
    "print(json.dumps({'escaped':escaped,'markers':len(markers),'ok':resp and resp['ok'],'gridIsNull':resp is not None and resp['grid'] is None,'tbHasError':bool(resp and 'kaboom-from-repr' in (resp.get('traceback') or ''))}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.escaped, null, "the repr failure must not escape post_run_cell");
  assert.equal(payload.markers, 1, "exactly one response marker must still be emitted");
  assert.equal(payload.ok, false);
  assert.equal(payload.gridIsNull, true);
  assert.equal(payload.tbHasError, true, "the marker traceback must carry the underlying error");
});

test("reports progress for running Python for-loops without waiting for the execution lock", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, json, threading, time",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "namespace={}",
    "result={}",
    "code='import time\\nseen=[]\\nfor item in range(5):\\n    time.sleep(0.05)\\n    seen.append(item)\\nlen(seen)'",
    "thread=threading.Thread(target=lambda: result.setdefault('value', mod._execute_code(namespace, code)))",
    "thread.start()",
    "progress={}",
    "deadline=time.time()+0.8",
    "while time.time() < deadline:",
    "    time.sleep(0.01)",
    "    progress=mod._run_request(namespace, 'tok', {'token':'tok','kind':'progress'}, set())",
    "    if progress.get('active') and progress.get('total') == 5 and progress.get('current', 0) >= 1:",
    "        break",
    "thread.join(2)",
    "final=mod._run_request(namespace, 'tok', {'token':'tok','kind':'progress'}, set())",
    "print(json.dumps({'doneAlive': thread.is_alive(), 'final': final, 'progress': progress, 'result': result.get('value')}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.doneAlive, false);
  assert.equal(payload.result.ok, true);
  assert.equal(payload.result.result, "5");
  assert.equal(payload.progress.active, true);
  assert.equal(payload.progress.total, 5);
  assert.ok(payload.progress.current >= 1, `expected progress current >= 1, got ${payload.progress.current}`);
  assert.equal(payload.progress.line, 3);
  assert.equal(payload.progress.detail, "range(5)");
  assert.equal(payload.final.done, true);
  assert.equal(payload.final.ok, true);
});

test("interrupt request stops the active Python execution thread", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, json, threading, time",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "namespace={'flag': []}",
    "result={}",
    "code='flag.append(\"start\")\\nwhile True:\\n    pass\\nflag.append(\"end\")'",
    "thread=threading.Thread(target=lambda: result.setdefault('value', mod._run_request(namespace, 'tok', {'token':'tok','kind':'execute','code':code}, set())), daemon=True)",
    "thread.start()",
    "deadline=time.time()+1",
    "while time.time() < deadline and not mod._STATE.get('execution_thread_id'):",
    "    time.sleep(0.01)",
    "interrupted=mod._run_request(namespace, 'tok', {'token':'tok','kind':'interrupt','reason':'test'}, set())",
    "thread.join(2)",
    "response=result.get('value') or {}",
    "print(json.dumps({'alive': thread.is_alive(), 'flag': namespace['flag'], 'interrupted': interrupted, 'response': response, 'threadId': mod._STATE.get('execution_thread_id')}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.alive, false);
  assert.deepEqual(payload.flag, ["start"]);
  assert.equal(payload.interrupted.ok, true);
  assert.equal(payload.interrupted.interrupted, true);
  assert.equal(payload.response.ok, false);
  assert.match(payload.response.traceback, /_ExecutionInterrupted|KeyboardInterrupt/);
  assert.equal(payload.threadId, null);
});

test("core backend defers the model browser until loadfeature installs it", { skip: !PYTHON }, () => {
  const script = [
    "import json, zlib, base64",
    `src=open(${JSON.stringify(path.resolve("python/django_shell_backend.py"))},encoding='utf-8').read()`,
    "idx=src.index('# --- Model data browser')",
    "core=src[:idx]; feature=src[idx:]",
    "g={}",
    "exec(compile(core,'<core>','exec'), g)",
    "before=('_browse_models' in g)",
    "loader=('_load_feature' in g and '_BROWSE_REQUEST_KINDS' in g)",
    "guard=g['_run_request'](None,'t',{'token':'t','kind':'models'},None)",
    "data=base64.b64encode(zlib.compress(feature.encode('utf-8'))).decode('ascii')",
    "res=g['_load_feature']({'data':data})",
    "after=('_browse_models' in g)",
    "reload=g['_load_feature']({'data':data})",
    "print(json.dumps({'before':before,'loader':loader,'guardLoading':(not guard.get('ok')) and ('loading' in (guard.get('error') or '')),'loadOk':res.get('ok'),'reused':res.get('reused'),'after':after,'reloadReused':reload.get('reused')}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.before, false, "the core half does not define the model browser");
  assert.equal(payload.loader, true);
  assert.equal(payload.guardLoading, true, "browser requests before load return a still-loading message");
  assert.equal(payload.loadOk, true);
  assert.equal(payload.reused, false);
  assert.equal(payload.after, true, "loadfeature installs the browser into the same module globals");
  assert.equal(payload.reloadReused, true, "a second load is an idempotent no-op");
});

test("PTY models probe degrades to a still-loading catalog while the feature half is absent", { skip: !PYTHON }, () => {
  // Regression: the capture hook attached the catalog via an unguarded _browse_models() call, so a models
  // probe on a core-only remote raised NameError out of post_run_cell — no marker, catalog timeout, and an
  // "Error in callback" dump in the user's terminal.
  const script = [
    "import json, io, sys",
    `src=open(${JSON.stringify(path.resolve("python/django_shell_backend.py"))},encoding='utf-8').read()`,
    "g={}",
    "exec(compile(src[:src.index('# --- Model data browser')],'<core>','exec'), g)",
    "class Events:",
    "    def __init__(self): self.cb={}",
    "    def register(self, name, fn): self.cb[name]=fn",
    "class Shell: pass",
    "class Info:",
    "    def __init__(self, raw): self.raw_cell=raw",
    "class Result:",
    "    def __init__(self, value): self.result=value; self.error_in_exec=None; self.error_before_exec=None",
    "shell=Shell(); shell.user_ns={}; shell.events=Events()",
    "g['_pty_install_ipython_capture'](shell)",
    "pre=shell.events.cb['pre_run_cell']; post=shell.events.cb['post_run_cell']",
    "real=sys.stdout; buf=io.StringIO(); sys.stdout=buf; escaped=None",
    "try:",
    "    pre(Info('len(apps.get_models())'))",
    "    post(Result(3))",
    "except Exception as exc:",
    "    escaped=repr(exc)",
    "finally:",
    "    sys.stdout=real",
    "markers=[line for line in buf.getvalue().splitlines() if line.startswith(g['_RESPONSE_PREFIX'])]",
    "resp=json.loads(markers[0][len(g['_RESPONSE_PREFIX']):])['response'] if markers else None",
    "models=(resp or {}).get('models') or {}",
    "print(json.dumps({'escaped':escaped,'markers':len(markers),'markerOk':bool(resp and resp.get('ok')),'modelsOk':models.get('ok'),'loading':'loading' in (models.get('error') or '')}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.escaped, null, "the missing browser half must not escape post_run_cell");
  assert.equal(payload.markers, 1, "the probe still emits its response marker");
  assert.equal(payload.markerOk, true);
  assert.equal(payload.modelsOk, false);
  assert.equal(payload.loading, true, "the attached catalog carries the still-loading error");
});

test("loadfeature consumes staged shell-namespace chunks via partsKey (typed PTY delivery)", { skip: !PYTHON }, () => {
  const script = [
    "import json, zlib, base64",
    `src=open(${JSON.stringify(path.resolve("python/django_shell_backend.py"))},encoding='utf-8').read()`,
    "idx=src.index('# --- Model data browser')",
    "core=src[:idx]; feature=src[idx:]",
    "g={}",
    "exec(compile(core,'<core>','exec'), g)",
    "data=base64.b64encode(zlib.compress(feature.encode('utf-8'))).decode('ascii')",
    "ns={'_djs_feature_parts':[data[:1000],data[1000:]]}",
    "missing=g['_run_request'](ns,'t',{'token':'t','kind':'loadfeature','partsKey':'_djs_absent'},None)",
    "res=g['_run_request'](ns,'t',{'token':'t','kind':'loadfeature','partsKey':'_djs_feature_parts'},None)",
    "print(json.dumps({'missingOk':missing.get('ok'),'ok':res.get('ok'),'reused':res.get('reused'),'after':('_browse_models' in g),'popped':('_djs_feature_parts' not in ns)}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.missingOk, false, "an absent parts key still reports a clean payload error");
  assert.equal(payload.ok, true);
  assert.equal(payload.reused, false);
  assert.equal(payload.after, true, "the staged chunks install the browser half");
  assert.equal(payload.popped, true, "consumed chunks are removed from the shell namespace");
});

test("streams stdout and stderr chunks while PTY progress emit is active", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, io, json, sys",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "buf=io.StringIO()",
    "real=sys.__stdout__",
    "sys.__stdout__=buf",
    "try:",
    "    mod._STATE['progress_emit']=True",
    "    response=mod._execute_code({}, 'import sys\\nprint(\"hello-live\")\\nprint(\"err-live\", file=sys.stderr)')",
    "finally:",
    "    sys.__stdout__=real",
    "markers=[]",
    "for line in buf.getvalue().splitlines():",
    "    if line.startswith(mod._PROGRESS_PREFIX):",
    "        markers.append(json.loads(line[len(mod._PROGRESS_PREFIX):]))",
    "outputs=[marker for marker in markers if marker.get('kind') == 'output']",
    "stdout=''.join(marker.get('output', '') for marker in outputs if marker.get('stream') == 'stdout')",
    "stderr=''.join(marker.get('output', '') for marker in outputs if marker.get('stream') == 'stderr')",
    "print(json.dumps({'response': response, 'stderr': stderr, 'stdout': stdout}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.response.ok, true);
  assert.equal(payload.response.stdout, "hello-live\n");
  assert.equal(payload.response.stderr, "err-live\n");
  assert.equal(payload.stdout, "hello-live\n");
  assert.equal(payload.stderr, "err-live\n");
});

test("debugpy bootstrap requests do not redirect process stderr", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, json",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "code='import sys\\nprint(\"debug-marker\")\\nprint(\"debug-stderr\", file=sys.stderr)'",
    "response=mod._run_request({}, 'tok', {'token':'tok','kind':'debugpy','code':code}, set())",
    "print(json.dumps(response))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.stdout, "debug-marker\n");
  assert.equal(payload.stderr, "");
  assert.match(result.stderr, /debug-stderr/);
});

test("plain REPL ORM runtime probe includes namespace variables", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, io, json, sys, readline",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "namespace={'user_value': 42, '_djs_initial_names': set()}",
    "buf=io.StringIO()",
    "real_stdout=sys.stdout",
    "real_stderr=sys.stderr",
    "real_displayhook=sys.displayhook",
    "real_ps1=getattr(sys, 'ps1', None)",
    "try:",
    "    sys.stdout=buf",
    "    mod._pty_install_plain_capture(sys, namespace)",
    "    str(sys.ps1)",
    "    readline.add_history('len(globals())')",
    "    sys.displayhook(len(namespace))",
    "    str(sys.ps1)",
    "finally:",
    "    sys.stdout=real_stdout",
    "    sys.stderr=real_stderr",
    "    sys.displayhook=real_displayhook",
    "    if real_ps1 is not None: sys.ps1=real_ps1",
    "markers=[line for line in buf.getvalue().splitlines() if line.startswith(mod._RESPONSE_PREFIX)]",
    "response=json.loads(markers[-1][len(mod._RESPONSE_PREFIX):])['response']",
    "print(json.dumps({'names':[v['name'] for v in response['runtime']['variables']], 'stdout': response['stdout']}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.names.includes("user_value"));
  assert.equal(payload.stdout, "");
});

test("uses request filename and line offset as the compiled shell input location", { skip: !PYTHON }, () => {
  const filename = path.join(process.cwd(), ".django-shell", "console-cell.py");
  const script = [
    "import importlib.util, json, linecache",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    `filename=${JSON.stringify(filename)}`,
    "source='header\\n# --- django shell input ---\\nfirst = 1\\nraise RuntimeError(\"breakpoint-file\")\\n'",
    "response=mod._run_request({}, 'tok', {'token':'tok','kind':'execute','code':'raise RuntimeError(\"breakpoint-file\")','filename':filename,'lineOffset':3,'sourceText':source}, set())",
    "print(json.dumps({'linecache': linecache.getline(filename, 4).strip(), 'response': response}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.linecache, 'raise RuntimeError("breakpoint-file")');
  assert.equal(payload.response.ok, false);
  assert.match(payload.response.traceback, /breakpoint-file/);
  assert.match(payload.response.traceback, /line 4/);
  assert.ok(payload.response.traceback.includes(filename), payload.response.traceback);
});

test("injects debug breakpoints on active overlay source lines", { skip: !PYTHON }, () => {
  const filename = path.join(process.cwd(), ".django-shell", "console-cell.py");
  const script = [
    "import importlib.util, json, sys, types",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    `filename=${JSON.stringify(filename)}`,
    "hits={'breakpoint': 0, 'thread': 0}",
    "fake=types.SimpleNamespace(is_client_connected=lambda: True, breakpoint=lambda: hits.__setitem__('breakpoint', hits['breakpoint'] + 1), debug_this_thread=lambda: hits.__setitem__('thread', hits['thread'] + 1))",
    "sys.modules['debugpy']=fake",
    "namespace={'hits': hits}",
    "request={'token':'tok','kind':'execute','code':'value = (1\\n + 1)\\nvalue','filename':filename,'lineOffset':4,'breakpointLines':[6]}",
    "response=mod._run_request(namespace, 'tok', request, set())",
    "print(json.dumps({'breakpoint': hits['breakpoint'], 'thread': hits['thread'], 'response': response, 'value': namespace.get('value')}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.breakpoint, 1);
  assert.ok(payload.thread >= 1);
  assert.equal(payload.response.ok, true);
  assert.equal(payload.response.result, "2");
  assert.equal(payload.value, 2);
});

test("honors debug breakpoints added while a cell is already running", { skip: !PYTHON }, () => {
  const filename = path.join(process.cwd(), ".django-shell", "console-cell.py");
  const script = [
    "import importlib.util, json, sys, types",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    `filename=${JSON.stringify(filename)}`,
    "hits={'breakpoint': 0, 'thread': 0}",
    "fake=types.SimpleNamespace(is_client_connected=lambda: True, breakpoint=lambda: hits.__setitem__('breakpoint', hits['breakpoint'] + 1), debug_this_thread=lambda: hits.__setitem__('thread', hits['thread'] + 1))",
    "sys.modules['debugpy']=fake",
    "namespace={'mod': mod}",
    "code='for i in range(3):\\n    if i == 1:\\n        mod._debug_update_breakpoints({\"breakpointLines\": [4]})\\n    value = i\\n'",
    "response=mod._run_request(namespace, 'tok', {'token':'tok','kind':'execute','code':code,'filename':filename,'breakpointLines':[]}, set())",
    "print(json.dumps({'breakpoint': hits['breakpoint'], 'response': response, 'thread': hits['thread'], 'value': namespace.get('value')}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.breakpoint, 2);
  assert.equal(payload.response.ok, true);
  assert.equal(payload.value, 2);
});

test("does not inject nested function breakpoints at the enclosing function definition", { skip: !PYTHON }, () => {
  const filename = path.join(process.cwd(), ".django-shell", "console-cell.py");
  const script = [
    "import importlib.util, json, sys, types",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    `filename=${JSON.stringify(filename)}`,
    "hits={'breakpoint': 0, 'thread': 0}",
    "fake=types.SimpleNamespace(is_client_connected=lambda: True, breakpoint=lambda: hits.__setitem__('breakpoint', hits['breakpoint'] + 1), debug_this_thread=lambda: hits.__setitem__('thread', hits['thread'] + 1))",
    "sys.modules['debugpy']=fake",
    "namespace={}",
    "code='def work():\\n    value = 1\\n    return value\\n'",
    "define_response=mod._run_request(namespace, 'tok', {'token':'tok','kind':'execute','code':code,'filename':filename,'breakpointLines':[2]}, set())",
    "define_hits=hits['breakpoint']",
    "hits['breakpoint']=0",
    "call_response=mod._run_request(namespace, 'tok', {'token':'tok','kind':'execute','code':code + '\\nresult = work()','filename':filename,'breakpointLines':[2]}, set())",
    "print(json.dumps({'call': call_response, 'callHits': hits['breakpoint'], 'define': define_response, 'defineHits': define_hits, 'result': namespace.get('result')}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.define.ok, true);
  assert.equal(payload.defineHits, 0);
  assert.equal(payload.call.ok, true);
  assert.equal(payload.callHits, 1);
  assert.equal(payload.result, 1);
});

test("debug execution creates a visible overlay stack frame", { skip: !PYTHON }, () => {
  const filename = path.join(process.cwd(), ".django-shell", "console-cell.py");
  const script = [
    "import importlib.util, json",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    `filename=${JSON.stringify(filename)}`,
    "request={'token':'tok','kind':'execute','code':'value = 1\\nraise RuntimeError(\"visible-frame\")','filename':filename,'lineOffset':4,'breakpointLines':[]}",
    "response=mod._run_request({}, 'tok', request, set())",
    "print(json.dumps(response))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.traceback, /__djs_overlay_cell__/);
  assert.match(payload.traceback, /visible-frame/);
  assert.ok(payload.traceback.includes(filename), payload.traceback);
});

test("debug execution does not make invalid module-level return valid", { skip: !PYTHON }, () => {
  const filename = path.join(process.cwd(), ".django-shell", "console-cell.py");
  const script = [
    "import importlib.util, json",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    `filename=${JSON.stringify(filename)}`,
    "request={'token':'tok','kind':'execute','code':'return 1','filename':filename,'lineOffset':4,'breakpointLines':[]}",
    "response=mod._run_request({}, 'tok', request, set())",
    "print(json.dumps(response))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.traceback, /outside function/);
});

test("marks backend socket threads debugger-exempt and restores tracing for cell executes", { skip: !PYTHON }, () => {
  const script = [
    "import importlib.util, json, threading",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "marked=mod._debugger_exempt_thread(threading.Thread(target=lambda: None))",
    "current=threading.current_thread()",
    "current.pydev_do_not_trace=True",
    "current.is_pydev_daemon_thread=True",
    "mod._restore_debugger_tracing()",
    "print(json.dumps({",
    "  'daemonThreads': bool(mod._Server.daemon_threads),",
    "  'markedDoNotTrace': bool(marked.pydev_do_not_trace),",
    "  'markedDaemonFlag': bool(marked.is_pydev_daemon_thread),",
    "  'restoredDoNotTrace': bool(current.pydev_do_not_trace),",
    "  'restoredDaemonFlag': bool(current.is_pydev_daemon_thread)",
    "}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.daemonThreads, true);
  assert.equal(payload.markedDoNotTrace, true);
  assert.equal(payload.markedDaemonFlag, true);
  assert.equal(payload.restoredDoNotTrace, false);
  assert.equal(payload.restoredDaemonFlag, false);
});

test("stages the debugpy bundle by digest with probe, install, reuse, and traversal guard", { skip: !PYTHON }, () => {
  const script = [
    "import base64, hashlib, importlib.util, json, os, shutil, tempfile, zlib",
    `path=${JSON.stringify(path.resolve("python/django_shell_backend.py"))}`,
    "spec=importlib.util.spec_from_file_location('django_shell_backend', path)",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "digest=hashlib.sha256(b'bundle-test').hexdigest()",
    "root=os.path.join(tempfile.gettempdir(), 'django-shell-debugpy-' + digest[:16])",
    "shutil.rmtree(root, ignore_errors=True)",
    "probe=mod._run_request({}, 'tok', {'token':'tok','kind':'stagedebugpy','digest':digest}, set())",
    "bad=mod._run_request({}, 'tok', {'token':'tok','kind':'stagedebugpy','digest':'NOPE'}, set())",
    "files=[['debugpy/__init__.py', base64.b64encode(b'# stub').decode()]]",
    "data=base64.b64encode(zlib.compress(json.dumps(files).encode())).decode()",
    "install=mod._run_request({}, 'tok', {'token':'tok','kind':'stagedebugpy','digest':digest,'data':data}, set())",
    "reuse=mod._run_request({}, 'tok', {'token':'tok','kind':'stagedebugpy','digest':digest}, set())",
    "digest2=hashlib.sha256(b'bundle-evil').hexdigest()",
    "shutil.rmtree(os.path.join(tempfile.gettempdir(), 'django-shell-debugpy-' + digest2[:16]), ignore_errors=True)",
    "evil=base64.b64encode(zlib.compress(json.dumps([['../evil.py', base64.b64encode(b'boom').decode()]]).encode())).decode()",
    "traversal=mod._run_request({}, 'tok', {'token':'tok','kind':'stagedebugpy','digest':digest2,'data':evil}, set())",
    "shutil.rmtree(root, ignore_errors=True)",
    "print(json.dumps({'probe':probe,'badOk':bad['ok'],'install':install,'reuse':reuse,'traversalOk':traversal['ok'],'traversalError':traversal.get('error','')}))"
  ].join("\n");
  const result = childProcess.spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.probe, { ok: true, path: null, reused: false });
  assert.equal(payload.badOk, false);
  assert.equal(payload.install.ok, true);
  assert.equal(payload.install.files, 1);
  assert.equal(payload.install.reused, false);
  assert.ok(payload.install.path.includes("django-shell-debugpy-"));
  assert.equal(payload.reuse.ok, true);
  assert.equal(payload.reuse.reused, true);
  assert.equal(payload.reuse.path, payload.install.path);
  assert.equal(payload.traversalOk, false);
  assert.match(payload.traversalError, /Unsafe debugpy bundle path/);
});

function pythonExecutable() {
  const candidates = [process.env.DJANGO_SHELL_E2E_PYTHON, process.env.DJLS_E2E_BASE_PYTHON, "/Users/lky/.asdf/installs/python/3.11.15/bin/python3.11", "/usr/bin/python3", "python3"].filter(Boolean);
  return candidates.find((candidate) => childProcess.spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0);
}

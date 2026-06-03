# In-process JSON backend for executing code inside an interactive Django shell namespace.

import ast
import codeop
import contextlib
import dataclasses
import io
import inspect
import json
import keyword
import os
import pprint
import socketserver
import sys
import threading
import traceback
import types

_READY_PREFIX = "__DJANGO_SHELL_BACKEND_READY__"
_FAILED_PREFIX = "__DJANGO_SHELL_BACKEND_FAILED__"
_STATE = {}
_EXECUTION_LOCK = threading.Lock()


class _Server(socketserver.ThreadingTCPServer):
    """TCP server that stores the Django shell namespace and auth token."""

    allow_reuse_address = True


class _Handler(socketserver.StreamRequestHandler):
    """Handles a single JSON execution request from the VS Code extension."""

    def handle(self):
        """Reads one JSON line, executes it, and writes one JSON response line."""
        try:
            request = json.loads(self.rfile.readline().decode("utf-8"))
            response = _run_request(self.server.namespace, self.server.token, request, self.server.initial_names)
        except Exception:
            response = {"ok": False, "stdout": "", "stderr": "", "traceback": traceback.format_exc()}
        self.wfile.write((json.dumps(response) + "\n").encode("utf-8"))


def start(namespace, token):
    """Starts or reuses the backend server for the given interactive shell namespace."""
    try:
        server = _STATE.get("server")
        if server is None:
            server = _Server((_bind_host(), 0), _Handler)
            server.initial_names = set(namespace)
            server.namespace = namespace
            _STATE["server"] = server
            threading.Thread(target=server.serve_forever, daemon=True).start()
        server.token = token
        host, port = server.server_address
        _print_marker(_READY_PREFIX, {"host": _connect_host(host), "port": port, "token": token})
    except Exception:
        _print_marker(_FAILED_PREFIX, {"error": traceback.format_exc()})


def _bind_host():
    """Returns the TCP bind host for the backend server."""
    return os.environ.get("DJANGO_SHELL_BACKEND_HOST") or "127.0.0.1"


def _connect_host(bound_host):
    """Returns the host that the extension should use to connect back."""
    configured = os.environ.get("DJANGO_SHELL_BACKEND_CONNECT_HOST")
    if configured:
        return configured
    return "127.0.0.1" if bound_host in ("0.0.0.0", "::") else bound_host


def _run_request(namespace, token, request, initial_names):
    """Validates a request and executes its code under the shared execution lock."""
    if request.get("token") != token:
        return {"ok": False, "stdout": "", "stderr": "Invalid backend token.", "traceback": ""}
    if request.get("kind") == "environment":
        return _inspect_environment()
    if request.get("kind") == "inspect":
        return _inspect_runtime(namespace, initial_names, request)
    if request.get("kind") == "prelude":
        return _inspect_prelude(namespace, initial_names)
    if request.get("kind") == "children":
        return _inspect_children(namespace, request.get("path"))
    if request.get("kind") == "models":
        return _browse_models()
    if request.get("kind") == "schema":
        return _browse_schema(request)
    if request.get("kind") == "rows":
        return _browse_rows(request)
    if request.get("kind") == "related":
        return _browse_related(request)
    if request.get("kind") == "count":
        return _browse_count(request)
    code = request.get("code")
    if not isinstance(code, str):
        return {"ok": False, "stdout": "", "stderr": "Request code must be a string.", "traceback": ""}
    if request.get("kind") == "complete":
        return _check_complete(code)
    with _EXECUTION_LOCK:
        return _execute_code(namespace, code)


def _check_complete(code):
    """Returns whether Python considers the source complete enough to execute."""
    try:
        return {"ok": True, "complete": codeop.compile_command(code, "<django-shell-input>", "exec") is not None}
    except (OverflowError, SyntaxError, ValueError):
        return {"ok": True, "complete": True}


def _inspect_runtime(namespace, initial_names, request=None):
    """Returns safe runtime summaries for variables and loaded modules."""
    with _EXECUTION_LOCK:
        try:
            lightweight = bool(request and request.get("lightweight"))
            return {
                "ok": True,
                "loadedModuleCount": len(sys.modules),
                "modules": [] if lightweight else _inspect_modules(),
                "variables": _inspect_variables(namespace, initial_names, lightweight),
            }
        except Exception:
            return {"ok": False, "error": traceback.format_exc(), "modules": [], "variables": []}


def _inspect_prelude(namespace, initial_names):
    """Returns namespace summaries intended only for hidden editor preludes."""
    with _EXECUTION_LOCK:
        try:
            return {
                "ok": True,
                "loadedModuleCount": len(sys.modules),
                "modules": [],
                "variables": _inspect_prelude_variables(namespace, initial_names),
            }
        except Exception:
            return {"ok": False, "error": traceback.format_exc(), "modules": [], "variables": []}


def _inspect_children(namespace, path):
    """Returns child summaries for one runtime object path."""
    with _EXECUTION_LOCK:
        try:
            value = _resolve_path(namespace, path)
            return {"ok": True, "children": _inspect_value_children(value, path)}
        except Exception:
            return {"ok": False, "children": [], "error": traceback.format_exc()}


def _inspect_environment():
    """Returns lightweight Python and Django runtime environment details."""
    with _EXECUTION_LOCK:
        try:
            return {"basePrefix": sys.base_prefix, "cwd": os.getcwd(), "django": _django_environment(), "executable": sys.executable, "ok": True, "path": list(sys.path), "prefix": sys.prefix, "settingsModule": os.environ.get("DJANGO_SETTINGS_MODULE"), "version": sys.version, "virtualEnv": os.environ.get("VIRTUAL_ENV")}
        except Exception:
            return {"ok": False, "error": traceback.format_exc()}


def _django_environment():
    """Returns Django-specific runtime metadata without calling django.setup()."""
    info = {"appsReady": False, "available": False, "configured": False, "installedApps": [], "settingsModule": os.environ.get("DJANGO_SETTINGS_MODULE")}
    try:
        import django
        from django.apps import apps
        from django.conf import settings

        info["available"] = True
        info["version"] = django.get_version()
        info["configured"] = settings.configured
        if settings.configured:
            info["settingsModule"] = getattr(settings, "SETTINGS_MODULE", info["settingsModule"])
        info["appsReady"] = apps.ready
        if apps.ready:
            info["installedApps"] = [config.name for config in apps.get_app_configs()]
    except Exception as error:
        info["error"] = repr(error)
    return info


def _inspect_variables(namespace, initial_names, lightweight=False):
    """Builds non-evaluating summaries for names in the shell namespace."""
    items = []
    importable_initial = []
    for name, value in sorted(namespace.items()):
        if name.startswith("__") and name.endswith("__"):
            continue
        origin = _variable_origin(name, initial_names)
        if lightweight and origin in ("bootstrap", "private"):
            continue
        summary = _value_summary(name, value, [{"op": "name", "name": name}], origin)
        if not lightweight:
            items.append(summary)
            continue
        if origin in ("user", "last"):
            items.append(summary)
            continue
        if summary.get("importLine"):
            importable_initial.append(summary)
    if lightweight:
        items = items + importable_initial
        return items[:900]
    return items


def _inspect_prelude_variables(namespace, initial_names):
    """Builds bounded summaries for names that should exist in editor analysis only."""
    items = []
    for name, value in sorted(namespace.items()):
        if name.startswith("__") and name.endswith("__"):
            continue
        origin = _variable_origin(name, initial_names)
        if origin in ("bootstrap", "private"):
            continue
        items.append(_value_summary(name, value, [{"op": "name", "name": name}], origin))
        if len(items) >= 1400:
            break
    return items


def _inspect_value_children(value, path):
    """Builds child summaries for mappings, sequences, modules, classes, and objects."""
    if isinstance(value, dict):
        return _dict_children(value, path)
    if isinstance(value, (list, tuple)):
        return _sequence_children(value, path)
    if isinstance(value, (set, frozenset)):
        return _sequence_children(list(value), path)
    mapping = _attribute_mapping(value, evaluate_values=True)
    if mapping is not None:
        return _attribute_children(mapping, path)
    return []


def _dict_children(value, path):
    """Builds child summaries for dictionary values without evaluating keys."""
    children = []
    for index, (key, child) in enumerate(list(value.items())[:200]):
        name = f"[{_truncate(repr(key), 60)}]"
        children.append(_value_summary(name, child, path + [{"op": "dict", "index": index}]))
    return children


def _sequence_children(value, path):
    """Builds child summaries for indexable sequence values."""
    return [_value_summary(f"[{index}]", child, path + [{"op": "index", "index": index}]) for index, child in enumerate(list(value)[:200])]


def _attribute_children(mapping, path):
    """Builds child summaries from an object's attribute dictionary."""
    children = []
    for name, child in sorted(mapping.items()):
        if name.startswith("__") and name.endswith("__"):
            continue
        children.append(_value_summary(name, child, path + [{"op": "attr", "name": name}]))
        if len(children) >= 200:
            break
    return children


def _value_summary(name, value, path, origin=None):
    """Builds one serializable runtime value summary."""
    summary = {"hasChildren": _has_children(value), "importLine": _import_line(name, value), "kind": _variable_kind(value), "name": name, "path": path, "preview": _preview_value(value), "type": _type_name(value), "typeImportLine": _type_import_line(name, value)}
    if origin is not None:
        summary["origin"] = origin
    return summary


def _import_line(name, value):
    """Returns a static import line for values that can be re-imported by name."""
    if not _is_identifier(name) or name.startswith("_"):
        return None
    if isinstance(value, types.ModuleType):
        module_name = value.__name__
        return f"import {module_name}" if name == module_name else f"import {module_name} as {name}"
    if inspect.isclass(value) or callable(value):
        module_name = getattr(value, "__module__", "")
        qualified = getattr(value, "__qualname__", getattr(value, "__name__", ""))
        source_name = qualified.split(".", 1)[0]
        if not module_name or module_name == "builtins" or not _is_identifier(source_name):
            return None
        return f"from {module_name} import {source_name}" if source_name == name else f"from {module_name} import {source_name} as {name}"
    return None


def _type_import_line(name, value):
    """Returns a static import line for the runtime value type when available."""
    if not _is_identifier(name) or name.startswith("_") or isinstance(value, types.ModuleType) or inspect.isclass(value):
        return None
    value_type = type(value)
    module_name = getattr(value_type, "__module__", "")
    qualified = getattr(value_type, "__qualname__", getattr(value_type, "__name__", ""))
    source_name = qualified.split(".", 1)[0]
    if not module_name or module_name == "builtins" or not _is_identifier(source_name):
        return None
    return f"from {module_name} import {source_name}"


def _is_identifier(name):
    """Returns whether a string is a valid import alias identifier."""
    return isinstance(name, str) and name.isidentifier() and not keyword.iskeyword(name)


def _resolve_path(namespace, path):
    """Resolves an inspector path without evaluating arbitrary expressions."""
    if not path or not isinstance(path, list) or path[0].get("op") != "name":
        raise ValueError("Invalid runtime inspector path.")
    value = namespace[path[0]["name"]]
    for segment in path[1:]:
        value = _resolve_child(value, segment)
    return value


def _resolve_child(value, segment):
    """Resolves one safe child path segment."""
    op = segment.get("op")
    if op == "attr":
        mapping = _attribute_mapping(value, evaluate_values=True)
        if mapping is None:
            raise ValueError("Object does not expose a safe attribute dictionary.")
        return mapping[segment["name"]]
    if op == "index":
        return list(value)[segment["index"]]
    if op == "dict":
        return list(value.items())[segment["index"]][1]
    raise ValueError("Unsupported runtime inspector path segment.")


def _variable_origin(name, initial_names):
    """Classifies whether a variable came from user code, shell startup, or internals."""
    if name.startswith("_djs_"):
        return "bootstrap"
    if name == "_":
        return "last"
    if name.startswith("_"):
        return "private"
    return "initial" if name in initial_names else "user"


def _variable_kind(value):
    """Classifies one namespace value by display-oriented runtime kind."""
    if isinstance(value, types.ModuleType):
        return "module"
    if inspect.isclass(value):
        return "class"
    if callable(value):
        return "callable"
    if isinstance(value, (type(None), bool, int, float, complex, str, bytes)):
        return "primitive"
    if isinstance(value, (list, tuple, set, frozenset, dict)):
        return "collection"
    return "object"


def _has_children(value):
    """Returns whether a runtime value has safe children to show in the tree."""
    if isinstance(value, (dict, list, tuple, set, frozenset)):
        return len(value) > 0
    mapping = _attribute_mapping(value)
    return bool(mapping and any(not (name.startswith("__") and name.endswith("__")) for name in mapping))


def _attribute_mapping(value, evaluate_values=False):
    """Returns safe attributes, dataclass fields, and readable properties."""
    if not inspect.isclass(value):
        mapping = dict(_safe_vars(value) or {})
        _merge_dataclass_fields(value, mapping, evaluate_values)
        _merge_property_values(value, mapping, evaluate_values)
        return mapping or None
    merged = {}
    for cls in reversed(inspect.getmro(value)):
        mapping = _safe_vars(cls)
        if mapping:
            merged.update(mapping)
    _merge_dataclass_fields(value, merged, evaluate_values)
    return merged


def _merge_dataclass_fields(value, mapping, evaluate_values):
    """Adds dataclass field names and reads values only for explicit child inspection."""
    try:
        fields = dataclasses.fields(value)
    except TypeError:
        return
    is_class = inspect.isclass(value)
    for field in fields:
        if field.name in mapping:
            continue
        if is_class or not evaluate_values:
            mapping[field.name] = field
            continue
        with contextlib.suppress(Exception):
            mapping[field.name] = getattr(value, field.name)


def _merge_property_values(value, mapping, evaluate_values):
    """Adds property names and reads values only for explicit child inspection."""
    for cls in reversed(inspect.getmro(type(value))):
        for name, descriptor in (_safe_vars(cls) or {}).items():
            if name in mapping or not isinstance(descriptor, property):
                continue
            mapping[name] = descriptor
            if evaluate_values:
                with contextlib.suppress(Exception):
                    mapping[name] = getattr(value, name)


def _safe_vars(value):
    """Returns an object's attribute dictionary without traversing properties."""
    try:
        return vars(value)
    except TypeError:
        return None


def _inspect_modules():
    """Builds summaries for modules currently loaded in the Python process."""
    modules = []
    for name, module in sorted(sys.modules.items()):
        if not isinstance(module, types.ModuleType):
            continue
        modules.append({"file": str(getattr(module, "__file__", "") or ""), "name": name, "package": str(getattr(module, "__package__", "") or "")})
        if len(modules) >= 300:
            break
    return modules


def _type_name(value):
    """Returns a compact fully-qualified type name."""
    value_type = type(value)
    module = value_type.__module__
    if module == "builtins":
        return value_type.__name__
    return f"{module}.{value_type.__name__}"


def _preview_value(value):
    """Returns a preview that avoids calling arbitrary object repr methods."""
    if isinstance(value, (type(None), bool, int, float, complex, str, bytes)):
        return _truncate(repr(value))
    if isinstance(value, (list, tuple, set, frozenset, dict)):
        return f"{type(value).__name__}(len={len(value)})"
    if isinstance(value, types.ModuleType):
        return f"module {value.__name__}"
    if inspect.isclass(value):
        return f"class {value.__module__}.{value.__qualname__}"
    if callable(value):
        name = getattr(value, "__qualname__", getattr(value, "__name__", type(value).__name__))
        module = getattr(value, "__module__", type(value).__module__)
        return f"callable {module}.{name}"
    return f"<{_type_name(value)}>"


def _truncate(text, limit=180):
    """Shortens long previews for tree rendering."""
    return text if len(text) <= limit else text[:limit - 3] + "..."


def _execute_code(namespace, code):
    """Executes Python code and captures stdout, stderr, repr result, and traceback."""
    stdout = io.StringIO()
    stderr = io.StringIO()
    result = None
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            tree = ast.parse(code, filename="<django-shell-input>", mode="exec")
            body, expression = _split_last_expression(tree)
            if body:
                tree.body = body
                ast.fix_missing_locations(tree)
                exec(compile(tree, "<django-shell-input>", "exec"), namespace)
            if expression is None:
                if not body:
                    exec(compile(tree, "<django-shell-input>", "exec"), namespace)
            else:
                expr = ast.Expression(expression.value)
                ast.fix_missing_locations(expr)
                value = eval(compile(expr, "<django-shell-input>", "eval"), namespace)
                if value is not None:
                    namespace["_"] = value
                    result = pprint.pformat(value, width=120, compact=False)
            return {"ok": True, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "result": result}
        except Exception:
            return {"ok": False, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "traceback": traceback.format_exc()}


def _split_last_expression(tree):
    """Returns executable statements and an optional final expression node."""
    if not tree.body or not isinstance(tree.body[-1], ast.Expr):
        return tree.body, None
    return tree.body[:-1], tree.body[-1]


def _print_marker(prefix, payload):
    """Prints a single backend marker line that the extension can parse from PTY output."""
    print(prefix + json.dumps(payload), flush=True)


# --- Model data browser ---------------------------------------------------
# Additive feature: read Django models as tables without triggering N+1.
# Rows are read with _base_manager.values(*concrete_fields) so foreign keys
# stay as raw *_id columns (no JOIN). Related rows are fetched only on an
# explicit, bounded "related" request. None of the existing request kinds,
# inspection functions, or serialization helpers above are modified.


def _browse_models():
    """Returns the catalog of installed models as browsable tables."""
    with _EXECUTION_LOCK:
        try:
            from django.apps import apps

            items = []
            for model in apps.get_models():
                meta = model._meta
                items.append({"app": meta.app_label, "label": str(meta.verbose_name), "model": meta.object_name, "table": meta.db_table})
            items.sort(key=lambda item: (item["app"], item["model"]))
            return {"ok": True, "models": items}
        except Exception:
            return {"ok": False, "error": traceback.format_exc(), "models": []}


def _browse_schema(request):
    """Returns columns and expandable relations for one model without querying rows."""
    with _EXECUTION_LOCK:
        try:
            model = _browse_resolve_model(request)
            meta = model._meta
            return {"app": meta.app_label, "columns": _browse_columns(model), "label": str(meta.verbose_name), "model": meta.object_name, "ok": True, "pk": meta.pk.attname, "relations": _browse_relations(model), "table": meta.db_table}
        except Exception:
            return {"ok": False, "error": traceback.format_exc()}


def _browse_rows(request):
    """Returns one bounded page of rows using concrete columns only (no JOIN, no N+1)."""
    with _EXECUTION_LOCK:
        try:
            model = _browse_resolve_model(request)
            columns = _browse_columns(model)
            attnames = [column["attname"] for column in columns]
            pk_attname = model._meta.pk.attname
            limit = _browse_limit(request.get("limit"))
            order = _browse_order(request.get("order"), attnames, pk_attname)
            keyset_capable = order == [pk_attname]
            queryset = model._base_manager.all().order_by(*order).filter(_browse_build_filters(model, request.get("filters"), attnames))
            cursor = request.get("cursor")
            offset = request.get("offset")
            base_offset = offset if isinstance(offset, int) and offset > 0 else 0
            if keyset_capable and cursor is not None:
                queryset = queryset.filter(**{f"{pk_attname}__gt": cursor})
            elif not keyset_capable and base_offset:
                queryset = queryset[base_offset:]
            with _browse_capture() as ctx:
                raw = list(queryset.values(*attnames)[: limit + 1])
            has_more = len(raw) > limit
            raw = raw[:limit]
            next_cursor = raw[-1][pk_attname] if keyset_capable and has_more and raw else None
            next_offset = base_offset + limit if not keyset_capable and has_more else None
            orm = _browse_orm_rows(model, order, request.get("filters"), attnames, pk_attname, keyset_capable, cursor, base_offset, limit)
            return {"columns": columns, "hasMore": has_more, "nextCursor": _browse_jsonable(next_cursor), "nextOffset": next_offset, "ok": True, "orm": orm, "pk": pk_attname, "rows": [_browse_serialize_row(row) for row in raw], "sql": _browse_sql(ctx)}
        except Exception:
            return {"ok": False, "columns": [], "error": traceback.format_exc(), "rows": []}


def _browse_related(request):
    """Returns related rows for one source row, fetched lazily on explicit expansion."""
    with _EXECUTION_LOCK:
        try:
            model = _browse_resolve_model(request)
            field = _browse_find_relation(model, request.get("relation"))
            if field is None:
                return {"columns": [], "error": "Unknown relation.", "ok": False, "rows": []}
            target = field.related_model
            columns = _browse_columns(target)
            attnames = [column["attname"] for column in columns]
            source_pk = request.get("pk")
            limit = _browse_limit(request.get("limit"))
            with _browse_capture() as ctx:
                if field.many_to_one or (field.one_to_one and not field.auto_created):
                    result = _browse_related_single(model, field, target, attnames, columns, source_pk, request.get("value"))
                else:
                    result = _browse_related_many(model, field, columns, attnames, source_pk, limit)
            result["sql"] = _browse_sql(ctx)
            return result
        except Exception:
            return {"columns": [], "error": traceback.format_exc(), "rows": []}


def _browse_related_single(model, field, target, attnames, columns, source_pk, value):
    """Fetches one forward foreign-key or one-to-one related row with at most two queries."""
    if value is None:
        value = model._base_manager.filter(pk=source_pk).values_list(field.attname, flat=True).first()
    raw = list(target._base_manager.filter(pk=value).values(*attnames)[:1]) if value is not None else []
    orm = f"{target.__name__}._base_manager.filter(pk={value!r}).values({_orm_args(attnames)})[:1]"
    return {"columns": columns, "hasMore": False, "ok": True, "orm": orm, "rows": [_browse_serialize_row(row) for row in raw], "single": True}


def _browse_related_many(model, field, columns, attnames, source_pk, limit):
    """Fetches a bounded page of reverse foreign-key or many-to-many related rows."""
    accessor_name = _browse_relation_name(field)
    orm = f"{model.__name__}._base_manager.get(pk={source_pk!r}).{accessor_name}.all().values({_orm_args(attnames)})[:{limit + 1}]"
    instance = model._base_manager.filter(pk=source_pk).first()
    if instance is None:
        return {"columns": columns, "error": "Source row not found.", "ok": False, "rows": []}
    try:
        accessor = getattr(instance, accessor_name)
    except Exception:
        return {"columns": columns, "hasMore": False, "ok": True, "orm": orm, "rows": [], "single": bool(field.one_to_one)}
    if not hasattr(accessor, "all"):
        raw = list(type(accessor)._base_manager.filter(pk=accessor.pk).values(*attnames)[:1]) if accessor is not None else []
        return {"columns": columns, "hasMore": False, "ok": True, "orm": orm, "rows": [_browse_serialize_row(row) for row in raw], "single": True}
    raw = list(accessor.all().values(*attnames)[: limit + 1])
    has_more = len(raw) > limit
    return {"columns": columns, "hasMore": has_more, "ok": True, "orm": orm, "rows": [_browse_serialize_row(row) for row in raw[:limit]], "single": False}


def _browse_resolve_model(request):
    """Returns the model class named by an app label and model name."""
    from django.apps import apps

    return apps.get_model(request.get("app"), request.get("model"))


def _browse_columns(model):
    """Returns concrete (real DB) column descriptors; foreign keys appear as their id column."""
    columns = []
    for field in model._meta.concrete_fields:
        column = {"attname": field.attname, "editable": bool(getattr(field, "editable", False)) and not field.primary_key, "name": field.name, "null": bool(getattr(field, "null", False)), "pk": bool(field.primary_key), "type": type(field).__name__}
        if field.is_relation and field.related_model is not None:
            column["relation"] = {"field": field.name, "single": True, "target": _browse_label(field.related_model)}
        choices = getattr(field, "choices", None)
        if choices:
            column["choices"] = [[_browse_jsonable(choice[0]), str(choice[1])] for choice in list(choices)[:200]]
        columns.append(column)
    return columns


def _browse_relations(model):
    """Returns expandable relations (reverse FK, M2M, reverse O2O) excluding forward columns."""
    relations = []
    for field in model._meta.get_fields():
        if not field.is_relation or field.related_model is None:
            continue
        single = bool(field.one_to_one or field.many_to_one)
        if single and not field.auto_created:
            continue
        name = _browse_relation_name(field)
        if name is None:
            continue
        relations.append({"kind": _browse_relation_kind(field), "name": name, "single": single, "target": _browse_label(field.related_model)})
    return relations


def _browse_find_relation(model, relation):
    """Resolves a relation request name back to its model field or reverse descriptor."""
    if not relation:
        return None
    for field in model._meta.get_fields():
        if not field.is_relation:
            continue
        if _browse_relation_name(field) == relation or getattr(field, "name", None) == relation:
            return field
    return None


def _browse_relation_name(field):
    """Returns the accessor name for reverse relations or the field name for forward ones."""
    if field.auto_created and not getattr(field, "concrete", False):
        try:
            name = field.get_accessor_name()
        except Exception:
            return None
        return name if name and name != "+" else None
    return field.name


def _browse_relation_kind(field):
    """Returns a compact display kind for one relation field."""
    if field.many_to_many:
        return "m2m"
    if field.one_to_many:
        return "reverse-fk"
    if field.one_to_one:
        return "o2o"
    return "fk"


def _browse_label(model):
    """Returns an app-qualified model label."""
    return f"{model._meta.app_label}.{model._meta.object_name}"


def _browse_limit(value, default=50, maximum=200):
    """Returns a bounded page size so a single request cannot starve the shell."""
    if isinstance(value, int) and value > 0:
        return min(value, maximum)
    return default


def _browse_order(order, attnames, pk_attname):
    """Returns a safe order-by list restricted to real columns, defaulting to the primary key."""
    result = []
    if isinstance(order, list):
        for item in order:
            field = item.get("field") if isinstance(item, dict) else item
            descending = isinstance(item, dict) and bool(item.get("desc"))
            if field in attnames:
                result.append(f"-{field}" if descending else field)
    return result or [pk_attname]


def _browse_serialize_row(row):
    """Returns one row dict with every cell converted to a JSON-safe representation."""
    return {key: _browse_cell(value) for key, value in row.items()}


def _browse_cell(value):
    """Returns a JSON-safe representation for one field value without triggering queries."""
    import base64
    import datetime
    import decimal
    import uuid

    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, decimal.Decimal):
        return {"t": "decimal", "v": str(value)}
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return {"t": "datetime", "v": value.isoformat()}
    if isinstance(value, datetime.timedelta):
        return {"t": "duration", "v": str(value)}
    if isinstance(value, uuid.UUID):
        return {"t": "uuid", "v": str(value)}
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        return {"len": len(raw), "t": "bytes", "v": base64.b64encode(raw[:64]).decode("ascii")}
    if isinstance(value, (list, tuple, dict, set, frozenset)):
        return {"t": "json", "v": _truncate(repr(value), 400)}
    return {"t": "repr", "v": _truncate(repr(value), 400)}


def _browse_jsonable(value):
    """Returns a JSON-safe scalar for cursors and choice keys."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return str(value)


_BROWSE_LOOKUPS = frozenset({"exact", "iexact", "contains", "icontains", "gt", "gte", "lt", "lte", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "range", "date", "year", "month", "day"})


def _browse_count(request):
    """Returns the row count for the current filter set, computed only on explicit request."""
    with _EXECUTION_LOCK:
        try:
            model = _browse_resolve_model(request)
            attnames = [field.attname for field in model._meta.concrete_fields]
            with _browse_capture() as ctx:
                count = model._base_manager.filter(_browse_build_filters(model, request.get("filters"), attnames)).count()
            includes, excludes = _browse_orm_clauses(request.get("filters"), set(attnames))
            count_lines = [f"{model.__name__}._base_manager"]
            if includes:
                count_lines.append(f"    .filter({', '.join(includes)})")
            if excludes:
                count_lines.append(f"    .exclude({', '.join(excludes)})")
            count_lines.append("    .count()")
            return {"count": count, "ok": True, "orm": "\n".join(count_lines), "sql": _browse_sql(ctx)}
        except Exception:
            return {"error": traceback.format_exc(), "ok": False}


def _browse_capture():
    """Returns a context manager that records the SQL executed inside it (even when DEBUG is off)."""
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    return CaptureQueriesContext(connection)


def _browse_sql(ctx):
    """Returns a bounded list of executed SQL statements with their durations."""
    return [{"sql": query.get("sql", ""), "time": query.get("time", "")} for query in ctx.captured_queries[:50]]


def _orm_args(items):
    """Joins items as a Python argument list for the ORM command log."""
    return ", ".join(repr(item) for item in items)


def _browse_orm_clauses(filters, attnames):
    """Splits structured filters into Django .filter()/.exclude() kwarg strings for the command log."""
    includes, excludes = [], []
    for term in filters or []:
        if not isinstance(term, dict):
            continue
        field = term.get("field")
        lookup = term.get("lookup") or "exact"
        if field not in attnames or lookup not in _BROWSE_LOOKUPS:
            continue
        key = field if lookup == "exact" else f"{field}__{lookup}"
        (excludes if term.get("negate") else includes).append(f"{key}={term.get('value')!r}")
    return includes, excludes


def _browse_orm_rows(model, order, filters, attnames, pk_attname, keyset_capable, cursor, base_offset, limit):
    """Builds a readable Django ORM expression mirroring the executed rows query."""
    includes, excludes = _browse_orm_clauses(filters, set(attnames))
    lines = [f"{model.__name__}._base_manager", f"    .order_by({_orm_args(order)})"]
    if includes:
        lines.append(f"    .filter({', '.join(includes)})")
    if excludes:
        lines.append(f"    .exclude({', '.join(excludes)})")
    if keyset_capable and cursor is not None:
        lines.append(f"    .filter({pk_attname}__gt={cursor!r})")
    lines.append(f"    .values({_orm_args(attnames)})")
    end = limit + 1
    lines.append(f"    [{base_offset}:{base_offset + end}]" if (not keyset_capable and base_offset) else f"    [:{end}]")
    return "\n".join(lines)


def _browse_build_filters(model, filters, attnames):
    """Builds a safe Q filter; field and lookup are allowlisted and values stay ORM-parameterized (no injection)."""
    from django.db.models import Q

    query = Q()
    if not isinstance(filters, list):
        return query
    allowed = set(attnames)
    fields = {field.attname: field for field in model._meta.concrete_fields}
    for term in filters:
        if not isinstance(term, dict):
            continue
        field = term.get("field")
        lookup = term.get("lookup") or "exact"
        if field not in allowed or lookup not in _BROWSE_LOOKUPS:
            continue
        clause = Q(**{f"{field}__{lookup}": _browse_coerce_filter_value(lookup, term.get("value"), fields.get(field))})
        query &= ~clause if term.get("negate") else clause
    return query


def _browse_coerce_filter_value(lookup, value, field=None):
    """Coerces one filter value for lookups and field types that need a specific Python shape."""
    if lookup == "isnull":
        if isinstance(value, str):
            return value.strip().lower() not in ("", "false", "0", "no")
        return bool(value)
    if lookup in ("in", "range"):
        if isinstance(value, str):
            parts = [part.strip() for part in value.split(",") if part.strip() != ""]
        elif isinstance(value, (list, tuple)):
            parts = list(value)
        else:
            parts = [value]
        return parts[:2] if lookup == "range" else parts
    if isinstance(value, str) and field is not None and field.get_internal_type() == "BooleanField":
        return value.strip().lower() in ("true", "1", "t", "yes", "on")
    return value

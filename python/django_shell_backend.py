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
_RESPONSE_PREFIX = "__DJANGO_SHELL_BACKEND_RESPONSE__"
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


class _InspectionError:
    """Represents an attribute that exists but raised while inspection tried to read its value."""

    def __init__(self, error):
        """Stores a compact user-visible attribute read failure."""
        self.error = _truncate(repr(error), 240)


class _InspectionDeferred:
    """Represents an attribute that exists but was not evaluated during child-list inspection."""

    def __init__(self, label):
        """Stores the static descriptor kind for a lazily evaluated child."""
        self.label = label


def start(namespace, token):
    """Starts or reuses the backend server for the given interactive shell namespace."""
    try:
        # Bind common Django names and registered model classes before any initial-name snapshot; the slower module scan
        # remains configurable.
        autoimported = _autoimport_base_names(namespace)
        autoimported += _autoimport_registered_models(namespace)
        if _autoimport_enabled():
            autoimported += _autoimport_django_namespace(namespace)
        server = _STATE.get("server")
        if server is None:
            server = _Server((_bind_host(), 0), _Handler)
            server.initial_names = set(namespace)
            server.namespace = namespace
            _STATE["server"] = server
            threading.Thread(target=server.serve_forever, daemon=True).start()
        server.token = token
        host, port = server.server_address
        try:
            capture = _pty_install_capture(namespace)
        except Exception:
            capture = False
        # Wire the namespace helpers here (not in the typed bootstrap) so the bootstrap command stays short — well under the
        # tty canonical-input line limit — and the audit line carries no `_djs_rpc` lambda.
        namespace["_djs_backend_initial_names"] = server.initial_names
        namespace["_djs_rpc"] = lambda _djs_r, _djs_i: _pty_serve(namespace, token, _djs_r, _djs_i, namespace.get("_djs_backend_initial_names", set()))
        _print_marker(_READY_PREFIX, {"autoImported": autoimported, "cellCapture": bool(capture), "host": _connect_host(host), "ipython": _pty_is_ipython(), "port": port, "token": token})
    except Exception:
        _print_marker(_FAILED_PREFIX, {"error": traceback.format_exc()})


def _autoimport_enabled():
    """Returns whether startup should bind workspace Django models into the shell namespace."""
    return os.environ.get("DJANGO_SHELL_AUTOIMPORT_MODELS") == "1"


def _autoimport_django_namespace(namespace):
    """Binds Django base names and workspace model classes into the live shell namespace at startup, so
    names the editor resolves from its analysis prelude are actually importable in the shell. Best-effort:
    every failure is swallowed and never blocks startup, and names already bound are left untouched."""
    try:
        import importlib
        import inspect
    except Exception:
        return 0
    count = _autoimport_base_names(namespace)
    try:
        from django.apps import apps
        if not apps.ready:
            return count
    except Exception:
        return count
    # Bind every registered model directly first (guaranteed, no import) so models the module scan would miss
    # still resolve as bare names; the scan then adds managers/enums/etc. for editor-prelude parity.
    count += _autoimport_bind_models(namespace, apps)
    for module_name in _autoimport_model_modules(apps):
        try:
            module = importlib.import_module(module_name)
        except Exception:
            continue
        count += _autoimport_module_classes(namespace, module, inspect)
    return count


def _autoimport_registered_models(namespace):
    """Binds model classes already loaded in Django's app registry into the shell namespace."""
    try:
        from django.apps import apps

        if not apps.ready:
            return 0
        return _autoimport_bind_models(namespace, apps)
    except Exception:
        return 0


def _autoimport_bind_models(namespace, apps):
    """Binds every installed model class by its bare class name straight from the app registry, using the
    already-loaded class objects (no fresh import). This guarantees that models shell_plus skips, or whose
    defining module fails a standalone import, still resolve as bare names for ORM browsing. Names already
    bound win and are left untouched; failures are swallowed per-model so one bad model never blocks the rest."""
    count = 0
    try:
        models = apps.get_models()
    except Exception:
        return 0
    for model in models:
        try:
            name = model.__name__
        except Exception:
            continue
        if name and name not in namespace:
            namespace[name] = model
            count += 1
    return count


def _autoimport_base_names(namespace):
    """Binds common Django console names (django, apps, settings, models) when not already present."""
    count = 0
    for name, loader in (("django", _load_django), ("apps", _load_apps), ("settings", _load_settings), ("models", _load_models)):
        if name in namespace:
            continue
        try:
            namespace[name] = loader()
            count += 1
        except Exception:
            pass
    return count


def _load_django():
    import django
    return django


def _load_apps():
    from django.apps import apps
    return apps


def _load_settings():
    from django.conf import settings
    return settings


def _load_models():
    from django.db import models
    return models


def _autoimport_model_modules(apps):
    """Returns candidate model module names: every model's defining module plus each app's models module."""
    modules = set()
    try:
        for model in apps.get_models():
            module = getattr(model, "__module__", None)
            if module:
                modules.add(module)
    except Exception:
        pass
    try:
        for config in apps.get_app_configs():
            name = getattr(config, "name", None)
            if name:
                modules.add(name + ".models")
    except Exception:
        pass
    return sorted(modules)


def _autoimport_module_classes(namespace, module, inspect):
    """Binds every public class defined in one module into the namespace, mirroring the editor prelude's
    top-level-class scan; imported names and existing bindings are skipped."""
    count = 0
    module_name = getattr(module, "__name__", None)
    for name in dir(module):
        if name.startswith("_") or name in namespace:
            continue
        try:
            value = getattr(module, name)
        except Exception:
            continue
        if inspect.isclass(value) and getattr(value, "__module__", None) == module_name:
            namespace[name] = value
            count += 1
    return count


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
    if request.get("kind") == "filterfields":
        return _browse_filter_fields(request)
    if request.get("kind") == "rows":
        return _browse_rows(request)
    if request.get("kind") == "related":
        return _browse_related(request)
    if request.get("kind") == "count":
        return _browse_count(request)
    if request.get("kind") == "commit":
        return _browse_commit(request)
    if request.get("kind") == "lookup":
        return _browse_lookup(request)
    if request.get("kind") == "computed":
        return _browse_computed(request)
    if request.get("kind") == "query":
        return _browse_query(namespace, request)
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
        summary = _value_summary(name, value, [{"op": "name", "name": name}], origin, detailed=False)
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
        return items
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
        items.append(_value_summary(name, value, [{"op": "name", "name": name}], origin, detailed=False))
        if len(items) >= 1400:
            break
    return items


def _inspect_value_children(value, path):
    """Builds child summaries for mappings, sequences, modules, classes, and objects."""
    if _inspection_value_leaf_needed(value):
        return [_value_leaf_summary("value", value, path + [{"op": "value"}])]
    if isinstance(value, dict):
        return _dict_children(value, path)
    if isinstance(value, (list, tuple)):
        return _sequence_children(value, path)
    if isinstance(value, (set, frozenset)):
        return _sequence_children(list(value), path)
    if callable(getattr(value, "all", None)):
        return _all_children(value, path)
    model_mapping = _model_instance_attribute_mapping(value, evaluate_values=False)
    if model_mapping is not None:
        return _attribute_children(model_mapping, path)
    mapping = _attribute_mapping(value, evaluate_values=False)
    if mapping is not None:
        return _attribute_children(mapping, path)
    return []


def _dict_children(value, path):
    """Builds child summaries for dictionary values without evaluating keys."""
    children = []
    for index, (key, child) in enumerate(list(value.items())):
        name = f"[{_truncate(repr(key), 60)}]"
        children.append(_value_summary(name, child, path + [{"op": "dict", "index": index}]))
    return children


def _sequence_children(value, path):
    """Builds child summaries for indexable sequence values."""
    return [_value_summary(f"[{index}]", child, path + [{"op": "index", "index": index}]) for index, child in enumerate(list(value))]


def _all_children(value, path):
    """Builds child summaries for Django managers/querysets that are iterated through all()."""
    return [_value_summary(f"[{index}]", child, path + [{"op": "all_index", "index": index}]) for index, child in enumerate(list(value.all()))]


def _attribute_children(mapping, path):
    """Builds child summaries from an object's attribute dictionary."""
    children = []
    for name, child in sorted(mapping.items()):
        if name.startswith("__") and name.endswith("__"):
            continue
        children.append(_value_summary(name, child, path + [{"op": "attr", "name": name}], detailed=False))
    return children


def _value_summary(name, value, path, origin=None, detailed=True):
    """Builds one serializable runtime value summary."""
    summary = {"hasChildren": _has_children(value, detailed), "importLine": _import_line(name, value), "kind": _variable_kind(value), "name": name, "path": path, "preview": _preview_value(value), "type": _type_name(value), "typeImportLine": _type_import_line(name, value)}
    if detailed:
        summary.update(_inspection_metadata(value))
    if origin is not None:
        summary["origin"] = origin
    return summary


def _value_leaf_summary(name, value, path):
    """Builds a non-expandable child that displays a lazily evaluated value."""
    return {"hasChildren": False, "importLine": _import_line(name, value), "kind": _variable_kind(value), "name": name, "path": path, "preview": _preview_value(value), "type": _type_name(value), "typeImportLine": _type_import_line(name, value)}


def _inspection_value_leaf_needed(value):
    """Returns whether child inspection should show the value itself rather than only attributes."""
    if isinstance(value, _InspectionError):
        return True
    if isinstance(value, _InspectionDeferred):
        return False
    if isinstance(value, (type(None), bool, int, float, complex, str, bytes)):
        return True
    try:
        import datetime as _datetime
        import decimal as _decimal
        import uuid as _uuid

        return isinstance(value, (_decimal.Decimal, _datetime.datetime, _datetime.date, _datetime.time, _datetime.timedelta, _uuid.UUID))
    except Exception:
        return False


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
        name = segment["name"]
        model_mapping = _model_instance_attribute_mapping(value, evaluate_values=False)
        if isinstance(model_mapping, dict) and name in model_mapping:
            return _read_attr_value(value, name)
        mapping = _attribute_mapping(value, evaluate_values=False)
        if isinstance(mapping, dict) and name in mapping:
            return _read_attr_value(value, name)
        # Django relation descriptors (FK / reverse FK / M2M managers) and computed fields are listed as drill-down children
        # (via _meta in _browse_children_of) but are NOT in the safe attribute mapping (vars/dataclass/property); resolve them
        # directly so drilling into a relation works the same as the pure-expression path. _pty_safe_getattr never raises.
        return _pty_safe_getattr(value, name)
    if op == "index":
        try:
            return list(value)[segment["index"]]
        except TypeError:
            if callable(getattr(value, "all", None)):
                return list(value.all())[segment["index"]]
            raise
    if op == "all_index":
        return list(value.all())[segment["index"]]
    if op == "dict":
        return list(value.items())[segment["index"]][1]
    if op == "value":
        return value
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
    if isinstance(value, _InspectionError):
        return "error"
    if isinstance(value, _InspectionDeferred):
        return "deferred"
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


def _has_children(value, detailed=True):
    """Returns whether a runtime value has safe children to show in the tree."""
    if isinstance(value, _InspectionError):
        return False
    if isinstance(value, _InspectionDeferred):
        return True
    if isinstance(value, (dict, list, tuple, set, frozenset)):
        return len(value) > 0
    if not detailed:
        return _has_children_shallow(value)
    model_mapping = _model_instance_attribute_mapping(value)
    if model_mapping is not None:
        return bool(model_mapping)
    mapping = _attribute_mapping(value)
    return bool(mapping and any(not (name.startswith("__") and name.endswith("__")) for name in mapping))


def _has_children_shallow(value):
    """Returns a fast conservative child flag for top-level namespace summaries."""
    if isinstance(value, (type(None), bool, int, float, complex, str, bytes)):
        return False
    return True


def _inspection_metadata(value):
    """Returns exact static inspection metadata that does not evaluate arbitrary object values."""
    metadata = {}
    child_count = _child_count(value)
    if child_count is not None:
        metadata["childCount"] = child_count
        metadata["childrenTruncated"] = False
    collection_length = _collection_length(value)
    if collection_length is not None:
        metadata["length"] = collection_length
    django_model = _django_model_metadata(value)
    if django_model is not None:
        metadata["djangoModel"] = django_model
    if _has_dynamic_attribute_protocol(value):
        metadata["dynamicAttributes"] = True
    return metadata


def _child_count(value):
    """Returns the exact known child count for built-in containers and statically inspectable objects."""
    if isinstance(value, _InspectionError):
        return 0
    if isinstance(value, (dict, list, tuple, set, frozenset)):
        return len(value)
    model_mapping = _model_instance_attribute_mapping(value)
    if model_mapping is not None:
        return len(model_mapping)
    mapping = _attribute_mapping(value)
    if mapping is None:
        return None
    return len([name for name in mapping if not (name.startswith("__") and name.endswith("__"))])


def _collection_length(value):
    """Returns a collection length without issuing ORM queries or consuming iterators."""
    if isinstance(value, (dict, list, tuple, set, frozenset, str, bytes)):
        return len(value)
    return None


def _django_model_metadata(value):
    """Returns Django model identity metadata for model instances and model classes."""
    meta = getattr(value, "_meta", None)
    if meta is None:
        return None
    payload = {"app": getattr(meta, "app_label", ""), "model": getattr(meta, "object_name", ""), "table": getattr(meta, "db_table", "")}
    pk = getattr(meta, "pk", None)
    if pk is not None:
        payload["pk"] = getattr(pk, "attname", getattr(pk, "name", ""))
    if not isinstance(value, type):
        payload["pkValue"] = _browse_jsonable(_pty_safe_getattr(value, payload.get("pk"))) if payload.get("pk") else None
    return payload


def _has_dynamic_attribute_protocol(value):
    """Returns whether a value can synthesize attributes outside static metadata sources."""
    owner = value if inspect.isclass(value) else type(value)
    for name in ("__getattr__", "__getattribute__", "__dir__"):
        try:
            descriptor = inspect.getattr_static(owner, name)
        except Exception:
            continue
        module = getattr(descriptor, "__module__", "")
        if module not in ("builtins", ""):
            return True
    return False


def _model_instance_attribute_mapping(value, evaluate_values=False):
    """Returns Django model instance fields, relations, and computed attributes as inspector children."""
    names = _model_instance_attribute_names(value)
    if names is None:
        return None
    if not evaluate_values:
        data = getattr(value, "__dict__", {})
        return {name: data[name] if name in data else _InspectionDeferred(_model_instance_attribute_label(value, name)) for name in names}
    return {name: _read_attr_value(value, name) for name in names}


def _model_instance_attribute_label(value, name):
    """Returns a static display label for one Django model instance child."""
    if _pty_is_computed_field(type(value), name):
        return "property"
    return "attribute"


def _model_instance_attribute_names(value):
    """Returns ordered Django model instance child names, preserving raw foreign-key attnames."""
    if getattr(value, "_meta", None) is None or isinstance(value, type):
        return None
    names = []
    seen = set()

    def add(name):
        if isinstance(name, str) and name and not name.startswith("_") and name not in seen:
            names.append(name)
            seen.add(name)

    try:
        fields = value._meta.get_fields(include_hidden=True)
    except TypeError:
        fields = value._meta.get_fields()
    except Exception:
        fields = []
    for field in fields:
        try:
            if getattr(field, "auto_created", False) and not getattr(field, "concrete", False):
                accessor = field.get_accessor_name()
                if isinstance(accessor, str) and not accessor.endswith("+"):
                    add(accessor)
                continue
            add(getattr(field, "attname", None))
            add(getattr(field, "name", None))
        except Exception:
            continue
    for name in dir(type(value)):
        if _pty_is_computed_field(type(value), name):
            add(name)
    return names


def _attribute_mapping(value, evaluate_values=False):
    """Returns complete static member names and optionally reads their runtime values."""
    if not inspect.isclass(value):
        mapping = dict(_safe_vars(value) or {})
        _merge_dataclass_fields(value, mapping, evaluate_values)
        _merge_slot_values(value, mapping, evaluate_values)
        _merge_property_values(value, mapping, evaluate_values)
        _merge_annotation_values(value, mapping, evaluate_values)
        _merge_class_attribute_values(value, mapping, evaluate_values)
        _merge_static_dir_values(value, mapping, evaluate_values)
        return mapping or None
    merged = {}
    for cls in reversed(inspect.getmro(value)):
        mapping = _safe_vars(cls)
        if mapping:
            merged.update(mapping)
    _merge_dataclass_fields(value, merged, evaluate_values)
    return merged


def _set_mapped_attr_value(value, mapping, name, evaluate_values, fallback=None):
    """Adds one attribute name to a mapping and optionally reads its runtime value."""
    if name in mapping:
        return
    if not evaluate_values:
        mapping[name] = fallback
        return
    mapping[name] = _read_attr_value(value, name)


def _read_attr_value(value, name):
    """Reads one attribute value while preserving failures as inspection results."""
    try:
        return getattr(value, name)
    except Exception as error:
        return _InspectionError(error)


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
        if is_class:
            mapping[field.name] = _InspectionDeferred("dataclass field")
            continue
        if not evaluate_values:
            mapping[field.name] = _read_attr_value(value, field.name)
            continue
        mapping[field.name] = _read_attr_value(value, field.name)


def _merge_slot_values(value, mapping, evaluate_values):
    """Adds non-dataclass slot attributes that are absent from vars(obj)."""
    if inspect.isclass(value):
        return
    for name in _slot_names(type(value)):
        if name not in mapping:
            mapping[name] = _read_attr_value(value, name)


def _slot_names(cls):
    """Returns user-visible slot names declared across a class hierarchy."""
    names = []
    seen = set()
    for owner in reversed(inspect.getmro(cls)):
        slots = getattr(owner, "__slots__", ())
        if isinstance(slots, str):
            slots = (slots,)
        elif isinstance(slots, dict):
            slots = tuple(slots)
        for name in slots:
            if isinstance(name, str) and name not in ("__dict__", "__weakref__") and not (name.startswith("__") and name.endswith("__")) and name not in seen:
                names.append(name)
                seen.add(name)
    return names


def _merge_annotation_values(value, mapping, evaluate_values):
    """Adds annotated instance fields when they are not already visible through vars or slots."""
    if inspect.isclass(value):
        return
    for owner in reversed(inspect.getmro(type(value))):
        annotations = (_safe_vars(owner) or {}).get("__annotations__", {})
        if not isinstance(annotations, dict):
            continue
        for name, annotation in annotations.items():
            if isinstance(name, str) and not (name.startswith("__") and name.endswith("__")):
                _set_mapped_attr_value(value, mapping, name, evaluate_values, _InspectionDeferred("annotation"))


def _merge_class_attribute_values(value, mapping, evaluate_values):
    """Adds non-callable class-level fields for an instance without traversing methods."""
    if inspect.isclass(value):
        return
    for owner in reversed(inspect.getmro(type(value))):
        for name, descriptor in (_safe_vars(owner) or {}).items():
            if (name.startswith("__") and name.endswith("__")) or name in ("__annotations__", "__dict__", "__slots__", "__weakref__") or name in mapping:
                continue
            if not _is_static_field_descriptor(descriptor):
                continue
            _set_mapped_attr_value(value, mapping, name, evaluate_values, descriptor)


def _merge_static_dir_values(value, mapping, evaluate_values):
    """Adds remaining names reported by dir()/__dir__ so regular objects do not lose metadata."""
    for name in _safe_dir(value):
        if name in mapping or (name.startswith("__") and name.endswith("__")):
            continue
        try:
            descriptor = inspect.getattr_static(value, name)
        except Exception:
            descriptor = None
        _set_mapped_attr_value(value, mapping, name, evaluate_values, descriptor)


def _is_static_field_descriptor(descriptor):
    """Returns whether a class attribute looks like data, not a method or computed descriptor."""
    if isinstance(descriptor, (property, staticmethod, classmethod)) or type(descriptor).__name__ == "cached_property":
        return False
    if inspect.isroutine(descriptor) or inspect.isclass(descriptor) or callable(descriptor):
        return False
    if hasattr(descriptor, "__get__"):
        return False
    return True


def _merge_property_values(value, mapping, evaluate_values):
    """Adds property and cached-property names, reading values only for explicit child inspection."""
    for cls in reversed(inspect.getmro(type(value))):
        for name, descriptor in (_safe_vars(cls) or {}).items():
            if name in mapping or not (isinstance(descriptor, property) or type(descriptor).__name__ == "cached_property"):
                continue
            _set_mapped_attr_value(value, mapping, name, evaluate_values, _InspectionDeferred(type(descriptor).__name__))


def _safe_vars(value):
    """Returns an object's attribute dictionary without traversing properties."""
    try:
        return vars(value)
    except TypeError:
        return None


def _safe_dir(value):
    """Returns dir(value) without allowing a custom __dir__ failure to break inspection."""
    try:
        return sorted(set(dir(value)))
    except Exception:
        return []


def _inspect_modules():
    """Builds summaries for modules currently loaded in the Python process."""
    modules = []
    for name, module in sorted(sys.modules.items()):
        if not isinstance(module, types.ModuleType):
            continue
        modules.append({"file": str(getattr(module, "__file__", "") or ""), "name": name, "package": str(getattr(module, "__package__", "") or "")})
    return modules


def _type_name(value):
    """Returns a compact fully-qualified type name."""
    if isinstance(value, _InspectionError):
        return "inspection.error"
    if isinstance(value, _InspectionDeferred):
        return value.label
    value_type = type(value)
    module = value_type.__module__
    if module == "builtins":
        return value_type.__name__
    return f"{module}.{value_type.__name__}"


def _preview_value(value):
    """Returns a preview that avoids calling arbitrary object repr methods."""
    import datetime as _datetime
    import decimal as _decimal
    import uuid as _uuid

    if isinstance(value, _InspectionError):
        return f"<error: {value.error}>"
    if isinstance(value, _InspectionDeferred):
        return f"<{value.label}>"
    if isinstance(value, (type(None), bool, int, float, complex, str, bytes)):
        return _truncate(repr(value))
    if isinstance(value, (_decimal.Decimal, _datetime.datetime, _datetime.date, _datetime.time, _datetime.timedelta, _uuid.UUID)):
        return _truncate(str(value))
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


def _pty_is_ipython():
    """Returns whether the interactive shell is an IPython shell (exposes get_ipython)."""
    import builtins

    getter = getattr(builtins, "get_ipython", None)
    try:
        return bool(getter) and getter() is not None
    except Exception:
        return False


# Keep a cell response marker under the extension's 1.25 MB PTY read buffer: a larger marker loses its prefix to the
# buffer's tail-slice and never parses, hanging the serialized PTY request queue. Bounded reads pass through untouched.
_PTY_MARKER_LIMIT = 1000000
_PTY_CHUNK_LIMIT = 200000
_PROPERTY_FILTER_CHUNK_SIZE = 1000


def _pty_fit_response(response):
    """Shrinks an oversized cell response so its marker fits the PTY read buffer (a huge stdout/grid would otherwise jam
    the serialized PTY queue). Truncates the text fields, caps the SQL log, and KEEPS as many grid rows as fit (marking
    `truncated`/`hasMore`) instead of dropping the whole table. Only triggers for genuinely huge output."""
    notice = "\n... truncated by django-shell: output too large for the terminal transport — switch the link to Socket/Auto for large results ..."
    fitted = dict(response)
    # Cap the SQL log to 50 queries AND truncate each query's text: a single cell can run megabytes of SQL (e.g. a @property
    # with deeply nested subqueries), which alone could overrun the marker and force stdout truncation that corrupts a read
    # cell's parseable JSON. Bound it BEFORE the stdout/grid budget so the parseable payload survives.
    fitted["sql"] = [dict(entry, sql=_truncate(str(entry.get("sql", "")), 2000)) if isinstance(entry, dict) else entry for entry in (fitted.get("sql") or [])[:50]]
    for key in ("stdout", "stderr", "traceback"):
        value = fitted.get(key)
        if isinstance(value, str) and len(value) > 40000:
            fitted[key] = value[:40000] + notice
    grid = fitted.get("grid")
    if isinstance(grid, dict) and isinstance(grid.get("rows"), list) and grid["rows"]:
        rows = grid["rows"]
        base = len(json.dumps(dict(fitted, grid=dict(grid, rows=[]))))
        budget = _PTY_MARKER_LIMIT - base - 256
        sample_count = min(len(rows), 200)
        per_row = max(1, len(json.dumps(rows[:sample_count])) // sample_count)
        keep = max(1, min(len(rows), budget // per_row))
        fitted["grid"] = dict(grid, rows=rows[:keep], hasMore=True, truncated=True) if keep < len(rows) else grid
    else:
        fitted["grid"] = None
    return fitted


def _pty_cell_marker(cell_id, response):
    """Builds one or more `_djs_cell` response marker lines, chunking oversized responses without dropping inspection data."""
    payload = json.dumps({"id": cell_id, "response": response})
    if len(payload) > _PTY_MARKER_LIMIT:
        fitted_payload = json.dumps({"id": cell_id, "response": _pty_fit_response(response)})
        if len(fitted_payload) <= _PTY_MARKER_LIMIT:
            return _RESPONSE_PREFIX + fitted_payload
        response_payload = json.dumps(response)
        chunks = [response_payload[index:index + _PTY_CHUNK_LIMIT] for index in range(0, len(response_payload), _PTY_CHUNK_LIMIT)]
        count = len(chunks)
        return "\n".join(_RESPONSE_PREFIX + json.dumps({"chunk": {"count": count, "data": chunk, "index": index}, "id": cell_id}) for index, chunk in enumerate(chunks))
    return _RESPONSE_PREFIX + payload


def _pty_emit_cell(counter, ok, result_repr, out, err, tb, grid=None, sql=None, inspect=None):
    """Prints one response marker for a literal code cell run in the interactive shell (grid = ORM-mode rows; inspect = pure-expression drill-down child summaries)."""
    response = {"grid": grid, "inspect": inspect, "ok": ok, "result": result_repr, "sql": sql or [], "stderr": err, "stdout": out, "traceback": tb}
    raw = _STATE.pop("pty_raw_metadata", None)
    if isinstance(raw, dict):
        response.update(raw)
    print(_pty_cell_marker("_djs_cell-%d" % counter, response), flush=True)


def _pty_orm_inspect(limit=None):
    """Attaches runtime-variable metadata for ORM-mode inspection helper cells."""
    _STATE["pty_raw_metadata"] = {"runtime": _pty_runtime_inspection(_STATE["server"].namespace, limit)}
    return None


def _pty_runtime_inspection(namespace, limit=None):
    """Returns runtime-variable metadata for top-level namespace inspection."""
    initial = namespace.get("_djs_initial_names", frozenset())
    items = [(k, v) for k, v in sorted(namespace.items()) if not k.startswith("_")]
    ordered = [kv for kv in items if kv[0] not in initial] + [kv for kv in items if kv[0] in initial]
    variables = []
    limit_value = None if limit is None else max(0, int(limit))
    for name, value in (ordered if limit_value is None else ordered[:limit_value]):
        try:
            variables.append(_value_summary(name, value, [{"op": "name", "name": name}], _variable_origin(name, initial), detailed=False))
        except Exception:
            pass
    return {"loadedModuleCount": len(sys.modules), "variables": variables}


def _pty_is_models_probe(raw):
    """Returns whether the cell is the pure Python model-catalog probe typed by the extension."""
    return (raw or "").strip() == "len(apps.get_models())"


def _pty_is_runtime_probe(raw):
    """Returns whether the cell is the pure Python runtime-inspection probe typed by the extension."""
    return (raw or "").strip() == "len(globals())"


def _pty_looks_like_model_cell(raw):
    """Returns whether a raw cell likely needs bare Django model names to be bound before execution."""
    text = raw or ""
    return "._base_manager" in text or "._meta" in text


def _pty_inspect_probe_target(raw, namespace):
    """Returns (matched, value, error) for pure `dir(expr)` / `len(expr)` inspection probe cells."""
    try:
        tree = ast.parse((raw or "").strip(), mode="eval")
    except Exception:
        return False, None, None
    call = tree.body
    if not isinstance(call, ast.Call) or len(call.args) != 1 or call.keywords:
        return False, None, None
    if not isinstance(call.func, ast.Name) or call.func.id not in ("dir", "len"):
        return False, None, None
    target = call.args[0]
    if call.func.id == "len" and isinstance(target, ast.Call) and isinstance(target.func, ast.Name) and target.func.id == "globals":
        return False, None, None
    if not _pty_safe_inspect_expr(target):
        return False, None, None
    try:
        return True, _pty_resolve_inspect_expr(target, namespace), None
    except Exception as error:
        return True, _InspectionError(error), None


def _pty_resolve_inspect_expr(node, namespace):
    """Resolves a safe inspector AST expression through the same lazy path rules as the structured helper."""
    if isinstance(node, ast.Name):
        return namespace[node.id]
    if isinstance(node, ast.Attribute):
        value = _pty_resolve_inspect_expr(node.value, namespace)
        return value if isinstance(value, _InspectionError) else _resolve_child(value, {"op": "attr", "name": node.attr})
    if isinstance(node, ast.Subscript):
        value = _pty_resolve_inspect_expr(node.value, namespace)
        return value if isinstance(value, _InspectionError) else _resolve_child(value, {"op": "index", "index": node.slice.value})
    if isinstance(node, ast.Call):
        return _pty_resolve_inspect_call(node, namespace)
    raise ValueError("Unsupported runtime inspector expression.")


def _pty_resolve_inspect_call(node, namespace):
    """Resolves one safe inspector helper call without evaluating arbitrary functions."""
    if isinstance(node.func, ast.Name) and node.func.id == "list":
        value = _pty_resolve_inspect_expr(node.args[0], namespace)
        return value if isinstance(value, _InspectionError) else list(value)
    if isinstance(node.func, ast.Attribute) and node.func.attr == "items":
        value = _pty_resolve_inspect_expr(node.func.value, namespace)
        return value if isinstance(value, _InspectionError) else value.items()
    if isinstance(node.func, ast.Attribute) and node.func.attr == "all":
        value = _pty_resolve_inspect_expr(node.func.value, namespace)
        return value if isinstance(value, _InspectionError) else value.all()
    raise ValueError("Unsupported runtime inspector call.")


def _pty_safe_inspect_expr(node):
    """Returns whether an AST expression is a safe path expression generated by the inspector."""
    if isinstance(node, ast.Name):
        return True
    if isinstance(node, ast.Attribute):
        return _pty_safe_inspect_expr(node.value)
    if isinstance(node, ast.Subscript):
        return _pty_safe_inspect_expr(node.value) and _pty_safe_inspect_slice(node.slice)
    if isinstance(node, ast.Call):
        return _pty_safe_inspect_call(node)
    return False


def _pty_safe_inspect_slice(node):
    """Returns whether an AST subscript slice is a non-negative integer index."""
    return isinstance(node, ast.Constant) and isinstance(node.value, int) and node.value >= 0


def _pty_safe_inspect_call(node):
    """Returns whether an AST call is one of the path reconstruction helpers: list(x), x.items(), or x.all()."""
    if node.keywords:
        return False
    if isinstance(node.func, ast.Name) and node.func.id == "list" and len(node.args) == 1:
        return _pty_safe_inspect_expr(node.args[0])
    if isinstance(node.func, ast.Attribute) and node.func.attr == "items" and not node.args:
        return _pty_safe_inspect_expr(node.func.value)
    if isinstance(node.func, ast.Attribute) and node.func.attr == "all" and not node.args:
        return _pty_safe_inspect_expr(node.func.value)
    return False


def _pty_safe_getattr(obj, name):
    """getattr that never raises (a Django RelatedObjectDoesNotExist subclasses AttributeError → None for missing relations)."""
    try:
        return getattr(obj, name)
    except Exception:
        return None


def _pty_is_computed_field(owner, name):
    """Returns whether owner.name is a computed-field descriptor: @property OR @cached_property (Django's `django.utils.functional.cached_property` and `functools.cached_property` both have type name 'cached_property') — so the drill-down shows computed/derived fields, not just DB columns."""
    try:
        descriptor = inspect.getattr_static(owner, name)
    except Exception:
        descriptor = getattr(owner, name, None)
    return isinstance(descriptor, property) or type(descriptor).__name__ == "cached_property"


def _browse_children_of(value, base_path, n=None):
    """Builds child summaries for an ALREADY-RESOLVED object (rich drill-down: dict/sequence items, manager/queryset
    rows, a Django model instance's fields + reverse relations + @property values, else __dict__ attrs). Each child's path is
    base_path + [segment]; pass base_path=[] (relative) when the result object came from a bare expression typed by the
    extension (which prepends the path it asked for), or the resolved path when called from the path-resolving helper."""
    v = value
    limit = None if n is None else max(0, int(n))
    def bounded(items):
        """Returns all items unless a legacy explicit limit was supplied."""
        return list(items) if limit is None else list(items)[:limit]
    if _inspection_value_leaf_needed(v):
        src = [("value", v, {"op": "value"})]
    elif isinstance(v, dict):
        src = [("[" + repr(k)[:60] + "]", cv, {"op": "dict", "index": i}) for i, (k, cv) in enumerate(bounded(v.items()))]
    elif isinstance(v, (list, tuple, set, frozenset)):
        src = [("[" + str(i) + "]", cv, {"op": "index", "index": i}) for i, cv in enumerate(bounded(v))]
    elif callable(getattr(v, "all", None)):
        values = v.all() if limit is None else v.all()[:limit]
        src = [("[" + str(i) + "]", cv, {"op": "all_index", "index": i}) for i, cv in enumerate(list(values))]
    elif getattr(v, "_meta", None) is not None and not isinstance(v, type):
        names = _model_instance_attribute_names(v) or []
        mapping = _model_instance_attribute_mapping(v, evaluate_values=False) or {}
        src = [(nm, mapping.get(nm), {"op": "attr", "name": nm}) for nm in bounded([name for name in names if name and not name.startswith("_")])]
    else:
        mapping = _attribute_mapping(v, evaluate_values=False) or {}
        src = [(a, cv, {"op": "attr", "name": a}) for a, cv in bounded([(name, child) for name, child in sorted(mapping.items()) if not (name.startswith("__") and name.endswith("__"))])]
    children = []
    for nm, cv, seg in src:
        try:
            summary = _value_leaf_summary(nm, cv, base_path + [seg]) if seg.get("op") == "value" else _value_summary(nm, cv, base_path + [seg], None)
            children.append(summary)
        except Exception:
            pass
    return children


def _pty_is_name_chain(raw):
    """Returns whether a typed cell is a bare name or dotted attribute chain (`a`, `a.b.c`) — the cells the extension types for a pure-expression inspector drill-down. Used to gate the hook's inspect-children computation so heavy console/grid cells (calls/subscripts) are never inspected."""
    stripped = (raw or "").strip()
    parts = [part.strip() for part in stripped.split(".")]
    return bool(stripped) and all(part.isidentifier() and not keyword.iskeyword(part) for part in parts)


def _pty_orm_children(path_json, limit=None):
    """Attaches child-summary metadata for ORM-mode inspection drill-down helper cells."""
    namespace = _STATE["server"].namespace
    try:
        path = json.loads(path_json)
        children = _browse_children_of(_resolve_path(namespace, path), [], limit)
    except Exception:
        _STATE["pty_raw_metadata"] = {"inspect": {"children": [], "error": traceback.format_exc()}}
        return None
    _STATE["pty_raw_metadata"] = {"inspect": {"children": children}}
    return None


def _pty_sql_begin(state):
    """Forces a debug cursor and snapshots the query log so a cell's SQL can be captured under any DEBUG setting."""
    try:
        from django.db import connection

        state["sql_force"] = connection.force_debug_cursor
        connection.force_debug_cursor = True
        state["sql0"] = len(connection.queries_log)
    except Exception:
        state["sql0"] = None


def _pty_sql_end(state):
    """Restores the debug-cursor flag and returns the SQL captured since _pty_sql_begin (bounded, best-effort)."""
    try:
        from django.db import connection

        if "sql_force" in state:
            connection.force_debug_cursor = state["sql_force"]
        if state.get("sql0") is None:
            return []
        return [{"sql": query.get("sql", ""), "time": query.get("time", "")} for query in connection.queries[state["sql0"]:state["sql0"] + 200]]
    except Exception:
        return []


def _pty_tabulate_result(value):
    """Serializes a cell result into a rich grid for ORM mode (instance QuerySet/instance -> editable
    columns/relations/rows), reusing the model-browser helpers; any other value (lists/dicts/scalars,
    e.g. an ORM query console result) is tabulated read-only via _browse_tabulate so the Terminal-mode
    query console matches the socket path; returns None only for None or on error."""
    if value is None:
        return None
    try:
        import itertools

        from django.db.models import Model, QuerySet
        from django.db.models.query import ModelIterable

        if isinstance(value, QuerySet) and value._iterable_class is ModelIterable and not value.query.values_select:
            model = value.model
            concrete_names = [column["attname"] for column in _browse_columns(model)]
            rows = [_browse_serialize_row({attname: getattr(instance, attname, None) for attname in concrete_names}) for instance in itertools.islice(value, 50001)]
            return {"app": model._meta.app_label, "columns": _browse_columns(model) + _browse_computed_columns(model), "editable": True, "hasMore": False, "model": model._meta.object_name, "ok": True, "pk": model._meta.pk.attname, "relations": _browse_relations(model), "rows": rows}
        if isinstance(value, Model):
            model = type(value)
            concrete_names = [column["attname"] for column in _browse_columns(model)]
            row = _browse_serialize_row({attname: getattr(value, attname, None) for attname in concrete_names})
            return {"app": model._meta.app_label, "columns": _browse_columns(model) + _browse_computed_columns(model), "editable": True, "hasMore": False, "model": model._meta.object_name, "ok": True, "pk": model._meta.pk.attname, "relations": _browse_relations(model), "rows": [row]}
        if isinstance(value, QuerySet):
            payload = _browse_tabulate(list(itertools.islice(value, 50001)), 0, 50000)
            payload["ok"] = True
            payload.setdefault("relations", [])
            return payload
        payload = _browse_tabulate(value, 0, 50000)
        payload["ok"] = True
        payload.setdefault("relations", [])
        return payload
    except Exception:
        return None
    return None


def _pty_install_capture(namespace):
    """Installs a per-cell capture hook so the extension can type a user's literal code cell (keeping the
    shell's raw_cell pure) while the cell's output is captured and emitted as a backend response marker.
    Uses IPython run-cell events when available, otherwise a sys.ps1 hook for the plain Python REPL."""
    import builtins
    import sys

    # Snapshot the shell-startup names so ORM-mode inspect cells can tell user variables from pre-existing ones.
    try:
        namespace.setdefault("_djs_initial_names", frozenset(namespace.keys()))
    except Exception:
        pass
    getter = getattr(builtins, "get_ipython", None)
    try:
        shell = getter() if getter else None
    except Exception:
        shell = None
    if shell is not None:
        return _pty_install_ipython_capture(shell)
    return _pty_install_plain_capture(sys)


def _pty_install_ipython_capture(shell):
    """Captures each IPython cell's output via run-cell events and emits a response marker."""
    import io
    import sys

    if getattr(shell, "_djs_capture", False):
        return True
    try:
        shell.user_ns.setdefault("_djs_initial_names", frozenset(shell.user_ns.keys()))
    except Exception:
        pass
    state = {"counter": 0, "err": None, "out": None, "save": None, "skip": False, "scrub": False}

    def _pre(info):
        if str(getattr(info, "raw_cell", "") or "").lstrip().startswith("_djs_rpc("):
            state["skip"] = True  # plumbing cell: let its own marker print through untouched
            return
        state["skip"] = False
        state["raw"] = str(getattr(info, "raw_cell", "") or "")
        if _pty_looks_like_model_cell(state["raw"]):
            _autoimport_registered_models(shell.user_ns)
        # Introspection plumbing (inspect/children call a backend helper): capture+emit its marker like a normal cell, but drop it from history afterwards so it stays out of the interactive shell.
        state["scrub"] = "_djs_backend_module._pty_orm_" in state["raw"]
        state["out"], state["err"] = io.StringIO(), io.StringIO()
        state["save"] = (sys.stdout, sys.stderr)
        sys.stdout, sys.stderr = state["out"], state["err"]
        _pty_sql_begin(state)

    def _post(result):
        if state.get("skip"):
            state["skip"] = False
            return
        if not state["save"]:
            return  # _pre never ran: this is the bootstrap cell that registered the hook mid-execution; it captured nothing, and emitting an empty marker here would desync the FIFO response queue (the first ORM read would consume it instead of its own cell's output)
        sys.stdout, sys.stderr = state["save"]
        out = state["out"].getvalue() if state["out"] else ""
        err = state["err"].getvalue() if state["err"] else ""
        state["out"] = state["err"] = state["save"] = None
        error = getattr(result, "error_in_exec", None) or getattr(result, "error_before_exec", None)
        tb = "".join(traceback.format_exception(type(error), error, getattr(error, "__traceback__", None))) if error is not None else ""
        value = getattr(result, "result", None)
        inspect = None
        matched_probe, probe_value, probe_error = _pty_inspect_probe_target(state.get("raw"), shell.user_ns)
        inspection_probe = matched_probe or (error is None and (_pty_is_models_probe(state.get("raw")) or _pty_is_runtime_probe(state.get("raw"))))
        if inspection_probe:
            out = ""
            err = ""
        eval_tb = ""
        result_repr = None
        grid = None
        if not inspection_probe and error is None:
            try:
                # The cell statement already ran; computing its repr/grid here forces any deferred work
                # (e.g. a lazy QuerySet hitting the DB), which can raise. Catch it so the failure becomes
                # this cell's error instead of escaping post_run_cell -- an escape skips _pty_emit_cell,
                # leaving the ORM read with no marker (it hangs / desyncs the FIFO) and double-faults when
                # IPython then reprs the ExecutionResult to build its "Error in callback" message.
                if value is not None:
                    result_repr = _truncate(repr(value), 4000)
                grid = _pty_tabulate_result(value)
            except Exception:
                eval_tb = traceback.format_exc()
                result_repr = None
                grid = None
        if matched_probe:
            if probe_error:
                inspect = {"children": [], "error": probe_error}
            else:
                try:
                    inspect = {"children": _browse_children_of(probe_value, [])}
                except Exception:
                    inspect = {"children": [], "error": traceback.format_exc()}
        raw_metadata = {}
        if error is None and _pty_is_models_probe(state.get("raw")):
            _autoimport_registered_models(shell.user_ns)
            raw_metadata["models"] = _browse_models()
        if error is None and _pty_is_runtime_probe(state.get("raw")):
            raw_metadata["runtime"] = _pty_runtime_inspection(shell.user_ns)
        if raw_metadata:
            _STATE["pty_raw_metadata"] = raw_metadata
        sql = _pty_sql_end(state)
        state["counter"] += 1
        marker_ok = (error is None and not eval_tb) or matched_probe
        _pty_emit_cell(state["counter"], marker_ok, result_repr, out, err, eval_tb or ("" if matched_probe else tb), grid, sql, inspect)
        if state.get("scrub"):
            state["scrub"] = False
            try:
                _pty_history_scrub(None)  # introspection plumbing: keep it out of the interactive shell history (counter/sqlite handled by the scrub)
            except Exception:
                pass

    shell.events.register("pre_run_cell", _pre)
    shell.events.register("post_run_cell", _post)
    shell._djs_capture = True
    return True


def _pty_install_plain_capture(sys):
    """Captures each plain-REPL cell's output by teeing stdout/stderr and emitting a marker on every prompt
    (the REPL calls str(sys.ps1) once per cell boundary). raw_cell stays the user's literal command."""
    if getattr(sys, "_djs_capture", False):
        return True
    real_out = sys.stdout
    state = {"counter": 0, "first": True, "out": [], "err": [], "result": None}

    class _Tee(object):
        def __init__(self, real, buf):
            self._real = real
            self._buf = buf

        def write(self, text):
            try:
                self._buf.append(text)
            except Exception:
                pass
            return self._real.write(text)

        def flush(self):
            try:
                self._real.flush()
            except Exception:
                pass

        def __getattr__(self, name):
            return getattr(self._real, name)

    class _Ps1(object):
        def __str__(self):
            out = "".join(state["out"])
            err = "".join(state["err"])
            del state["out"][:]
            del state["err"][:]
            if state["first"]:
                state["first"] = False
                return ">>> "
            value = state["result"]
            state["result"] = None
            if _RESPONSE_PREFIX in out:
                return ">>> "  # plumbing cell (_djs_rpc): its marker already went through, don't double-emit
            ok = "Traceback (most recent call last)" not in err
            grid = _pty_tabulate_result(value) if ok else None
            state["counter"] += 1
            # Write straight to the real stream so the marker is not re-captured by the tee.
            real_out.write(_pty_cell_marker("_djs_cell-%d" % state["counter"], {"grid": grid, "ok": ok, "result": None, "stderr": "" if ok else err, "stdout": out, "traceback": err if not ok else ""}) + "\n")
            real_out.flush()
            return ">>> "

    real_displayhook = sys.displayhook

    def _display(value):
        state["result"] = value  # capture this cell's expression result for ORM-mode grid serialization
        real_displayhook(value)  # keep default behavior (repr to stdout, bind builtins._)

    sys.stdout = _Tee(real_out, state["out"])
    sys.stderr = _Tee(sys.stderr, state["err"])
    sys.displayhook = _display
    sys.ps1 = _Ps1()
    sys._djs_capture = True
    return True


def _pty_serve(namespace, token, request_json, request_id, initial_names):
    """Services one PTY-fallback request, prints the response marker, then keeps the interactive
    shell history clean: the user's executed ORM (execute/query) stays as a tidy line, while the
    extension's plumbing (grid/inspect/keepalive/bootstrap) is removed from history and the counter."""
    try:
        request = json.loads(request_json)
    except Exception:
        request = {}
    response = _run_request(namespace, token, request, initial_names)
    if isinstance(response, dict):
        limit = 750000
        for key in ("stdout", "stderr", "result", "traceback", "error"):
            value = response.get(key)
            if isinstance(value, str) and len(value) > limit:
                response[key] = value[:limit] + "\n... truncated by django-shell PTY fallback ..."
    print(_RESPONSE_PREFIX + json.dumps({"id": request_id, "response": response}), flush=True)
    _pty_history_scrub(_pty_visible_command(request, response))


def _pty_visible_command(request, response):
    """Returns the clean command to leave in shell history for a PTY request: the user's code for
    execute/query, the reconstructed Django ORM expression for grid reads (rows/related/count/commit),
    or None for pure metadata/inspection plumbing (schema/models/lookup/inspect/...) which is dropped."""
    kind = request.get("kind") if isinstance(request, dict) else None
    if kind in ("execute", "query"):
        candidate = request.get("code")
    elif isinstance(response, dict):
        candidate = response.get("orm")
    else:
        candidate = None
    return candidate if isinstance(candidate, str) and candidate.strip() else None


def _pty_history_scrub(visible):
    """Replaces the just-run RPC line in shell history with the clean executed query, or drops it (best-effort)."""
    import builtins

    getter = getattr(builtins, "get_ipython", None)
    try:
        shell = getter() if getter else None
    except Exception:
        shell = None
    if shell is not None:
        _pty_scrub_ipython(shell, visible)
    else:
        _pty_scrub_readline(visible)


def _pty_scrub_ipython(shell, visible):
    """Scrubs the just-run RPC cell from IPython history. A kept command (visible) is relabelled to the
    clean query in memory and on disk; pure plumbing is dropped from memory, the execution counter, and
    the SQLite history so the freed (session, line) cannot later collide when the counter reuses it."""
    try:
        history = shell.history_manager
        line_num = int(shell.execution_count)
        last_is_rpc = bool(getattr(history, "input_hist_raw", None)) and _pty_is_rpc_line(history.input_hist_raw[-1])
    except Exception:
        return
    if not last_is_rpc:
        return
    if visible:
        for attr in ("input_hist_parsed", "input_hist_raw"):
            sequence = getattr(history, attr, None)
            if sequence:
                sequence[-1] = visible
        _pty_rewrite_ipython_db(history, line_num, visible)
        return
    # Dropping plumbing requires freeing its on-disk (session, line) first; if that fails, leave the line
    # in place rather than rolling the counter back into a duplicate that corrupts IPython history logging.
    if not _pty_forget_ipython_db(history, line_num):
        return
    for attr in ("input_hist_parsed", "input_hist_raw"):
        sequence = getattr(history, attr, None)
        if sequence and _pty_is_rpc_line(sequence[-1]):
            sequence.pop()
    try:
        shell.execution_count = max(1, int(shell.execution_count) - 1)
    except Exception:
        pass


def _pty_forget_ipython_db(history, line_num):
    """Erases a dropped plumbing line from IPython's SQLite history (pending write caches plus the input
    and output tables) so its (session, line) is free to reuse. Returns True only when the on-disk row is
    gone, letting the caller roll the counter back without risking the unique-key clash that the
    'Session/line number was not unique in database' error reports."""
    try:
        with history.db_input_cache_lock:
            history.db_input_cache[:] = [row for row in history.db_input_cache if row[0] != line_num]
        with history.db_output_cache_lock:
            history.db_output_cache[:] = [row for row in history.db_output_cache if row[0] != line_num]
        session = int(history.session_number)
        connection = history.db
        with connection:
            connection.execute("DELETE FROM history WHERE session=? AND line=?", (session, line_num))
            connection.execute("DELETE FROM output_history WHERE session=? AND line=?", (session, line_num))
        return True
    except Exception:
        return False


def _pty_rewrite_ipython_db(history, line_num, visible):
    """Flushes pending history then rewrites a kept line's stored source to the clean query so a later
    session's %history matches the in-memory display. The live pre_run_cell hook still sees the originally
    typed cell, which is why ORM mode types real ORM instead of relying on this after-the-fact rewrite."""
    try:
        history.writeout_cache()
    except Exception:
        pass
    try:
        session = int(history.session_number)
        connection = history.db
        with connection:
            connection.execute("UPDATE history SET source=?, source_raw=? WHERE session=? AND line=?", (visible, visible, session, line_num))
    except Exception:
        pass


def _pty_scrub_readline(visible):
    """Removes the RPC line from readline history; reinserts the clean query for the plain Python REPL."""
    try:
        import readline

        count = readline.get_current_history_length()
        if count > 0 and _pty_is_rpc_line(readline.get_history_item(count)):
            readline.remove_history_item(count - 1)
            if visible:
                readline.add_history(visible)
    except Exception:
        pass


def _pty_is_rpc_line(line):
    """Returns whether a history line is django-shell RPC/bootstrap plumbing (never a user command)."""
    text = str(line or "").lstrip()
    return text.startswith("_djs_rpc(") or (text.startswith("exec(") and "_djs_" in text)


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
            return {"app": meta.app_label, "columns": _browse_columns(model) + _browse_computed_columns(model), "label": str(meta.verbose_name), "model": meta.object_name, "ok": True, "pk": meta.pk.attname, "relations": _browse_relations(model), "table": meta.db_table}
        except Exception:
            return {"ok": False, "error": traceback.format_exc()}


def _browse_rows(request):
    """Returns one bounded page of rows using concrete columns only (no JOIN, no N+1)."""
    with _EXECUTION_LOCK:
        try:
            model = _browse_resolve_model(request)
            columns = _browse_columns(model) + _browse_computed_columns(model)
            attnames = [column["attname"] for column in _browse_columns(model)]
            pk_attname = model._meta.pk.attname
            limit = _browse_limit(request.get("limit"), maximum=None)
            order = _browse_order(request.get("order"), attnames, pk_attname)
            keyset_capable = order == [pk_attname]
            queryset, property_terms = _browse_apply_db_filters(model._base_manager.all().order_by(*order), model, request.get("filters"), attnames)
            cursor = request.get("cursor")
            offset = request.get("offset")
            base_offset = offset if isinstance(offset, int) and offset > 0 else 0
            if keyset_capable and cursor is not None:
                queryset = queryset.filter(**{f"{pk_attname}__gt": cursor})
            elif not keyset_capable and base_offset and not property_terms:
                queryset = queryset[base_offset:]
            with _browse_capture() as ctx:
                if property_terms:
                    objects = list(_browse_islice(_browse_python_filter_iter(queryset, property_terms), base_offset, base_offset + limit + 1))
                    raw = [{attname: getattr(obj, attname, None) for attname in attnames} for obj in objects]
                else:
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


def _browse_declared_annotations(model):
    """Returns the model's declared {computed_field: DB-annotation expression} map (from a `djshell_annotations` dict or classmethod). A @property is arbitrary Python (can't be auto-translated to SQL), so a model opts a computed column into a SINGLE annotated query — instead of per-row @property N+1 — by declaring its equivalent ORM expression here. Empty on absence/error."""
    source = getattr(model, "djshell_annotations", None)
    if source is None:
        return {}
    try:
        mapping = source() if callable(source) else source
        return mapping if isinstance(mapping, dict) else {}
    except Exception:
        return {}


def _browse_computed_columns(model):
    """Returns read-only column descriptors for a model's @property / @cached_property attributes (computed, not DB-backed); `annotated=True` marks the ones the model declares a DB annotation for (loaded in one query, not per-row)."""
    reserved = {field.attname for field in model._meta.concrete_fields}
    reserved.update(field.name for field in model._meta.get_fields())
    reserved.add("pk")
    declared = set(_browse_declared_annotations(model))
    columns = []
    for name in sorted(dir(model)):
        if len(columns) >= 40:
            break
        if name.startswith("_") or name in reserved or not _pty_is_computed_field(model, name):
            continue
        columns.append({"annotated": name in declared, "attname": name, "computed": True, "editable": False, "name": name, "null": True, "pk": False, "type": "property"})
    return columns


def _browse_computed(request):
    """Lazily computes ONE @property over the current filter/order page — the opt-in replacement for eager-loading. The user activates a single column, so only that property runs (no N+1 across every property, no multi-model JOIN explosion), bounded to the loaded rows. Restricted to actual @property/@cached_property names; each value read via safe getattr so a throwing property yields null, not a failure. Returns {pk: cell}."""
    with _EXECUTION_LOCK:
        try:
            model = _browse_resolve_model(request)
            field = request.get("field")
            if not isinstance(field, str) or not field.isidentifier() or not _pty_is_computed_field(model, field):
                return {"ok": False, "error": "not a computed field", "values": {}}
            attnames = [column["attname"] for column in _browse_columns(model)]
            order = _browse_order(request.get("order"), attnames, model._meta.pk.attname)
            limit = _browse_limit(request.get("limit"), maximum=None)
            queryset, property_terms = _browse_apply_db_filters(model._base_manager.all().order_by(*order), model, request.get("filters"), attnames)
            # Capture only the query COUNT (never the SQL text — serializing it bloated the marker and corrupted the parseable
            # JSON; see the SQL-heavy @property bugfix). queryCount makes the cost verifiable: ≈ 1 with a declared annotation
            # (single SQL query), >> rowCount for a per-row @property (N+1).
            annotations = _browse_declared_annotations(model)
            if field in annotations:
                # The model declared a DB annotation for this field → compute it in ONE SQL query instead of per-row Python.
                if property_terms:
                    with _browse_capture() as ctx:
                        values = {_browse_jsonable(obj.pk): _browse_cell(_pty_safe_getattr(obj, field)) for obj in _browse_islice(_browse_python_filter_iter(queryset, property_terms), 0, limit)}
                    return {"field": field, "ok": True, "queryCount": len(ctx.captured_queries), "rowCount": len(values), "values": values}
                with _browse_capture() as ctx:
                    rows = list(queryset.annotate(__djs=annotations[field]).values_list("pk", "__djs")[:limit])
                values = {_browse_jsonable(pk): _browse_cell(value) for pk, value in rows}
                return {"annotated": True, "field": field, "ok": True, "queryCount": len(ctx.captured_queries), "rowCount": len(values), "values": values}
            with _browse_capture() as ctx:
                source = _browse_python_filter_iter(queryset, property_terms) if property_terms else queryset[:limit]
                values = {_browse_jsonable(obj.pk): _browse_cell(_pty_safe_getattr(obj, field)) for obj in _browse_islice(source, 0, limit)}
            return {"field": field, "ok": True, "queryCount": len(ctx.captured_queries), "rowCount": len(values), "values": values}
        except Exception:
            return {"ok": False, "error": traceback.format_exc(), "values": {}}


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
        # `name` is the accessor (used to expand related rows); `queryName` is the filter query name (reverse
        # relations differ — related_query_name, not the `_set` accessor) so traversal filters resolve correctly.
        relations.append({"kind": _browse_relation_kind(field), "name": name, "queryName": _browse_relation_query_name(field) or name, "single": single, "target": _browse_label(field.related_model)})
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
    """Returns the accessor name for reverse relations or the field name for forward ones (None for hidden relations whose related_name ends in '+', which have no usable accessor)."""
    if field.auto_created and not getattr(field, "concrete", False):
        try:
            name = field.get_accessor_name()
        except Exception:
            return None
        return name if name and not name.endswith("+") else None
    return field.name


def _browse_relation_query_name(field):
    """Returns the name used INSIDE .filter() to span this relation. Forward FK/O2O/M2M use the field name; reverse relations use related_query_name() (the lowercased model name by default), NOT the `_set` accessor name. Hidden relations (related_name ending '+') return None — they cannot be queried."""
    if field.auto_created and not getattr(field, "concrete", False):
        if getattr(field, "hidden", False):
            return None
        forward = getattr(field, "field", None)
        if forward is None:
            return None
        try:
            name = forward.related_query_name()
        except Exception:
            return None
        return name if name and not str(name).endswith("+") else None
    return field.name


def _browse_filter_fields(request):
    """Returns the filterable field/relation tree for one model so the cascading filter UI can drill across relations."""
    with _EXECUTION_LOCK:
        try:
            model = _browse_resolve_model(request)
            tree = _browse_filter_field_tree(model)
            tree["ok"] = True
            return tree
        except Exception:
            return {"error": traceback.format_exc(), "fields": [], "ok": False, "relations": []}


def _browse_filter_field_tree(model):
    """Returns {fields, relations, pk} for one model: leaf scalar fields (FKs as their *_id column) plus traversable relations carrying the filter query name and target label. Relations are deduped by query name."""
    fields = []
    for column in _browse_columns(model):
        leaf = {"attname": column["attname"], "name": column["name"], "null": column["null"], "pk": column["pk"], "type": column["type"]}
        if column.get("choices"):
            leaf["choices"] = column["choices"]
        fields.append(leaf)
    relations = []
    seen = set()
    for field in model._meta.get_fields():
        if not field.is_relation or field.related_model is None:
            continue
        name = _browse_relation_query_name(field)
        if not name or name in seen:
            continue
        seen.add(name)
        relations.append({"kind": _browse_relation_kind(field), "name": name, "single": bool(field.one_to_one or field.many_to_one), "target": _browse_label(field.related_model)})
    return {"fields": fields, "pk": model._meta.pk.attname, "relations": relations}


def _browse_match_segment(model, name):
    """Resolves one filter-path segment to its field/relation: `pk`, a relation query name, a concrete field, or a foreign-key `*_id` attname (None when nothing matches)."""
    if name == "pk":
        return model._meta.pk
    for field in model._meta.get_fields():
        if field.is_relation and field.related_model is not None and _browse_relation_query_name(field) == name:
            return field
    try:
        return model._meta.get_field(name)
    except Exception:
        for field in model._meta.concrete_fields:
            if field.attname == name:
                return field
        return None


def _browse_resolve_filter_path(model, path):
    """Walks a `__`-separated query-name path across relations. Each non-final segment must be a traversable relation; returns (leaf_field_or_relation, needs_distinct, is_relation_leaf) or None if any segment is invalid. needs_distinct is set when the path spans a to-many relation (avoids duplicate rows)."""
    parts = path.split("__")
    if not parts or any(not part for part in parts):
        return None
    current = model
    needs_distinct = False
    for index, part in enumerate(parts):
        field = _browse_match_segment(current, part)
        if field is None:
            return None
        is_relation = bool(getattr(field, "is_relation", False) and getattr(field, "related_model", None) is not None)
        if is_relation and (getattr(field, "many_to_many", False) or getattr(field, "one_to_many", False)):
            needs_distinct = True
        if index == len(parts) - 1:
            return field, needs_distinct, is_relation
        if not is_relation:
            return None
        current = field.related_model
    return None


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
    """Returns a page size; bounded by maximum, or user-driven and uncapped when maximum is None."""
    if isinstance(value, bool):
        return default
    if isinstance(value, int) and value > 0:
        return value if maximum is None else min(value, maximum)
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
    # File/Image fields and other value-objects: show the stored value (e.g. the file path / str()), not the "<FieldFile: ...>" object ref.
    try:
        text = str(value)
    except Exception:
        text = repr(value)
    return {"t": "repr", "v": _truncate(text, 400)}


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
                queryset, property_terms = _browse_apply_db_filters(model._base_manager.all(), model, request.get("filters"), attnames)
                count = sum(1 for _ in _browse_python_filter_iter(queryset, property_terms)) if property_terms else queryset.count()
            includes, excludes, annotations, distinct = _browse_orm_clauses(model, request.get("filters"), set(attnames))
            count_lines = [f"{model.__name__}._base_manager"]
            if annotations:
                count_lines.append(f"    .annotate({', '.join(annotations)})")
            if includes:
                count_lines.append(f"    .filter({', '.join(includes)})")
            if excludes:
                count_lines.append(f"    .exclude({', '.join(excludes)})")
            if distinct:
                count_lines.append("    .distinct()")
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


def _browse_orm_clauses(model, filters, attnames):
    """Splits structured filters into Django .filter()/.exclude() kwarg strings for the command log."""
    includes, excludes = [], []
    annotations = []
    distinct = False
    declared = _browse_declared_annotations(model)
    for term in filters or []:
        parsed = _browse_filter_term(model, term, attnames, declared)
        if parsed is None:
            continue
        key, lookup, value, annotation, needs_distinct, property_name = parsed
        if property_name is not None:
            lookup_key = property_name if lookup == "exact" else f"{property_name}__{lookup}"
            (excludes if term.get("negate") else includes).append(f"{lookup_key}={value!r}  # Python @property")
            continue
        if annotation is not None:
            annotations.append(f"{annotation[0]}=<annotation>")
        distinct = distinct or needs_distinct
        lookup_key = key if lookup == "exact" else f"{key}__{lookup}"
        (excludes if term.get("negate") else includes).append(f"{lookup_key}={value!r}")
    return includes, excludes, annotations, distinct


def _browse_orm_rows(model, order, filters, attnames, pk_attname, keyset_capable, cursor, base_offset, limit):
    """Builds a readable Django ORM expression mirroring the executed rows query."""
    includes, excludes, annotations, distinct = _browse_orm_clauses(model, filters, set(attnames))
    lines = [f"{model.__name__}._base_manager", f"    .order_by({_orm_args(order)})"]
    if annotations:
        lines.append(f"    .annotate({', '.join(annotations)})")
    if includes:
        lines.append(f"    .filter({', '.join(includes)})")
    if excludes:
        lines.append(f"    .exclude({', '.join(excludes)})")
    if distinct:
        lines.append("    .distinct()")
    if keyset_capable and cursor is not None:
        lines.append(f"    .filter({pk_attname}__gt={cursor!r})")
    lines.append(f"    .values({_orm_args(attnames)})")
    end = limit + 1
    lines.append(f"    [{base_offset}:{base_offset + end}]" if (not keyset_capable and base_offset) else f"    [:{end}]")
    return "\n".join(lines)


def _browse_commit(request):
    """Applies staged cell edits in one atomic transaction; validates everything first (all-or-nothing)."""
    with _EXECUTION_LOCK:
        try:
            from django.core.exceptions import ValidationError
            from django.db import connection, transaction
            from django.test.utils import CaptureQueriesContext

            model = _browse_resolve_model(request)
            changes = request.get("changes")
            if not isinstance(changes, list) or not changes:
                return {"error": "No changes to commit.", "ok": False, "results": []}
            editable = {field.attname: field for field in model._meta.concrete_fields if getattr(field, "editable", False) and not field.primary_key and not _browse_is_auto(field)}
            field_names = [field.name for field in model._meta.fields]
            prepared, results, has_error = [], [], False
            for change in changes:
                if not isinstance(change, dict):
                    continue
                pk = change.get("pk")
                fields = change.get("fields") if isinstance(change.get("fields"), dict) else {}
                instance = model._base_manager.filter(pk=pk).first()
                if instance is None:
                    results.append({"error": "Row not found.", "ok": False, "pk": pk})
                    has_error = True
                    continue
                applied = []
                for attname, value in fields.items():
                    field = editable.get(attname)
                    if field is None:
                        continue
                    setattr(instance, attname, _browse_coerce_edit_value(field, value))
                    applied.append(field.name)
                if not applied:
                    continue
                try:
                    instance.full_clean(exclude=[name for name in field_names if name not in applied])
                except ValidationError as error:
                    results.append({"fieldErrors": _browse_field_errors(error), "ok": False, "pk": pk})
                    has_error = True
                    continue
                results.append({"ok": True, "pk": pk})
                prepared.append((instance, applied))
            if has_error:
                return {"ok": False, "results": results, "saved": 0}
            with CaptureQueriesContext(connection) as ctx:
                with transaction.atomic():
                    for instance, applied in prepared:
                        instance.save(update_fields=applied)
            return {"ok": True, "orm": _browse_orm_commit(model, prepared), "results": results, "saved": len(prepared), "sql": _browse_sql(ctx)}
        except Exception:
            return {"error": traceback.format_exc(), "ok": False, "results": []}


def _browse_is_auto(field):
    """Returns whether a field is auto-managed (auto_now/auto_now_add) and so not user-editable."""
    return bool(getattr(field, "auto_now", False) or getattr(field, "auto_now_add", False))


def _browse_coerce_edit_value(field, value):
    """Coerces an edited cell value to the field's Python type, leaving validation to full_clean."""
    if value is None:
        return None
    if isinstance(value, str) and value == "" and getattr(field, "null", False):
        return None
    if field.is_relation:
        return value if value not in ("", None) else None
    if isinstance(value, str) and field.get_internal_type() == "BooleanField":
        return value.strip().lower() in ("true", "1", "t", "yes", "on")
    try:
        return field.to_python(value)
    except Exception:
        return value


def _browse_field_errors(error):
    """Returns a JSON-safe {field: [messages]} mapping from a ValidationError."""
    try:
        return {key: [str(message) for message in messages] for key, messages in error.message_dict.items()}
    except Exception:
        return {"__all__": [str(message) for message in getattr(error, "messages", [str(error)])]}


def _browse_orm_commit(model, prepared):
    """Builds a readable ORM expression mirroring the committed saves."""
    lines = ["with transaction.atomic():"]
    for instance, applied in prepared:
        lines.append(f"    {model.__name__}(pk={instance.pk!r}).save(update_fields={applied!r})")
    return "\n".join(lines)


_BROWSE_TEXT_TYPES = frozenset({"CharField", "TextField", "SlugField", "EmailField", "URLField", "FilePathField"})
_BROWSE_INT_PK_TYPES = frozenset({"AutoField", "BigAutoField", "SmallAutoField", "IntegerField", "BigIntegerField", "SmallIntegerField", "PositiveIntegerField", "PositiveSmallIntegerField", "PositiveBigIntegerField"})


def _browse_lookup(request):
    """Searches a target model for foreign-key picker candidates: one bounded SELECT, no __str__/joins."""
    with _EXECUTION_LOCK:
        try:
            model = _browse_resolve_model(request)
            if model is None:
                return {"error": "Unknown model.", "ok": False, "rows": []}
            pk_attname = model._meta.pk.attname
            exclude = request.get("exclude") if isinstance(request.get("exclude"), list) else []
            text_fields = _browse_text_fields(model, exclude)
            label_fields = text_fields[:2]
            value_fields = list(dict.fromkeys([pk_attname, *label_fields]))
            limit = _browse_limit(request.get("limit"), default=20, maximum=50)
            query = (request.get("q") or "").strip()
            queryset = model._base_manager.all().order_by(pk_attname)
            if query:
                queryset = queryset.filter(_browse_lookup_filter(model, query, text_fields, pk_attname))
            with _browse_capture() as ctx:
                raw = list(queryset.values(*value_fields)[: limit + 1])
            rows = [_browse_lookup_row(item, pk_attname, label_fields) for item in raw[:limit]]
            return {"hasMore": len(raw) > limit, "ok": True, "rows": rows, "sql": _browse_sql(ctx)}
        except Exception:
            return {"error": traceback.format_exc(), "ok": False, "rows": []}


def _browse_text_fields(model, exclude=()):
    """Returns concrete text-field attnames for FK search and labels; every field is exposed unless its
    name contains a caller-supplied exclude substring (default: none, so all are shown)."""
    patterns = [str(item).lower() for item in exclude if item]
    fields = []
    for field in model._meta.concrete_fields:
        if field.is_relation or field.get_internal_type() not in _BROWSE_TEXT_TYPES:
            continue
        lowered = field.attname.lower()
        if any(pattern in lowered for pattern in patterns):
            continue
        fields.append(field.attname)
    return fields


def _browse_lookup_filter(model, query, text_fields, pk_attname):
    """Builds an OR query across text fields (icontains) plus an exact primary-key match when applicable."""
    from django.db.models import Q

    condition = Q()
    for attname in text_fields:
        condition |= Q(**{f"{attname}__icontains": query})
    if model._meta.pk.get_internal_type() in _BROWSE_INT_PK_TYPES:
        if query.isdigit():
            condition |= Q(**{pk_attname: int(query)})
    else:
        condition |= Q(**{f"{pk_attname}__icontains": query})
    return condition


def _browse_lookup_row(item, pk_attname, label_fields):
    """Builds one {pk, label} candidate from a .values() dict without invoking __str__."""
    pk = item.get(pk_attname)
    parts = [_truncate(str(item.get(attname)), 80) for attname in label_fields if item.get(attname) not in (None, "")]
    label = f"#{pk}" + (" · " + " · ".join(parts) if parts else "")
    return {"label": label, "pk": _browse_jsonable(pk)}


def _browse_query(namespace, request):
    """Evaluates user-written ORM code in the live shell namespace and tabulates the final
    expression's value into grid rows. Multi-line code is allowed (last expression is tabulated);
    assignments/imports mutate the shell namespace, exactly like the interactive shell."""
    code = request.get("code")
    if not isinstance(code, str) or not code.strip():
        return {"columns": [], "editable": False, "error": "Query code must be a non-empty string.", "hasMore": False, "ok": False, "rows": []}
    limit = _browse_limit(request.get("limit"), maximum=None)
    offset = request.get("offset")
    offset = offset if isinstance(offset, int) and offset > 0 else 0
    with _EXECUTION_LOCK:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                value = _browse_eval_last(namespace, code)
                with _browse_capture() as ctx:
                    payload = _browse_tabulate(value, offset, limit)
                payload.update({"ok": True, "orm": code, "sql": _browse_sql(ctx), "stderr": stderr.getvalue(), "stdout": stdout.getvalue()})
                return payload
            except Exception:
                return {"columns": [], "editable": False, "error": traceback.format_exc(), "hasMore": False, "ok": False, "rows": [], "stderr": stderr.getvalue(), "stdout": stdout.getvalue()}


def _browse_eval_last(namespace, code):
    """Runs leading statements then returns the value of the final expression (no pprint, no `_`)."""
    tree = ast.parse(code, filename="<django-shell-query>", mode="exec")
    body, expression = _split_last_expression(tree)
    if body:
        tree.body = body
        ast.fix_missing_locations(tree)
        exec(compile(tree, "<django-shell-query>", "exec"), namespace)
    if expression is None:
        if not body:
            exec(compile(tree, "<django-shell-query>", "exec"), namespace)
        raise ValueError("The last line must be an expression to tabulate (for example a QuerySet).")
    expr = ast.Expression(expression.value)
    ast.fix_missing_locations(expr)
    return eval(compile(expr, "<django-shell-query>", "eval"), namespace)


def _browse_tabulate(value, offset, limit):
    """Turns an evaluated value into {columns, rows, hasMore, pk?, editable, model?, app?}; bounded, no __str__."""
    import itertools

    from django.db.models import Model, QuerySet
    from django.db.models.query import ModelIterable

    if isinstance(value, QuerySet):
        if value._iterable_class is ModelIterable and not value.query.values_select:
            try:
                return _browse_tabulate_instances(value, value.model, offset, limit)
            except TypeError:
                pass  # already-sliced / un-sliceable queryset → fall through to bounded read-only
        else:
            return _browse_tabulate_dicts(value, offset, limit)
    if isinstance(value, Model):
        return _browse_tabulate_single(value)
    if isinstance(value, (str, bytes)) or not hasattr(value, "__iter__"):
        return {"columns": [{"attname": "value", "editable": False, "name": "value", "null": True, "pk": False, "type": ""}], "editable": False, "hasMore": False, "rows": [{"value": _browse_cell(value)}]}
    items = list(itertools.islice(value, offset, offset + limit + 1))
    return _browse_tabulate_items(items, limit)


def _browse_tabulate_instances(queryset, model, offset, limit):
    """Tabulates a model-instance QuerySet as editable rows via a single bounded .values() SELECT."""
    columns = _browse_columns(model)
    attnames = [column["attname"] for column in columns]
    raw = list(queryset[offset:offset + limit + 1].values(*attnames))
    return {"app": model._meta.app_label, "columns": columns, "editable": True, "hasMore": len(raw) > limit, "model": model._meta.object_name, "pk": model._meta.pk.attname, "relations": _browse_relations(model), "rows": [_browse_serialize_row(row) for row in raw[:limit]]}


def _browse_tabulate_dicts(queryset, offset, limit):
    """Tabulates a .values()/.values_list() QuerySet as read-only rows."""
    names = list(queryset.query.values_select) + list(getattr(queryset.query, "annotation_select", {}))
    flat = queryset._iterable_class.__name__ == "FlatValuesListIterable"
    valued = queryset._iterable_class.__name__ in ("ValuesListIterable", "FlatValuesListIterable")
    raw = list(queryset[offset:offset + limit + 1])
    if not names and raw:
        names = list(raw[0].keys()) if isinstance(raw[0], dict) else [f"col{index}" for index in range(len(raw[0]))]
    if flat:
        names = names[:1] or ["value"]
        rows = [{names[0]: _browse_cell(item)} for item in raw[:limit]]
    elif valued:
        rows = [_browse_serialize_row(dict(zip(names, item))) for item in raw[:limit]]
    else:
        rows = [_browse_serialize_row(item) for item in raw[:limit]]
    return {"columns": [{"attname": name, "editable": False, "name": name, "null": True, "pk": False, "type": ""} for name in names], "editable": False, "hasMore": len(raw) > limit, "rows": rows}


def _browse_tabulate_single(instance):
    """Tabulates one model instance as a single editable row (attname getattr, never __str__)."""
    model = type(instance)
    columns = _browse_columns(model)
    row = {column["attname"]: _browse_cell(getattr(instance, column["attname"], None)) for column in columns}
    return {"app": model._meta.app_label, "columns": columns, "editable": True, "hasMore": False, "model": model._meta.object_name, "pk": model._meta.pk.attname, "relations": _browse_relations(model), "rows": [row]}


def _browse_tabulate_items(items, limit):
    """Tabulates a bounded plain list/iterable (read-only): instances by attname, dicts by key, else a value column."""
    from django.db.models import Model

    has_more = len(items) > limit
    items = items[:limit]
    if items and all(isinstance(item, Model) and type(item) is type(items[0]) for item in items):
        model = type(items[0])
        columns = _browse_columns(model)
        rows = [{column["attname"]: _browse_cell(getattr(item, column["attname"], None)) for column in columns} for item in items]
        return {"app": model._meta.app_label, "columns": columns + _browse_computed_columns(model), "editable": True, "hasMore": has_more, "model": model._meta.object_name, "pk": model._meta.pk.attname, "relations": _browse_relations(model), "rows": rows}
    if items and all(isinstance(item, dict) for item in items):
        names = list(dict.fromkeys(key for item in items for key in item))
        return {"columns": [{"attname": name, "editable": False, "name": name, "null": True, "pk": False, "type": ""} for name in names], "editable": False, "hasMore": has_more, "rows": [_browse_serialize_row(item) for item in items]}
    return {"columns": [{"attname": "value", "editable": False, "name": "value", "null": True, "pk": False, "type": ""}], "editable": False, "hasMore": has_more, "rows": [{"value": _browse_cell(item)} for item in items]}


def _browse_build_filters(model, filters, attnames):
    """Builds a safe Q filter; field and lookup are allowlisted and values stay ORM-parameterized (no injection)."""
    return _browse_filter_parts(model, filters, attnames)[0]


def _browse_apply_filters(queryset, model, filters, attnames):
    """Applies safe concrete, annotated-property, and relation-existence filters to a queryset."""
    queryset, property_terms = _browse_apply_db_filters(queryset, model, filters, attnames)
    return _browse_python_filter_iter(queryset, property_terms) if property_terms else queryset


def _browse_apply_db_filters(queryset, model, filters, attnames):
    """Applies filters that can be represented by Django ORM and returns deferred Python property terms."""
    query, annotations, distinct, property_terms = _browse_filter_parts(model, filters, attnames)
    if annotations:
        queryset = queryset.annotate(**annotations)
    queryset = queryset.filter(query)
    return (queryset.distinct() if distinct else queryset), property_terms


def _browse_filter_parts(model, filters, attnames):
    """Returns a Q object plus required annotations/distinct flag for safe table filters."""
    from django.db.models import Q

    query = Q()
    annotations = {}
    distinct = False
    property_terms = []
    if not isinstance(filters, list):
        return query, annotations, distinct, property_terms
    declared = _browse_declared_annotations(model)
    for term in filters:
        parsed = _browse_filter_term(model, term, set(attnames), declared)
        if parsed is None:
            continue
        key, lookup, value, annotation, needs_distinct, property_name = parsed
        if property_name is not None:
            property_terms.append({"field": property_name, "lookup": lookup, "negate": bool(term.get("negate")), "value": value})
            continue
        if annotation is not None:
            annotations[annotation[0]] = annotation[1]
        distinct = distinct or needs_distinct
        clause = Q(**{f"{key}__{lookup}": value})
        query &= ~clause if term.get("negate") else clause
    return query, annotations, distinct, property_terms


def _browse_filter_term(model, term, attnames, declared):
    """Parses one structured table filter term into a safe ORM lookup key."""
    if not isinstance(term, dict):
        return None
    field = term.get("field")
    lookup = term.get("lookup") or "exact"
    if not isinstance(field, str) or lookup not in _BROWSE_LOOKUPS:
        return None
    fields = {field.attname: field for field in model._meta.concrete_fields}
    annotation = None
    needs_distinct = False
    if field == "pk":
        # Must precede the @property branch: Django defines `pk` as a property on the base Model, so
        # _pty_is_computed_field(model, "pk") is True and would otherwise misroute pk to a Python full-table scan.
        key = "pk"
        value = _browse_coerce_filter_value(lookup, term.get("value"), model._meta.pk)
    elif field in attnames:
        key = field
        value = _browse_coerce_filter_value(lookup, term.get("value"), fields.get(field))
    elif field in declared and field.isidentifier():
        key = _browse_annotation_alias(field)
        annotation = (key, declared[field])
        value = _browse_coerce_filter_value(lookup, term.get("value"))
    elif field.isidentifier() and _pty_is_computed_field(model, field):
        return None, lookup, _browse_coerce_filter_value(lookup, term.get("value")), None, False, field
    elif field.startswith("rel:") and lookup == "isnull":
        relation = _browse_find_relation(model, field[4:])
        name = _browse_relation_name(relation) if relation is not None else None
        if not name:
            return None
        key = name
        value = _browse_coerce_filter_value(lookup, term.get("value"))
        needs_distinct = bool(relation.one_to_many or relation.many_to_many)
    else:
        # Relation-traversal path (e.g. author__profile__city): every segment is allowlisted against the live
        # model graph, so an unknown field/relation is rejected (never injected) and values stay ORM-parameterized.
        resolved = _browse_resolve_filter_path(model, field)
        if resolved is None:
            return None
        leaf, needs_distinct, is_relation_leaf = resolved
        if is_relation_leaf:
            if lookup != "isnull":
                return None
            value = _browse_coerce_filter_value("isnull", term.get("value"))
        else:
            value = _browse_coerce_filter_value(lookup, term.get("value"), leaf if getattr(leaf, "concrete", False) else None)
        key = field
    return key, lookup, value, annotation, needs_distinct, None


def _browse_annotation_alias(field):
    """Returns a safe annotation alias for one declared computed-property filter."""
    return f"djs_{field}"


def _browse_python_filter_iter(queryset, terms):
    """Yields objects whose unannotated @property values match every Python-side filter term."""
    if not terms:
        return iter(queryset)
    source = queryset.iterator(chunk_size=_PROPERTY_FILTER_CHUNK_SIZE) if callable(getattr(queryset, "iterator", None)) else queryset
    return (obj for obj in source if all(_browse_property_filter_match(obj, term) for term in terms))


def _browse_property_filter_match(obj, term):
    """Returns whether one object matches one Python-side @property filter term."""
    value = _pty_safe_getattr(obj, term.get("field"))
    matched = _browse_property_lookup_match(value, term.get("lookup"), term.get("value"))
    return not matched if term.get("negate") else matched


def _browse_property_lookup_match(value, lookup, expected):
    """Applies one supported lookup to a Python @property value."""
    if lookup == "isnull":
        return (value is None) == bool(expected)
    if value is None:
        return False
    if lookup == "exact":
        return value == expected
    if lookup == "iexact":
        return str(value).lower() == str(expected).lower()
    if lookup == "contains":
        return str(expected) in str(value)
    if lookup == "icontains":
        return str(expected).lower() in str(value).lower()
    if lookup in ("gt", "gte", "lt", "lte"):
        return _browse_compare(value, expected, lookup)
    if lookup == "startswith":
        return str(value).startswith(str(expected))
    if lookup == "istartswith":
        return str(value).lower().startswith(str(expected).lower())
    if lookup == "endswith":
        return str(value).endswith(str(expected))
    if lookup == "iendswith":
        return str(value).lower().endswith(str(expected).lower())
    if lookup == "in":
        return value in expected if isinstance(expected, (list, tuple, set, frozenset)) else False
    if lookup == "range":
        return isinstance(expected, (list, tuple)) and len(expected) >= 2 and _browse_compare(expected[0], value, "lte") and _browse_compare(value, expected[1], "lte")
    if lookup == "date":
        actual = value.date() if callable(getattr(value, "date", None)) else value
        return str(actual) == str(expected)
    if lookup in ("year", "month", "day"):
        return getattr(value, lookup, None) == expected
    return False


def _browse_compare(left, right, lookup):
    """Compares two property filter values, returning False on incompatible types."""
    try:
        if lookup == "gt":
            return left > right
        if lookup == "gte":
            return left >= right
        if lookup == "lt":
            return left < right
        if lookup == "lte":
            return left <= right
    except Exception:
        return False
    return False


def _browse_islice(iterable, start, stop):
    """Returns an iterator slice for querysets, lists, and generators."""
    import itertools

    return itertools.islice(iterable, start, stop)


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
    if isinstance(value, str) and field is None and value.strip().lower() in ("true", "false", "1", "0", "t", "yes", "no", "on", "off"):
        return value.strip().lower() in ("true", "1", "t", "yes", "on")
    if isinstance(value, str) and field is None and value.strip().replace(".", "", 1).lstrip("-").isdigit():
        return float(value.strip()) if "." in value.strip() else int(value.strip())
    return value

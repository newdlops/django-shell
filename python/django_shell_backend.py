# In-process JSON backend for executing code inside an interactive Django shell namespace.

import ast
import codeop
import contextlib
import ctypes
import dataclasses
import io
import inspect
import json
import keyword
import linecache
import os
import pprint
import socketserver
import sys
import threading
import time
import traceback
import types

_READY_PREFIX = "__DJANGO_SHELL_BACKEND_READY__"
_FAILED_PREFIX = "__DJANGO_SHELL_BACKEND_FAILED__"
_RESPONSE_PREFIX = "__DJANGO_SHELL_BACKEND_RESPONSE__"
_PROGRESS_PREFIX = "__DJANGO_SHELL_BACKEND_PROGRESS__"
_STATE = {}
_EXECUTION_LOCK = threading.Lock()
_PROGRESS_LOCK = threading.Lock()
_PROGRESS_INTERVAL_SECONDS = 0.25
_PTY_ORM_TABULATE_LIMIT = 1000
_MISSING = object()


class _ExecutionInterrupted(BaseException):
    """Stops the current backend execution when the debugger or UI requests termination."""


class _Server(socketserver.ThreadingTCPServer):
    """TCP server that stores the Django shell namespace and auth token."""

    allow_reuse_address = True
    daemon_threads = True

    def process_request(self, request, client_address):
        """Serves each request on a debugger-exempt thread so model-browser reads keep answering while debugpy is paused at a breakpoint."""
        thread = threading.Thread(target=self.process_request_thread, args=(request, client_address), daemon=True)
        _debugger_exempt_thread(thread).start()


def _debugger_exempt_thread(thread):
    """Marks a backend service thread so debugpy suspend-all skips it (pydevd leaves pydev_do_not_trace threads running)."""
    thread.pydev_do_not_trace = True
    thread.is_pydev_daemon_thread = True
    return thread


def _restore_debugger_tracing():
    """Re-enables debugger tracing on a socket handler thread before it runs user cell code, so cell breakpoints still bind."""
    thread = threading.current_thread()
    if not getattr(thread, "pydev_do_not_trace", False):
        return
    thread.pydev_do_not_trace = False
    thread.is_pydev_daemon_thread = False
    try:
        import debugpy

        debugpy.trace_this_thread(True)
    except Exception:
        pass


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
        _register_transform_lookups()
        _install_queryset_progress()
        server = _STATE.get("server")
        if server is None:
            server = _Server((_bind_host(), 0), _Handler)
            server.initial_names = set(namespace)
            server.namespace = namespace
            _STATE["server"] = server
            _debugger_exempt_thread(threading.Thread(target=server.serve_forever, daemon=True)).start()
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


def _register_transform_lookups():
    """Registers the char/text field transforms the model browser exposes as filter operators — Length (string
    length) and Trim (whitespace-stripped match) — so `field__length__gt=5` / `field__trim='x'` resolve natively.
    Date/time extracts (week_day, quarter, hour, minute, second) are Django built-ins and need no registration.
    Idempotent and best-effort: never blocks startup."""
    if _STATE.get("transforms_registered"):
        return
    try:
        from django.db import models
        from django.db.models.functions import Length, Trim

        for field_class in (models.CharField, models.TextField):
            field_class.register_lookup(Length)
            field_class.register_lookup(Trim)
        _STATE["transforms_registered"] = True
    except Exception:
        pass


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


# Model-browser request kinds handled by the deferred feature module (loaded via "loadfeature"); guarded so a browser
# request that races ahead of the feature load returns a clean "still loading" message instead of a NameError.
_BROWSE_REQUEST_KINDS = frozenset({"models", "schema", "filterfields", "rows", "related", "count", "aggregate", "commit", "lookup", "computed", "query"})
_BROWSE_LOADING_ERROR = "The model browser is still loading; try again in a moment."


def _browse_models_or_loading():
    """Returns the model catalog, or a degraded still-loading list while the deferred browser feature is absent —
    the PTY capture hooks call this so a models probe can never raise NameError out of post_run_cell."""
    if "_browse_models" in globals():
        return _browse_models()
    return {"error": _BROWSE_LOADING_ERROR, "models": [], "ok": False}


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
    if request.get("kind") == "progress":
        return _progress_snapshot()
    if request.get("kind") == "interrupt":
        return _interrupt_execution(request)
    if request.get("kind") == "debugBreakpoints":
        return _debug_update_breakpoints(request)
    if request.get("kind") == "stagedebugpy":
        return _stage_debugpy_bundle(request)
    if request.get("kind") == "loadfeature":
        return _load_feature(request, namespace)
    if request.get("kind") == "children":
        return _inspect_children(namespace, request.get("path"))
    if request.get("kind") in _BROWSE_REQUEST_KINDS and "_browse_models" not in globals():
        return {"ok": False, "error": _BROWSE_LOADING_ERROR}
    if request.get("kind") == "models":
        return _browse_models()
    if request.get("kind") == "schema":
        return _browse_schema(request)
    if request.get("kind") == "filterfields":
        return _browse_filter_fields(request)
    if request.get("kind") == "rows":
        return _browse_rows(namespace, request)
    if request.get("kind") == "related":
        return _browse_related(request)
    if request.get("kind") == "count":
        return _browse_count(request)
    if request.get("kind") == "aggregate":
        return _browse_aggregate(request)
    if request.get("kind") == "commit":
        return _browse_commit(request)
    if request.get("kind") == "lookup":
        return _browse_lookup(request)
    if request.get("kind") == "computed":
        return _browse_computed(namespace, request)
    if request.get("kind") == "query":
        return _browse_query(namespace, request)
    code = request.get("code")
    if not isinstance(code, str):
        return {"ok": False, "stdout": "", "stderr": "Request code must be a string.", "traceback": ""}
    if request.get("kind") == "debugpy":
        with _EXECUTION_LOCK:
            return _execute_debugpy_bootstrap(namespace, code)
    if request.get("kind") == "complete":
        return _check_complete(code)
    filename = request.get("filename")
    line_offset = request.get("lineOffset")
    source_text = request.get("sourceText")
    breakpoint_lines = request.get("breakpointLines")
    _restore_debugger_tracing()
    with _EXECUTION_LOCK:
        return _execute_code(
            namespace,
            code,
            filename if isinstance(filename, str) and filename else None,
            line_offset if isinstance(line_offset, int) else 0,
            source_text if isinstance(source_text, str) else None,
            breakpoint_lines if isinstance(breakpoint_lines, list) else None,
        )


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
        return {name: _model_instance_child_value(value, name, data) for name in names}
    return {name: _read_attr_value(value, name) for name in names}


def _model_instance_child_value(value, name, data):
    """Returns a visible Django model child value while deferring relation descriptors."""
    if name in data:
        return data[name]
    if _pty_is_computed_field(type(value), name):
        return _read_attr_value(value, name)
    return _InspectionDeferred(_model_instance_attribute_label(value, name))


def _debug_model_value_map(value, limit=80):
    """Returns Django model fields, annotations, and computed values for debug adapter watch display."""
    if getattr(value, "_meta", None) is None or isinstance(value, type):
        return {}
    data = getattr(value, "__dict__", {})
    result = {}
    for name in (_model_instance_attribute_names(value) or [])[:max(0, int(limit))]:
        child = _model_instance_child_value(value, name, data)
        if not isinstance(child, _InspectionDeferred):
            result[name] = child
    return result


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
    for name in getattr(value, "__dict__", {}):
        add(name)
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


def _execute_code(namespace, code, filename=None, line_offset=0, source_text=None, breakpoint_lines=None):
    """Executes Python code and captures stdout, stderr, repr result, and traceback."""
    result = None
    compile_filename = filename or "<django-shell-input>"
    _install_debug_source_cache(compile_filename, source_text, code, line_offset)
    _debug_current_thread(breakpoint_lines is not None)
    # A debug run steps line-by-line, and each pause's inspection reprs (e.g. Django QuerySet repr, which iterates) would
    # otherwise flood the progress stream through the QuerySet-progress hook. Suppress progress while breakpoints are active.
    progress_emit = bool(_STATE.get("progress_emit")) and breakpoint_lines is None
    _progress_begin(code, emit=progress_emit)
    stdout = _StreamingCapture("stdout", progress_emit)
    stderr = _StreamingCapture("stderr", progress_emit)
    namespace["_djs_debug_should_break"] = _debug_should_break
    namespace["_djs_progress_iter"] = _progress_iter
    _debug_set_breakpoint_lines(breakpoint_lines)
    _execution_mark_active()
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                tree = ast.parse(code, filename=compile_filename, mode="exec")
                tree = _progress_instrument_tree(tree)
                if line_offset > 0:
                    ast.increment_lineno(tree, line_offset)
                if breakpoint_lines is not None and _debug_can_wrap_tree(tree):
                    tree = _debug_breakpoint_tree(tree, breakpoint_lines)
                    result = _execute_debug_tree(namespace, tree, compile_filename)
                else:
                    tree = _debug_breakpoint_tree(tree, breakpoint_lines)
                    result = _execute_plain_tree(namespace, tree, compile_filename)
                _progress_finish(True)
                return {"ok": True, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "result": result}
            except (KeyboardInterrupt, _ExecutionInterrupted):
                _progress_finish(False)
                return {"ok": False, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "traceback": traceback.format_exc()}
            except Exception:
                _progress_finish(False)
                return {"ok": False, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "traceback": traceback.format_exc()}
    finally:
        _execution_mark_inactive()


def _execute_debugpy_bootstrap(namespace, code):
    """Executes debugger bootstrap code without redirecting process stderr."""
    stdout = _StreamingCapture("stdout", False)
    try:
        with contextlib.redirect_stdout(stdout):
            exec(compile(code, "<django-shell-debugpy>", "exec"), namespace)
        return {"ok": True, "stdout": stdout.getvalue(), "stderr": "", "result": ""}
    except Exception:
        return {"ok": False, "stdout": stdout.getvalue(), "stderr": "", "traceback": traceback.format_exc()}


def _load_feature(request, namespace=None):
    """Loads a deferred backend feature (the model browser) into this module's globals from a deflate+base64 source blob.

    Keeps the initial remote bootstrap small: the core backend is typed in first, then the browser half is delivered
    on first use over the socket, or typed as staged shell-namespace chunks referenced here via `partsKey`.
    Idempotent — a second call after the browser is present is a no-op."""
    if "_browse_models" in globals():
        return {"ok": True, "reused": True}
    import base64
    import zlib

    data = request.get("data")
    parts_key = request.get("partsKey")
    if (not isinstance(data, str) or not data) and isinstance(parts_key, str) and parts_key and isinstance(namespace, dict):
        data = "".join(namespace.pop(parts_key, []) or [])
    if not isinstance(data, str) or not data:
        return {"ok": False, "error": "loadfeature requires a deflate+base64 source payload."}
    try:
        source = zlib.decompress(base64.b64decode(data)).decode("utf-8")
        exec(compile(source, "<django-shell-backend>", "exec"), globals())
        return {"ok": True, "reused": False}
    except Exception:
        return {"ok": False, "error": "loadfeature failed to install the model browser.", "traceback": traceback.format_exc()}


def _stage_debugpy_bundle(request):
    """Probes for, or installs, the extension's bundled debugpy copy under a digest-keyed temp directory.

    Without ``data`` this is a cheap probe so reconnects reuse an earlier install instead of re-shipping megabytes;
    with ``data`` (deflate+base64 of a ``[[relative_path, base64_content], ...]`` JSON list) it writes the files.
    The socket transport carries the payload in one request, replacing thousands of typed terminal lines."""
    import base64
    import tempfile
    import zlib

    digest = request.get("digest")
    if not isinstance(digest, str) or len(digest) < 16 or not all(c in "0123456789abcdef" for c in digest):
        return {"ok": False, "error": "stagedebugpy requires a lowercase hex digest."}
    root = os.path.normpath(os.path.join(tempfile.gettempdir(), "django-shell-debugpy-" + digest[:16]))
    if os.path.exists(os.path.join(root, "debugpy", "__init__.py")):
        return {"ok": True, "path": root, "reused": True}
    data = request.get("data")
    if not isinstance(data, str) or not data:
        return {"ok": True, "path": None, "reused": False}
    try:
        files = json.loads(zlib.decompress(base64.b64decode(data)).decode("utf-8"))
        for entry in files:
            relative, content = entry
            target = os.path.normpath(os.path.join(root, *str(relative).split("/")))
            if target != root and not target.startswith(root + os.sep):
                return {"ok": False, "error": "Unsafe debugpy bundle path: " + str(relative)}
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as handle:
                handle.write(base64.b64decode(content))
        return {"ok": True, "files": len(files), "path": root, "reused": False}
    except Exception:
        return {"ok": False, "error": traceback.format_exc()}


def _execution_mark_active():
    """Records the thread currently executing user Python code."""
    with _PROGRESS_LOCK:
        _STATE["execution_thread_id"] = threading.get_ident()


def _execution_mark_inactive():
    """Clears the current user execution thread marker."""
    with _PROGRESS_LOCK:
        _STATE.pop("execution_thread_id", None)
        _STATE.pop("debug_breakpoint_lines", None)


def _interrupt_execution(request=None):
    """Raises an internal interruption in the active user execution thread without waiting for the execution lock."""
    reason = str((request or {}).get("reason") or "")
    with _PROGRESS_LOCK:
        thread_id = _STATE.get("execution_thread_id")
    if not isinstance(thread_id, int):
        return {"interrupted": False, "message": "No Python execution is running.", "ok": True, "reason": reason}
    try:
        changed = _raise_async_exception(thread_id, _ExecutionInterrupted)
    except Exception as error:
        return {"error": repr(error), "interrupted": False, "ok": False, "reason": reason}
    if changed == 1:
        _progress_update(label="Interrupting Python cell")
        return {"interrupted": True, "ok": True, "reason": reason}
    return {"error": "Execution thread was not found." if changed == 0 else "Async interrupt touched multiple threads and was rolled back.", "interrupted": False, "ok": False, "reason": reason}


def _raise_async_exception(thread_id, exception_type):
    """Raises one exception type asynchronously in a CPython thread and returns the affected thread count."""
    setter = ctypes.pythonapi.PyThreadState_SetAsyncExc
    setter.restype = ctypes.c_int
    changed = setter(ctypes.c_ulong(thread_id), ctypes.py_object(exception_type))
    if changed > 1:
        setter(ctypes.c_ulong(thread_id), None)
    return changed


def _execute_plain_tree(namespace, tree, compile_filename):
    """Executes a parsed tree with normal module-level shell semantics."""
    result = None
    body, expression = _split_last_expression(tree)
    if body:
        tree.body = body
        ast.fix_missing_locations(tree)
        exec(compile(tree, compile_filename, "exec"), namespace)
    if expression is None:
        if not body:
            exec(compile(tree, compile_filename, "exec"), namespace)
    else:
        expr = ast.Expression(expression.value)
        ast.fix_missing_locations(expr)
        value = eval(compile(expr, compile_filename, "eval"), namespace)
        if value is not None:
            namespace["_"] = value
            result = pprint.pformat(value, width=120, compact=False)
    return result


def _execute_debug_tree(namespace, tree, compile_filename):
    """Executes a parsed tree through a named function frame visible to debugpy."""
    result_name = "__djs_overlay_cell_result__"
    function_name = "__djs_overlay_cell__"
    previous_result = namespace.get(result_name, _MISSING)
    previous_function = namespace.get(function_name, _MISSING)
    try:
        module = _debug_wrapper_tree(tree, function_name, result_name)
        ast.fix_missing_locations(module)
        exec(compile(module, compile_filename, "exec"), namespace)
        value = namespace.get(result_name)
        if value is not None:
            namespace["_"] = value
            return pprint.pformat(value, width=120, compact=False)
        return None
    finally:
        _restore_namespace_value(namespace, result_name, previous_result)
        _restore_namespace_value(namespace, function_name, previous_function)


def _restore_namespace_value(namespace, name, previous):
    """Restores one temporary namespace binding after debug wrapper execution."""
    if previous is _MISSING:
        namespace.pop(name, None)
    else:
        namespace[name] = previous


def _debug_can_wrap_tree(tree):
    """Returns whether a tree can run inside a debug-visible function frame."""
    for statement in tree.body:
        if isinstance(statement, ast.ImportFrom) and statement.module == "__future__":
            return False
        if isinstance(statement, ast.ImportFrom) and any(alias.name == "*" for alias in statement.names):
            return False
    return not _DebugWrapSafetyVisitor.has_unsafe_control_flow(tree)


class _DebugWrapSafetyVisitor(ast.NodeVisitor):
    """Detects module-scope nodes whose meaning would change inside a function."""

    def __init__(self):
        """Initializes the unsafe-node flag."""
        self.unsafe = False

    @classmethod
    def has_unsafe_control_flow(cls, tree):
        """Returns whether wrapping would make invalid module-scope control flow valid."""
        visitor = cls()
        visitor.visit(tree)
        return visitor.unsafe

    def visit_FunctionDef(self, node):
        """Skips nested function bodies whose control flow already belongs to them."""
        return

    def visit_AsyncFunctionDef(self, node):
        """Skips nested async function bodies whose control flow already belongs to them."""
        return

    def visit_Lambda(self, node):
        """Skips lambda bodies whose control flow already belongs to them."""
        return

    def visit_Return(self, node):
        """Marks module-level return as unsafe to wrap."""
        self.unsafe = True

    def visit_Yield(self, node):
        """Marks module-level yield as unsafe to wrap."""
        self.unsafe = True

    def visit_YieldFrom(self, node):
        """Marks module-level yield-from as unsafe to wrap."""
        self.unsafe = True


def _debug_wrapper_tree(tree, function_name, result_name):
    """Builds a module that calls user code through one debug-visible function."""
    body, expression = _split_last_expression(tree)
    first = _first_statement_or_expression(body, expression)
    function_body = _debug_wrapper_body(body, expression)
    function = ast.FunctionDef(name=function_name, args=ast.arguments(posonlyargs=[], args=[], vararg=None, kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]), body=function_body, decorator_list=[])
    if first:
        ast.copy_location(function, first)
    call = ast.Assign(targets=[ast.Name(id=result_name, ctx=ast.Store())], value=ast.Call(func=ast.Name(id=function_name, ctx=ast.Load()), args=[], keywords=[]))
    if first:
        ast.copy_location(call, first)
    return ast.Module(body=[function, call], type_ignores=[])


def _debug_wrapper_body(body, expression):
    """Returns function statements that preserve shell globals and final expression output."""
    statements = []
    names = sorted(_DebugGlobalNameCollector.collect(body, expression))
    first = _first_statement_or_expression(body, expression)
    if names:
        global_node = ast.Global(names=names)
        if first:
            ast.copy_location(global_node, first)
        statements.append(global_node)
    statements.extend(body)
    if expression is not None:
        return_node = ast.Return(value=expression.value)
        ast.copy_location(return_node, expression)
        statements.append(return_node)
    elif not body:
        pass_node = ast.Pass()
        if first:
            ast.copy_location(pass_node, first)
        statements.append(pass_node)
    return statements


def _first_statement_or_expression(body, expression):
    """Returns the first source-bearing node in a split shell tree."""
    return body[0] if body else expression


class _DebugGlobalNameCollector(ast.NodeVisitor):
    """Collects names that module-level shell code binds into globals."""

    def __init__(self):
        """Initializes the bound-name set."""
        self.names = set()

    @classmethod
    def collect(cls, body, expression):
        """Returns all global names bound by wrapper-executed user code."""
        collector = cls()
        for statement in body:
            collector.visit(statement)
        if expression is not None:
            collector.visit(expression.value)
        return collector.names

    def visit_FunctionDef(self, node):
        """Collects a function definition name without entering its local body."""
        self.names.add(node.name)
        for decorator in node.decorator_list:
            self.visit(decorator)
        for default in node.args.defaults + node.args.kw_defaults:
            if default is not None:
                self.visit(default)

    def visit_AsyncFunctionDef(self, node):
        """Collects an async function definition name without entering its local body."""
        self.visit_FunctionDef(node)

    def visit_ClassDef(self, node):
        """Collects a class definition name and base expressions without entering its body."""
        self.names.add(node.name)
        for item in [*node.bases, *[keyword.value for keyword in node.keywords], *node.decorator_list]:
            self.visit(item)

    def visit_Lambda(self, node):
        """Skips lambda-local bindings."""
        return

    def visit_ListComp(self, node):
        """Visits comprehension inputs without collecting comprehension-local targets."""
        self._visit_comprehension(node)

    def visit_SetComp(self, node):
        """Visits set comprehension inputs without collecting local targets."""
        self._visit_comprehension(node)

    def visit_DictComp(self, node):
        """Visits dict comprehension inputs without collecting local targets."""
        self._visit_comprehension(node)

    def visit_GeneratorExp(self, node):
        """Visits generator inputs without collecting generator-local targets."""
        self._visit_comprehension(node)

    def visit_Name(self, node):
        """Collects store-context names."""
        if isinstance(node.ctx, ast.Store):
            self.names.add(node.id)

    def visit_Import(self, node):
        """Collects names bound by import statements."""
        for alias in node.names:
            self.names.add(alias.asname or alias.name.split(".", 1)[0])

    def visit_ImportFrom(self, node):
        """Collects names bound by from-import statements."""
        for alias in node.names:
            if alias.name != "*":
                self.names.add(alias.asname or alias.name)

    def _visit_comprehension(self, node):
        """Visits comprehension expressions that can read outer names."""
        for generator in node.generators:
            self.visit(generator.iter)
            for condition in generator.ifs:
                self.visit(condition)
        for field in ("elt", "key", "value"):
            value = getattr(node, field, None)
            if value is not None:
                self.visit(value)


def _install_debug_source_cache(filename, source_text, code, line_offset):
    """Installs source text in linecache so debugpy binds breakpoints to generated overlay code."""
    if not filename or filename.startswith("<"):
        return
    text = source_text if isinstance(source_text, str) and source_text else ("\n" * max(0, int(line_offset or 0))) + code
    if not text.endswith("\n"):
        text += "\n"
    linecache.cache[filename] = (len(text), None, text.splitlines(True), filename)


def _debug_update_breakpoints(request):
    """Updates active debug breakpoint lines without waiting for user code to finish."""
    lines = _debug_breakpoint_lines((request or {}).get("breakpointLines"))
    with _PROGRESS_LOCK:
        _STATE["debug_breakpoint_lines"] = lines
    return {"breakpointLines": sorted(lines), "ok": True}


def _debug_set_breakpoint_lines(breakpoint_lines):
    """Stores active breakpoint lines for injected debug guards."""
    if breakpoint_lines is None:
        with _PROGRESS_LOCK:
            _STATE.pop("debug_breakpoint_lines", None)
        return
    with _PROGRESS_LOCK:
        _STATE["debug_breakpoint_lines"] = _debug_breakpoint_lines(breakpoint_lines)


def _debug_line_has_breakpoint(line, end_line=None):
    """Returns whether one source line or line span currently has an active breakpoint."""
    try:
        start = int(line)
        end = int(end_line if end_line is not None else line)
    except Exception:
        return False
    with _PROGRESS_LOCK:
        lines = _STATE.get("debug_breakpoint_lines")
    return isinstance(lines, set) and any(start <= value <= end for value in lines)


def _debug_should_break(line=None, end_line=None):
    """Returns whether an injected overlay breakpoint should call the debug hook."""
    if line is not None and not _debug_line_has_breakpoint(line, end_line):
        return False
    debugpy = sys.modules.get("debugpy")
    if not debugpy:
        return False
    try:
        if hasattr(debugpy, "debug_this_thread"):
            debugpy.debug_this_thread()
        connected = _debug_wait_for_client(debugpy)
        if connected and hasattr(debugpy, "breakpoint"):
            os.environ["PYTHONBREAKPOINT"] = "debugpy.breakpoint"
            sys.breakpointhook = debugpy.breakpoint
            return True
    except Exception:
        pass
    return False


def _debug_wait_for_client(debugpy, timeout=1.5):
    """Waits briefly for the VS Code debug adapter to finish attaching."""
    connected = getattr(debugpy, "is_client_connected", lambda: True)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if connected():
                return True
        except Exception:
            return False
        time.sleep(0.05)
    try:
        return bool(connected())
    except Exception:
        return False


def _debug_breakpoint_tree(tree, breakpoint_lines):
    """Injects debugpy breakpoint calls before statements whose source lines are active breakpoints."""
    if breakpoint_lines is None:
        return tree
    return _DebugBreakpointTransformer().visit(tree)


def _debug_breakpoint_lines(breakpoint_lines):
    """Normalizes requested one-based source line numbers into a positive integer set."""
    lines = set()
    for line in breakpoint_lines or []:
        try:
            value = int(line)
        except Exception:
            continue
        if value > 0:
            lines.add(value)
    return lines


class _DebugBreakpointTransformer(ast.NodeTransformer):
    """Adds breakpoint helper calls before statements on active source lines."""

    def generic_visit(self, node):
        """Visits children and injects breakpoint calls into statement lists."""
        node = super().generic_visit(node)
        for field in ("body", "orelse", "finalbody"):
            statements = getattr(node, field, None)
            if isinstance(statements, list):
                setattr(node, field, self._with_breakpoints(statements))
        return node

    def _with_breakpoints(self, statements):
        """Returns a statement list with helper calls inserted before matching source lines."""
        injected = []
        for statement in statements:
            if self._can_break_before(statement):
                injected.append(_debug_breakpoint_statement(statement))
            injected.append(statement)
        return injected

    def _can_break_before(self, statement):
        """Returns whether one statement can safely host a dynamic breakpoint guard."""
        return int(getattr(statement, "lineno", 0) or 0) > 0 and not isinstance(statement, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))


def _debug_statement_owns_nested_lines(statement):
    """Returns whether a statement span mainly represents nested child statement lines."""
    return isinstance(statement, (
        ast.AsyncFor,
        ast.AsyncFunctionDef,
        ast.AsyncWith,
        ast.ClassDef,
        ast.For,
        ast.FunctionDef,
        ast.If,
        ast.Match,
        ast.Try,
        ast.While,
        ast.With,
    ))


def _debug_breakpoint_statement(statement):
    """Builds an overlay-line breakpoint call guarded by the debugpy connection state."""
    start = int(getattr(statement, "lineno", 0) or 0)
    end = start if _debug_statement_owns_nested_lines(statement) else int(getattr(statement, "end_lineno", start) or start)
    node = ast.If(
        test=ast.Call(func=ast.Name(id="_djs_debug_should_break", ctx=ast.Load()), args=[ast.Constant(value=start), ast.Constant(value=end)], keywords=[]),
        body=[ast.Expr(value=_debug_builtin_breakpoint_call())],
        orelse=[],
    )
    return _debug_copy_location(node, statement)


def _debug_builtin_breakpoint_call():
    """Builds a builtins.breakpoint call without depending on user namespace names."""
    return ast.Call(
        func=ast.Attribute(
            value=ast.Call(func=ast.Name(id="__import__", ctx=ast.Load()), args=[ast.Constant(value="builtins")], keywords=[]),
            attr="breakpoint",
            ctx=ast.Load(),
        ),
        args=[],
        keywords=[],
    )


def _debug_copy_location(node, source):
    """Copies source location metadata onto a node and its direct children."""
    ast.copy_location(node, source)
    for child in ast.walk(node):
        if child is not node:
            ast.copy_location(child, source)
    return node


def _debug_current_thread(active):
    """Enables debugger tracing on the request thread only for debug runs so a warm debugpy connection does not trace normal cells; disables it otherwise."""
    debugpy = sys.modules.get("debugpy")
    if not debugpy:
        return
    try:
        if active:
            connected = getattr(debugpy, "is_client_connected", lambda: True)()
            if connected and hasattr(debugpy, "debug_this_thread"):
                debugpy.debug_this_thread()
        elif hasattr(debugpy, "trace_this_thread"):
            debugpy.trace_this_thread(False)
    except Exception:
        pass


def _split_last_expression(tree):
    """Returns executable statements and an optional final expression node."""
    if not tree.body or not isinstance(tree.body[-1], ast.Expr):
        return tree.body, None
    return tree.body[:-1], tree.body[-1]


class _ProgressTransformer(ast.NodeTransformer):
    """Wraps Python for-loop iterables so the UI can poll processed item counts."""

    def visit_For(self, node):
        """Adds a progress wrapper around one synchronous for-loop iterable."""
        self.generic_visit(node)
        if _progress_for_iter_handled_elsewhere(node.iter):
            return node
        node.iter = ast.Call(
            func=ast.Name(id="_djs_progress_iter", ctx=ast.Load()),
            args=[node.iter, ast.Constant(value=_progress_iter_label(node.iter)), ast.Constant(value=getattr(node, "lineno", 0))],
            keywords=[],
        )
        return node


def _progress_for_iter_handled_elsewhere(node):
    """Returns whether an iterable expression already has a more specific progress hook."""
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "iterator"


def _progress_instrument_tree(tree):
    """Returns an AST where for-loops update the shared progress snapshot."""
    instrumented = _ProgressTransformer().visit(tree)
    ast.fix_missing_locations(instrumented)
    return instrumented


def _progress_iter_label(node):
    """Returns a compact display label for one for-loop iterable expression."""
    try:
        text = ast.unparse(node)
    except Exception:
        text = "iterable"
    return _truncate(text.replace("\n", " "), 120)


def _progress_begin(code, emit=False):
    """Starts a shared progress snapshot for one backend execution."""
    now = time.time()
    with _PROGRESS_LOCK:
        _STATE["progress_emit"] = bool(emit)
        _STATE["progress"] = {"active": True, "current": 0, "done": False, "elapsed": 0, "kind": "execute", "label": "Preparing Python cell", "line": 0, "startedAt": now, "total": None, "updatedAt": now}
    _progress_emit()


def _progress_finish(ok):
    """Marks the current progress snapshot as complete."""
    now = time.time()
    with _PROGRESS_LOCK:
        progress = dict(_STATE.get("progress") or {})
        started = progress.get("startedAt") or now
        progress.update({"active": False, "done": True, "elapsed": max(0, now - started), "ok": bool(ok), "updatedAt": now})
        _STATE["progress"] = progress
    _progress_emit()


def _progress_snapshot():
    """Returns the latest execution progress without waiting on the execution lock."""
    now = time.time()
    with _PROGRESS_LOCK:
        progress = dict(_STATE.get("progress") or {})
    if not progress:
        return {"active": False, "done": True, "ok": True}
    started = progress.get("startedAt") or now
    current = progress.get("current")
    total = progress.get("total")
    progress["elapsed"] = max(0, now - started)
    if isinstance(current, (int, float)) and isinstance(total, (int, float)) and total > 0:
        progress["percent"] = min(100, max(0, current * 100 / total))
    return progress


class _StreamingCapture(io.StringIO):
    """StringIO capture that can mirror live writes as progress output markers."""

    def __init__(self, stream_name, emit=False):
        """Stores the stream label and whether writes should be mirrored."""
        super().__init__()
        self._stream_name = stream_name
        self._emit = bool(emit)

    @property
    def encoding(self):
        """Returns the real terminal encoding for libraries that inspect stream capabilities."""
        return getattr(getattr(sys, "__stdout__", None), "encoding", None) or "utf-8"

    def isatty(self):
        """Reports a tty-like stream while live output mirroring is active."""
        return bool(self._emit)

    def write(self, text):
        """Captures text and mirrors it to the UI progress stream when enabled."""
        value = str(text)
        written = super().write(value)
        if self._emit and value:
            _progress_output(self._stream_name, value)
        return written

    def flush(self):
        """Keeps file-like flush calls from progress libraries harmless."""
        return None


def _progress_update(**fields):
    """Merges fields into the shared progress snapshot."""
    now = time.time()
    with _PROGRESS_LOCK:
        progress = dict(_STATE.get("progress") or {})
        started = progress.get("startedAt") or now
        progress.update(fields)
        progress.update({"active": True, "done": False, "elapsed": max(0, now - started), "updatedAt": now})
        _STATE["progress"] = progress
    _progress_emit()


def _progress_iter(iterable, label="", line=0, total=None):
    """Yields an iterable while publishing processed item counts for UI polling."""
    detail = _progress_iter_detail(iterable, label)
    _progress_update(current=0, detail=detail, label="Counting iterable", line=line, total=None)
    total = _progress_iter_total(iterable) if total is None else total
    current = 0
    started = time.time()
    last_update = 0
    _progress_update(current=0, detail=detail, label="Iterating", line=line, total=total)
    previous_wrapping = _STATE.get("progress_iter_wrapping")
    _STATE["progress_iter_wrapping"] = True
    try:
        for item in iterable:
            current += 1
            now = time.time()
            if current <= 10 or now - last_update >= _PROGRESS_INTERVAL_SECONDS:
                elapsed = max(0.001, now - started)
                _progress_update(current=current, detail=detail, label="Iterating", line=line, rate=current / elapsed, total=total)
                last_update = now
            yield item
    finally:
        _STATE["progress_iter_wrapping"] = previous_wrapping
    elapsed = max(0.001, time.time() - started)
    _progress_update(current=current, detail=detail, label="Finished iterable", line=line, rate=current / elapsed, total=total)


def _progress_iter_total(iterable):
    """Returns a cheap total for common iterables, including Django QuerySets."""
    try:
        from django.db.models.query import QuerySet

        if isinstance(iterable, QuerySet):
            return int(iterable.count())
    except Exception:
        pass
    try:
        return len(iterable)
    except Exception:
        return None


def _progress_iter_detail(iterable, label):
    """Returns a compact human-readable label for the current iterable."""
    try:
        from django.db.models.query import QuerySet

        if isinstance(iterable, QuerySet):
            model = getattr(iterable, "model", None)
            model_label = getattr(getattr(model, "_meta", None), "label", None)
            return f"{model_label or 'QuerySet'}: {label}"
    except Exception:
        pass
    return label or type(iterable).__name__


def _progress_emit():
    """Writes a progress marker to the real terminal stream when PTY streaming is active."""
    if not _STATE.get("progress_emit"):
        return
    _progress_write_marker(_progress_snapshot())


def _progress_output(stream_name, text):
    """Writes one live stdout/stderr chunk as a progress marker."""
    if not _STATE.get("progress_emit"):
        return
    _progress_write_marker({"active": True, "kind": "output", "output": text, "stream": stream_name})


def _progress_write_marker(payload):
    """Writes one JSON progress payload to the real terminal stream."""
    try:
        stream = getattr(sys, "__stdout__", None) or sys.stdout
        stream.write(_PROGRESS_PREFIX + json.dumps(payload) + "\n")
        stream.flush()
    except Exception:
        pass


def _install_queryset_progress():
    """Patches Django QuerySet iteration so ORM work can report processed rows while progress is active."""
    if _STATE.get("queryset_progress_installed"):
        return
    try:
        from django.db.models.query import QuerySet
    except Exception:
        return
    original_iter = QuerySet.__iter__
    original_iterator = QuerySet.iterator

    def _iter(self):
        """Returns the normal QuerySet iterator, wrapped with progress when a cell is active."""
        return _progress_queryset_iterable(self, original_iter(self))

    def _iterator(self, *args, **kwargs):
        """Returns QuerySet.iterator(), wrapped with progress when a cell is active."""
        return _progress_queryset_iterable(self, original_iterator(self, *args, **kwargs))

    QuerySet.__iter__ = _iter
    QuerySet.iterator = _iterator
    _STATE["queryset_progress_installed"] = True


def _progress_queryset_iterable(queryset, iterable):
    """Wraps a QuerySet iterable with progress metadata when progress is currently active."""
    if not _progress_enabled() or _STATE.get("progress_iter_wrapping"):
        return iterable
    total = None
    try:
        total = int(queryset.count())
    except Exception:
        pass
    return _progress_iter(iterable, _progress_queryset_label(queryset), 0, total)


def _progress_enabled():
    """Returns whether an execution is currently publishing progress."""
    with _PROGRESS_LOCK:
        progress = _STATE.get("progress") or {}
        return bool(progress.get("active"))


def _progress_queryset_label(queryset):
    """Returns a compact label for one Django QuerySet."""
    try:
        model = getattr(queryset, "model", None)
        model_label = getattr(getattr(model, "_meta", None), "label", None)
        return model_label or "QuerySet"
    except Exception:
        return "QuerySet"


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
            # Surface per-row annotation columns (e.g. annotate(Count('books')) / Window(...)) that Django sets on the
            # instance, skipping the internal djs_/__ aliases used for declared-@property filters.
            ann_names = [name for name in getattr(value.query, "annotation_select", {}) or {} if isinstance(name, str) and not name.startswith("djs_") and not name.startswith("__")]
            rows = [_browse_serialize_row(dict({attname: getattr(instance, attname, None) for attname in concrete_names}, **{name: getattr(instance, name, None) for name in ann_names})) for instance in itertools.islice(value, _PTY_ORM_TABULATE_LIMIT + 1)]
            has_more = len(rows) > _PTY_ORM_TABULATE_LIMIT
            rows = rows[:_PTY_ORM_TABULATE_LIMIT]
            columns = _browse_columns(model) + [{"annotation": True, "attname": name, "editable": False, "name": name, "null": True, "pk": False, "type": "annotation"} for name in ann_names] + _browse_computed_columns(model)
            return {"app": model._meta.app_label, "columns": columns, "editable": True, "hasMore": has_more, "model": model._meta.object_name, "ok": True, "pk": model._meta.pk.attname, "relations": _browse_relations(model), "rows": rows}
        if isinstance(value, Model):
            model = type(value)
            concrete_names = [column["attname"] for column in _browse_columns(model)]
            row = _browse_serialize_row({attname: getattr(value, attname, None) for attname in concrete_names})
            return {"app": model._meta.app_label, "columns": _browse_columns(model) + _browse_computed_columns(model), "editable": True, "hasMore": False, "model": model._meta.object_name, "ok": True, "pk": model._meta.pk.attname, "relations": _browse_relations(model), "rows": [row]}
        if isinstance(value, QuerySet):
            payload = _browse_tabulate(list(itertools.islice(value, _PTY_ORM_TABULATE_LIMIT + 1)), 0, _PTY_ORM_TABULATE_LIMIT)
            payload["ok"] = True
            payload.setdefault("relations", [])
            return payload
        payload = _browse_tabulate(value, 0, _PTY_ORM_TABULATE_LIMIT)
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
    return _pty_install_plain_capture(sys, namespace)


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
            raw_metadata["models"] = _browse_models_or_loading()
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


def _pty_install_plain_capture(sys, namespace):
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
            raw = _pty_plain_last_history()
            ok = "Traceback (most recent call last)" not in err
            inspect = None
            matched_probe, probe_value, probe_error = _pty_inspect_probe_target(raw, namespace)
            inspection_probe = matched_probe or (ok and (_pty_is_models_probe(raw) or _pty_is_runtime_probe(raw)))
            if inspection_probe:
                out = ""
                err = ""
            grid = None if inspection_probe or not ok else _pty_tabulate_result(value)
            raw_metadata = {}
            if ok and _pty_is_models_probe(raw):
                _autoimport_registered_models(namespace)
                raw_metadata["models"] = _browse_models_or_loading()
            if ok and _pty_is_runtime_probe(raw):
                raw_metadata["runtime"] = _pty_runtime_inspection(namespace)
            if matched_probe:
                if probe_error:
                    inspect = {"children": [], "error": probe_error}
                else:
                    try:
                        inspect = {"children": _browse_children_of(probe_value, [])}
                    except Exception:
                        inspect = {"children": [], "error": traceback.format_exc()}
            state["counter"] += 1
            response = {"grid": grid, "inspect": inspect, "ok": ok or matched_probe, "result": None, "stderr": "" if ok else err, "stdout": out, "traceback": err if not ok else ""}
            metadata = _STATE.pop("pty_raw_metadata", None)
            if isinstance(metadata, dict):
                response.update(metadata)
            response.update(raw_metadata)
            # Write straight to the real stream so the marker is not re-captured by the tee.
            real_out.write(_pty_cell_marker("_djs_cell-%d" % state["counter"], response) + "\n")
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


def _pty_plain_last_history():
    """Returns the latest plain-REPL history item when readline exposes it."""
    try:
        import readline

        return readline.get_history_item(readline.get_current_history_length()) or ""
    except Exception:
        return ""


def _pty_serve(namespace, token, request_json, request_id, initial_names):
    """Services one PTY-fallback request, prints the response marker, then keeps the interactive
    shell history clean: the user's executed ORM (execute/query) stays as a tidy line, while the
    extension's plumbing (grid/inspect/keepalive/bootstrap) is removed from history and the counter."""
    try:
        request = json.loads(request_json)
    except Exception:
        request = {}
    _progress_begin(str(request.get("kind") or "request"), emit=True)
    try:
        response = _run_request(namespace, token, request, initial_names)
        _progress_finish(bool(isinstance(response, dict) and response.get("ok", True)))
    except Exception:
        response = {"ok": False, "stdout": "", "stderr": "", "traceback": traceback.format_exc()}
        _progress_finish(False)
    _STATE["progress_emit"] = False
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


def _browse_parallel_context():
    """Returns a no-op context for read-only model browser requests that may run beside cell execution."""
    return contextlib.nullcontext()


def _browse_rows_context(request):
    """Returns the execution lock only when row annotations may read shell namespace aliases."""
    annotations = request.get("annotations")
    needs_namespace = any(isinstance(item, dict) and item.get("kind") == "annotate" for item in annotations) if isinstance(annotations, list) else False
    return _EXECUTION_LOCK if needs_namespace else _browse_parallel_context()


def _browse_models():
    """Returns the catalog of installed models as browsable tables."""
    with _browse_parallel_context():
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
    with _browse_parallel_context():
        try:
            model = _browse_resolve_model(request)
            meta = model._meta
            return {"app": meta.app_label, "columns": _browse_columns(model) + _browse_computed_columns(model), "label": str(meta.verbose_name), "model": meta.object_name, "ok": True, "pk": meta.pk.attname, "relations": _browse_relations(model), "table": meta.db_table}
        except Exception:
            return {"ok": False, "error": traceback.format_exc()}


def _browse_rows(namespace, request):
    """Returns one bounded page of rows (concrete columns only — no JOIN, no N+1), plus any per-row annotation columns
    (raw annotate expressions, relation/field aggregates, window functions, F-expression arithmetic) defined by the column builder."""
    with _browse_rows_context(request):
        try:
            model = _browse_resolve_model(request)
            attnames = [column["attname"] for column in _browse_columns(model)]
            pk_attname = model._meta.pk.attname
            annotations = _browse_annotation_specs(model, request.get("annotations"), set(attnames), pk_attname, namespace)
            ann_exprs = {spec["alias"]: spec["expr"] for spec in annotations}
            ann_aliases = [spec["alias"] for spec in annotations]
            has_window = any(spec["window"] for spec in annotations)
            columns = _browse_columns(model) + _browse_annotation_columns(annotations) + _browse_computed_columns(model)
            limit = _browse_limit(request.get("limit"), maximum=None)
            # Sorting may target a concrete column or an annotation alias; alias order_by is applied AFTER .annotate() below.
            order = _browse_order(request.get("order"), attnames, pk_attname, ann_aliases)
            # A lookup on an annotation column filters AFTER .annotate() (HAVING for aggregates, WHERE on the expression for
            # F-expr); window columns can't be filtered in SQL, so those filters are dropped. The rest stay WHERE filters.
            having_aliases = {spec["alias"] for spec in annotations if not spec["window"]}
            all_alias_set = {spec["alias"] for spec in annotations}
            base_filters, having_filters = _browse_split_having(request.get("filters"), all_alias_set, having_aliases)
            # Window functions are evaluated over the WHERE set, then LIMIT/OFFSET; a keyset cursor (pk__gt) would restart
            # their frames on every page, so any window annotation forces offset pagination. Ordering by an annotation alias
            # likewise can't keyset on pk, so it falls through to offset paging (order != [pk]).
            keyset_capable = order == [pk_attname] and not has_window
            queryset, property_terms = _browse_apply_db_filters(model._base_manager.all(), model, base_filters, attnames)
            if ann_exprs:
                queryset = queryset.annotate(**ann_exprs)
            if having_filters:
                queryset = queryset.filter(_browse_having_q(having_filters, having_aliases))
            # order_by AFTER .annotate() so a sort on an annotation alias resolves (a pre-annotate order_by raises FieldError).
            queryset = queryset.order_by(*order)
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
                    raw = [dict({attname: getattr(obj, attname, None) for attname in attnames}, **{alias: getattr(obj, alias, None) for alias in ann_aliases}) for obj in objects]
                else:
                    raw = list(queryset.values(*attnames, *ann_aliases)[: limit + 1])
            has_more = len(raw) > limit
            raw = raw[:limit]
            next_cursor = raw[-1][pk_attname] if keyset_capable and has_more and raw else None
            next_offset = base_offset + limit if not keyset_capable and has_more else None
            orm = _browse_orm_rows(model, order, base_filters, attnames, pk_attname, keyset_capable, cursor, base_offset, limit, annotations, having_filters)
            return {"columns": columns, "hasMore": has_more, "nextCursor": _browse_jsonable(next_cursor), "nextOffset": next_offset, "ok": True, "orm": orm, "pk": pk_attname, "rows": [_browse_serialize_row(row) for row in raw], "sql": _browse_sql(ctx)}
        except Exception:
            return {"ok": False, "columns": [], "error": traceback.format_exc(), "rows": []}


def _browse_related(request):
    """Returns related rows for one source row, fetched lazily on explicit expansion."""
    with _browse_parallel_context():
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
            relation = {"field": field.name, "single": True, "target": _browse_label(field.related_model)}
            relation.update(_browse_relation_subquery_meta(model, field))
            column["relation"] = relation
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


def _browse_computed(namespace, request):
    """Lazily computes ONE @property over the current filter/order page — the opt-in replacement for eager-loading. The user activates a single column, so only that property runs (no N+1 across every property, no multi-model JOIN explosion), bounded to the loaded rows. Restricted to actual @property/@cached_property names; each value read via safe getattr so a throwing property yields null, not a failure. Returns {pk: cell}."""
    with _EXECUTION_LOCK:
        try:
            model = _browse_resolve_model(request)
            field = request.get("field")
            if not isinstance(field, str) or not field.isidentifier() or not _pty_is_computed_field(model, field):
                return {"ok": False, "error": "not a computed field", "values": {}}
            attnames = [column["attname"] for column in _browse_columns(model)]
            pk_attname = model._meta.pk.attname
            # Reproduce the rows page exactly (same per-row annotations / HAVING / order) so the {pk: value} map covers the
            # displayed rows even when the grid is sorted by an annotation alias (which the rows query annotates).
            ann_specs = _browse_annotation_specs(model, request.get("annotations"), set(attnames), pk_attname, namespace)
            ann_exprs = {spec["alias"]: spec["expr"] for spec in ann_specs}
            ann_aliases = {spec["alias"] for spec in ann_specs}
            having_aliases = {spec["alias"] for spec in ann_specs if not spec["window"]}
            base_filters, having_filters = _browse_split_having(request.get("filters"), ann_aliases, having_aliases)
            order = _browse_order(request.get("order"), attnames, pk_attname, ann_aliases)
            limit = _browse_limit(request.get("limit"), maximum=None)
            queryset, property_terms = _browse_apply_db_filters(model._base_manager.all(), model, base_filters, attnames)
            if ann_exprs:
                queryset = queryset.annotate(**ann_exprs)
            if having_filters:
                queryset = queryset.filter(_browse_having_q(having_filters, having_aliases))
            queryset = queryset.order_by(*order)
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
        relation = {"kind": _browse_relation_kind(field), "name": name, "queryName": _browse_relation_query_name(field) or name, "single": single, "target": _browse_label(field.related_model)}
        relation.update(_browse_relation_subquery_meta(model, field))
        relations.append(relation)
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


def _browse_relation_subquery_meta(model, field):
    """Returns relation metadata the UI/ORM-mode builder needs to generate a correlated one-row Subquery safely."""
    meta = {}
    try:
        if getattr(field, "many_to_many", False):
            relation_field = getattr(field, "field", field)
            owner_model = getattr(relation_field, "model", model)
            if getattr(field, "auto_created", False):
                source_name = relation_field.m2m_reverse_field_name()
                target_name = relation_field.m2m_field_name()
            else:
                source_name = relation_field.m2m_field_name()
                target_name = relation_field.m2m_reverse_field_name()
            meta.update({"throughOwner": owner_model.__name__, "throughRelation": relation_field.name, "throughSource": source_name, "throughTarget": target_name})
        elif getattr(field, "auto_created", False) and not getattr(field, "concrete", False):
            forward = getattr(field, "field", None)
            if forward is not None:
                meta.update({"filterField": forward.attname, "outerField": "pk"})
        elif getattr(field, "many_to_one", False) or getattr(field, "one_to_one", False):
            meta.update({"filterField": field.related_model._meta.pk.attname, "outerField": field.attname})
    except Exception:
        return meta
    return meta


def _browse_filter_fields(request):
    """Returns the filterable field/relation tree for one model so the cascading filter UI can drill across relations."""
    with _browse_parallel_context():
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
        relation = {"kind": _browse_relation_kind(field), "name": name, "single": bool(field.one_to_one or field.many_to_one), "target": _browse_label(field.related_model)}
        relation.update(_browse_relation_subquery_meta(model, field))
        relations.append(relation)
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


def _browse_order(order, attnames, pk_attname, extra=None):
    """Returns a safe order-by list restricted to real columns (plus any allowlisted annotation aliases in `extra`),
    defaulting to the primary key. Annotation aliases are applied AFTER .annotate() by the caller so they resolve."""
    allowed = attnames if not extra else (set(attnames) | set(extra))
    result = []
    if isinstance(order, list):
        for item in order:
            field = item.get("field") if isinstance(item, dict) else item
            descending = isinstance(item, dict) and bool(item.get("desc"))
            if field in allowed:
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


_BROWSE_LOOKUPS = frozenset({"exact", "iexact", "contains", "icontains", "gt", "gte", "lt", "lte", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "range", "date", "year", "quarter", "month", "week_day", "day", "hour", "minute", "second", "length", "length__gt", "length__gte", "length__lt", "length__lte", "trim"})


def _browse_count(request):
    """Returns the row count for the current filter set, computed only on explicit request."""
    with _browse_parallel_context():
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


_BROWSE_AGG_FUNCS = frozenset({"count", "sum", "avg", "min", "max", "exists"})
_BROWSE_AGG_LABELS = {"count": "Count", "sum": "Sum", "avg": "Avg", "min": "Min", "max": "Max"}


def _browse_aggregate(request):
    """Computes grouped or global aggregates (Count/Sum/Avg/Min/Max/Exists) for the current filter set. DB-aggregatable
    args (concrete columns and Count over a reverse/M2M relation) run as one GROUP BY/aggregate query; @property args are
    streamed object-by-object and aggregated in Python (a full scan), then merged with the DB results by group. Group-by
    and DB args are allowlisted against the live model graph (no injection); the result is a read-only grid."""
    with _browse_parallel_context():
        try:
            from django.db.models import Avg, Count, Max, Min, Sum

            model = _browse_resolve_model(request)
            attnames = [field.attname for field in model._meta.concrete_fields]
            attset = set(attnames)
            pk_attname = model._meta.pk.attname
            group_by = _browse_agg_group_by(request.get("groupBy"), attset, pk_attname, model)
            specs = _browse_agg_specs(model, request.get("aggregates"), attset, pk_attname, bool(group_by))
            if not specs and not group_by:
                return {"columns": [], "error": "Add at least one aggregate, or a group-by field.", "ok": False, "rows": []}
            if not specs:
                return {"columns": [], "error": "Add at least one aggregate to compute per group.", "ok": False, "rows": []}
            db_specs = [spec for spec in specs if spec["kind"] == "db"]
            exists_specs = [spec for spec in specs if spec["kind"] == "exists"]
            py_specs = [spec for spec in specs if spec["kind"] == "py"]
            # A lookup on an aggregate column filters the groups AFTER aggregation (HAVING) — only DB aggregates support it
            # (a Python-@property aggregate can't be a SQL HAVING). Such filters are split out of the WHERE clause.
            having_aliases = {spec["alias"] for spec in db_specs} if group_by else set()
            base_filters, having_filters = _browse_split_having(request.get("filters"), {spec["alias"] for spec in specs}, having_aliases)
            queryset, property_terms = _browse_apply_db_filters(model._base_manager.all(), model, base_filters, attnames)
            if property_terms:
                return {"columns": [], "error": "Aggregation cannot combine with Python @property filters; remove them first.", "ok": False, "rows": []}
            limit = _browse_limit(request.get("limit"), default=1000, maximum=None)
            builders = {"count": Count, "sum": Sum, "avg": Avg, "min": Min, "max": Max}

            def _expr(spec):
                if spec["func"] == "count":
                    return Count(spec["arg"], distinct=spec["distinct"])
                return builders[spec["func"]](spec["arg"])

            with _browse_capture() as ctx:
                if group_by:
                    by_group = {}
                    order = []
                    if db_specs:
                        grouped_qs = queryset.values(*group_by).annotate(**{spec["alias"]: _expr(spec) for spec in db_specs})
                        if having_filters:
                            grouped_qs = grouped_qs.filter(_browse_having_q(having_filters, having_aliases))
                    else:
                        # No DB aggregate to define the GROUP BY — seed the ordered, bounded group set from a cheap distinct
                        # query so a @property-only grouped aggregate matches the DB path's ordering and limit instead of
                        # materializing every group in iteration order.
                        grouped_qs = queryset.values(*group_by).distinct()
                    for row in grouped_qs.order_by(*group_by)[: limit + 1]:
                        key = tuple(row.get(name) for name in group_by)
                        order.append(key)
                        by_group[key] = dict(row)
                    if py_specs:
                        _browse_agg_python_grouped(queryset, group_by, py_specs, by_group, order)
                    has_more = len(order) > limit
                    order = order[:limit]
                    names = list(group_by) + [spec["alias"] for spec in specs]
                    rows = [_browse_serialize_row({name: by_group.get(key, {}).get(name) for name in names}) for key in order]
                else:
                    result = {}
                    aggregate = {spec["alias"]: _expr(spec) for spec in db_specs}
                    if aggregate:
                        result.update(queryset.aggregate(**aggregate))
                    for spec in exists_specs:
                        result[spec["alias"]] = queryset.exists()
                    if py_specs:
                        result.update(_browse_agg_python_global(queryset, py_specs))
                    # Non-exists first, then exists, matching the ORM-mode cell's dict order so both transports agree.
                    names = [spec["alias"] for spec in specs if spec["func"] != "exists"] + [spec["alias"] for spec in specs if spec["func"] == "exists"]
                    rows = [_browse_serialize_row({name: result.get(name) for name in names})]
                    has_more = False
            columns = [_browse_agg_column(name, name in group_by) for name in names]
            payload = {"columns": columns, "editable": False, "groupBy": group_by, "hasMore": has_more, "ok": True, "orm": _browse_orm_aggregate(model, base_filters, attset, group_by, specs, having_filters), "pk": None, "relations": [], "rows": rows, "sql": _browse_sql(ctx)}
            if py_specs:
                payload["pythonScan"] = True
            return payload
        except Exception:
            return {"columns": [], "error": traceback.format_exc(), "ok": False, "rows": []}


def _browse_agg_group_by(group_by, attset, pk_attname, model):
    """Returns the safe, deduped group-by field names (concrete columns, `pk`→attname, or an FK-drill-in traversal path that
    ends on a concrete field), bounded to 8."""
    result = []
    if isinstance(group_by, list):
        for item in group_by:
            name = item.get("field") if isinstance(item, dict) else item
            if not isinstance(name, str):
                continue
            resolved = pk_attname if name == "pk" else name
            if resolved in result:
                continue
            if resolved in attset:
                result.append(resolved)
            elif "__" in resolved:
                # Group by a related concrete field (author__country); a path ending on a relation can't be a GROUP BY key.
                path = _browse_resolve_filter_path(model, resolved)
                if path is not None and not path[2]:
                    result.append(resolved)
            if len(result) >= 8:
                break
    return result


def _browse_agg_specs(model, aggregates, attset, pk_attname, grouped):
    """Parses aggregate terms into safe {func, arg, alias, distinct, kind} specs. `kind` is `db` (concrete column, or
    Count over a reverse/M2M relation query name), `py` (a @property computed object-by-object), or `exists` (global-only).
    Functions/fields are allowlisted, aliases sanitized to unique identifiers, and `exists` is dropped when grouping."""
    specs = []
    used = set()
    if not isinstance(aggregates, list):
        return specs
    relation_names = _browse_agg_relation_names(model)
    for term in aggregates:
        if not isinstance(term, dict):
            continue
        func = term.get("func")
        if func not in _BROWSE_AGG_FUNCS:
            continue
        kind = "db"
        to_many = False
        if func == "exists":
            if grouped:
                continue
            arg, kind = pk_attname, "exists"
        elif func == "count":
            raw = term.get("field")
            if raw in (None, "", "*", "pk"):
                arg = pk_attname
            elif raw in attset:
                arg = raw
            elif raw in relation_names:
                arg, to_many = raw, _browse_path_is_to_many(model, raw)
            elif isinstance(raw, str) and "__" in raw and _browse_resolve_filter_path(model, raw) is not None:
                # FK drill-in: count related rows / a related field across an allowlisted traversal path.
                arg, to_many = raw, _browse_path_is_to_many(model, raw)
            elif isinstance(raw, str) and raw not in attset and raw.isidentifier() and _pty_is_computed_field(model, raw):
                arg, kind = raw, "py"
            else:
                continue
        else:
            raw = term.get("field")
            arg = pk_attname if raw == "pk" else raw
            if isinstance(arg, str) and arg in attset:
                pass
            elif isinstance(arg, str) and "__" in arg:
                # FK drill-in for Sum/Avg/Min/Max: must end on a concrete field AND not cross a to-many relation — a join
                # fan-out would silently inflate the sum/average and distinct can't fix it, so reject those paths.
                resolved = _browse_resolve_filter_path(model, arg)
                if resolved is None or resolved[2] or resolved[1]:
                    continue
            elif isinstance(arg, str) and arg not in attset and arg not in relation_names and arg.isidentifier() and _pty_is_computed_field(model, arg):
                kind = "py"
            else:
                # Relations are only countable (Sum/Avg/… over a bare relation is invalid); unknown args are dropped.
                continue
        alias = _browse_agg_alias(term.get("alias"), func, arg, used)
        used.add(alias)
        # Count over a to-many relation/traversal must be distinct, else a sibling to-many join multiplies the tally.
        distinct = func == "count" and (bool(term.get("distinct")) or to_many)
        specs.append({"alias": alias, "arg": arg, "distinct": distinct, "func": func, "kind": kind})
        if len(specs) >= 20:
            break
    return specs


def _browse_path_is_to_many(model, name):
    """Returns whether a relation name or traversal path crosses a to-many (reverse-FK / M2M) relation. Such an aggregate
    must count distinct (a sibling to-many join would multiply the tally), and Sum/Avg over it is unreliable (fan-out)."""
    if not isinstance(name, str):
        return False
    if "__" in name:
        resolved = _browse_resolve_filter_path(model, name)
        return bool(resolved and resolved[1])
    field = _browse_match_segment(model, name)
    return bool(field is not None and (getattr(field, "one_to_many", False) or getattr(field, "many_to_many", False)))


def _browse_agg_relation_names(model):
    """Returns the set of filter/aggregate query names for the model's relations (reverse uses related_query_name)."""
    names = set()
    for field in model._meta.get_fields():
        if getattr(field, "is_relation", False) and getattr(field, "related_model", None) is not None:
            name = _browse_relation_query_name(field)
            if name:
                names.add(name)
    return names


def _browse_agg_python_global(queryset, py_specs):
    """Streams the filtered objects once and reduces each @property aggregate in Python (a full scan, bounded memory)."""
    accumulators = {spec["alias"]: _browse_agg_py_init() for spec in py_specs}
    for obj in queryset.iterator(chunk_size=_PROPERTY_FILTER_CHUNK_SIZE):
        for spec in py_specs:
            _browse_agg_py_update(accumulators[spec["alias"]], _pty_safe_getattr(obj, spec["arg"]))
    return {spec["alias"]: _browse_agg_py_final(accumulators[spec["alias"]], spec["func"]) for spec in py_specs}


def _browse_agg_python_grouped(queryset, group_by, py_specs, by_group, order):
    """Streams the filtered objects once, buckets them by group key, and reduces each @property aggregate per group.
    When `order` is already populated (a DB pass ran), only those groups are accumulated and the values merged in;
    otherwise the buckets define the groups and their first-seen order."""
    wanted = set(order) if order else None
    accumulators = {}
    group_values = {}
    for obj in queryset.iterator(chunk_size=_PROPERTY_FILTER_CHUNK_SIZE):
        key = tuple(_pty_safe_getattr(obj, name) for name in group_by)
        if wanted is not None and key not in wanted:
            continue
        bucket = accumulators.get(key)
        if bucket is None:
            bucket = {spec["alias"]: _browse_agg_py_init() for spec in py_specs}
            accumulators[key] = bucket
            if wanted is None:
                group_values[key] = {name: _pty_safe_getattr(obj, name) for name in group_by}
        for spec in py_specs:
            _browse_agg_py_update(bucket[spec["alias"]], _pty_safe_getattr(obj, spec["arg"]))
    for key, bucket in accumulators.items():
        if key not in by_group:
            by_group[key] = dict(group_values.get(key, {}))
            order.append(key)
        by_group[key].update({spec["alias"]: _browse_agg_py_final(bucket[spec["alias"]], spec["func"]) for spec in py_specs})


def _browse_agg_py_init():
    """Returns a fresh streaming accumulator (count/summable-count/sum/min/max state) for one @property aggregate."""
    return {"n": 0, "sum": 0, "sum_n": 0, "min": None, "max": None}


def _browse_agg_py_update(accumulator, value):
    """Folds one @property value into a streaming accumulator (None is ignored, like SQL aggregates). `n` counts every
    non-None value (for Count); `sum`/`sum_n` track only the values that are actually addable, so a mixed-type property
    averages over its numeric subset rather than dividing a partial sum by the full count."""
    if value is None:
        return
    accumulator["n"] += 1
    try:
        accumulator["sum"] += value
        accumulator["sum_n"] += 1
    except Exception:
        pass
    if accumulator["min"] is None or _browse_agg_lt(value, accumulator["min"]):
        accumulator["min"] = value
    if accumulator["max"] is None or _browse_agg_lt(accumulator["max"], value):
        accumulator["max"] = value


def _browse_agg_py_final(accumulator, func):
    """Finalizes a streaming accumulator into the aggregate value (None on empty, matching SQL aggregate semantics)."""
    if func == "count":
        return accumulator["n"]
    if func == "sum":
        return accumulator["sum"] if accumulator["sum_n"] else None
    if func == "avg":
        return accumulator["sum"] / accumulator["sum_n"] if accumulator["sum_n"] else None
    if func == "min":
        return accumulator["min"]
    if func == "max":
        return accumulator["max"]
    return None


def _browse_agg_lt(left, right):
    """Returns left < right, or False when the values aren't orderable together."""
    try:
        return left < right
    except Exception:
        return False


def _browse_agg_safe_alias(name):
    """Returns whether a string is a safe column alias: an identifier, not a Python keyword, not an internal djs_/__ alias."""
    return isinstance(name, str) and name.isidentifier() and not keyword.iskeyword(name) and not name.startswith("djs_") and not name.startswith("__")


def _browse_agg_alias(alias, func, arg, used):
    """Returns a unique safe identifier alias for one aggregate/annotation column (used as an ORM keyword argument)."""
    candidate = alias if _browse_agg_safe_alias(alias) else ("exists" if func == "exists" else f"{arg}_{func}")
    if not _browse_agg_safe_alias(candidate):
        candidate = f"agg_{func}"
    base = candidate
    suffix = 2
    while candidate in used:
        candidate = f"{base}_{suffix}"
        suffix += 1
    return candidate


def _browse_agg_column(name, is_group):
    """Returns a read-only grid column descriptor for one group-by or aggregate result column."""
    return {"attname": name, "editable": False, "name": name, "null": True, "pk": False, "type": "group" if is_group else "agg"}


_BROWSE_WINDOW_RANK_FUNCS = frozenset({"rank", "dense_rank", "row_number"})
_BROWSE_WINDOW_AGG_FUNCS = frozenset({"sum", "avg", "min", "max", "count"})
_BROWSE_EXPR_OPS = frozenset({"+", "-", "*", "/"})
_BROWSE_ANNOTATION_SAFE_METHODS = frozenset({"alias", "all", "annotate", "defer", "distinct", "exclude", "filter", "none", "only", "order_by", "prefetch_related", "select_related", "using", "values", "values_list"})
_BROWSE_ANNOTATION_BLOCKED_ATTRS = frozenset({"bulk_create", "bulk_update", "create", "cursor", "delete", "execute", "executemany", "extra", "get_or_create", "raw", "save", "update", "update_or_create"})


def _browse_annotation_specs(model, annotations, attset, pk_attname, namespace=None):
    """Parses per-row annotation specs (raw annotate / aggregate / window / F-expr) into safe {alias, expr, window, log} entries."""
    if not isinstance(annotations, list):
        return []
    relation_names = _browse_agg_relation_names(model)
    specs = []
    used = set()
    for item in annotations:
        if not isinstance(item, dict):
            continue
        built = _browse_build_annotation(model, item, attset, pk_attname, relation_names, namespace)
        if built is None:
            continue
        field = item.get("field")
        label = "expr" if item.get("kind") == "expr" else ("annotate" if item.get("kind") == "annotate" else (item.get("func") or item.get("kind") or "col"))
        arg = field if isinstance(field, str) and field and field != "*" else "col"
        alias = _browse_agg_alias(item.get("alias"), label, arg, used)
        used.add(alias)
        specs.append({"alias": alias, "expr": built["expr"], "log": built["log"], "window": built["window"]})
        if len(specs) >= 12:
            break
    return specs


def _browse_build_annotation(model, item, attset, pk_attname, relation_names, namespace=None):
    """Builds one safe per-row annotation expression (and a readable log string) from a column-builder spec, or None.
    Field/relation/order/partition identifiers are allowlisted against the live model graph (no injection)."""
    from django.db.models import Avg, Count, F, Max, Min, Sum, Window
    from django.db.models.functions import DenseRank, Rank, RowNumber

    aggregates = {"count": Count, "sum": Sum, "avg": Avg, "min": Min, "max": Max}
    kind = item.get("kind")
    if kind == "annotate":
        expr = _browse_eval_annotation_expression(item.get("expression"), namespace)
        if expr is None:
            return None
        return {"expr": expr, "label": "annotate", "log": str(item.get("expression", "")).strip(), "window": False}
    if kind == "subquery":
        return _browse_build_subquery_annotation(model, item, pk_attname)
    if kind == "aggregate":
        func = item.get("func")
        if func not in aggregates:
            return None
        raw = item.get("field")
        if func == "count":
            if raw in (None, "", "*", "pk"):
                arg = pk_attname
            elif raw in attset:
                arg = raw
            elif raw in relation_names or (isinstance(raw, str) and "__" in raw and _browse_resolve_filter_path(model, raw) is not None):
                arg = raw
            else:
                return None
            # Count over a to-many relation/traversal must be distinct (a sibling to-many join would multiply it).
            distinct = bool(item.get("distinct")) or _browse_path_is_to_many(model, arg)
            return {"expr": Count(arg, distinct=distinct), "label": func, "log": f"Count({arg!r}{', distinct=True' if distinct else ''})", "window": False}
        arg = pk_attname if raw == "pk" else raw
        if not isinstance(arg, str):
            return None
        if arg not in attset:
            resolved = _browse_resolve_filter_path(model, arg)
            # Reject a path that is invalid, ends on a relation, or crosses a to-many relation (Sum/Avg fan-out can't be deduped).
            if resolved is None or resolved[2] or resolved[1]:
                return None
        return {"expr": aggregates[func](arg), "label": func, "log": f"{_BROWSE_AGG_LABELS[func]}({arg!r})", "window": False}
    if kind == "window":
        func = item.get("func")
        raw_partition = item.get("partitionBy")
        partition = [name for name in (raw_partition if isinstance(raw_partition, (list, tuple)) else []) if isinstance(name, str) and name in attset]
        order_terms, order_log = _browse_window_order(item.get("orderBy"), attset)
        if func in _BROWSE_WINDOW_RANK_FUNCS:
            if not order_terms:
                return None  # ranking windows require an ORDER BY
            builder, inner_log = {"rank": (Rank, "Rank()"), "dense_rank": (DenseRank, "DenseRank()"), "row_number": (RowNumber, "RowNumber()")}[func]
            inner = builder()
        elif func in _BROWSE_WINDOW_AGG_FUNCS:
            field = item.get("field")
            arg = pk_attname if field in (None, "", "*", "pk") and func == "count" else field
            if not (isinstance(arg, str) and arg in attset):
                return None
            inner = aggregates[func](F(arg))
            inner_log = f"{_BROWSE_AGG_LABELS[func]}(F({arg!r}))"
        else:
            return None
        expr = Window(expression=inner, partition_by=[F(name) for name in partition] or None, order_by=order_terms or None)
        parts = [inner_log]
        if partition:
            parts.append("partition_by=[%s]" % ", ".join("F(%r)" % name for name in partition))
        if order_terms:
            parts.append("order_by=[%s]" % order_log)
        return {"expr": expr, "label": "win_" + func, "log": "Window(%s)" % ", ".join(parts), "window": True}
    if kind == "expr":
        op = item.get("op")
        if op not in _BROWSE_EXPR_OPS:
            return None
        left, left_log, left_field = _browse_expr_operand(item.get("left"), attset)
        right, right_log, right_field = _browse_expr_operand(item.get("right"), attset)
        # Require at least one field reference: a constant-only expression isn't a valid annotation (and `5/0` would crash).
        if left is None or right is None or not (left_field or right_field):
            return None
        try:
            expr = _browse_expr_combine(left, right, op)
        except Exception:
            return None
        return {"expr": expr, "label": "expr", "log": f"{left_log} {op} {right_log}", "window": False}
    return None


def _browse_build_subquery_annotation(model, item, pk_attname):
    """Builds a correlated one-row Subquery for a selected relation, value field, and optional order fields."""
    from django.db.models import OuterRef, Subquery

    relation = _browse_find_subquery_relation(model, item.get("relation"))
    target = relation.related_model if relation is not None else _browse_resolve_model_label(item.get("target"))
    if target is None:
        return None
    value_path = _browse_subquery_value_path(target, item.get("field"))
    if value_path is None:
        return None
    if relation is None:
        return _browse_build_custom_subquery(model, target, item, value_path)
    if getattr(relation, "many_to_many", False):
        query = _browse_m2m_subquery(relation, pk_attname, value_path, item.get("orderBy"))
        if query is None:
            return None
        inner, log = query
    else:
        filter_key, outer_field = _browse_subquery_correlation(model, relation, pk_attname)
        if filter_key is None or outer_field is None:
            return None
        order, order_log = _browse_subquery_order(target, item.get("orderBy"), target._meta.pk.attname)
        inner = target._base_manager.filter(**{filter_key: OuterRef(outer_field)}).order_by(*order).values(value_path)
        log = "Subquery(%s._base_manager.filter(%s=OuterRef(%r)).order_by(%s).values(%r)[:1])" % (target.__name__, filter_key, outer_field, order_log, value_path)
    return {"expr": Subquery(inner[:1]), "label": "subquery", "log": log, "window": False}


def _browse_resolve_model_label(label):
    """Returns a Django model class from an app.Model label, or None when the label is invalid."""
    if not isinstance(label, str) or "." not in label:
        return None
    app, model_name = label.rsplit(".", 1)
    try:
        from django.apps import apps

        return apps.get_model(app, model_name)
    except Exception:
        return None


def _browse_build_custom_subquery(model, target, item, value_path):
    """Builds a correlated Subquery that compares an arbitrary target-model field to a current-row field."""
    from django.db.models import OuterRef, Subquery

    filter_path = _browse_subquery_value_path(target, item.get("filterField"))
    outer_path = _browse_subquery_value_path(model, item.get("outerField"))
    if filter_path is None or outer_path is None:
        return None
    order, order_log = _browse_subquery_order(target, item.get("orderBy"), target._meta.pk.attname)
    inner = target._base_manager.filter(**{filter_path: OuterRef(outer_path)}).order_by(*order).values(value_path)
    log = "Subquery(%s._base_manager.filter(%s=OuterRef(%r)).order_by(%s).values(%r)[:1])" % (target.__name__, filter_path, outer_path, order_log, value_path)
    return {"expr": Subquery(inner[:1]), "label": "subquery", "log": log, "window": False}


def _browse_find_subquery_relation(model, relation):
    """Resolves a relation name/query-name selected by the Subquery UI to a Django relation field."""
    if not isinstance(relation, str) or not relation:
        return None
    for field in model._meta.get_fields():
        if not getattr(field, "is_relation", False) or getattr(field, "related_model", None) is None:
            continue
        names = {getattr(field, "name", None), _browse_relation_name(field), _browse_relation_query_name(field)}
        if relation in names:
            return field
    return None


def _browse_subquery_correlation(model, relation, pk_attname):
    """Returns (inner_filter_field, outer_ref_field) for FK/O2O/reverse-FK one-row subqueries."""
    if getattr(relation, "auto_created", False) and not getattr(relation, "concrete", False):
        forward = getattr(relation, "field", None)
        return (getattr(forward, "attname", None), "pk") if forward is not None else (None, None)
    if getattr(relation, "many_to_one", False) or getattr(relation, "one_to_one", False):
        return relation.related_model._meta.pk.attname, relation.attname
    return None, None


def _browse_subquery_value_path(model, path):
    """Returns a validated scalar field path for a subquery `.values()` or `.order_by()` clause."""
    if not isinstance(path, str) or not path:
        return None
    resolved = _browse_resolve_filter_path(model, path)
    if resolved is None or resolved[2]:
        return None
    return path


def _browse_subquery_order(model, order_by, default_path):
    """Returns validated order_by terms and readable log text for a Subquery inner queryset."""
    terms, logs = [], []
    for item in (order_by if isinstance(order_by, (list, tuple)) else []):
        field = item.get("field") if isinstance(item, dict) else item
        path = _browse_subquery_value_path(model, field)
        if path is None:
            continue
        descending = isinstance(item, dict) and bool(item.get("desc"))
        terms.append(f"-{path}" if descending else path)
        logs.append("%r" % (f"-{path}" if descending else path))
        if len(terms) >= 3:
            break
    if not terms:
        terms.append(default_path)
        logs.append("%r" % default_path)
    return terms, ", ".join(logs)


def _browse_m2m_subquery(relation, pk_attname, value_path, order_by):
    """Builds the through-table queryset used for M2M Subquery annotations, returning (queryset, log)."""
    try:
        relation_field = getattr(relation, "field", relation)
        through = relation_field.remote_field.through
        if getattr(relation, "auto_created", False):
            source_name = relation_field.m2m_reverse_field_name()
            target_name = relation_field.m2m_field_name()
        else:
            source_name = relation_field.m2m_field_name()
            target_name = relation_field.m2m_reverse_field_name()
        related_model = relation.related_model
    except Exception:
        return None
    target_value = _browse_prefixed_subquery_path(target_name, value_path)
    target_default = _browse_prefixed_subquery_path(target_name, related_model._meta.pk.attname)
    order, order_log = _browse_subquery_prefixed_order(related_model, order_by, target_name, target_default)
    from django.db.models import OuterRef

    filter_key = f"{source_name}_id"
    inner = through._base_manager.filter(**{filter_key: OuterRef(pk_attname)}).order_by(*order).values(target_value)
    log = "Subquery(%s._base_manager.filter(%s=OuterRef(%r)).order_by(%s).values(%r)[:1])" % (through.__name__, filter_key, pk_attname, order_log, target_value)
    return inner, log


def _browse_prefixed_subquery_path(prefix, path):
    """Prefixes a target-model field path so it can be selected through an M2M through-table FK."""
    return f"{prefix}__{path}"


def _browse_subquery_prefixed_order(model, order_by, prefix, default_path):
    """Returns through-table order_by terms for target-model field paths."""
    terms, logs = [], []
    for item in (order_by if isinstance(order_by, (list, tuple)) else []):
        field = item.get("field") if isinstance(item, dict) else item
        path = _browse_subquery_value_path(model, field)
        if path is None:
            continue
        prefixed = _browse_prefixed_subquery_path(prefix, path)
        descending = isinstance(item, dict) and bool(item.get("desc"))
        terms.append(f"-{prefixed}" if descending else prefixed)
        logs.append("%r" % (f"-{prefixed}" if descending else prefixed))
        if len(terms) >= 3:
            break
    if not terms:
        terms.append(default_path)
        logs.append("%r" % default_path)
    return terms, ", ".join(logs)


def _browse_eval_annotation_expression(source, namespace):
    """Evaluates a user-supplied annotate expression after AST validation, returning a Django expression or None."""
    if not isinstance(source, str):
        return None
    text = source.strip()
    if not text or len(text) > 800:
        return None
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError:
        return None
    env = _browse_annotation_eval_env(namespace)
    if not _browse_annotation_ast_safe(tree, set(env)):
        return None
    try:
        expr = eval(compile(tree, "<django-shell-annotate>", "eval"), {"__builtins__": {}}, env)
    except Exception:
        return None
    return expr if hasattr(expr, "resolve_expression") else None


def _browse_annotation_eval_env(namespace):
    """Returns the restricted names available to raw annotate expressions."""
    from django.apps import apps
    from django.db import models
    from django.db.models import Avg, Case, Count, Exists, ExpressionWrapper, F, Max, Min, OuterRef, Q, Subquery, Sum, Value, When, Window
    from django.db.models.functions import Cast, Coalesce, Concat, Greatest, Length, Lower, Trim, Upper

    env = {
        "Avg": Avg, "Case": Case, "Cast": Cast, "Coalesce": Coalesce, "Concat": Concat, "Count": Count,
        "Exists": Exists, "ExpressionWrapper": ExpressionWrapper, "F": F, "Greatest": Greatest, "Length": Length,
        "Lower": Lower, "Max": Max, "Min": Min, "OuterRef": OuterRef, "Q": Q, "Subquery": Subquery, "Sum": Sum,
        "Trim": Trim, "Upper": Upper, "Value": Value, "When": When, "Window": Window, "models": models,
    }
    try:
        for model in apps.get_models():
            name = getattr(model, "__name__", "")
            if _browse_agg_safe_alias(name):
                env.setdefault(name, model)
    except Exception:
        pass
    for name, value in (namespace or {}).items():
        if _browse_agg_safe_alias(name) and _browse_annotation_namespace_value(value):
            env.setdefault(name, value)
    return env


def _browse_annotation_namespace_value(value):
    """Returns whether a shell namespace value may be referenced by a raw annotate expression."""
    try:
        return hasattr(value, "_meta") and hasattr(value, "_default_manager")
    except Exception:
        return False


def _browse_annotation_ast_safe(tree, safe_names):
    """Returns whether a parsed raw annotate expression uses only lazy ORM/expression constructs."""
    allowed_nodes = (
        ast.Expression, ast.Call, ast.Name, ast.Load, ast.Attribute, ast.Constant, ast.keyword, ast.Subscript, ast.Slice,
        ast.Tuple, ast.List, ast.Dict, ast.UnaryOp, ast.BinOp, ast.BoolOp, ast.Compare, ast.And, ast.Or, ast.Add, ast.Sub,
        ast.Mult, ast.Div, ast.Mod, ast.Pow, ast.USub, ast.UAdd, ast.Eq, ast.NotEq, ast.Gt, ast.GtE, ast.Lt, ast.LtE,
        ast.In, ast.NotIn, ast.Is, ast.IsNot,
    )
    for node in ast.walk(tree):
        if not isinstance(node, allowed_nodes):
            return False
        if isinstance(node, ast.Name) and node.id not in safe_names:
            return False
        if isinstance(node, ast.Attribute) and not _browse_annotation_attr_safe(node.attr):
            return False
        if isinstance(node, ast.Subscript) and not isinstance(node.slice, ast.Slice):
            return False
        if isinstance(node, ast.Call) and not _browse_annotation_call_safe(node.func):
            return False
    return True


def _browse_annotation_attr_safe(name):
    """Returns whether an attribute name is allowed in a raw annotate expression."""
    return isinstance(name, str) and name and not name.startswith("_") and name not in _BROWSE_ANNOTATION_BLOCKED_ATTRS


def _browse_annotation_call_safe(func):
    """Returns whether a call target is a safe expression constructor or lazy QuerySet method."""
    if isinstance(func, ast.Name):
        return True
    if not isinstance(func, ast.Attribute) or not _browse_annotation_attr_safe(func.attr):
        return False
    if _browse_annotation_attr_root(func) == "models":
        return True
    return func.attr in _BROWSE_ANNOTATION_SAFE_METHODS


def _browse_annotation_attr_root(node):
    """Returns the root name for an attribute chain, or None for other AST forms."""
    current = node
    while isinstance(current, ast.Attribute):
        current = current.value
    return current.id if isinstance(current, ast.Name) else None


def _browse_window_order(order_by, attset):
    """Returns (order_by F-expression list, log text) for a window's ORDER BY, restricted to concrete fields."""
    from django.db.models import F

    terms, logs = [], []
    for item in (order_by if isinstance(order_by, (list, tuple)) else []):
        name = item.get("field") if isinstance(item, dict) else item
        if not isinstance(name, str) or name not in attset:
            continue
        descending = isinstance(item, dict) and bool(item.get("desc"))
        terms.append(F(name).desc() if descending else F(name).asc())
        logs.append("F(%r).desc()" % name if descending else "F(%r)" % name)
    return terms, ", ".join(logs)


def _browse_expr_operand(raw, attset):
    """Returns (operand, log, is_field) for one F-expression side: a concrete-field reference or a numeric literal; (None, '', False) if invalid."""
    from django.db.models import F

    if isinstance(raw, bool):
        return None, "", False
    if isinstance(raw, (int, float)):
        return raw, repr(raw), False
    if isinstance(raw, str):
        if raw in attset:
            return F(raw), "F(%r)" % raw, True
        text = raw.strip()
        try:
            number = int(text) if text.lstrip("-").isdigit() else float(text)
        except (ValueError, TypeError):
            return None, "", False
        return number, repr(number), False
    return None, "", False


def _browse_expr_combine(left, right, op):
    """Combines two F-expression/numeric operands with an arithmetic operator into a Django expression."""
    if op == "+":
        return left + right
    if op == "-":
        return left - right
    if op == "*":
        return left * right
    return left / right


def _browse_annotation_columns(specs):
    """Returns read-only grid column descriptors for per-row annotation columns (window vs plain annotation)."""
    return [{"annotation": True, "attname": spec["alias"], "editable": False, "name": spec["alias"], "null": True, "pk": False, "type": "window" if spec["window"] else "annotation"} for spec in specs]


def _browse_split_having(filters, all_aliases, having_aliases):
    """Splits filters into (base WHERE filters, post-annotate HAVING filters). A filter on any annotation alias leaves the
    base set; only filters on a HAVING-eligible alias (non-window) become HAVING filters — window-alias filters are dropped."""
    base, having = [], []
    for term in filters or []:
        field = term.get("field") if isinstance(term, dict) else None
        if field in all_aliases:
            if field in having_aliases:
                having.append(term)
        else:
            base.append(term)
    return base, having


def _browse_having_q(filters, having_aliases):
    """Builds a Q for filters on annotation aliases, applied after .annotate() (HAVING / WHERE-on-expression). The alias is
    an allowlisted identifier, the lookup is allowlisted, and the value is coerced/ORM-parameterized — injection-proof."""
    from django.db.models import Q

    query = Q()
    for term in filters or []:
        if not isinstance(term, dict):
            continue
        field = term.get("field")
        lookup = term.get("lookup") or "exact"
        if field not in having_aliases or lookup not in _BROWSE_LOOKUPS or not (isinstance(field, str) and field.isidentifier()):
            continue
        value = _browse_coerce_filter_value(lookup, term.get("value"), numeric=True)
        clause = Q(**{f"{field}__{lookup}": value})
        query &= ~clause if term.get("negate") else clause
    return query


def _browse_orm_aggregate(model, filters, attnames, group_by, specs, having_filters=None):
    """Builds a readable Django ORM expression mirroring the executed aggregate query (for the command log)."""
    includes, excludes, annotations, distinct = _browse_orm_clauses(model, filters, attnames)
    lines = [f"{model.__name__}._base_manager"]
    if annotations:
        lines.append(f"    .annotate({', '.join(annotations)})")
    if includes:
        lines.append(f"    .filter({', '.join(includes)})")
    if excludes:
        lines.append(f"    .exclude({', '.join(excludes)})")
    if distinct:
        lines.append("    .distinct()")
    db_specs = [spec for spec in specs if spec["kind"] == "db"]
    if group_by:
        lines.append(f"    .values({_orm_args(group_by)})")
        if db_specs:
            lines.append(f"    .annotate({', '.join(_browse_agg_expr_text(spec) for spec in db_specs)})")
        for term in having_filters or []:
            if isinstance(term, dict) and isinstance(term.get("field"), str):
                having_lookup = term.get("lookup") or "exact"
                having_key = term["field"] if having_lookup == "exact" else f"{term['field']}__{having_lookup}"
                lines.append(f"    .{'exclude' if term.get('negate') else 'filter'}({having_key}={_browse_coerce_filter_value(having_lookup, term.get('value'), numeric=True)!r})  # HAVING")
        lines.append(f"    .order_by({_orm_args(group_by)})")
    else:
        if db_specs:
            lines.append(f"    .aggregate({', '.join(_browse_agg_expr_text(spec) for spec in db_specs)})")
        for spec in specs:
            if spec["kind"] == "exists":
                lines.append(f"    # {spec['alias']}: .exists()")
    for spec in specs:
        if spec["kind"] == "py":
            lines.append(f"    # {spec['alias']}: Python @property {spec['arg']!r} ({spec['func']})")
    return "\n".join(lines)


def _browse_agg_expr_text(spec):
    """Returns the readable `alias=Func('field')` text for one aggregate spec."""
    label = _BROWSE_AGG_LABELS.get(spec["func"], spec["func"])
    distinct = ", distinct=True" if spec.get("distinct") else ""
    return f"{spec['alias']}={label}({spec['arg']!r}{distinct})"


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


def _browse_orm_rows(model, order, filters, attnames, pk_attname, keyset_capable, cursor, base_offset, limit, annotations=None, having_filters=None):
    """Builds a readable Django ORM expression mirroring the executed rows query (including per-row annotation columns and any HAVING lookup on them)."""
    includes, excludes, declared, distinct = _browse_orm_clauses(model, filters, set(attnames))
    annotations = annotations or []
    column_annotations = [f"{spec['alias']}={spec['log']}" for spec in annotations]
    lines = [f"{model.__name__}._base_manager"]
    # Match execution order: declared-@property annotations (so the WHERE can use them) → base WHERE → column annotations → HAVING → order_by.
    if declared:
        lines.append(f"    .annotate({', '.join(declared)})")
    if includes:
        lines.append(f"    .filter({', '.join(includes)})")
    if excludes:
        lines.append(f"    .exclude({', '.join(excludes)})")
    if column_annotations:
        lines.append(f"    .annotate({', '.join(column_annotations)})")
    for term in having_filters or []:
        if isinstance(term, dict) and isinstance(term.get("field"), str):
            having_lookup = term.get("lookup") or "exact"
            having_key = term["field"] if having_lookup == "exact" else f"{term['field']}__{having_lookup}"
            lines.append(f"    .{'exclude' if term.get('negate') else 'filter'}({having_key}={_browse_coerce_filter_value(having_lookup, term.get('value'), numeric=True)!r})")
    # order_by AFTER .annotate() so a sort on an annotation alias is valid in the printed (runnable) ORM.
    lines.append(f"    .order_by({_orm_args(order)})")
    if distinct:
        lines.append("    .distinct()")
    if keyset_capable and cursor is not None:
        lines.append(f"    .filter({pk_attname}__gt={cursor!r})")
    lines.append(f"    .values({_orm_args(attnames + [spec['alias'] for spec in annotations])})")
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
    with _browse_parallel_context():
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
        concrete = {column["attname"] for column in columns}
        # Surface per-row annotation values Django stored on the instance (e.g. an annotate() over a @property-filtered
        # stream) — they live in __dict__ as non-underscore keys outside the concrete columns.
        ann_names = [name for name in vars(items[0]) if isinstance(name, str) and not name.startswith("_") and name not in concrete]
        rows = [_browse_serialize_row(dict({column["attname"]: getattr(item, column["attname"], None) for column in columns}, **{name: getattr(item, name, None) for name in ann_names})) for item in items]
        ann_cols = [{"annotation": True, "attname": name, "editable": False, "name": name, "null": True, "pk": False, "type": "annotation"} for name in ann_names]
        return {"app": model._meta.app_label, "columns": columns + ann_cols + _browse_computed_columns(model), "editable": True, "hasMore": has_more, "model": model._meta.object_name, "pk": model._meta.pk.attname, "relations": _browse_relations(model), "rows": rows}
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
    # `length`/`length__<cmp>` and `trim` are char/text transforms (Length/Trim, registered at startup).
    is_text_transform = lookup == "trim" or lookup == "length" or lookup.startswith("length__")
    if field == "pk":
        # Must precede the @property branch: Django defines `pk` as a property on the base Model, so
        # _pty_is_computed_field(model, "pk") is True and would otherwise misroute pk to a Python full-table scan.
        if is_text_transform:
            return None
        key = "pk"
        value = _browse_coerce_filter_value(lookup, term.get("value"), model._meta.pk)
    elif field in attnames:
        if is_text_transform and type(fields[field]).__name__ not in _BROWSE_TEXT_TYPES:
            return None  # Length()/Trim() are only valid on char/text columns; drop the term rather than raise FieldError.
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
            if is_text_transform and type(leaf).__name__ not in _BROWSE_TEXT_TYPES:
                return None  # Length()/Trim() only on a char/text leaf (e.g. author__name), never a numeric/relation leaf.
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


def _browse_coerce_filter_value(lookup, value, field=None, numeric=False):
    """Coerces one filter value for lookups and field types that need a specific Python shape. `numeric` (used for
    aggregate/annotation HAVING values) coerces a digit string to int/float BEFORE the boolean-string check, so a count
    comparison like `>= 1` stays the int 1 rather than the bool True."""
    if lookup == "isnull":
        if isinstance(value, str):
            return value.strip().lower() not in ("", "false", "0", "no")
        return bool(value)
    if isinstance(lookup, str) and (lookup.startswith("length") or lookup in ("week_day", "quarter", "hour", "minute", "second")):
        numeric = True  # length and date/time extracts compare against an int, regardless of the underlying field type.
    if lookup in ("in", "range"):
        if isinstance(value, str):
            parts = [_browse_coerce_filter_value("exact", part.strip(), field, numeric) for part in value.split(",") if part.strip() != ""]
        elif isinstance(value, (list, tuple)):
            parts = list(value)
        else:
            parts = [value]
        return parts[:2] if lookup == "range" else parts
    if numeric and isinstance(value, str) and value.strip().replace(".", "", 1).lstrip("-").isdigit():
        return float(value.strip()) if "." in value.strip() else int(value.strip())
    if isinstance(value, str) and field is not None and field.get_internal_type() == "BooleanField":
        return value.strip().lower() in ("true", "1", "t", "yes", "on")
    if isinstance(value, str) and field is None and value.strip().lower() in ("true", "false", "1", "0", "t", "yes", "no", "on", "off"):
        return value.strip().lower() in ("true", "1", "t", "yes", "on")
    if isinstance(value, str) and field is None and value.strip().replace(".", "", 1).lstrip("-").isdigit():
        return float(value.strip()) if "." in value.strip() else int(value.strip())
    return value

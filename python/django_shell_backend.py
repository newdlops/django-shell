# In-process JSON backend for executing code inside an interactive Django shell namespace.

import ast
import codeop
import contextlib
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
            return {
                "basePrefix": sys.base_prefix,
                "cwd": os.getcwd(),
                "django": _django_environment(),
                "executable": sys.executable,
                "ok": True,
                "path": list(sys.path),
                "prefix": sys.prefix,
                "settingsModule": os.environ.get("DJANGO_SETTINGS_MODULE"),
                "version": sys.version,
                "virtualEnv": os.environ.get("VIRTUAL_ENV"),
            }
        except Exception:
            return {"ok": False, "error": traceback.format_exc()}


def _django_environment():
    """Returns Django-specific runtime metadata without calling django.setup()."""
    info = {
        "appsReady": False,
        "available": False,
        "configured": False,
        "installedApps": [],
        "settingsModule": os.environ.get("DJANGO_SETTINGS_MODULE"),
    }
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
    mapping = _safe_vars(value)
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
    return [
        _value_summary(f"[{index}]", child, path + [{"op": "index", "index": index}])
        for index, child in enumerate(list(value)[:200])
    ]


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
    summary = {
        "hasChildren": _has_children(value),
        "importLine": _import_line(name, value),
        "kind": _variable_kind(value),
        "name": name,
        "path": path,
        "preview": _preview_value(value),
        "type": _type_name(value),
        "typeImportLine": _type_import_line(name, value),
    }
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
        mapping = _safe_vars(value)
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
    mapping = _safe_vars(value)
    return bool(mapping and any(not (name.startswith("__") and name.endswith("__")) for name in mapping))


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
        modules.append({
            "file": str(getattr(module, "__file__", "") or ""),
            "name": name,
            "package": str(getattr(module, "__package__", "") or ""),
        })
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
            return {
                "ok": False,
                "stdout": stdout.getvalue(),
                "stderr": stderr.getvalue(),
                "traceback": traceback.format_exc(),
            }


def _split_last_expression(tree):
    """Returns executable statements and an optional final expression node."""
    if not tree.body or not isinstance(tree.body[-1], ast.Expr):
        return tree.body, None
    return tree.body[:-1], tree.body[-1]


def _print_marker(prefix, payload):
    """Prints a single backend marker line that the extension can parse from PTY output."""
    print(prefix + json.dumps(payload), flush=True)

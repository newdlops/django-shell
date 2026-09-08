# Indexes existing Python definitions into dependency-checked, independently loadable runtime capabilities.
import ast
import hashlib
import json
from pathlib import Path


def build_index(root):
    """Assigns original source ranges to capabilities without rewriting Python behavior or duplicating definitions."""
    manifest = json.loads((root / "django_shell_backend.parts.json").read_text())
    source = "\n\n".join((root / part).read_bytes().decode("utf-8") for part in manifest)
    nodes = ast.parse(source).body
    functions = {node.name: node for node in nodes if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
    deferred = {"_run_request", "_pty_tabulate_result", "_browse_children_of", "_pty_runtime_inspection"}
    optional = {"_install_queryset_progress"}
    groups = {
        "base": ["start", "_pty_serve", "_load_feature", "_load_capability_from_stdin", "_check_complete", "_truncate", "_interrupt_execution", "_debug_update_breakpoints"],
        "grid": ["_pty_tabulate_result"],
        "schema": ["_browse_schema", "_browse_filter_fields"],
        "inspection": ["_inspect_runtime", "_inspect_prelude", "_inspect_children", "_inspect_environment", "_browse_children_of", "_pty_runtime_inspection"],
        "query": ["_browse_query", "_interrupt_query_execution", "_query_forget_result"],
        "models": ["_browse_rows", "_browse_count", "_browse_computed", "_browse_lookup", "_browse_related", "_browse_aggregate"],
        "commit": ["_browse_commit"],
        "execution": ["_execute_code", "_restore_debugger_tracing", "_install_queryset_progress"],
        "extras": list(functions),
    }
    owners, expanded, requirements = {}, set(), {}

    def visit(name, group, dependencies):
        """Follows Python name references while keeping dispatch and optional hooks as explicit lazy boundaries."""
        if name not in functions or name in optional:
            return
        owner = owners.setdefault(name, group)
        if owner != group:
            dependencies.add(owner)
        if name in expanded or name in deferred:
            return
        expanded.add(name)
        for child in ast.walk(functions[name]):
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load):
                visit(child.id, group, dependencies)

    for group, roots in groups.items():
        dependencies = set() if group == "base" else {"base"}
        if group != "base":
            deferred.difference_update(roots)
            optional.difference_update(roots)
        for name in roots:
            if name not in functions:
                raise ValueError("Missing capability entry point: " + name)
            visit(name, group, dependencies)
        if group == "base":
            for node in nodes:
                if not isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                    for child in ast.walk(node):
                        if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load):
                            visit(child.id, group, dependencies)
        requirements[group] = sorted(dependencies)
    units = []
    for node in nodes:
        start = min([node.lineno] + [item.lineno for item in getattr(node, "decorator_list", [])]) - 1
        units.append({"start": start, "end": node.end_lineno, "feature": owners.get(getattr(node, "name", None), "base")})
    return {"version": 1, "sourceDigest": hashlib.sha256(source.encode()).hexdigest(), "requires": requirements, "units": units}


def main():
    """Writes a deterministic index consumed by the extension without requiring Python on the VS Code host."""
    root = Path(__file__).resolve().parent.parent / "python"
    target = root / "django_shell_backend.runtime.json"
    data = json.dumps(build_index(root), separators=(",", ":")) + "\n"
    if not target.exists() or target.read_text() != data:
        target.write_text(data)


if __name__ == "__main__":
    main()

# Composes ordered Django-shell backend fragments into one shared module-global runtime.
import json as _djs_parts_json
from pathlib import Path as _djs_parts_path

_djs_parts_root = _djs_parts_path(__file__).resolve().parent
_djs_parts_manifest_path = _djs_parts_root / "django_shell_backend.parts.json"
try:
    _djs_parts_manifest = _djs_parts_json.loads(_djs_parts_manifest_path.read_text(encoding="utf-8"))
    if not isinstance(_djs_parts_manifest, list) or not _djs_parts_manifest or not all(isinstance(_djs_parts_item, str) for _djs_parts_item in _djs_parts_manifest):
        raise RuntimeError("django-shell backend manifest must be a non-empty string list")
    _djs_parts_sources = []
    for _djs_parts_item in _djs_parts_manifest:
        _djs_parts_pathname = (_djs_parts_root / _djs_parts_item).resolve()
        if _djs_parts_root not in _djs_parts_pathname.parents:
            raise RuntimeError("django-shell backend fragment path escapes its runtime directory")
        _djs_parts_sources.append(_djs_parts_pathname.read_text(encoding="utf-8"))
    _djs_parts_source = "\n\n".join(_djs_parts_sources)
    exec(compile(_djs_parts_source, "<django-shell-backend>", "exec"), globals())
finally:
    for _djs_parts_temp_name in (
        "_djs_parts_json",
        "_djs_parts_path",
        "_djs_parts_root",
        "_djs_parts_manifest_path",
        "_djs_parts_manifest",
        "_djs_parts_item",
        "_djs_parts_pathname",
        "_djs_parts_sources",
        "_djs_parts_source",
    ):
        globals().pop(_djs_parts_temp_name, None)
    del _djs_parts_temp_name

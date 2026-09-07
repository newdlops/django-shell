// Generates validated, routed, atomic Django ORM edits without backend RPC calls in shell history.

import type { BackendModelColumn, ModelCommitChange } from "./modelBackend";

/** Builds readable Django save code that validates every row before writing to the selected database. */
export function buildValidatedCommitOrm(model: string, changes: ModelCommitChange[], columns: BackendModelColumn[], valueLiteral: (column: BackendModelColumn | undefined, value: unknown) => string, pkLiteral: (value: unknown) => string, database?: string): string {
  const byAttname = new Map(columns.map((column) => [column.attname, column]));
  const lines = [
    "from django.db import router as _router, transaction as _transaction",
    `_model = ${model}`,
    `_db = ${database ? JSON.stringify(database) : "_router.db_for_write(_model)"}`,
    "_editable = {f.attname: f for f in _model._meta.concrete_fields if f.editable and not f.primary_key and not getattr(f, 'auto_now', False) and not getattr(f, 'auto_now_add', False)}",
    "_prepared = []",
    "with _transaction.atomic(using=_db):"
  ];
  for (const [index, change] of changes.entries()) {
    if (!change || !change.fields) { continue; }
    const variable = `_o${index}`;
    lines.push(`    ${variable} = ${model}._base_manager.using(_db).select_for_update().get(pk=${pkLiteral(change.pk)})`, "    _applied = []");
    for (const [attname, value] of Object.entries(change.fields)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(attname)) { continue; }
      const field = JSON.stringify(attname);
      lines.push(`    if ${field} in _editable:`, `        ${variable}.${attname} = ${valueLiteral(byAttname.get(attname), value)}`,
        `        if ${variable}.${attname} == '' and (_editable[${field}].null or _editable[${field}].is_relation):`, `            ${variable}.${attname} = None`,
        `        _applied.append(_editable[${field}].name)`);
    }
    lines.push("    if _applied:", `        if ${database ? "False" : `_router.db_for_write(_model, instance=${variable}) != _db`}:`, "            raise ValueError('One commit cannot span multiple databases.')",
      `        ${variable}.full_clean(exclude=[f.name for f in _model._meta.fields if f.name not in _applied])`, `        _prepared.append((${variable}, _applied))`);
  }
  lines.push("    for _instance, _fields in _prepared:", "        _instance.save(using=_db, update_fields=_fields)", "len(_prepared)");
  return lines.join("\n");
}

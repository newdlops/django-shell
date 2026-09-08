// Generates pure Django searches that distinguish display primary keys from stored foreign-key values.

/** Builds a bounded candidate search on the same explicit database as the edited source rows. */
export function buildLookupModelOrm(model: string, q: string, exclude: string[], limit: number, database?: string, valueField?: string): string {
  const cap = Math.min(Number.isInteger(limit) && limit > 0 ? limit : 20, 50) + 1;
  return [
    "from django.db.models import Q",
    `_lookup_model = ${model}`,
    `_search = ${JSON.stringify(q.trim())}`,
    `_exclude = ${JSON.stringify(exclude.filter(Boolean).map((item) => item.toLowerCase()))}`,
    `_key_field = ${valueField ? `_lookup_model._meta.get_field(${JSON.stringify(valueField)})` : "_lookup_model._meta.pk"}`,
    "if not _key_field.concrete or not _key_field.unique:",
    "    raise ValueError('Foreign-key lookup requires a unique target field.')",
    "_pk, _value = _lookup_model._meta.pk.attname, _key_field.attname",
    "_fields = [f.attname for f in _lookup_model._meta.concrete_fields if not f.is_relation and f.get_internal_type() in ('CharField', 'TextField', 'SlugField', 'EmailField', 'URLField', 'FilePathField') and not any(part in f.attname.lower() for part in _exclude)]",
    "_where = Q()",
    "if _search:",
    "    _where = Q(pk__in=[])",
    "    for _name in _fields:",
    "        _where |= Q(**{_name + '__icontains': _search})",
    "    if _key_field.get_internal_type().endswith(('AutoField', 'IntegerField')):",
    "        if (_search[1:] if _search.startswith('-') else _search).isdigit(): _where |= Q(**{_value: int(_search)})",
    "    else:",
    "        _where |= Q(**{_value + '__icontains': _search})",
    `_candidates = _lookup_model._base_manager.using(${database ? JSON.stringify(database) : "None"}).exclude(**{_value + '__isnull': True}).filter(_where).order_by(_pk).values(*dict.fromkeys([_pk, _value, *_fields[:2]]))[:${cap}]`,
    "[dict(pk=row[_pk], label='#' + str(row[_pk]) + ''.join(' · ' + str(row[name])[:80] for name in _fields[:2] if row[name] not in (None, '')), **({'value': row[_value]} if _value != _pk else {})) for row in _candidates]"
  ].join("\n");
}

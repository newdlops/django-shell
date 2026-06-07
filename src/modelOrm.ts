// Reconstructs Django ORM one-liners for "ORM mode", where model-browser operations run as the
// user's own literal shell cells (so a live pre_run_cell audit logs ORM, not RPC plumbing).
// Identifiers are restricted to a safe pattern and values are emitted as JSON/Python literals so
// reconstructed expressions cannot inject code.

import type { BackendModelColumn, BackendModelFilter, BackendModelOrder, ModelCommitChange } from "./modelBackend";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOOKUPS = new Set(["exact", "iexact", "contains", "icontains", "gt", "gte", "lt", "lte", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "range", "date", "year", "month", "day"]);
const TRUTHY = /^(true|1|t|yes|on)$/i;
const NUMERIC_FIELD = /Integer|Float|Decimal|AutoField/;

/** Returns the value if it is a safe Python identifier (model name / field attname), else a fallback. */
function safeName(value: string | undefined, fallback = "pk"): string {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : fallback;
}

/** Returns the bare model class name used in visible ORM cells; startup auto-import/shell_plus must bind it so the audit stays real ORM, not app-registry plumbing. */
function modelRef(app: string | undefined, model: string | undefined): string {
  return safeName(model, "Model");
}

/** Encodes a string as a Python string literal (double-quoted; JSON escaping is valid Python). */
function pyStr(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

/** Returns the set of DB-orderable/filterable column attnames — CONCRETE fields only. @property (computed) columns are NOT DB fields, so using them in `.order_by()`/`.filter()` raises Django's `FieldError: Cannot resolve keyword ... into field`. */
function concreteAttnames(columns: BackendModelColumn[] | undefined): Set<string> {
  return new Set((columns ?? []).filter((column) => !column.computed).map((column) => column.attname));
}

/** Returns a comma-separated `order_by()` argument list from grid sort terms, restricted to concrete columns (defaults to the pk). */
function orderArgs(order: BackendModelOrder[] | undefined, attnames: Set<string>): string {
  const terms = (order ?? []).filter((term) => term && attnames.has(String(term.field))).map((term) => `'${term.desc ? "-" : ""}${term.field}'`);
  return terms.length ? terms.join(", ") : "'pk'";
}

/** Returns a Python literal for one filter value, matching the backend's lookup-aware coercion. */
function filterValue(lookup: string, value: unknown): string {
  const text = String(value ?? "");
  if (lookup === "isnull") {
    return TRUTHY.test(text.trim()) ? "True" : "False";
  }
  if (lookup === "in" || lookup === "range") {
    return `[${text.split(",").map((part) => pyStr(part.trim())).join(", ")}]`;
  }
  return pyStr(text);
}

/** Returns `.filter(...)`/`.exclude(...)` chain text from allowlisted filter terms (injection-proof). */
function filterChain(filters: BackendModelFilter[] | undefined, attnames: Set<string>): string {
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const term of filters ?? []) {
    if (!term || !attnames.has(String(term.field)) || !LOOKUPS.has(String(term.lookup))) {
      continue;
    }
    const clause = `**{${pyStr(`${term.field}__${term.lookup}`)}: ${filterValue(term.lookup, term.value)}}`;
    (term.negate ? excludes : includes).push(clause);
  }
  return includes.map((clause) => `.filter(${clause})`).join("") + excludes.map((clause) => `.exclude(${clause})`).join("");
}

/** Parameters for a reconstructed rows query (one bounded page of model instances). */
export interface OrmRowsParams {
  app?: string;
  columns?: BackendModelColumn[];
  filters?: BackendModelFilter[];
  limit: number;
  model: string;
  offset?: number;
  order?: BackendModelOrder[];
}

/** Builds `Model._base_manager.filter(...).order_by(...)[offset:offset+limit+1]` (extra row = "has more"). @property columns are NOT computed here (concrete only) — they load lazily per-column via buildComputedOrm, so a property joining many models never delays the base page. */
export function buildRowsOrm(params: OrmRowsParams): string {
  const offset = Number.isInteger(params.offset) && (params.offset as number) > 0 ? (params.offset as number) : 0;
  const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 50;
  const attnames = concreteAttnames(params.columns);
  const chain = filterChain(params.filters, attnames);
  return `${modelRef(params.app, params.model)}._base_manager${chain}.order_by(${orderArgs(params.order, attnames)})[${offset}:${offset + limit + 1}]`;
}

/** Builds a lazy single-@property fetch as a readable ORM result, returning rows/dicts directly so raw audit has no JSON-print or backend-helper layer. */
export function buildComputedOrm(app: string | undefined, model: string, field: string, filters: BackendModelFilter[] | undefined, order: BackendModelOrder[] | undefined, limit: number, columns: BackendModelColumn[] | undefined): string {
  const attnames = concreteAttnames(columns);
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 50;
  const ref = modelRef(app, model);
  const chain = filterChain(filters, attnames);
  const tail = `${chain}.order_by(${orderArgs(order, attnames)})[0:${cap}]`;
  if ((columns ?? []).some((column) => column.attname === field && column.annotated)) {
    // The model declares a DB annotation for this field → ONE annotated query (no per-row @property N+1). The audit shows real
    // ORM (annotate + values_list); a `lambda __m:` binds the model name once, keeping the typed cell compact. Resolves
    // `djshell_annotations` as a dict OR classmethod.
    const expression = `(__m.djshell_annotations() if callable(__m.djshell_annotations) else __m.djshell_annotations)[${pyStr(field)}]`;
    return `(lambda __m: __m._base_manager.annotate(__djs=${expression})${chain}.order_by(${orderArgs(order, attnames)}).values("pk", "__djs")[0:${cap}])(${ref})`;
  }
  const access = IDENTIFIER.test(field) ? `__o.${field}` : `getattr(__o, ${pyStr(field)}, None)`;
  return `[{${pyStr("pk")}: __o.pk, ${pyStr("value")}: ${access}} for __o in ${ref}._base_manager${tail}]`;
}

/** Builds the row-count ORM `Model._base_manager.filter(...).count()` for the current filter set. */
export function buildCountOrm(app: string | undefined, model: string, filters: BackendModelFilter[] | undefined, columns: BackendModelColumn[] | undefined): string {
  return `${modelRef(app, model)}._base_manager${filterChain(filters, concreteAttnames(columns))}.count()`;
}

/** Builds the pure Python model-catalog probe; the capture hook attaches the actual model list to the marker. */
export function buildModelsOrm(): string {
  return "len(apps.get_models())";
}

/** Builds the pure Python runtime-inspection probe; the capture hook attaches the actual namespace metadata. */
export function buildInspectOrm(): string {
  return "len(globals())";
}

/** Builds a foreign-key picker search as a real ORM cell, returning `.values(...)` rows directly so raw audit has no JSON-print layer. */
export function buildLookupOrm(app: string | undefined, model: string, q: string, exclude: string[], limit: number): string {
  const excluded = `[${(exclude ?? []).filter((field) => IDENTIFIER.test(field)).map((field) => pyStr(field)).join(", ")}]`;
  const cap = (Number.isInteger(limit) && limit > 0 ? limit : 20) + 1;
  return [
    "from django.db.models import Q",
    `_search = ${pyStr(q)}`,
    `_fields = [f.name for f in ${modelRef(app, model)}._meta.concrete_fields if f.get_internal_type() in ("CharField", "TextField", "SlugField", "EmailField") and f.name not in ${excluded}]`,
    "_where = Q(pk=_search) if _search.isdigit() else Q()",
    "for _name in _fields:",
    "    _where |= Q(**{_name + '__icontains': _search})",
    `${modelRef(app, model)}._base_manager.filter(_where).values("pk", *_fields)[:${cap}]`
  ].join("\n");
}

/** Builds a related-rows ORM that works for any relation: getattr the accessor (None if missing/orphaned, never raising), then .all() a bounded page only when it is a manager/queryset, else use the single object as-is. */
export function buildRelatedOrm(app: string | undefined, model: string, pk: unknown, relation: string, limit: number): string {
  const cap = (Number.isInteger(limit) && limit > 0 ? limit : 50) + 1;
  return [
    `_rel = getattr(${modelRef(app, model)}._base_manager.get(pk=${pyScalar(pk)}), ${pyStr(safeName(relation, "pk"))}, None)`,
    `_rel.all()[0:${cap}] if hasattr(_rel, "all") else _rel`
  ].join("\n");
}

/** Returns a Python literal for a primary-key scalar (int passthrough, everything else quoted). */
function pyScalar(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : pyStr(value);
}

/** Returns a Python literal for an edited cell value, typed by its column (bool/number/FK id/text/null). */
function editValue(column: BackendModelColumn | undefined, value: unknown): string {
  const text = String(value ?? "");
  if (text === "" && column && column.null) {
    return "None";
  }
  if (column && column.type === "BooleanField") {
    return TRUTHY.test(text.trim()) ? "True" : "False";
  }
  if (column && (column.relation || NUMERIC_FIELD.test(column.type)) && /^-?\d+(\.\d+)?$/.test(text.trim())) {
    return text.trim();
  }
  return pyStr(text);
}

/** Builds an atomic save ORM for staged edits: per row, get → set fields → save (audit shows real ORM). */
export function buildCommitOrm(app: string | undefined, model: string, changes: ModelCommitChange[], columns: BackendModelColumn[] | undefined): string {
  const byAttname = new Map((columns ?? []).map((column) => [column.attname, column]));
  const name = modelRef(app, model);
  const lines = ["import django.db.transaction as _t", `with _t.atomic():`];
  changes.forEach((change, index) => {
    if (!change || !change.fields) {
      return;
    }
    const variable = `_o${index}`;
    lines.push(`    ${variable} = ${name}._base_manager.get(pk=${pyScalar(change.pk)})`);
    for (const [attname, value] of Object.entries(change.fields)) {
      if (IDENTIFIER.test(attname)) {
        lines.push(`    ${variable}.${attname} = ${editValue(byAttname.get(attname), value)}`);
      }
    }
    lines.push(`    ${variable}.save()`);
  });
  return lines.join("\n");
}

export const __test = { buildCommitOrm, buildCountOrm, buildInspectOrm, buildLookupOrm, buildModelsOrm, buildRelatedOrm, editValue, filterChain, orderArgs, safeName };

// Reconstructs Django ORM one-liners for "ORM mode", where model-browser operations run as the
// user's own literal shell cells (so a live pre_run_cell audit logs ORM, not RPC plumbing).
// Identifiers are restricted to a safe pattern and values are emitted as JSON/Python literals so
// reconstructed expressions cannot inject code.

import type { BackendModelColumn, BackendModelFilter, BackendModelOrder, ModelCommitChange } from "./modelBackend";
import type { BackendRuntimePathSegment } from "./backendClient";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOOKUPS = new Set(["exact", "iexact", "contains", "icontains", "gt", "gte", "lt", "lte", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "range", "date", "year", "month", "day"]);
const TRUTHY = /^(true|1|t|yes|on)$/i;
const NUMERIC_FIELD = /Integer|Float|Decimal|AutoField/;

/** Returns the value if it is a safe Python identifier (model name / field attname), else a fallback. */
function safeName(value: string | undefined, fallback = "pk"): string {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : fallback;
}

/** Resolves a model via the app registry so a reconstructed cell works for ANY catalogued model — not just bare names. The catalog lists every app's models (`apps.get_models()`), but the shell only defines names that were `from x import *`-ed, so a bare `Model` is often undefined → NameError. Self-contained `__import__` (no reliance on `apps`/`django` being imported); the string args are escaped (injection-proof). */
function modelRef(app: string | undefined, model: string | undefined): string {
  return `__import__("django.apps", fromlist=["apps"]).apps.get_model(${pyStr(app)}, ${pyStr(model)})`;
}

/** Encodes a string as a Python string literal (double-quoted; JSON escaping is valid Python). */
function pyStr(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

/** Returns a comma-separated `order_by()` argument list from grid sort terms (defaults to the pk). */
function orderArgs(order: BackendModelOrder[] | undefined): string {
  const terms = (order ?? []).filter((term) => term && IDENTIFIER.test(String(term.field))).map((term) => `'${term.desc ? "-" : ""}${term.field}'`);
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

/** Builds `Model._base_manager.filter(...).order_by(...)[offset:offset+limit+1]` (extra row = "has more"). */
export function buildRowsOrm(params: OrmRowsParams): string {
  const offset = Number.isInteger(params.offset) && (params.offset as number) > 0 ? (params.offset as number) : 0;
  const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 50;
  const attnames = new Set((params.columns ?? []).map((column) => column.attname));
  const chain = filterChain(params.filters, attnames);
  return `${modelRef(params.app, params.model)}._base_manager${chain}.order_by(${orderArgs(params.order)})[${offset}:${offset + limit + 1}]`;
}

/** Builds the row-count ORM `Model._base_manager.filter(...).count()` for the current filter set. */
export function buildCountOrm(app: string | undefined, model: string, filters: BackendModelFilter[] | undefined, columns: BackendModelColumn[] | undefined): string {
  const attnames = new Set((columns ?? []).map((column) => column.attname));
  return `${modelRef(app, model)}._base_manager${filterChain(filters, attnames)}.count()`;
}

/** Builds a readable introspection cell that prints the installed-model catalog as JSON (ORM mode has no schema RPC). */
export function buildModelsOrm(): string {
  return "import json, django.apps; print(json.dumps([[m._meta.app_label, m._meta.object_name, str(m._meta.verbose_name), m._meta.db_table] for m in django.apps.apps.get_models()]))";
}

// Cap on variables serialized in one inspect ORM cell. Without it, a shell_plus / auto-imported namespace (1000s of
// names) yields a multi-MB ORM-cell response that overruns the PTY marker buffer (1.25 MB) so the marker never parses
// and the inspector hangs — and, because ORM reads share one serialized PTY queue, the model-data table queued behind it
// hangs too. User variables are always emitted in full (listed first); only the pre-existing ("initial") names are capped.
const INSPECT_VARIABLE_CAP = 500;

/** Builds a non-evaluating namespace-introspection cell printing runtime variables (with real hasChildren) as JSON. */
export function buildInspectOrm(): string {
  // Delegate to a backend helper so the TYPED cell stays tiny — the previous inlined form was ~1.5 KB, which overran the
  // tty input limit over the PTY and hung the shell at a continuation prompt. The helper caps + serializes server-side.
  return `print(_djs_backend_module._pty_orm_inspect(${INSPECT_VARIABLE_CAP}))`;
}

/** Builds a cell resolving one inspector path and printing its children as JSON: dict/sequence items, manager/queryset rows, or for a Django model instance every field + reverse relation (FK/O2O/M2M) + @property value, else __dict__ attributes. */
export function buildChildrenOrm(path: BackendRuntimePathSegment[]): string {
  // Delegate to a backend helper (same reason as buildInspectOrm — the inlined drill-down cell was multi-KB). The helper
  // replicates the rich drill-down (dict/sequence/manager rows + a model's fields/reverse relations/properties) server-side.
  return `print(_djs_backend_module._pty_orm_children(${pyStr(JSON.stringify(path))}, 200))`;
}

/** Builds a foreign-key picker search as a real ORM cell: icontains across text fields, labelled by str(obj). */
export function buildLookupOrm(app: string | undefined, model: string, q: string, exclude: string[], limit: number): string {
  const excluded = `[${(exclude ?? []).filter((field) => IDENTIFIER.test(field)).map((field) => pyStr(field)).join(", ")}]`;
  const cap = (Number.isInteger(limit) && limit > 0 ? limit : 20) + 1;
  return [
    "import json",
    "from django.db.models import Q",
    `_target, _search = ${modelRef(app, model)}, ${pyStr(q)}`,
    `_fields = [f.name for f in _target._meta.concrete_fields if f.get_internal_type() in ("CharField", "TextField", "SlugField", "EmailField") and f.name not in ${excluded}]`,
    "_where = Q(pk=_search) if _search.isdigit() else Q()",
    "for _name in _fields:",
    "    _where |= Q(**{_name + '__icontains': _search})",
    `print(json.dumps([{"pk": _o.pk, "label": str(_o)} for _o in _target._base_manager.filter(_where)[:${cap}]], default=str))`
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

export const __test = { buildChildrenOrm, buildCommitOrm, buildCountOrm, buildInspectOrm, buildLookupOrm, buildModelsOrm, buildRelatedOrm, editValue, filterChain, orderArgs, safeName };

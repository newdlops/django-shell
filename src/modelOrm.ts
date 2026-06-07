// Reconstructs Django ORM one-liners for "ORM mode", where model-browser operations run as the
// user's own literal shell cells (so a live pre_run_cell audit logs ORM, not RPC plumbing).
// Identifiers are restricted to a safe pattern and values are emitted as JSON/Python literals so
// reconstructed expressions cannot inject code.

import type { BackendModelColumn, BackendModelFilter, BackendModelOrder, BackendModelRelation, ModelCommitChange } from "./modelBackend";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOOKUPS = new Set(["exact", "iexact", "contains", "icontains", "gt", "gte", "lt", "lte", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "range", "date", "year", "month", "day"]);
const PYTHON_FILTER_CHUNK_SIZE = 1000;
const TRUTHY = /^(true|1|t|yes|on)$/i;
const NUMERIC_FIELD = /Integer|Float|Decimal|AutoField/;

interface OrmFilterPlan {
  annotations: Array<{ alias: string; expression: string }>;
  chain: string;
  distinct: boolean;
  pythonTerms: BackendModelFilter[];
}

interface OrmFilterSpec {
  alias?: string;
  column?: BackendModelColumn;
  distinct?: boolean;
  key: string;
  python?: boolean;
  relation?: BackendModelRelation;
}

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
function filterValue(lookup: string, value: unknown, column?: BackendModelColumn): string {
  const text = String(value ?? "");
  if (lookup === "isnull") {
    return TRUTHY.test(text.trim()) ? "True" : "False";
  }
  if (lookup === "in" || lookup === "range") {
    return `[${text.split(",").map((part) => pyStr(part.trim())).join(", ")}]`;
  }
  if (column?.type === "BooleanField") {
    return TRUTHY.test(text.trim()) ? "True" : "False";
  }
  if (column?.computed && /^(true|false|1|0|t|yes|no|on|off)$/i.test(text.trim())) {
    return TRUTHY.test(text.trim()) ? "True" : "False";
  }
  if (column?.computed && /^-?\d+(\.\d+)?$/.test(text.trim())) {
    return text.trim();
  }
  return pyStr(text);
}

/** Returns `.filter(...)`/`.exclude(...)` chain text from allowlisted filter terms (injection-proof). */
function filterChain(filters: BackendModelFilter[] | undefined, attnames: Set<string>): string {
  return filterPlan(filters, new Map([...attnames].map((field) => [field, { key: field }]))).chain;
}

/** Returns filter specs for concrete columns, annotated properties, and relation existence checks. */
function filterSpecs(columns: BackendModelColumn[] | undefined, relations: BackendModelRelation[] | undefined): Map<string, OrmFilterSpec> {
  const specs = new Map<string, OrmFilterSpec>();
  for (const column of columns ?? []) {
    if (column.computed && column.annotated) {
      const alias = annotationAlias(column.attname);
      specs.set(column.attname, { alias, column, key: alias });
    } else if (column.computed) {
      specs.set(column.attname, { column, key: column.attname, python: true });
    } else if (!column.computed) {
      specs.set(column.attname, { column, key: column.attname });
    }
  }
  for (const relation of relations ?? []) {
    if (IDENTIFIER.test(relation.name)) {
      specs.set(`rel:${relation.name}`, { distinct: !relation.single, key: relation.name, relation });
    }
  }
  return specs;
}

/** Returns a safe annotation alias for a declared computed-property filter. */
function annotationAlias(field: string): string {
  return `djs_${safeName(field, "field")}`;
}

/** Returns the model-declared annotation expression for one computed property. */
function annotationExpression(field: string): string {
  return `(__m.djshell_annotations() if callable(__m.djshell_annotations) else __m.djshell_annotations)[${pyStr(field)}]`;
}

/** Returns a safe filter plan with required annotations and distinct flag. */
function filterPlan(filters: BackendModelFilter[] | undefined, specs: Map<string, OrmFilterSpec>): OrmFilterPlan {
  const includes: string[] = [];
  const excludes: string[] = [];
  const annotations = new Map<string, string>();
  let distinct = false;
  const pythonTerms: BackendModelFilter[] = [];
  for (const term of filters ?? []) {
    const lookup = String(term?.lookup ?? "exact");
    const spec = specs.get(String(term?.field));
    if (!term || !spec || !LOOKUPS.has(lookup) || (spec.relation && lookup !== "isnull")) {
      continue;
    }
    if (spec.python) {
      pythonTerms.push({ field: String(term.field), lookup, negate: term.negate, value: term.value });
      continue;
    }
    if (spec.alias) {
      annotations.set(spec.alias, annotationExpression(String(term.field)));
    }
    distinct = distinct || Boolean(spec.distinct);
    const clause = `**{${pyStr(`${spec.key}__${lookup}`)}: ${filterValue(lookup, term.value, spec.column)}}`;
    (term.negate ? excludes : includes).push(clause);
  }
  return {
    annotations: [...annotations.entries()].map(([alias, expression]) => ({ alias, expression })),
    chain: includes.map((clause) => `.filter(${clause})`).join("") + excludes.map((clause) => `.exclude(${clause})`).join(""),
    distinct,
    pythonTerms
  };
}

/** Builds a model-manager query expression, wrapping in a lambda only when annotation expressions need the model object. */
function queryExpression(app: string | undefined, model: string | undefined, plan: OrmFilterPlan, tail = ""): string {
  const ref = modelRef(app, model);
  const receiver = plan.annotations.length ? "__m" : ref;
  const annotate = plan.annotations.length ? `.annotate(${plan.annotations.map((item) => `${item.alias}=${item.expression}`).join(", ")})` : "";
  const distinct = plan.distinct ? ".distinct()" : "";
  const expression = `${receiver}._base_manager${annotate}${plan.chain}${distinct}${tail}`;
  return plan.annotations.length ? `(lambda __m: ${expression})(${ref})` : expression;
}

/** Returns Python code that evaluates unannotated @property filters after the DB queryset. */
function pythonFilterCell(baseExpression: string, terms: BackendModelFilter[], offset: number, end: number): string {
  return [
    "import itertools as _it",
    "def _prop_ok(__o):",
    "    try:",
    `        return ${pythonFilterPredicate(terms)}`,
    "    except Exception:",
    "        return False",
    `list(_it.islice((__o for __o in ${streamingQuerysetExpression(baseExpression)} if _prop_ok(__o)), ${offset}, ${end}))`
  ].join("\n");
}

/** Returns Python code that counts rows matching unannotated @property filters after the DB queryset. */
function pythonFilterCountCell(baseExpression: string, terms: BackendModelFilter[]): string {
  return [
    "def _prop_ok(__o):",
    "    try:",
    `        return ${pythonFilterPredicate(terms)}`,
    "    except Exception:",
    "        return False",
    `sum(1 for __o in ${streamingQuerysetExpression(baseExpression)} if _prop_ok(__o))`
  ].join("\n");
}

/** Returns a QuerySet expression using iterator() so Python-side property filters stream candidates instead of caching the whole queryset. */
function streamingQuerysetExpression(baseExpression: string): string {
  return `(${baseExpression}).iterator(chunk_size=${PYTHON_FILTER_CHUNK_SIZE})`;
}

/** Returns a conjunction of safe Python property lookup predicates. */
function pythonFilterPredicate(terms: BackendModelFilter[]): string {
  const clauses = terms.map((term) => {
    const value = propertyLiteral(term.value);
    const expr = `(lambda __v: ${propertyLookupPredicate("__v", String(term.lookup || "exact"), value)})(getattr(__o, ${pyStr(term.field)}, None))`;
    return term.negate ? `(not ${expr})` : expr;
  });
  return clauses.length ? clauses.join(" and ") : "True";
}

/** Returns a Python literal for property-filter comparison values. */
function propertyLiteral(value: unknown): string {
  const text = String(value ?? "");
  if (/^(true|false|1|0|t|yes|no|on|off)$/i.test(text.trim())) {
    return TRUTHY.test(text.trim()) ? "True" : "False";
  }
  if (/^-?\d+(\.\d+)?$/.test(text.trim())) {
    return text.trim();
  }
  return pyStr(text);
}

/** Returns a safe Python boolean expression for one property lookup. */
function propertyLookupPredicate(variable: string, lookup: string, value: string): string {
  const text = `str(${variable})`;
  const lowered = `${text}.lower()`;
  const valueText = `str(${value})`;
  const valueLowered = `${valueText}.lower()`;
  if (lookup === "exact") { return `${variable} == ${value}`; }
  if (lookup === "iexact") { return `${lowered} == ${valueLowered}`; }
  if (lookup === "contains") { return `${valueText} in ${text}`; }
  if (lookup === "icontains") { return `${valueLowered} in ${lowered}`; }
  if (lookup === "gt" || lookup === "gte" || lookup === "lt" || lookup === "lte") {
    return `${variable} ${lookupOperator(lookup)} ${value}`;
  }
  if (lookup === "startswith") { return `${text}.startswith(${valueText})`; }
  if (lookup === "istartswith") { return `${lowered}.startswith(${valueLowered})`; }
  if (lookup === "endswith") { return `${text}.endswith(${valueText})`; }
  if (lookup === "iendswith") { return `${lowered}.endswith(${valueLowered})`; }
  if (lookup === "in") { return `${variable} in ${propertyListLiteral(value)}`; }
  if (lookup === "range") { return `(lambda __r: len(__r) >= 2 and __r[0] <= ${variable} <= __r[1])(${propertyListLiteral(value)})`; }
  if (lookup === "isnull") { return `(${variable} is None) == ${value}`; }
  if (lookup === "date") { return `str(getattr(${variable}, "date", lambda: ${variable})()) == ${valueText}`; }
  if (["year", "month", "day"].includes(lookup)) { return `getattr(${variable}, ${pyStr(lookup)}, None) == ${value}`; }
  return "False";
}

/** Returns the Python comparison operator for ordered property lookups. */
function lookupOperator(lookup: string): string {
  return ({ gt: ">", gte: ">=", lt: "<", lte: "<=" } as Record<string, string>)[lookup] ?? "==";
}

/** Returns a Python list literal for `in` and `range` property filters. */
function propertyListLiteral(value: string): string {
  const raw = value === "True" || value === "False" || /^-?\d+(\.\d+)?$/.test(value) ? value : JSON.stringify(String(JSON.parse(value)));
  return `[${String(raw).split(",").map((part) => propertyLiteral(part.trim())).join(", ")}]`;
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
  relations?: BackendModelRelation[];
}

/** Builds `Model._base_manager.filter(...).order_by(...)[offset:offset+limit+1]` (extra row = "has more"). @property columns are NOT computed here (concrete only) — they load lazily per-column via buildComputedOrm, so a property joining many models never delays the base page. */
export function buildRowsOrm(params: OrmRowsParams): string {
  const offset = Number.isInteger(params.offset) && (params.offset as number) > 0 ? (params.offset as number) : 0;
  const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 50;
  const attnames = concreteAttnames(params.columns);
  const plan = filterPlan(params.filters, filterSpecs(params.columns, params.relations));
  const order = `.order_by(${orderArgs(params.order, attnames)})`;
  if (plan.pythonTerms.length) {
    return pythonFilterCell(queryExpression(params.app, params.model, plan, order), plan.pythonTerms, offset, offset + limit + 1);
  }
  return queryExpression(params.app, params.model, plan, `${order}[${offset}:${offset + limit + 1}]`);
}

/** Builds a lazy single-@property fetch as a readable ORM result, returning rows/dicts directly so raw audit has no JSON-print or backend-helper layer. */
export function buildComputedOrm(app: string | undefined, model: string, field: string, filters: BackendModelFilter[] | undefined, order: BackendModelOrder[] | undefined, limit: number, columns: BackendModelColumn[] | undefined, relations?: BackendModelRelation[]): string {
  const attnames = concreteAttnames(columns);
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 50;
  const plan = filterPlan(filters, filterSpecs(columns, relations));
  const tail = `.order_by(${orderArgs(order, attnames)})[0:${cap}]`;
  if (plan.pythonTerms.length) {
    const base = queryExpression(app, model, plan, `.order_by(${orderArgs(order, attnames)})`);
    const access = IDENTIFIER.test(field) ? `__o.${field}` : `getattr(__o, ${pyStr(field)}, None)`;
    return [
      "import itertools as _it",
      "def _prop_ok(__o):",
      "    try:",
      `        return ${pythonFilterPredicate(plan.pythonTerms)}`,
      "    except Exception:",
      "        return False",
      `[{${pyStr("pk")}: __o.pk, ${pyStr("value")}: ${access}} for __o in _it.islice((__o for __o in ${streamingQuerysetExpression(base)} if _prop_ok(__o)), 0, ${cap})]`
    ].join("\n");
  }
  if ((columns ?? []).some((column) => column.attname === field && column.annotated)) {
    // The model declares a DB annotation for this field → ONE annotated query (no per-row @property N+1). The audit shows real
    // ORM (annotate + values_list); a `lambda __m:` binds the model name once, keeping the typed cell compact. Resolves
    // `djshell_annotations` as a dict OR classmethod.
    plan.annotations.push({ alias: "__djs", expression: annotationExpression(field) });
    return queryExpression(app, model, plan, `.order_by(${orderArgs(order, attnames)}).values("pk", "__djs")[0:${cap}]`);
  }
  const access = IDENTIFIER.test(field) ? `__o.${field}` : `getattr(__o, ${pyStr(field)}, None)`;
  return `[{${pyStr("pk")}: __o.pk, ${pyStr("value")}: ${access}} for __o in ${queryExpression(app, model, plan, tail)}]`;
}

/** Builds the row-count ORM `Model._base_manager.filter(...).count()` for the current filter set. */
export function buildCountOrm(app: string | undefined, model: string, filters: BackendModelFilter[] | undefined, columns: BackendModelColumn[] | undefined, relations?: BackendModelRelation[]): string {
  const plan = filterPlan(filters, filterSpecs(columns, relations));
  if (plan.pythonTerms.length) {
    return pythonFilterCountCell(queryExpression(app, model, plan), plan.pythonTerms);
  }
  return queryExpression(app, model, plan, ".count()");
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

// Reconstructs Django ORM one-liners for "ORM mode", where model-browser operations run as the
// user's own literal shell cells (so a live pre_run_cell audit logs ORM, not RPC plumbing).
// Identifiers are restricted to a safe pattern and values are emitted as JSON/Python literals so
// reconstructed expressions cannot inject code.

import type { BackendModelColumn, BackendModelFilter, BackendModelOrder, BackendModelRelation, ModelAggregateTerm, ModelAnnotationSpec, ModelCommitChange } from "./modelBackend";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PYTHON_KEYWORDS = new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]);

/** Returns whether a string is safe as an emitted ORM keyword-argument alias (identifier, not a Python keyword, not an internal djs_/__ alias). */
function isSafeAlias(name: string): boolean {
  return IDENTIFIER.test(name) && !PYTHON_KEYWORDS.has(name) && !name.startsWith("djs_") && !name.startsWith("__");
}
const LOOKUPS = new Set(["exact", "iexact", "contains", "icontains", "gt", "gte", "lt", "lte", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "range", "date", "year", "quarter", "month", "week_day", "day", "hour", "minute", "second", "length", "length__gt", "length__gte", "length__lt", "length__lte", "trim"]);
const INT_TRANSFORM_LOOKUPS = new Set(["week_day", "quarter", "hour", "minute", "second"]);
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
  if (lookup.startsWith("length") || INT_TRANSFORM_LOOKUPS.has(lookup)) {
    // length and date/time extracts (week_day, quarter, hour, ...) compare against an int regardless of field type.
    return /^-?\d+(\.\d+)?$/.test(text.trim()) ? text.trim() : "0";
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
    // Relation-existence filters from the new cascading UI arrive as the bare filter query name (e.g. `members`,
    // or a reverse relation's related_query_name) — register it so the term gets the right keyword AND .distinct().
    const queryName = relation.queryName || relation.name;
    if (IDENTIFIER.test(queryName) && !specs.has(queryName)) {
      specs.set(queryName, { distinct: !relation.single, key: queryName, relation });
    }
  }
  return specs;
}

/** Returns a relation-traversal filter path (e.g. `author__profile__city`, or `pk`) when every `__`-separated segment is a safe identifier, else null — so reconstructed ORM cells stay injection-proof. */
function safeFilterPath(field: string): string | null {
  const parts = String(field ?? "").split("__");
  return parts.length && parts.every((part) => IDENTIFIER.test(part)) ? field : null;
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
    if (!term || !LOOKUPS.has(lookup)) {
      continue;
    }
    const spec = specs.get(String(term.field));
    if (!spec) {
      // No concrete/annotated/relation spec: try a relation-traversal path (e.g. author__name) or `pk`. distinct guards
      // against duplicate rows when the path may span a to-many relation (harmless when it does not).
      const path = safeFilterPath(String(term.field ?? ""));
      if (!path) {
        continue;
      }
      distinct = distinct || path.includes("__");
      const clause = `**{${pyStr(`${path}__${lookup}`)}: ${filterValue(lookup, term.value, undefined)}}`;
      (term.negate ? excludes : includes).push(clause);
      continue;
    }
    if (spec.relation && lookup !== "isnull") {
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
  annotations?: ModelAnnotationSpec[];
  app?: string;
  columns?: BackendModelColumn[];
  filters?: BackendModelFilter[];
  limit: number;
  model: string;
  offset?: number;
  order?: BackendModelOrder[];
  relations?: BackendModelRelation[];
}

const WINDOW_RANK_FUNCS: Record<string, string> = { dense_rank: "DenseRank", rank: "Rank", row_number: "RowNumber" };
const ANNOTATION_FUNCTION_CONSTRUCTORS = new Set(["Cast", "Coalesce", "Concat", "Greatest", "Length", "Lower", "Trim", "Upper"]);
const ANNOTATION_BARE_CONSTRUCTORS = ["Avg", "Case", "Cast", "Coalesce", "Concat", "Count", "Exists", "ExpressionWrapper", "F", "Greatest", "Length", "Lower", "Max", "Min", "OuterRef", "Q", "Subquery", "Sum", "Trim", "Upper", "Value", "When", "Window"];
const ANNOTATION_BLOCKED_WORDS = /\b(?:breakpoint|compile|delattr|eval|exec|getattr|globals|input|lambda|locals|open|setattr|super|type|vars|__import__)\b/;
const ANNOTATION_BLOCKED_METHODS = /\.(?:bulk_create|bulk_update|create|cursor|delete|execute|executemany|extra|get_or_create|raw|save|update|update_or_create)\s*\(/;
const ANNOTATION_BLOCKED_MODULES = /\b(?:builtins|ctypes|importlib|os|pathlib|shutil|socket|subprocess|sys)\b/;

/** Returns a safe single-line annotation expression for one per-row column spec via the `models` namespace, or null. */
function annotationExpr(item: ModelAnnotationSpec, attnames: Set<string>, relationNames: Set<string>, sourceModel: string): string | null {
  const kind = item ? String(item.kind) : "";
  if (kind === "annotate") {
    return normalizeAnnotationExpressionText(item.expression);
  }
  if (kind === "subquery") {
    return subqueryAnnotationExpr(item, sourceModel);
  }
  if (kind === "aggregate") {
    const func = String(item.func);
    if (func === "count") {
      const raw = item.field;
      const arg = raw === undefined || raw === null || raw === "" || raw === "*" || raw === "pk" ? "pk" : String(raw);
      if (arg !== "pk" && !attnames.has(arg) && !relationNames.has(arg) && !(arg.includes("__") && safeFilterPath(arg))) {
        return null;
      }
      return `models.Count(${pyStr(arg)}${item.distinct ? ", distinct=True" : ""})`;
    }
    if (AGG_FUNC_NAMES[func]) {
      const arg = item.field === "pk" ? "pk" : String(item.field ?? "");
      if (arg !== "pk" && !attnames.has(arg) && !(arg.includes("__") && safeFilterPath(arg))) {
        return null;
      }
      return `models.${AGG_FUNC_NAMES[func]}(${pyStr(arg)})`;
    }
    return null;
  }
  if (kind === "window") {
    const func = String(item.func);
    const partition = (item.partitionBy ?? []).filter((field) => attnames.has(field));
    const order = (item.orderBy ?? []).filter((term) => term && attnames.has(String(term.field)));
    let inner: string;
    if (WINDOW_RANK_FUNCS[func]) {
      if (!order.length) {
        return null;
      }
      inner = `models.functions.${WINDOW_RANK_FUNCS[func]}()`;
    } else if (AGG_FUNC_NAMES[func]) {
      const arg = func === "count" && (item.field === undefined || item.field === null || item.field === "" || item.field === "*" || item.field === "pk") ? "pk" : String(item.field ?? "");
      if (arg !== "pk" && !attnames.has(arg)) {
        return null;
      }
      inner = `models.${AGG_FUNC_NAMES[func]}(models.F(${pyStr(arg)}))`;
    } else {
      return null;
    }
    const parts = [inner];
    if (partition.length) {
      parts.push(`partition_by=[${partition.map((field) => `models.F(${pyStr(field)})`).join(", ")}]`);
    }
    if (order.length) {
      parts.push(`order_by=[${order.map((term) => `models.F(${pyStr(String(term.field))})${term.desc ? ".desc()" : ".asc()"}`).join(", ")}]`);
    }
    return `models.Window(${parts.join(", ")})`;
  }
  if (kind === "expr") {
    const op = String(item.op);
    if (!["+", "-", "*", "/"].includes(op)) {
      return null;
    }
    const left = exprOperand(item.left, attnames);
    const right = exprOperand(item.right, attnames);
    // Require at least one field reference: a constant-only expression isn't a valid Django annotation (and `5/0` would crash the cell).
    if (!left || !right || (!left.field && !right.field)) {
      return null;
    }
    return `${left.text} ${op} ${right.text}`;
  }
  return null;
}

/** Returns a safe single-line Subquery expression for the structured Subquery column builder. */
function subqueryAnnotationExpr(item: ModelAnnotationSpec, sourceModel: string): string | null {
  const valuePath = safeFilterPath(String(item.field ?? ""));
  if (!valuePath) {
    return null;
  }
  if (item.relationKind === "m2m") {
    const owner = safeName(item.throughOwner, safeName(sourceModel, ""));
    const relation = safeName(item.throughRelation, "");
    const source = safeName(item.throughSource, "");
    const target = safeName(item.throughTarget, "");
    if (!owner || !relation || !source || !target) {
      return null;
    }
    const selected = `${target}__${valuePath}`;
    const order = subqueryOrderArgs(item.orderBy, valuePath, target);
    return `models.Subquery(${owner}.${relation}.through.objects.filter(**{${pyStr(`${source}_id`)}: models.OuterRef(${pyStr("pk")})}).order_by(${order}).values(${pyStr(selected)})[:1])`;
  }
  const targetModel = targetModelName(item.target);
  const filterField = safeFilterPath(String(item.filterField ?? ""));
  const outerField = safeFilterPath(String(item.outerField ?? "pk"));
  if (!targetModel || !filterField || !outerField) {
    return null;
  }
  const order = subqueryOrderArgs(item.orderBy, valuePath);
  return `models.Subquery(${targetModel}._base_manager.filter(**{${pyStr(filterField)}: models.OuterRef(${pyStr(outerField)})}).order_by(${order}).values(${pyStr(valuePath)})[:1])`;
}

/** Returns a safe model class name from an app-qualified label. */
function targetModelName(target: string | undefined): string | null {
  const name = String(target ?? "").split(".").pop() ?? "";
  return IDENTIFIER.test(name) ? name : null;
}

/** Returns a comma-separated `.order_by()` argument list for a structured Subquery. */
function subqueryOrderArgs(orderBy: ModelAnnotationSpec["orderBy"], fallback: string, prefix?: string): string {
  const terms = [];
  for (const term of orderBy ?? []) {
    const path = safeFilterPath(String(term?.field ?? ""));
    if (!path) {
      continue;
    }
    const field = prefix ? `${prefix}__${path}` : path;
    terms.push(pyStr(`${term.desc ? "-" : ""}${field}`));
    if (terms.length >= 3) {
      break;
    }
  }
  if (!terms.length) {
    terms.push(pyStr(prefix ? `${prefix}__${fallback}` : fallback));
  }
  return terms.join(", ");
}

/** Returns a safe single-line raw annotate expression, normalizing bare Django constructors to the `models` namespace. */
function normalizeAnnotationExpressionText(expression: string | undefined): string | null {
  const text = String(expression ?? "").trim();
  if (!isSafeAnnotationExpressionText(text)) {
    return null;
  }
  return text.replace(new RegExp(`\\b(${ANNOTATION_BARE_CONSTRUCTORS.join("|")})\\s*\\(`, "g"), (match, name, offset, source) => {
    const before = source.slice(Math.max(0, offset - 1), offset);
    if (before === ".") {
      return match;
    }
    return ANNOTATION_FUNCTION_CONSTRUCTORS.has(name) ? `models.functions.${name}(` : `models.${name}(`;
  });
}

/** Returns whether raw annotate expression text is safe enough to emit into an ORM-mode single-line cell. */
function isSafeAnnotationExpressionText(text: string): boolean {
  if (!text || text.length > 800 || /[\r\n;#`]/.test(text)) {
    return false;
  }
  if (/\b__[A-Za-z0-9_]*__\b/.test(text) || ANNOTATION_BLOCKED_WORDS.test(text) || ANNOTATION_BLOCKED_METHODS.test(text) || ANNOTATION_BLOCKED_MODULES.test(text)) {
    return false;
  }
  return /^[A-Za-z0-9_.'",:()[\]\s=+\-*\/%<>!&|]+$/.test(text);
}

/** Returns one F-expression operand (`models.F('field')` or a numeric literal) with a `field` flag, or null when neither. */
function exprOperand(raw: string | number | undefined, attnames: Set<string>): { field: boolean; text: string } | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { field: false, text: String(raw) };
  }
  if (typeof raw === "string") {
    if (attnames.has(raw)) {
      return { field: true, text: `models.F(${pyStr(raw)})` };
    }
    const text = raw.trim();
    return /^-?\d+(\.\d+)?$/.test(text) ? { field: false, text } : null;
  }
  return null;
}

/** Returns safe {alias, expr, window} annotation specs (allowlisted, unique aliases) for the rows query. */
function buildRowAnnotations(annotations: ModelAnnotationSpec[] | undefined, attnames: Set<string>, relationNames: Set<string>, sourceModel: string): Array<{ alias: string; expr: string; window: boolean }> {
  const specs: Array<{ alias: string; expr: string; window: boolean }> = [];
  const used = new Set<string>();
  for (const item of annotations ?? []) {
    const expr = annotationExpr(item, attnames, relationNames, sourceModel);
    if (expr) {
      const label = item.kind === "expr" ? "expr" : item.kind === "annotate" ? "annotate" : String(item.func || item.kind || "col");
      const arg = typeof item.field === "string" && item.field && item.field !== "*" ? item.field : "col";
      specs.push({ alias: aggregateAlias(item.alias, label, arg, used), expr, window: String(item.kind) === "window" });
    }
  }
  return specs;
}

/** Returns a Python literal for one scalar HAVING value, numeric-FIRST so a count comparison like `>= 1` emits the int 1, not the bool True. */
function havingScalar(text: string): string {
  const trimmed = String(text ?? "").trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }
  if (/^(true|false)$/i.test(trimmed)) {
    return /^true$/i.test(trimmed) ? "True" : "False";
  }
  return pyStr(trimmed);
}

/** Returns a Python literal for a HAVING value, matching the socket's numeric-aware coercion (isnull→bool, in→list, range→2-element list, scalar numeric-first). */
function havingValue(lookup: string, value: unknown): string {
  const text = String(value ?? "");
  if (lookup === "isnull") {
    return TRUTHY.test(text.trim()) ? "True" : "False";
  }
  if (lookup === "in") {
    return `[${text.split(",").map((part) => havingScalar(part)).join(", ")}]`;
  }
  if (lookup === "range") {
    return `[${text.split(",").slice(0, 2).map((part) => havingScalar(part)).join(", ")}]`;
  }
  return havingScalar(text);
}

/** Returns the `.filter(...)`/`.exclude(...)` chain for lookups on annotation aliases, applied after .annotate() (HAVING / WHERE-on-expression). */
function havingChain(filters: BackendModelFilter[] | undefined, havingAliases: Set<string>): string {
  let chain = "";
  for (const term of filters ?? []) {
    const lookup = String(term?.lookup ?? "exact");
    if (!term || !havingAliases.has(String(term.field)) || !LOOKUPS.has(lookup)) {
      continue;
    }
    const clause = `**{${pyStr(`${term.field}__${lookup}`)}: ${havingValue(lookup, term.value)}}`;
    chain += term.negate ? `.exclude(${clause})` : `.filter(${clause})`;
  }
  return chain;
}

/** Builds `Model._base_manager.filter(...).annotate(...).order_by(...)[offset:offset+limit+1]` (extra row = "has more"). @property columns load lazily via buildComputedOrm; per-row annotation columns (raw annotate expressions, relation/field aggregates, window functions, F-expression arithmetic) are added here and surface on the instance via the capture hook. */
export function buildRowsOrm(params: OrmRowsParams): string {
  const offset = Number.isInteger(params.offset) && (params.offset as number) > 0 ? (params.offset as number) : 0;
  const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 50;
  const attnames = concreteAttnames(params.columns);
  const annotations = buildRowAnnotations(params.annotations, attnames, relationQueryNames(params.relations, params.columns), params.model);
  const annotate = annotations.length ? `.annotate(${annotations.map((spec) => `${spec.alias}=${spec.expr}`).join(", ")})` : "";
  // A lookup on a (non-window) annotation alias filters AFTER .annotate() (HAVING / WHERE-on-expression); window aliases can't be filtered.
  const allAliases = new Set(annotations.map((spec) => spec.alias));
  const havingAliases = new Set(annotations.filter((spec) => !spec.window).map((spec) => spec.alias));
  const baseFilters = (params.filters ?? []).filter((term) => !allAliases.has(String(term?.field)));
  const having = havingChain(params.filters, havingAliases);
  const plan = filterPlan(baseFilters, filterSpecs(params.columns, params.relations));
  const order = `.order_by(${orderArgs(params.order, attnames)})`;
  if (plan.pythonTerms.length) {
    // @property filter streams instances; annotate first so each instance carries the annotation attrs the capture hook surfaces.
    return pythonFilterCell(queryExpression(params.app, params.model, plan, `${annotate}${having}${order}`), plan.pythonTerms, offset, offset + limit + 1);
  }
  return queryExpression(params.app, params.model, plan, `${annotate}${having}${order}[${offset}:${offset + limit + 1}]`);
}

/** Builds a lazy single-@property fetch as a readable ORM result, returning rows/dicts directly so raw audit has no JSON-print or backend-helper layer. Per-row annotation columns are re-applied so the loaded page matches the rows grid even when it is sorted by an annotation alias. */
export function buildComputedOrm(app: string | undefined, model: string, field: string, filters: BackendModelFilter[] | undefined, order: BackendModelOrder[] | undefined, limit: number, columns: BackendModelColumn[] | undefined, relations?: BackendModelRelation[], annotations?: ModelAnnotationSpec[]): string {
  const attnames = concreteAttnames(columns);
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 50;
  const rowAnnotations = buildRowAnnotations(annotations, attnames, relationQueryNames(relations, columns), model);
  const annotate = rowAnnotations.length ? `.annotate(${rowAnnotations.map((spec) => `${spec.alias}=${spec.expr}`).join(", ")})` : "";
  const allAliases = new Set(rowAnnotations.map((spec) => spec.alias));
  const havingAliases = new Set(rowAnnotations.filter((spec) => !spec.window).map((spec) => spec.alias));
  const baseFilters = (filters ?? []).filter((term) => !allAliases.has(String(term?.field)));
  // annotate (so order_by('alias') resolves) → HAVING → order_by, mirroring buildRowsOrm's clause order.
  const pageTail = `${annotate}${havingChain(filters, havingAliases)}.order_by(${orderArgs(order, attnames)})`;
  const plan = filterPlan(baseFilters, filterSpecs(columns, relations));
  if (plan.pythonTerms.length) {
    const base = queryExpression(app, model, plan, pageTail);
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
    return queryExpression(app, model, plan, `${pageTail}.values("pk", "__djs")[0:${cap}]`);
  }
  const access = IDENTIFIER.test(field) ? `__o.${field}` : `getattr(__o, ${pyStr(field)}, None)`;
  return `[{${pyStr("pk")}: __o.pk, ${pyStr("value")}: ${access}} for __o in ${queryExpression(app, model, plan, `${pageTail}[0:${cap}]`)}]`;
}

/** Builds the row-count ORM `Model._base_manager.filter(...).count()` for the current filter set. */
export function buildCountOrm(app: string | undefined, model: string, filters: BackendModelFilter[] | undefined, columns: BackendModelColumn[] | undefined, relations?: BackendModelRelation[]): string {
  const plan = filterPlan(filters, filterSpecs(columns, relations));
  if (plan.pythonTerms.length) {
    return pythonFilterCountCell(queryExpression(app, model, plan), plan.pythonTerms);
  }
  return queryExpression(app, model, plan, ".count()");
}

const AGG_FUNC_NAMES: Record<string, string> = { avg: "Avg", count: "Count", max: "Max", min: "Min", sum: "Sum" };

/** Parameters for a reconstructed grouped/global aggregate query. */
export interface OrmAggregateParams {
  aggregates: ModelAggregateTerm[];
  app?: string;
  columns?: BackendModelColumn[];
  filters?: BackendModelFilter[];
  groupBy?: string[];
  limit?: number;
  model: string;
  relations?: BackendModelRelation[];
}

interface AggregateCellSpec {
  alias: string;
  arg: string;
  expr: string;
  func: string;
}

/** Returns a unique safe identifier alias for one aggregate column (only emitted as an ORM keyword). */
function aggregateAlias(alias: string | undefined, func: string, arg: string, used: Set<string>): string {
  let candidate = typeof alias === "string" && isSafeAlias(alias) ? alias : func === "exists" ? "exists" : `${arg}_${func}`;
  if (!isSafeAlias(candidate)) {
    candidate = `agg_${func}`;
  }
  const base = candidate;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/** Returns the relation query names Count can target: reverse/M2M (related_query_name) plus forward FK/O2O field names from the columns. */
function relationQueryNames(relations: BackendModelRelation[] | undefined, columns?: BackendModelColumn[]): Set<string> {
  const names = new Set((relations ?? []).map((relation) => relation.queryName || relation.name).filter((name): name is string => Boolean(name)));
  for (const column of columns ?? []) {
    if (column.relation && column.relation.field) {
      names.add(column.relation.field);
    }
  }
  return names;
}

/** Returns whether any aggregate targets a computed @property column — those need a Python scan (Socket/Auto only), not an ORM cell. */
export function aggregatesNeedPython(aggregates: ModelAggregateTerm[] | undefined, columns: BackendModelColumn[] | undefined): boolean {
  const computed = new Set((columns ?? []).filter((column) => column.computed).map((column) => column.attname));
  return (aggregates ?? []).some((term) => term && String(term.func) !== "exists" && typeof term.field === "string" && computed.has(term.field));
}

/** Returns safe aggregate specs (allowlisted field/func/relation, unique aliases) emitting each function via the auto-imported `models` namespace. Count may target a reverse/M2M relation query name; `exists` is dropped in grouped mode. */
function aggregateSpecs(terms: ModelAggregateTerm[] | undefined, attnames: Set<string>, relationNames: Set<string>, grouped: boolean): AggregateCellSpec[] {
  const specs: AggregateCellSpec[] = [];
  const used = new Set<string>();
  for (const term of terms ?? []) {
    const func = term ? String(term.func) : "";
    if (func === "exists") {
      if (grouped) {
        continue;
      }
      specs.push({ alias: aggregateAlias(term.alias, func, "pk", used), arg: "pk", expr: "", func });
    } else if (func === "count") {
      const raw = term.field;
      const arg = raw === undefined || raw === null || raw === "" || raw === "*" || raw === "pk" ? "pk" : String(raw);
      if (arg !== "pk" && !attnames.has(arg) && !relationNames.has(arg) && !(arg.includes("__") && safeFilterPath(arg))) {
        continue;
      }
      specs.push({ alias: aggregateAlias(term.alias, func, arg, used), arg, expr: `models.Count(${pyStr(arg)}${term.distinct ? ", distinct=True" : ""})`, func });
    } else if (AGG_FUNC_NAMES[func]) {
      const arg = term.field === "pk" ? "pk" : String(term.field ?? "");
      if (arg !== "pk" && !attnames.has(arg) && !(arg.includes("__") && safeFilterPath(arg))) {
        continue;
      }
      specs.push({ alias: aggregateAlias(term.alias, func, arg, used), arg, expr: `models.${AGG_FUNC_NAMES[func]}(${pyStr(arg)})`, func });
    }
  }
  return specs;
}

/** Builds a single-line, injection-proof aggregate ORM cell: grouped → `.values().annotate().order_by()` (a queryset the capture hook materializes), global → a list-wrapped `.aggregate()`/`.exists()` tabulating as one row. Aggregate functions use the auto-imported `models` namespace (models.Sum, models.Count, …) so no import line is needed and the cell stays one line (plain-REPL multi-line cells are unsupported). Computed-@property aggregates are NOT emitted here — the caller routes those to the socket Python scan (see aggregatesNeedPython). */
export function buildAggregateOrm(params: OrmAggregateParams): string {
  const attnames = concreteAttnames(params.columns);
  const groupBy = [...new Set((params.groupBy ?? []).filter((field) => field === "pk" || attnames.has(field) || (field.includes("__") && Boolean(safeFilterPath(field)))))].slice(0, 8);
  const specs = aggregateSpecs(params.aggregates, attnames, relationQueryNames(params.relations, params.columns), groupBy.length > 0);
  // A lookup on an aggregate alias filters the groups AFTER aggregation (HAVING) — keep it out of the WHERE plan.
  const aliasSet = new Set(specs.map((spec) => spec.alias));
  const baseFilters = (params.filters ?? []).filter((term) => !aliasSet.has(String(term?.field)));
  const plan = filterPlan(baseFilters, filterSpecs(params.columns, params.relations));
  if (!specs.length) {
    // Nothing usable survived (all fields dropped, or exists-only with a group-by): emit a degenerate empty aggregate
    // that tabulates to a zero-column grid, which parseOrmAggregateResponse maps to the same error the socket returns.
    return `[${queryExpression(params.app, params.model, plan, "")}.aggregate()]`;
  }
  if (groupBy.length) {
    const keys = groupBy.map((field) => pyStr(field)).join(", ");
    const annotate = `.annotate(${specs.map((spec) => `${spec.alias}=${spec.expr}`).join(", ")})`;
    const having = havingChain(params.filters, aliasSet);
    // Bound the grouped result like the socket does (limit+1) so a high-cardinality group-by can't overrun the PTY marker.
    const cap = Number.isInteger(params.limit) && (params.limit as number) > 0 ? (params.limit as number) : 1000;
    return queryExpression(params.app, params.model, plan, `.values(${keys})${annotate}${having}.order_by(${keys})[0:${cap + 1}]`);
  }
  const base = queryExpression(params.app, params.model, plan, "");
  const aggregates = specs.filter((spec) => spec.func !== "exists");
  const exists = specs.filter((spec) => spec.func === "exists");
  const aggregateCall = `${base}.aggregate(${aggregates.map((spec) => `${spec.alias}=${spec.expr}`).join(", ")})`;
  if (!exists.length) {
    return `[${aggregateCall}]`;
  }
  const existsEntries = exists.map((spec) => `${pyStr(spec.alias)}: ${base}.exists()`).join(", ");
  return aggregates.length ? `[dict(${aggregateCall}, **{${existsEntries}})]` : `[{${existsEntries}}]`;
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

export const __test = { aggregatesNeedPython, buildAggregateOrm, buildCommitOrm, buildCountOrm, buildInspectOrm, buildLookupOrm, buildModelsOrm, buildRelatedOrm, editValue, filterChain, orderArgs, safeName };

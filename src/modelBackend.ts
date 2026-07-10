// Types and response parsers for the additive Django model data-browser backend kinds.

/** Idle status shared by model-browser data sources while no Django shell runtime is attached; consumers treat it as deterministic (no retry) rather than transient. */
export const MODEL_IDLE_MESSAGE = "Open the Django Shell console first.";

/** One browsable model entry in the catalog. */
export interface BackendModelInfo {
  app: string;
  label: string;
  model: string;
  table: string;
}

/** Catalog of installed models returned by the backend. */
export interface BackendModelList {
  error?: string;
  models: BackendModelInfo[];
  ok: boolean;
}

/** Forward relation target attached to a foreign-key column. */
export interface BackendModelColumnRelation {
  field: string;
  filterField?: string;
  outerField?: string;
  single: boolean;
  target: string;
  throughOwner?: string;
  throughRelation?: string;
  throughSource?: string;
  throughTarget?: string;
}

/** One concrete column descriptor for a model. */
export interface BackendModelColumn {
  annotated?: boolean;
  annotation?: boolean;
  attname: string;
  choices?: Array<[unknown, string]>;
  computed?: boolean;
  editable: boolean;
  name: string;
  null: boolean;
  pk: boolean;
  relation?: BackendModelColumnRelation;
  type: string;
}

/** One expandable relation (reverse FK, M2M, reverse O2O) for a model. `name` is the accessor used to expand rows; `queryName` is the Django filter query name (reverse uses related_query_name, not the `_set` accessor). */
export interface BackendModelRelation {
  filterField?: string;
  kind: string;
  name: string;
  outerField?: string;
  queryName?: string;
  single: boolean;
  target: string;
  throughOwner?: string;
  throughRelation?: string;
  throughSource?: string;
  throughTarget?: string;
}

/** Column and relation metadata for one model. */
export interface BackendModelSchema {
  app?: string;
  columns: BackendModelColumn[];
  error?: string;
  label?: string;
  model?: string;
  ok: boolean;
  pk?: string;
  relations: BackendModelRelation[];
  table?: string;
}

/** One executed SQL statement captured for the command log. */
export interface BackendSqlEntry {
  sql: string;
  time: string;
}

/** A JSON-safe cell value; tagged objects describe non-primitive field types. */
export type BackendModelCell = boolean | number | string | null | { len?: number; t: string; v: string };

/** One serialized row keyed by column attname. */
export type BackendModelRow = Record<string, BackendModelCell>;

/** One bounded page of model rows. */
export interface BackendModelRows {
  columns: BackendModelColumn[];
  error?: string;
  hasMore: boolean;
  nextCursor?: unknown;
  nextOffset: number | null;
  ok: boolean;
  orm: string;
  pk?: string;
  relations?: BackendModelRelation[];
  rows: BackendModelRow[];
  sql: BackendSqlEntry[];
}

/** Related rows fetched lazily for one source row. */
export interface BackendModelRelatedRows {
  app?: string;
  columns: BackendModelColumn[];
  error?: string;
  hasMore: boolean;
  model?: string;
  ok: boolean;
  orm: string;
  pk?: string;
  rows: BackendModelRow[];
  single: boolean;
  sql: BackendSqlEntry[];
}

/** One sort term applied to a rows query. */
export interface BackendModelOrder {
  desc?: boolean;
  field: string;
}

/** One structured filter term; field and lookup are allowlisted by the backend. */
export interface BackendModelFilter {
  field: string;
  lookup: string;
  negate?: boolean;
  value: unknown;
}

/** One leaf (filterable, non-traversable) field in a model's filter tree. */
export interface BackendFilterField {
  attname: string;
  choices?: Array<[unknown, string]>;
  name: string;
  null: boolean;
  pk: boolean;
  type: string;
}

/** One traversable relation in a model's filter tree; `name` is the Django filter query name (reverse uses related_query_name, not the `_set` accessor). */
export interface BackendFilterRelation {
  filterField?: string;
  kind: string;
  name: string;
  outerField?: string;
  single: boolean;
  target: string;
  throughOwner?: string;
  throughRelation?: string;
  throughSource?: string;
  throughTarget?: string;
}

/** The filterable field/relation tree for one model, fed to the cascading filter dropdowns. */
export interface BackendFilterFieldTree {
  error?: string;
  fields: BackendFilterField[];
  ok: boolean;
  pk?: string;
  relations: BackendFilterRelation[];
}

/** On-demand row count for the current filter set. */
export interface BackendModelCount {
  count: number | null;
  error?: string;
  ok: boolean;
  orm: string;
  sql: BackendSqlEntry[];
}

/** One ORDER BY term inside a window-function annotation. */
export interface ModelAnnotationOrder {
  desc?: boolean;
  field: string;
}

/** The right-hand operand of one structured annotation/aggregate condition. */
export type ModelConditionRhs =
  | { kind: "value"; value: unknown }
  | { field: string; kind: "field" }
  | { field: string; kind: "outer" };

/** One validated predicate inside a structured annotation/aggregate condition group. */
export interface ModelConditionTerm {
  field: string;
  fieldType?: string;
  lookup: string;
  negate?: boolean;
  rhs: ModelConditionRhs;
  toMany?: boolean;
}

/** A bounded all/any group of structured predicates used by a computed column. */
export interface ModelConditionGroup {
  join?: "all" | "any";
  terms: ModelConditionTerm[];
}

/** One per-row annotation column: an aggregate, window function, F-expression, or raw Django annotate expression. */
export interface ModelAnnotationSpec {
  alias?: string;
  conditions?: ModelConditionGroup;
  distinct?: boolean;
  expression?: string;
  filterField?: string;
  field?: string;
  func?: string;
  kind: string;
  left?: string | number;
  op?: string;
  orderBy?: ModelAnnotationOrder[];
  outerField?: string;
  partitionBy?: string[];
  relation?: string;
  relationKind?: string;
  right?: string | number;
  target?: string;
  throughOwner?: string;
  throughRelation?: string;
  throughSource?: string;
  throughTarget?: string;
}

/** Parameters for one model rows page request. (`columns` is supplied in ORM mode for the filter/annotation allowlist.) */
export interface ModelRowsQuery {
  annotations?: ModelAnnotationSpec[];
  app: string;
  columns?: BackendModelColumn[];
  cursor?: unknown;
  filters?: BackendModelFilter[];
  limit?: number;
  model: string;
  offset?: number;
  order?: BackendModelOrder[];
  relations?: BackendModelRelation[];
}

/** Parameters for one row count request. */
export interface ModelCountQuery {
  app: string;
  columns?: BackendModelColumn[];
  filters?: BackendModelFilter[];
  model: string;
  relations?: BackendModelRelation[];
}

/** One aggregate term: a function (count/sum/avg/min/max/exists) over a field; count accepts "*"/pk for all rows. */
export interface ModelAggregateTerm {
  alias?: string;
  conditions?: ModelConditionGroup;
  distinct?: boolean;
  field?: string;
  func: string;
}

/** Parameters for one grouped/global aggregate request. (`columns` is supplied in ORM mode for the field allowlist.) */
export interface ModelAggregateQuery {
  aggregates: ModelAggregateTerm[];
  app: string;
  columns?: BackendModelColumn[];
  filters?: BackendModelFilter[];
  groupBy?: string[];
  model: string;
  relations?: BackendModelRelation[];
}

/** Result of a grouped/global aggregate: a read-only grid of group-by and aggregate columns. `pythonScan` marks that a computed-@property aggregate was reduced by a full Python scan. */
export interface BackendModelAggregate {
  columns: BackendModelColumn[];
  error?: string;
  groupBy?: string[];
  hasMore: boolean;
  ok: boolean;
  orm: string;
  pythonScan?: boolean;
  rows: BackendModelRow[];
  sql: BackendSqlEntry[];
}

/** One staged row's field edits to commit. */
export interface ModelCommitChange {
  fields: Record<string, unknown>;
  pk: unknown;
}

/** Parameters for one staged-edit commit. (`columns` is supplied in ORM mode for typed value literals.) */
export interface ModelCommitQuery {
  app: string;
  changes: ModelCommitChange[];
  columns?: BackendModelColumn[];
  model: string;
}

/** Per-row outcome of a commit (ok, not-found, or field validation errors). */
export interface BackendCommitRowResult {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  ok: boolean;
  pk: unknown;
}

/** Result of an atomic staged-edit commit. */
export interface BackendCommitResult {
  error?: string;
  ok: boolean;
  orm: string;
  results: BackendCommitRowResult[];
  saved: number;
  sql: BackendSqlEntry[];
}

/** One foreign-key picker candidate: a primary key and a human-readable label. */
export interface BackendModelLookupRow {
  label: string;
  pk: unknown;
}

/** A bounded page of foreign-key picker candidates for a target model. */
export interface BackendModelLookup {
  error?: string;
  hasMore: boolean;
  ok: boolean;
  rows: BackendModelLookupRow[];
  sql: BackendSqlEntry[];
}

/** Parameters for one custom ORM query request. */
export interface ModelQueryRequest {
  code: string;
  limit?: number;
  offset?: number;
}

/** Tabulated result of a custom ORM query; shares the rows shape so the grid renders it unchanged. */
export interface BackendModelQuery {
  app?: string;
  columns: BackendModelColumn[];
  editable: boolean;
  error?: string;
  hasMore: boolean;
  model?: string;
  ok: boolean;
  orm: string;
  pk?: string;
  relations: BackendModelRelation[];
  rows: BackendModelRow[];
  sql: BackendSqlEntry[];
  stderr?: string;
  stdout?: string;
}

/** Parameters for one foreign-key picker search request. */
export interface ModelLookupQuery {
  app: string;
  exclude?: string[];
  limit?: number;
  model: string;
  q: string;
}

/** Parameters for one related-rows expansion request. */
export interface ModelRelatedQuery {
  app: string;
  limit?: number;
  model: string;
  pk: unknown;
  relation: string;
  single?: boolean;
  value?: unknown;
}

/** Parameters for one lazy computed-field (@property) fetch over the current filter/order page. */
export interface ModelComputedQuery {
  annotations?: ModelAnnotationSpec[];
  app: string;
  columns?: BackendModelColumn[];
  field: string;
  filters?: BackendModelFilter[];
  limit?: number;
  model: string;
  order?: BackendModelOrder[];
  relations?: BackendModelRelation[];
}

/** Result of a lazy computed-field fetch: each loaded row's pk mapped to that property's cell value. */
export interface BackendModelComputed {
  error?: string;
  field?: string;
  ok: boolean;
  queryCount?: number;
  rowCount?: number;
  values: Record<string, BackendModelCell>;
}

/** Returns the first response line parsed as JSON. */
function parseLine<T>(buffer: string): T {
  const line = buffer.split(/\r?\n/, 1)[0] ?? "";
  return JSON.parse(line) as T;
}

/** Parses a backend model catalog response. */
export function parseModelListResponse(buffer: string): BackendModelList {
  const parsed = parseLine<Partial<BackendModelList>>(buffer);
  return { error: parsed.error, models: Array.isArray(parsed.models) ? parsed.models : [], ok: Boolean(parsed.ok) };
}

/** Parses a backend model schema response. */
export function parseModelSchemaResponse(buffer: string): BackendModelSchema {
  const parsed = parseLine<Partial<BackendModelSchema>>(buffer);
  return {
    app: parsed.app,
    columns: Array.isArray(parsed.columns) ? parsed.columns : [],
    error: parsed.error,
    label: parsed.label,
    model: parsed.model,
    ok: Boolean(parsed.ok),
    pk: parsed.pk,
    relations: Array.isArray(parsed.relations) ? parsed.relations : [],
    table: parsed.table
  };
}

/** Parses a backend filter-field-tree response (leaf fields + traversable relations for one model). */
export function parseFilterFieldsResponse(buffer: string): BackendFilterFieldTree {
  const parsed = parseLine<Partial<BackendFilterFieldTree>>(buffer);
  return {
    error: parsed.error,
    fields: Array.isArray(parsed.fields) ? parsed.fields : [],
    ok: Boolean(parsed.ok),
    pk: parsed.pk,
    relations: Array.isArray(parsed.relations) ? parsed.relations : []
  };
}

/** Parses a backend model rows page response. */
export function parseModelRowsResponse(buffer: string): BackendModelRows {
  const parsed = parseLine<Partial<BackendModelRows>>(buffer);
  return {
    columns: Array.isArray(parsed.columns) ? parsed.columns : [],
    error: parsed.error,
    hasMore: Boolean(parsed.hasMore),
    nextCursor: parsed.nextCursor,
    nextOffset: typeof parsed.nextOffset === "number" ? parsed.nextOffset : null,
    ok: Boolean(parsed.ok),
    orm: typeof parsed.orm === "string" ? parsed.orm : "",
    pk: parsed.pk,
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    sql: Array.isArray(parsed.sql) ? parsed.sql : []
  };
}

/** Parses an ORM-mode literal-cell marker into a rows page from the capture hook's `grid` (trims limit+1, offset pagination). */
export function parseOrmGridResponse(buffer: string, limit: number, offset: number): BackendModelRows {
  const parsed = parseLine<{ grid?: Partial<BackendModelRows> & { relations?: BackendModelRelation[]; truncated?: boolean }; sql?: BackendSqlEntry[]; stderr?: string; traceback?: string }>(buffer);
  const grid = parsed.grid;
  if (!grid || !Array.isArray(grid.columns)) {
    const detail = (parsed.traceback || parsed.stderr || "ORM mode could not tabulate this result; switch the Link selector to Socket/Auto.").trim().split(/\r?\n/).filter(Boolean).pop();
    return { columns: [], error: detail, hasMore: false, nextOffset: null, ok: false, orm: "", rows: [], sql: [] };
  }
  const all = Array.isArray(grid.rows) ? grid.rows : [];
  const rows = all.slice(0, limit);
  // `grid.truncated` = the backend kept only the rows that fit the PTY marker (a large "all" page); there are more.
  const hasMore = all.length > limit || Boolean(grid.truncated);
  return {
    columns: grid.columns,
    hasMore,
    nextOffset: hasMore ? offset + rows.length : null,
    ok: true,
    orm: "",
    pk: grid.pk,
    relations: Array.isArray(grid.relations) ? grid.relations : [],
    rows,
    sql: Array.isArray(parsed.sql) ? parsed.sql : []
  };
}

/** Returns the trimmed last non-empty traceback/stderr line for an ORM-mode failure message. */
function ormError(parsed: { stderr?: string; traceback?: string }, fallback: string): string {
  return (parsed.traceback || parsed.stderr || fallback).trim().split(/\r?\n/).filter(Boolean).pop() || fallback;
}

/** Parses a pure `len(apps.get_models())` probe marker into the catalog attached by the capture hook. */
export function parseOrmModelsResponse(buffer: string): BackendModelList {
  const parsed = parseLine<{ models?: Partial<BackendModelList>; ok?: boolean; stderr?: string; traceback?: string }>(buffer);
  const models = parsed.models;
  if (parsed.ok === false || !models || !Array.isArray(models.models)) {
    return { error: ormError(parsed, "Could not list models in ORM mode."), models: [], ok: false };
  }
  return { error: models.error, models: models.models, ok: Boolean(models.ok) };
}

/** Parses an ORM-mode foreign-key lookup cell from the capture hook's values-grid rows (trims limit+1). */
export function parseOrmLookupResponse(buffer: string, limit: number): BackendModelLookup {
  const parsed = parseLine<{ grid?: { rows?: BackendModelRow[] }; ok?: boolean; sql?: BackendSqlEntry[]; stderr?: string; traceback?: string }>(buffer);
  const rows = parsed.grid?.rows;
  if (parsed.ok === false || !Array.isArray(rows)) {
    return { error: ormError(parsed, "Lookup failed in ORM mode."), hasMore: false, ok: false, rows: [], sql: [] };
  }
  return { hasMore: rows.length > limit, ok: true, rows: rows.slice(0, limit).map((row) => ({ label: lookupRowLabel(row), pk: row.pk })), sql: Array.isArray(parsed.sql) ? parsed.sql : [] };
}

/** Parses an ORM-mode count cell marker (`Model._base_manager.count()`) into a row count. */
export function parseOrmCountResponse(buffer: string): BackendModelCount {
  const parsed = parseLine<{ ok?: boolean; result?: string; sql?: BackendSqlEntry[]; stderr?: string; stdout?: string; traceback?: string }>(buffer);
  const raw = (typeof parsed.result === "string" ? parsed.result : parsed.stdout || "").trim();
  const count = Number.parseInt(raw, 10);
  if (parsed.ok === false || !Number.isFinite(count)) {
    return { count: null, error: ormError(parsed, "Count failed."), ok: false, orm: "", sql: [] };
  }
  return { count, ok: true, orm: "", sql: Array.isArray(parsed.sql) ? parsed.sql : [] };
}

/** Parses a backend aggregate response (socket / `_djs_rpc` transport) into a read-only grid. */
export function parseModelAggregateResponse(buffer: string): BackendModelAggregate {
  const parsed = parseLine<Partial<BackendModelAggregate>>(buffer);
  return {
    columns: Array.isArray(parsed.columns) ? parsed.columns : [],
    error: parsed.error,
    groupBy: Array.isArray(parsed.groupBy) ? parsed.groupBy : [],
    hasMore: Boolean(parsed.hasMore),
    ok: Boolean(parsed.ok),
    orm: typeof parsed.orm === "string" ? parsed.orm : "",
    pythonScan: Boolean(parsed.pythonScan),
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    sql: Array.isArray(parsed.sql) ? parsed.sql : []
  };
}

/** Parses an ORM/Terminal-mode aggregate cell marker into a read-only grid from the capture hook's `grid`. */
export function parseOrmAggregateResponse(buffer: string, limit: number): BackendModelAggregate {
  const parsed = parseLine<{ grid?: Partial<BackendModelAggregate>; sql?: BackendSqlEntry[]; stderr?: string; traceback?: string }>(buffer);
  const grid = parsed.grid;
  if (!grid || !Array.isArray(grid.columns)) {
    return { columns: [], error: ormError(parsed, "Aggregation could not be tabulated in ORM mode; switch the Link selector to Socket/Auto."), groupBy: [], hasMore: false, ok: false, orm: "", rows: [], sql: [] };
  }
  if (!grid.columns.length) {
    // A degenerate empty aggregate (no usable group-by/aggregate) tabulates to zero columns — mirror the socket error.
    return { columns: [], error: "Add at least one aggregate, or a group-by field.", groupBy: [], hasMore: false, ok: false, orm: "", rows: [], sql: [] };
  }
  const all = Array.isArray(grid.rows) ? grid.rows : [];
  return { columns: grid.columns, groupBy: Array.isArray(grid.groupBy) ? grid.groupBy : [], hasMore: all.length > limit, ok: true, orm: "", rows: all.slice(0, limit), sql: Array.isArray(parsed.sql) ? parsed.sql : [] };
}

/** Parses an ORM-mode related cell marker into related rows from the capture hook's `grid`. */
export function parseOrmRelatedResponse(buffer: string, limit: number, single: boolean): BackendModelRelatedRows {
  const parsed = parseLine<{ grid?: { app?: string; columns?: BackendModelColumn[]; model?: string; pk?: string; rows?: BackendModelRow[] }; sql?: BackendSqlEntry[]; stderr?: string; traceback?: string }>(buffer);
  const grid = parsed.grid;
  if (!grid || !Array.isArray(grid.columns)) {
    return { columns: [], error: ormError(parsed, "No related rows."), hasMore: false, ok: false, orm: "", rows: [], single, sql: [] };
  }
  const all = Array.isArray(grid.rows) ? grid.rows : [];
  return { app: grid.app, columns: grid.columns, hasMore: all.length > limit, model: grid.model, ok: true, orm: "", pk: grid.pk, rows: all.slice(0, limit), single, sql: Array.isArray(parsed.sql) ? parsed.sql : [] };
}

/** Parses an ORM-mode commit cell marker (atomic save block): ok unless the cell raised. */
export function parseOrmCommitResponse(buffer: string, saved: number): BackendCommitResult {
  const parsed = parseLine<{ ok?: boolean; sql?: BackendSqlEntry[]; stderr?: string; traceback?: string }>(buffer);
  if (parsed.ok === false || (parsed.traceback && parsed.traceback.trim())) {
    return { error: ormError(parsed, "Commit failed."), ok: false, orm: "", results: [], saved: 0, sql: [] };
  }
  return { ok: true, orm: "", results: [], saved, sql: Array.isArray(parsed.sql) ? parsed.sql : [] };
}

/** Parses a backend related-rows response. */
export function parseModelRelatedResponse(buffer: string): BackendModelRelatedRows {
  const parsed = parseLine<Partial<BackendModelRelatedRows>>(buffer);
  return {
    columns: Array.isArray(parsed.columns) ? parsed.columns : [],
    error: parsed.error,
    hasMore: Boolean(parsed.hasMore),
    ok: Boolean(parsed.ok),
    orm: typeof parsed.orm === "string" ? parsed.orm : "",
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    single: Boolean(parsed.single),
    sql: Array.isArray(parsed.sql) ? parsed.sql : []
  };
}

/** Parses a backend row count response. */
export function parseModelCountResponse(buffer: string): BackendModelCount {
  const parsed = parseLine<Partial<BackendModelCount>>(buffer);
  return { count: typeof parsed.count === "number" ? parsed.count : null, error: parsed.error, ok: Boolean(parsed.ok), orm: typeof parsed.orm === "string" ? parsed.orm : "", sql: Array.isArray(parsed.sql) ? parsed.sql : [] };
}

/** Parses a backend staged-edit commit response. */
export function parseModelCommitResponse(buffer: string): BackendCommitResult {
  const parsed = parseLine<Partial<BackendCommitResult>>(buffer);
  return {
    error: parsed.error,
    ok: Boolean(parsed.ok),
    orm: typeof parsed.orm === "string" ? parsed.orm : "",
    results: Array.isArray(parsed.results) ? parsed.results : [],
    saved: typeof parsed.saved === "number" ? parsed.saved : 0,
    sql: Array.isArray(parsed.sql) ? parsed.sql : []
  };
}

/** Parses a backend custom ORM query response. */
export function parseModelQueryResponse(buffer: string): BackendModelQuery {
  const parsed = parseLine<Partial<BackendModelQuery>>(buffer);
  return {
    app: parsed.app,
    columns: Array.isArray(parsed.columns) ? parsed.columns : [],
    editable: Boolean(parsed.editable),
    error: parsed.error,
    hasMore: Boolean(parsed.hasMore),
    model: parsed.model,
    ok: Boolean(parsed.ok),
    orm: typeof parsed.orm === "string" ? parsed.orm : "",
    pk: parsed.pk,
    relations: Array.isArray(parsed.relations) ? parsed.relations : [],
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    sql: Array.isArray(parsed.sql) ? parsed.sql : [],
    stderr: typeof parsed.stderr === "string" ? parsed.stderr : undefined,
    stdout: typeof parsed.stdout === "string" ? parsed.stdout : undefined
  };
}

/** Parses an ORM/Terminal-mode query literal-cell marker into a tabulated page from the capture hook's `grid`, windowed client-side to the requested offset/limit (no `_djs_rpc`: the user's ORM was typed as the cell). */
export function parseOrmQueryResponse(buffer: string, limit: number, offset: number): BackendModelQuery {
  const parsed = parseLine<{ grid?: Partial<BackendModelQuery> & { relations?: BackendModelRelation[] }; sql?: BackendSqlEntry[]; stderr?: string; stdout?: string; traceback?: string }>(buffer);
  const grid = parsed.grid;
  if (!grid || !Array.isArray(grid.columns)) {
    return { columns: [], editable: false, error: ormError(parsed, "The last line must be an expression to tabulate (for example a QuerySet)."), hasMore: false, ok: false, orm: "", relations: [], rows: [], sql: [], stderr: parsed.stderr, stdout: parsed.stdout };
  }
  const all = Array.isArray(grid.rows) ? grid.rows : [];
  return {
    app: grid.app,
    columns: grid.columns,
    editable: Boolean(grid.editable),
    hasMore: all.length > offset + limit,
    model: grid.model,
    ok: true,
    orm: "",
    pk: grid.pk,
    relations: Array.isArray(grid.relations) ? grid.relations : [],
    rows: all.slice(offset, offset + limit),
    sql: Array.isArray(parsed.sql) ? parsed.sql : [],
    stderr: parsed.stderr,
    stdout: parsed.stdout
  };
}

/** Parses a backend foreign-key lookup response. */
export function parseModelLookupResponse(buffer: string): BackendModelLookup {
  const parsed = parseLine<Partial<BackendModelLookup>>(buffer);
  return { error: parsed.error, hasMore: Boolean(parsed.hasMore), ok: Boolean(parsed.ok), rows: Array.isArray(parsed.rows) ? parsed.rows : [], sql: Array.isArray(parsed.sql) ? parsed.sql : [] };
}

/** Parses a socket computed-field response ({pk: cell} values for one @property). */
export function parseModelComputedResponse(buffer: string): BackendModelComputed {
  const parsed = parseLine<Partial<BackendModelComputed>>(buffer);
  return { error: parsed.error, field: parsed.field, ok: Boolean(parsed.ok), queryCount: parsed.queryCount, rowCount: parsed.rowCount, values: parsed.values && typeof parsed.values === "object" ? parsed.values : {} };
}

/** Parses an ORM-mode computed-field response from grid rows returned by a visible ORM expression. */
export function parseOrmComputedResponse(buffer: string): BackendModelComputed {
  const parsed = parseLine<{ grid?: { rows?: BackendModelRow[] }; ok?: boolean; stderr?: string; traceback?: string }>(buffer);
  const rows = parsed.grid?.rows;
  if (parsed.ok === false || !Array.isArray(rows)) {
    return { error: ormError(parsed, "Computed field failed in ORM mode."), ok: false, values: {} };
  }
  const values: Record<string, BackendModelCell> = {};
  for (const row of rows) {
    const key = cellKey(row.pk);
    if (key !== undefined) { values[key] = row.value ?? row.__djs ?? null; }
  }
  return { ok: true, values };
}

/** Returns a compact FK picker label from a values() row. */
function lookupRowLabel(row: BackendModelRow): string {
  const values = Object.entries(row).filter(([key]) => key !== "pk").map(([, value]) => cellText(value)).filter(Boolean);
  return values.length ? values.join(" · ") : String(row.pk ?? "");
}

/** Returns a stable string key for a serialized primary key cell. */
function cellKey(value: BackendModelCell | undefined): string | undefined {
  if (value === undefined || value === null) { return undefined; }
  return typeof value === "object" ? value.v : String(value);
}

/** Formats one serialized cell for compact UI labels. */
function cellText(value: BackendModelCell | undefined): string {
  if (value === undefined || value === null) { return ""; }
  if (typeof value === "object") { return value.v ?? ""; }
  return String(value);
}

/** Returns a disabled response for a model-browser kind that cannot cross PTY fallback. */
export function modelUnsupportedFallback(kind: string, error: string): string | undefined {
  if (kind === "models") {
    return `${JSON.stringify({ error, models: [], ok: false })}\n`;
  }
  if (kind === "schema") {
    return `${JSON.stringify({ columns: [], error, ok: false, relations: [] })}\n`;
  }
  if (kind === "filterfields") {
    return `${JSON.stringify({ error, fields: [], ok: false, relations: [] })}\n`;
  }
  if (kind === "rows" || kind === "related") {
    return `${JSON.stringify({ columns: [], error, ok: false, rows: [] })}\n`;
  }
  if (kind === "computed") {
    return `${JSON.stringify({ error, ok: false, values: {} })}\n`;
  }
  if (kind === "lookup") {
    return `${JSON.stringify({ error, ok: false, rows: [] })}\n`;
  }
  if (kind === "query") {
    return `${JSON.stringify({ columns: [], editable: false, error, hasMore: false, ok: false, orm: "", relations: [], rows: [], sql: [] })}\n`;
  }
  if (kind === "count") {
    return `${JSON.stringify({ count: null, error, ok: false })}\n`;
  }
  if (kind === "aggregate") {
    return `${JSON.stringify({ columns: [], error, ok: false, rows: [] })}\n`;
  }
  if (kind === "commit") {
    return `${JSON.stringify({ error, ok: false, results: [], saved: 0 })}\n`;
  }
  return undefined;
}

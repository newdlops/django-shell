// Types and response parsers for the additive Django model data-browser backend kinds.

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
  single: boolean;
  target: string;
}

/** One concrete column descriptor for a model. */
export interface BackendModelColumn {
  attname: string;
  choices?: Array<[unknown, string]>;
  editable: boolean;
  name: string;
  null: boolean;
  pk: boolean;
  relation?: BackendModelColumnRelation;
  type: string;
}

/** One expandable relation (reverse FK, M2M, reverse O2O) for a model. */
export interface BackendModelRelation {
  kind: string;
  name: string;
  single: boolean;
  target: string;
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
  rows: BackendModelRow[];
  sql: BackendSqlEntry[];
}

/** Related rows fetched lazily for one source row. */
export interface BackendModelRelatedRows {
  columns: BackendModelColumn[];
  error?: string;
  hasMore: boolean;
  ok: boolean;
  orm: string;
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

/** On-demand row count for the current filter set. */
export interface BackendModelCount {
  count: number | null;
  error?: string;
  ok: boolean;
  orm: string;
  sql: BackendSqlEntry[];
}

/** Parameters for one model rows page request. */
export interface ModelRowsQuery {
  app: string;
  cursor?: unknown;
  filters?: BackendModelFilter[];
  limit?: number;
  model: string;
  offset?: number;
  order?: BackendModelOrder[];
}

/** Parameters for one row count request. */
export interface ModelCountQuery {
  app: string;
  filters?: BackendModelFilter[];
  model: string;
}

/** Parameters for one related-rows expansion request. */
export interface ModelRelatedQuery {
  app: string;
  limit?: number;
  model: string;
  pk: unknown;
  relation: string;
  value?: unknown;
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

/** Returns a disabled response for a model-browser kind that cannot cross PTY fallback. */
export function modelUnsupportedFallback(kind: string, error: string): string | undefined {
  if (kind === "models") {
    return `${JSON.stringify({ error, models: [], ok: false })}\n`;
  }
  if (kind === "schema") {
    return `${JSON.stringify({ columns: [], error, ok: false, relations: [] })}\n`;
  }
  if (kind === "rows" || kind === "related") {
    return `${JSON.stringify({ columns: [], error, ok: false, rows: [] })}\n`;
  }
  if (kind === "count") {
    return `${JSON.stringify({ count: null, error, ok: false })}\n`;
  }
  return undefined;
}

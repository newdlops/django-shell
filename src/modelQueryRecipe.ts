// Versioned, transport-neutral model query recipe types and immutable factories.

/** The only supported version of the model query recipe contract. */
export const MODEL_QUERY_RECIPE_VERSION = 2 as const;

/** JSON-safe scalar accepted by the query recipe. */
export type QueryScalar = string | number | boolean | null;
/** Boolean join used by predicate groups. */
export type QueryJoin = "and" | "or";
/** Result type requested or inferred for a computed value. */
export type QueryOutputType = "auto" | "boolean" | "integer" | "float" | "decimal" | "text" | "date" | "datetime" | "time" | "duration" | "uuid";

/** Identifies one installed Django model without relying on a Python class name. */
export interface QueryModelRef { app: string; model: string; }
/** Refers to a concrete, relation-traversed, or property field path. */
export interface QueryFieldRef { kind: "field"; path: string; }
/** Refers to a previously declared enabled computed column. */
export interface QueryComputedRef { alias: string; kind: "computed"; }
/** Refers to either a field path or computed alias. */
export type QueryValueRef = QueryFieldRef | QueryComputedRef;

/** A scalar RHS value. */
export interface QueryLiteralRhs { kind: "literal"; value: QueryScalar; }
/** A list RHS value, used by `in`. */
export interface QueryListRhs { kind: "list"; values: QueryScalar[]; }
/** A bounded pair RHS value, used by `range`. */
export interface QueryRangeRhs { kind: "range"; lower: QueryScalar; upper: QueryScalar; }
/** A same-query field RHS value, compiled as Django F(). */
export interface QueryFieldRhs { kind: "field"; path: string; }
/** An outer-query field RHS value, valid only inside a subquery. */
export interface QueryOuterFieldRhs { kind: "outerField"; path: string; }
/** A relative Django timezone-aware time RHS value. */
export interface QueryRelativeTimeRhs { amount: number; anchor: "now" | "today"; direction: "past" | "future"; kind: "relativeTime"; unit: "minutes" | "hours" | "days" | "weeks"; }
/** Every supported comparison RHS representation. */
export type QueryComparisonRhs = QueryLiteralRhs | QueryListRhs | QueryRangeRhs | QueryFieldRhs | QueryOuterFieldRhs | QueryRelativeTimeRhs;

/** A nested Boolean group of predicate nodes. */
export interface QueryPredicateGroup { children: QueryPredicateNode[]; join: QueryJoin; kind: "group"; negated: boolean; nodeId: string; }
/** A lookup comparison between a value reference and RHS. */
export interface QueryComparisonNode { kind: "comparison"; lhs: QueryValueRef; lookup: string; negated: boolean; nodeId: string; rhs: QueryComparisonRhs; }
/** Correlates an inner subquery path to an outer query path. */
export interface QueryCorrelation { nodeId: string; outerPath: string; targetPath: string; }
/** Describes either a relation-derived or explicitly selected subquery source. */
export type QuerySubquerySource = { kind: "relation"; relation: string } | { kind: "model"; target: QueryModelRef };
/** A correlated EXISTS predicate. */
export interface QueryExistsPredicateNode { correlations: QueryCorrelation[]; kind: "existsPredicate"; negated: boolean; nodeId: string; source: QuerySubquerySource; where: QueryPredicateGroup; }
/** Every supported predicate tree node. */
export type QueryPredicateNode = QueryPredicateGroup | QueryComparisonNode | QueryExistsPredicateNode;

/** Shared identity and enablement state for a computed column. */
export interface QueryComputedBase { alias: string; enabled: boolean; nodeId: string; }
/** An aggregate annotation column. */
export interface QueryAggregateColumn extends QueryComputedBase { distinct: "auto" | "always"; field: QueryFieldRef | { kind: "all" }; filter: QueryPredicateGroup; function: "count" | "sum" | "avg" | "min" | "max"; kind: "aggregate"; }
/** A scalar field selected by a scalar subquery. */
export interface QuerySubqueryFieldSelect { field: QueryFieldRef; kind: "field"; }
/** An aggregate selected by a scalar subquery. */
export interface QuerySubqueryAggregateSelect { distinct: "auto" | "always"; field: QueryFieldRef | { kind: "all" }; function: "count" | "sum" | "avg" | "min" | "max"; kind: "aggregate"; }
/** Select form for a scalar subquery. */
export type QuerySubquerySelect = QuerySubqueryFieldSelect | QuerySubqueryAggregateSelect;
/** A field or computed reference used to sort a query. */
export interface QueryOrderTerm { direction: "asc" | "desc"; nodeId: string; ref: QueryValueRef; }
/** A correlated scalar subquery annotation column. */
export interface QueryScalarSubqueryColumn extends QueryComputedBase { correlations: QueryCorrelation[]; kind: "scalarSubquery"; onEmpty: QueryLiteralRhs; orderBy: QueryOrderTerm[]; outputType: QueryOutputType; select: QuerySubquerySelect; source: QuerySubquerySource; where: QueryPredicateGroup; }
/** A correlated EXISTS annotation column. */
export interface QueryExistsColumn extends QueryComputedBase { correlations: QueryCorrelation[]; kind: "exists"; source: QuerySubquerySource; where: QueryPredicateGroup; }
/** An expression tree used by Formula annotations. */
export type QueryFormulaNode =
  | { kind: "field"; path: string }
  | { alias: string; kind: "computed" }
  | { kind: "literal"; value: QueryScalar }
  | { kind: "binary"; left: QueryFormulaNode; operator: "+" | "-" | "*" | "/" | "%"; right: QueryFormulaNode }
  | { args: QueryFormulaNode[]; function: "coalesce" | "concat" | "greatest" | "least" | "lower" | "upper" | "trim" | "length"; kind: "function" }
  | { branches: Array<{ then: QueryFormulaNode; when: QueryPredicateGroup }>; else: QueryFormulaNode; kind: "case" }
  | { expression: QueryFormulaNode; kind: "cast"; outputType: Exclude<QueryOutputType, "auto"> };
/** A Django expression formula annotation. */
export interface QueryFormulaColumn extends QueryComputedBase { expression: QueryFormulaNode; kind: "formula"; outputType: QueryOutputType; }
/** A window annotation column. */
export interface QueryWindowColumn extends QueryComputedBase { field?: QueryFieldRef; function: "rank" | "dense_rank" | "row_number" | "sum" | "avg" | "min" | "max" | "count"; kind: "window"; orderBy: QueryOrderTerm[]; partitionBy: QueryFieldRef[]; }
/** An explicitly entered, restricted Django expression annotation. */
export interface QueryCodeExpressionColumn extends QueryComputedBase { expression: string; kind: "codeExpression"; outputType: QueryOutputType; when: QueryPredicateGroup; }
/** Every supported computed column. */
export type QueryComputedColumn = QueryAggregateColumn | QueryScalarSubqueryColumn | QueryExistsColumn | QueryFormulaColumn | QueryWindowColumn | QueryCodeExpressionColumn;

/** Complete version-two model query state. */
export interface ModelQueryRecipeV2 { computed: QueryComputedColumn[]; groupBy: QueryFieldRef[]; mode: "rows" | "summary"; orderBy: QueryOrderTerm[]; postFilter: QueryPredicateGroup; source: QueryModelRef; version: typeof MODEL_QUERY_RECIPE_VERSION; where: QueryPredicateGroup; }

/** Creates the canonical empty recipe for one exact source model. */
export function createEmptyModelQueryRecipe(source: QueryModelRef): ModelQueryRecipeV2 {
  return { version: MODEL_QUERY_RECIPE_VERSION, source: { app: source.app, model: source.model }, mode: "rows", where: emptyRoot("where-root"), computed: [], postFilter: emptyRoot("post-root"), groupBy: [], orderBy: [] };
}

/** Returns the canonical empty predicate root with a fixed root identifier. */
function emptyRoot(nodeId: "where-root" | "post-root"): QueryPredicateGroup {
  return { kind: "group", nodeId, join: "and", negated: false, children: [] };
}

/** Clones a JSON-compatible recipe without retaining nested object references. */
export function cloneModelQueryRecipe(recipe: ModelQueryRecipeV2): ModelQueryRecipeV2 {
  return JSON.parse(JSON.stringify(recipe)) as ModelQueryRecipeV2;
}

/** Checks only the outer recipe shape; semantic checks belong to the validator. */
export function isModelQueryRecipeV2(value: unknown): value is ModelQueryRecipeV2 {
  if (!isRecord(value) || value.version !== MODEL_QUERY_RECIPE_VERSION || !isRecord(value.source)) { return false; }
  return typeof value.source.app === "string" && typeof value.source.model === "string" && (value.mode === "rows" || value.mode === "summary") && Array.isArray(value.computed) && Array.isArray(value.groupBy) && Array.isArray(value.orderBy) && isRecord(value.where) && isRecord(value.postFilter);
}

/** Narrows unknown values to object records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

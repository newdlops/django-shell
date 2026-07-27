// Builds validated Recipe v2 rows, summary, and count ORM cells with readable previews.

import type { BackendModelColumn, BackendModelRelation } from "./modelBackend";
import type { BackendTransport } from "./backendClient";
import type { ModelQueryRecipeV2, QueryModelRef, QueryOrderTerm } from "./modelQueryRecipe";
import type { ModelQueryMetadataIndex } from "./modelQueryRecipeMetadata";
import { compileModelQueryComputed } from "./modelQueryComputedOrm";
import { compileModelQueryPredicate, modelQueryOrmLiteral, modelQueryOrmModelExpression, modelQueryOrmString } from "./modelQueryPredicateOrm";
import { validateModelQueryRecipe, type ModelQueryIssue, type ModelQueryValidation } from "./modelQueryRecipeValidation";
import { MODEL_QUERY_RECIPE_LIMITS } from "./modelQueryRecipeLimits";

/** Metadata and pagination available to a Recipe v2 ORM reconstruction. */
export interface ModelQueryOrmCompileContext {
  columns: BackendModelColumn[];
  cursor?: unknown;
  limit: number;
  metadata: ModelQueryMetadataIndex;
  offset?: number;
  relations: BackendModelRelation[];
  source: QueryModelRef;
  transport: BackendTransport | "orm";
}

/** One executable ORM cell and its parallel validation result. */
export interface ModelQueryOrmCompileResult {
  cell: string;
  preview: string;
  validation: ModelQueryValidation;
}

/** Compiles a bounded rows cell, including all enabled annotations and post-annotation filtering. */
export function buildRecipeRowsOrm(recipe: ModelQueryRecipeV2, context: ModelQueryOrmCompileContext): ModelQueryOrmCompileResult {
  return build(recipe, context, "rows");
}

/** Compiles a grouped or global summary cell. */
export function buildRecipeSummaryOrm(recipe: ModelQueryRecipeV2, context: ModelQueryOrmCompileContext): ModelQueryOrmCompileResult {
  return build(recipe, context, "summary");
}

/** Compiles a count cell from the complete Recipe instead of only legacy WHERE filters. */
export function buildRecipeCountOrm(recipe: ModelQueryRecipeV2, context: ModelQueryOrmCompileContext): ModelQueryOrmCompileResult {
  return build(recipe, context, "count");
}

/** Produces one v2 execution expression after the authoritative TypeScript validator succeeds. */
function build(recipe: ModelQueryRecipeV2, context: ModelQueryOrmCompileContext, intent: "rows" | "summary" | "count"): ModelQueryOrmCompileResult {
  const validation = validateModelQueryRecipe(recipe, { columns: context.columns, metadata: context.metadata, source: context.source, transport: context.transport });
  if (!validation.ok || !validation.normalized) { return { cell: "", preview: "", validation }; }
  const normalized = validation.normalized;
  const where = compileModelQueryPredicate(normalized.where, normalized.source, { metadata: context.metadata, source: normalized.source });
  const computed = compileModelQueryComputed(normalized.computed, { metadata: context.metadata, source: normalized.source });
  const annotations = computed.length ? `.annotate(${computed.map((spec) => `${spec.alias}=${spec.expression}`).join(", ")})` : "";
  const post = compileModelQueryPredicate(normalized.postFilter, normalized.source, { metadata: context.metadata, source: normalized.source });
  const sourceBase = `${modelQueryOrmModelExpression(normalized.source)}._base_manager.filter(${where.expression})${where.toMany ? ".distinct()" : ""}`;
  const rowsBase = `${sourceBase}${annotations}${normalized.postFilter.children.length ? `.filter(${post.expression})` : ""}`;
  const cell = intent === "summary" ? summaryCell(normalized, sourceBase, context) : intent === "count" ? countCell(normalized, normalized.mode === "summary" ? sourceBase : rowsBase, context) : rowsCell(normalized, rowsBase, context);
  if (cell.length > MODEL_QUERY_RECIPE_LIMITS.generatedOrmCellCharacters) {
    return { cell: "", preview: "", validation: withGeneratedLimit(validation) };
  }
  return { cell, preview: prettyPreview(cell), validation: { ...validation, ormPreview: prettyPreview(cell) } };
}

/** Builds a bounded ordered page with one additional row for has-more detection. */
function rowsCell(recipe: ModelQueryRecipeV2, base: string, context: ModelQueryOrmCompileContext): string {
  const offset = Number.isInteger(context.offset) && (context.offset ?? 0) > 0 ? context.offset ?? 0 : 0;
  const limit = Number.isInteger(context.limit) && context.limit > 0 ? context.limit : 50;
  const keyset = recipe.orderBy.length === 0 && !recipe.computed.some((item) => item.enabled);
  const cursor = keyset && context.cursor !== undefined && context.cursor !== null ? `.filter(pk__gt=${modelQueryOrmLiteral(context.cursor)})` : "";
  const sliceStart = keyset ? 0 : offset;
  return `${base}${cursor}.order_by(${orderArguments(recipe.orderBy, "pk")})[${sliceStart}:${sliceStart + limit + 1}]`;
}

/** Builds grouped summary querysets or a single global aggregate mapping row. */
function summaryCell(recipe: ModelQueryRecipeV2, base: string, context: ModelQueryOrmCompileContext): string {
  const aggregates = recipe.computed.filter((item) => item.enabled && item.kind === "aggregate");
  const specs = compileModelQueryComputed(aggregates, { metadata: context.metadata, source: recipe.source });
  if (!recipe.groupBy.length) { return `[${base}.aggregate(${specs.map((spec) => `${spec.alias}=${spec.expression}`).join(", ")})]`; }
  const group = recipe.groupBy.map((field) => modelQueryOrmString(field.path)).join(", ");
  const limit = Number.isInteger(context.limit) && context.limit > 0 ? context.limit : 1000;
  return `${base}.values(${group}).annotate(${specs.map((spec) => `${spec.alias}=${spec.expression}`).join(", ")})${recipe.postFilter.children.length ? `.filter(${compileModelQueryPredicate(recipe.postFilter, recipe.source, { metadata: context.metadata, source: recipe.source }).expression})` : ""}.order_by(${orderArguments(recipe.orderBy, recipe.groupBy.map((field) => field.path).join(", ") || "pk")})[0:${limit + 1}]`;
}

/** Builds the count aligned with rows or grouped summary semantics. */
function countCell(recipe: ModelQueryRecipeV2, base: string, context: ModelQueryOrmCompileContext): string {
  if (recipe.mode === "summary" && recipe.groupBy.length) {
    const group = recipe.groupBy.map((field) => modelQueryOrmString(field.path)).join(", ");
    const specs = compileModelQueryComputed(recipe.computed.filter((item) => item.enabled && item.kind === "aggregate"), { metadata: context.metadata, source: recipe.source });
    return `${base}.values(${group}).annotate(${specs.map((spec) => `${spec.alias}=${spec.expression}`).join(", ")}).count()`;
  }
  return `${base}.count()`;
}

/** Emits safe ordering terms, defaulting to a stable concrete identifier. */
function orderArguments(terms: QueryOrderTerm[], fallback: string): string {
  if (!terms.length) { return modelQueryOrmString(fallback.split(",")[0] || "pk"); }
  return terms.map((term) => modelQueryOrmString(`${term.direction === "desc" ? "-" : ""}${term.ref.kind === "field" ? term.ref.path : term.ref.alias}`)).join(", ");
}

/** Adds the fixed generated-cell issue without mutating the validator's result. */
function withGeneratedLimit(validation: ModelQueryValidation): ModelQueryValidation {
  const issue: ModelQueryIssue = { code: "GENERATED_QUERY_TOO_LARGE", fix: "Shorten the query before applying it.", message: "generated query too large", path: "", severity: "error" };
  return { ...validation, humanSummary: "1 query error", issues: [...validation.issues, issue], ok: false, warnings: validation.warnings };
}

/** Formats a compact one-line cell into a readable non-executable preview. */
function prettyPreview(cell: string): string {
  return cell.replace(/\)\./g, ")\n  .").replace(/\.annotate\(/g, "\n  .annotate(").replace(/\.filter\(/g, "\n  .filter(");
}

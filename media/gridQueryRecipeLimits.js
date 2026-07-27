// Webview copy of ModelQueryRecipeV2 limits and immutable allowlists.

/** Exact query recipe size and structural limits shared with the TypeScript validator. */
export const MODEL_QUERY_RECIPE_LIMITS = Object.freeze({ recipeBytes: 64 * 1024, predicateNodes: 64, predicateGroupDepth: 5, predicateGroupChildren: 16, computedColumns: 12, groupByFields: 8, outerOrderTerms: 8, subqueryCorrelations: 4, subqueryOrderTerms: 3, formulaNodes: 32, formulaDepth: 6, caseBranches: 8, inValues: 200, pathCharacters: 240, pathSegments: 12, aliasCharacters: 64, literalStringCharacters: 4096, rawCodeExpressionCharacters: 800, generatedOrmCellCharacters: 32768 });
/** All supported Django lookup names in stable UI and validation order. */
export const MODEL_QUERY_LOOKUPS = Object.freeze(["exact", "in", "isnull", "gt", "gte", "lt", "lte", "range", "iexact", "contains", "icontains", "startswith", "istartswith", "endswith", "iendswith", "blank", "not_blank", "trim", "length", "length__gt", "length__gte", "length__lt", "length__lte", "date", "year", "quarter", "month", "week_day", "day", "hour", "minute", "second"]);
/** Aggregate functions allowed by the recipe. */
export const MODEL_QUERY_AGGREGATE_FUNCTIONS = Object.freeze(["count", "sum", "avg", "min", "max"]);
/** Formula functions allowed by the recipe. */
export const MODEL_QUERY_FORMULA_FUNCTIONS = Object.freeze(["coalesce", "concat", "greatest", "least", "lower", "upper", "trim", "length"]);
/** Window functions allowed by the recipe. */
export const MODEL_QUERY_WINDOW_FUNCTIONS = Object.freeze(["rank", "dense_rank", "row_number", "sum", "avg", "min", "max", "count"]);
/** Output types allowed by the recipe. */
export const MODEL_QUERY_OUTPUT_TYPES = Object.freeze(["auto", "boolean", "integer", "float", "decimal", "text", "date", "datetime", "time", "duration", "uuid"]);

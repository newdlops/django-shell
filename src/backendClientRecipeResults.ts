// Safe Recipe v2 response shaping for the backend client's in-process ORM branches.

import type { BackendModelAggregate, BackendModelCount, BackendModelRows } from "./modelBackend";
import type { ModelQueryRecipeV2 } from "./modelQueryRecipe";
import type { ModelQueryValidation } from "./modelQueryRecipeValidation";

type RecipeResponse = BackendModelAggregate | BackendModelCount | BackendModelRows;

/** Builds a non-executing rows response when Recipe validation rejects an ORM cell. */
export function recipeRowsValidationFailure(recipe: ModelQueryRecipeV2, validation: ModelQueryValidation): BackendModelRows {
  return { columns: [], error: recipeError(validation), hasMore: false, issues: validation.issues, nextOffset: null, ok: false, orm: "", recipeVersion: recipe.version, rows: [], sql: [] };
}

/** Builds a non-executing aggregate response when Recipe validation rejects an ORM cell. */
export function recipeAggregateValidationFailure(recipe: ModelQueryRecipeV2, validation: ModelQueryValidation): BackendModelAggregate {
  return { columns: [], error: recipeError(validation), groupBy: [], hasMore: false, issues: validation.issues, ok: false, orm: "", recipeVersion: recipe.version, rows: [], sql: [] };
}

/** Builds a non-executing count response when Recipe validation rejects an ORM cell. */
export function recipeCountValidationFailure(recipe: ModelQueryRecipeV2, validation: ModelQueryValidation): BackendModelCount {
  return { count: null, error: recipeError(validation), issues: validation.issues, ok: false, orm: "", recipeVersion: recipe.version, sql: [] };
}

/** Adds Recipe v2 provenance and validation warnings to one successful ORM response. */
export function withRecipeResult<T extends RecipeResponse>(result: T, recipe: ModelQueryRecipeV2, validation: ModelQueryValidation): T {
  return { ...result, issues: validation.issues.length ? validation.issues : undefined, recipeVersion: recipe.version } as T;
}

/** Chooses the first actionable validation message without exposing an empty response. */
function recipeError(validation: ModelQueryValidation): string {
  return validation.issues.find((issue) => issue.severity === "error")?.message ?? "Query recipe could not be compiled.";
}

// Canonical Recipe v2 construction for model-browser foreign-key drill-in targets.

import { createEmptyModelQueryRecipe, type ModelQueryRecipeV2, type QueryModelRef, type QueryScalar } from "./modelQueryRecipe";

/** Creates an exact target-key Recipe filter for a primary-key or alternate-field relation link. */
export function createInitialPkModelQueryRecipe(source: QueryModelRef, initialPk: QueryScalar, field = "pk"): ModelQueryRecipeV2 {
  const recipe = createEmptyModelQueryRecipe(source);
  recipe.where.children.push({ kind: "comparison", lhs: { kind: "field", path: /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? field : "pk" }, lookup: "exact", negated: false, nodeId: "initial-pk", rhs: { kind: "literal", value: initialPk } });
  return recipe;
}

/** Narrows a linked primary-key value to the JSON scalar contract accepted by Recipe v2. */
export function isRecipeInitialPk(value: unknown): value is QueryScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
}

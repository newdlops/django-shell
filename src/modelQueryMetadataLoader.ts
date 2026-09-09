// Loads only the model trees referenced by bounded query paths in their actual query scopes.
import type { BackendFilterFieldTree } from "./modelBackend";
import type { ModelQueryRecipeV2, QueryModelRef } from "./modelQueryRecipe";
import { MODEL_QUERY_RECIPE_LIMITS } from "./modelQueryRecipeLimits";
import type { ModelQueryMetadataIndex } from "./modelQueryRecipeMetadata";

const CHILD_KEYS = ["where", "postFilter", "computed", "groupBy", "orderBy", "ref", "children", "lhs", "rhs", "field", "filter", "select", "expression", "left", "right", "args", "branches", "when", "then", "else", "partitionBy"];

/** Loads reference metadata without recursively expanding unreferenced relations or executing a query. */
export async function loadQueryReferenceTrees(recipe: ModelQueryRecipeV2, index: ModelQueryMetadataIndex, loadTree: (model: QueryModelRef) => Promise<BackendFilterFieldTree>): Promise<void> {
  /** Reuses already loaded trees, including repeated and self-referential path segments. */
  async function ensureTree(model: QueryModelRef): Promise<BackendFilterFieldTree> {
    const existing = index.getTree(model);
    if (existing) { return existing; }
    const tree = await loadTree(model);
    index.addTree(model, tree);
    return tree;
  }

  /** Loads the target at each valid relation hop while keeping storage attributes terminal. */
  async function ensurePath(owner: QueryModelRef, value: unknown): Promise<void> {
    if (typeof value !== "string" || value.length > MODEL_QUERY_RECIPE_LIMITS.pathCharacters) { return; }
    const segments = value.split("__");
    if (segments.length > MODEL_QUERY_RECIPE_LIMITS.pathSegments || !segments.every((segment) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment))) { return; }
    let model = owner;
    for (const segment of segments.slice(0, -1)) {
      const tree = await ensureTree(model);
      if (tree.fields.some((field) => field.attname === segment && field.name !== segment)) { return; }
      const relation = index.resolveRelation(model, segment);
      const target = relation && parseTarget(relation.target);
      if (!target) { return; }
      model = target;
      await ensureTree(model);
    }
  }

  /** Visits structural query nodes, switching scope only at explicit subquery boundaries. */
  async function visit(value: unknown, owner: QueryModelRef, outer: QueryModelRef): Promise<void> {
    if (Array.isArray(value)) { for (const child of value) { await visit(child, owner, outer); } return; }
    if (!record(value)) { return; }
    if (value.kind === "outerField") { await ensurePath(outer, value.path); return; }
    if (value.kind === "field" && typeof value.path === "string") { await ensurePath(owner, value.path); return; }
    if (["literal", "list", "range", "relativeTime", "computed", "all"].includes(String(value.kind))) { return; }
    let model = owner, parent = outer;
    if (record(value.source) && ["existsPredicate", "exists", "scalarSubquery"].includes(String(value.kind))) {
      await ensureTree(owner);
      const source = value.source;
      const relation = source.kind === "relation" && typeof source.relation === "string" ? index.resolveRelation(owner, source.relation) : undefined;
      const target = relation ? parseTarget(relation.target) : source.kind === "model" && modelRef(source.target) ? source.target : undefined;
      if (!target) { return; }
      model = target; parent = owner;
      await ensureTree(model);
      if (Array.isArray(value.correlations)) {
        for (const correlation of value.correlations) {
          if (record(correlation)) { await ensurePath(owner, correlation.outerPath); await ensurePath(model, correlation.targetPath); }
        }
      }
    }
    for (const key of CHILD_KEYS) { await visit(value[key], model, parent); }
  }

  await ensureTree(recipe.source);
  await visit(recipe, recipe.source, recipe.source);
}

/** Parses only an app-qualified relation target supplied by live model metadata. */
function parseTarget(value: string): QueryModelRef | undefined {
  const boundary = value.lastIndexOf(".");
  return boundary > 0 && boundary < value.length - 1 ? { app: value.slice(0, boundary), model: value.slice(boundary + 1) } : undefined;
}

/** Narrows structural JSON nodes without interpreting literal query values as references. */
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Accepts explicit query sources only when both model identifiers are present. */
function modelRef(value: unknown): value is QueryModelRef { return record(value) && typeof value.app === "string" && Boolean(value.app) && typeof value.model === "string" && Boolean(value.model); }

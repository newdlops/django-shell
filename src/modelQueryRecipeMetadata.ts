// Live Django metadata indexing and deterministic field-path resolution for query recipes.

import type { BackendFilterField, BackendFilterFieldTree, BackendFilterRelation, BackendModelColumn } from "./modelBackend";
import { MODEL_QUERY_RECIPE_LIMITS } from "./modelQueryRecipeLimits";
import type { ModelQueryRecipeV2, QueryModelRef } from "./modelQueryRecipe";

/** Resolved metadata for a recipe path. */
export interface QueryResolvedPath { choices?: Array<[unknown, string]>; leafKind: "field" | "property" | "relation"; nullable: boolean; path: string; relationTerminal: boolean; toMany: boolean; type: string; }
/** Serializable snapshot of all trees and root columns used by a recipe. */
export interface ModelQueryMetadataBundle { catalog: QueryModelRef[]; models: Record<string, { columns?: BackendModelColumn[]; tree: BackendFilterFieldTree }>; }
/** One loaded model descriptor that is safe to include in an assistant schema projection. */
export interface QueryAssistantRelatedModel { app: string; columns: Array<Pick<BackendModelColumn, "attname" | "choices" | "label" | "name" | "null" | "pk" | "type">>; model: string; relations: BackendFilterRelation[]; }

/** Holds live model trees without falling back to lexical path guesses. */
export class ModelQueryMetadataIndex {
  private catalog = new Map<string, QueryModelRef>();
  private readonly models = new Map<string, { columns?: BackendModelColumn[]; tree: BackendFilterFieldTree }>();
  private readonly pendingColumns = new Map<string, BackendModelColumn[]>();

  /** Restores the one supported compiler metadata format. */
  static fromBundle(bundle: ModelQueryMetadataBundle): ModelQueryMetadataIndex {
    const index = new ModelQueryMetadataIndex();
    index.setCatalog(bundle.catalog);
    for (const [key, entry] of Object.entries(bundle.models)) {
      const model = parseModelKey(key);
      if (model) { index.models.set(modelKey(model), { tree: entry.tree, columns: entry.columns ? [...entry.columns] : undefined }); }
    }
    return index;
  }

  /** Replaces the installed-model catalog with a deduplicated immutable snapshot. */
  setCatalog(models: QueryModelRef[]): void {
    this.catalog = new Map(models.filter(isModelRef).map((model) => [modelKey(model), Object.freeze({ app: model.app, model: model.model })]));
  }

  /** Stores root column metadata used to identify concrete fields and Python properties. */
  addColumns(model: QueryModelRef, columns: BackendModelColumn[]): void {
    const key = modelKey(model);
    const entry = this.models.get(key);
    if (entry) { entry.columns = [...columns]; } else { this.pendingColumns.set(key, [...columns]); }
  }

  /** Stores a live field tree for a model. */
  addTree(model: QueryModelRef, tree: BackendFilterFieldTree): void {
    const key = modelKey(model);
    const existing = this.models.get(key);
    this.models.set(key, { tree, columns: existing?.columns ?? this.pendingColumns.get(key) });
    this.pendingColumns.delete(key);
  }

  /** Returns the tree fetched for a model, if any. */
  getTree(model: QueryModelRef): BackendFilterFieldTree | undefined { return this.models.get(modelKey(model))?.tree; }

  /** Resolves a path against only known live trees and returns its terminal characteristics. */
  resolvePath(model: QueryModelRef, path: string): QueryResolvedPath | undefined {
    const segments = splitPath(path);
    if (!segments) { return undefined; }
    let current = model;
    let tree = this.getTree(current);
    let toMany = false;
    for (let index = 0; index < segments.length; index += 1) {
      if (!tree) { return undefined; }
      const segment = segments[index];
      const final = index === segments.length - 1;
      const field = tree.fields.find((candidate) => candidate.attname === segment || candidate.name === segment || (segment === "pk" && candidate.pk));
      if (field) {
        if (!final) { return undefined; }
        return resolvedField(path, field, toMany, this.models.get(modelKey(current))?.columns);
      }
      const property = final && current.app === model.app && current.model === model.model ? this.models.get(modelKey(current))?.columns?.find((candidate) => candidate.computed && (candidate.attname === segment || candidate.name === segment)) : undefined;
      if (property) { return { choices: property.choices, leafKind: "property", nullable: property.null, path, relationTerminal: false, toMany, type: property.type }; }
      const currentTree = tree;
      const relation = currentTree.relations.find((candidate) => candidate.name === segment || candidate.queryName === segment || candidate.filterField === segment || (segment === "pk" && currentTree.pk === segment));
      if (!relation) { return undefined; }
      toMany ||= !relation.single;
      if (final) { return { leafKind: "relation", nullable: true, path, relationTerminal: true, toMany, type: relation.kind }; }
      const target = parseModelKey(relation.target);
      if (!target) { return undefined; }
      current = target;
      tree = this.getTree(current);
    }
    return undefined;
  }

  /** Resolves one direct relation from a source model's live tree. */
  resolveRelation(model: QueryModelRef, relation: string): BackendFilterRelation | undefined {
    if (!splitPath(relation) || relation.includes("__")) { return undefined; }
    return this.getTree(model)?.relations.find((candidate) => candidate.name === relation || candidate.queryName === relation || candidate.filterField === relation);
  }

  /** Serializes a detached snapshot suitable for an in-process ORM compiler only. */
  toBundle(): ModelQueryMetadataBundle {
    const models: ModelQueryMetadataBundle["models"] = {};
    for (const [key, entry] of this.models) { models[key] = { tree: entry.tree, columns: entry.columns ? [...entry.columns] : undefined }; }
    return { catalog: [...this.catalog.values()].map((model) => ({ app: model.app, model: model.model })), models };
  }
}

/** Fetches every model tree explicitly referenced by a recipe, once, without relation-cycle recursion. */
export async function loadModelQueryMetadata(recipe: ModelQueryRecipeV2, loadTree: (model: QueryModelRef) => Promise<BackendFilterFieldTree>, modelCatalog: QueryModelRef[], rootColumns: BackendModelColumn[]): Promise<ModelQueryMetadataIndex> {
  const index = new ModelQueryMetadataIndex();
  index.setCatalog(modelCatalog);
  index.addColumns(recipe.source, rootColumns);
  const pending = new Map<string, QueryModelRef>([[modelKey(recipe.source), recipe.source]]);
  for (const model of collectExplicitModels(recipe)) { pending.set(modelKey(model), model); }
  const visited = new Set<string>();
  while (pending.size) {
    const [key, model] = pending.entries().next().value as [string, QueryModelRef];
    pending.delete(key);
    if (visited.has(key)) { continue; }
    visited.add(key);
    index.addTree(model, await loadTree(model));
    for (const relation of collectRelationSources(recipe, model)) {
      const resolved = index.resolveRelation(model, relation);
      const target = resolved && parseModelKey(resolved.target);
      if (target && !visited.has(modelKey(target))) { pending.set(modelKey(target), target); }
    }
  }
  return index;
}

/** Selects only loaded model descriptors actually referenced by the current Recipe. */
export function selectQueryAssistantRelatedModels(recipe: ModelQueryRecipeV2, bundle: ModelQueryMetadataBundle): QueryAssistantRelatedModel[] {
  const wanted = new Map<string, QueryModelRef>([[modelKey(recipe.source), recipe.source]]);
  for (const model of collectExplicitModels(recipe)) { wanted.set(modelKey(model), model); }
  const root = bundle.models[modelKey(recipe.source)];
  if (root) {
    for (const relation of collectRelationSources(recipe, recipe.source)) {
      const resolved = root.tree.relations.find((candidate) => candidate.name === relation || candidate.queryName === relation || candidate.filterField === relation);
      const target = resolved && parseModelKey(resolved.target);
      if (target) { wanted.set(modelKey(target), target); }
    }
  }
  return [...wanted.values()].flatMap((model) => {
    const entry = bundle.models[modelKey(model)];
    return entry ? [{ app: model.app, columns: (entry.columns ?? entry.tree.fields).map(assistantColumn), model: model.model, relations: [...entry.tree.relations] }] : [];
  });
}

/** Projects a loaded column or filter-tree field to the assistant's schema descriptor. */
function assistantColumn(column: BackendModelColumn | BackendFilterField): Pick<BackendModelColumn, "attname" | "choices" | "label" | "name" | "null" | "pk" | "type"> {
  return { attname: column.attname, choices: column.choices, label: column.label, name: column.name, null: column.null, pk: column.pk, type: column.type };
}

/** Returns stable model keys in the format used by metadata bundles. */
export function modelQueryMetadataKey(model: QueryModelRef): string { return modelKey(model); }

/** Converts a model reference into a stable bundle key. */
function modelKey(model: QueryModelRef): string { return `${model.app}.${model.model}`; }

/** Parses a backend `app.Model` target string. */
function parseModelKey(value: string): QueryModelRef | undefined {
  const dot = value.indexOf(".");
  return dot > 0 && dot < value.length - 1 ? { app: value.slice(0, dot), model: value.slice(dot + 1) } : undefined;
}

/** Checks that an unknown value is a usable model reference. */
function isModelRef(value: QueryModelRef): boolean { return Boolean(value && typeof value.app === "string" && value.app && typeof value.model === "string" && value.model); }

/** Validates path bounds before any traversal. */
function splitPath(path: string): string[] | undefined {
  const trimmed = path.trim();
  if (!trimmed || trimmed.length > MODEL_QUERY_RECIPE_LIMITS.pathCharacters) { return undefined; }
  const segments = trimmed.split("__");
  return segments.length <= MODEL_QUERY_RECIPE_LIMITS.pathSegments && segments.every((segment) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) ? segments : undefined;
}

/** Builds field metadata, recognizing source-root computed properties from column metadata. */
function resolvedField(path: string, field: BackendFilterField, toMany: boolean, columns: BackendModelColumn[] | undefined): QueryResolvedPath {
  const column = columns?.find((candidate) => candidate.attname === field.attname || candidate.name === field.name);
  return { choices: field.choices, leafKind: column?.computed ? "property" : "field", nullable: field.null, path, relationTerminal: false, toMany, type: field.type };
}

/** Collects all model sources that do not depend on a relation resolver. */
function collectExplicitModels(recipe: ModelQueryRecipeV2): QueryModelRef[] {
  const models: QueryModelRef[] = [];
  walkRecipe(recipe, (source) => { if (source.kind === "model") { models.push(source.target); } });
  return models;
}

/** Collects relation sources whose owner is one known model. */
function collectRelationSources(recipe: ModelQueryRecipeV2, owner: QueryModelRef): string[] {
  const relations: string[] = [];
  if (owner.app !== recipe.source.app || owner.model !== recipe.source.model) { return relations; }
  walkRecipe(recipe, (source) => { if (source.kind === "relation") { relations.push(source.relation); } });
  return relations;
}

/** Walks every recipe-level subquery source exactly once in source order. */
function walkRecipe(recipe: ModelQueryRecipeV2, visit: (source: { kind: "relation"; relation: string } | { kind: "model"; target: QueryModelRef }) => void): void {
  const walkGroup = (group: { children: Array<{ kind: string; source?: { kind: "relation"; relation: string } | { kind: "model"; target: QueryModelRef }; where?: unknown }> }): void => {
    for (const child of group.children) { if (child.source) { visit(child.source); } if (child.where && isGroup(child.where)) { walkGroup(child.where); } }
  };
  walkGroup(recipe.where);
  walkGroup(recipe.postFilter);
  for (const computed of recipe.computed) { if ("source" in computed) { visit(computed.source); } if ("where" in computed) { walkGroup(computed.where); } }
}

/** Narrows unknown values to a predicate group-like object. */
function isGroup(value: unknown): value is { children: Array<{ kind: string; source?: { kind: "relation"; relation: string } | { kind: "model"; target: QueryModelRef }; where?: unknown }> } {
  return typeof value === "object" && value !== null && Array.isArray((value as { children?: unknown }).children);
}

// Deterministic schema-backed progressive Query Builder starter examples.
import { createEmptyQueryRecipe } from "./gridQueryRecipeStore.js";

const CATEGORICAL_NAMES = ["status", "state", "category", "type", "kind", "role"];
const TEXT_TYPES = new Set(["CharField", "TextField", "SlugField", "EmailField", "URLField"]);
const TEXT_NAMES = ["name", "title", "username", "email", "slug", "code"];
const WINDOW_NUMERIC_TYPES = new Set(["AutoField", "BigAutoField", "SmallAutoField", "IntegerField", "BigIntegerField", "SmallIntegerField", "PositiveIntegerField", "PositiveSmallIntegerField", "PositiveBigIntegerField", "DecimalField", "FloatField", "DurationField"]);

/** Returns a copied source identity only when both identity segments are non-empty. */
function sourceIdentity(source) {
  const app = String(source?.app || "").trim(); const model = String(source?.model || "").trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(app) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(model) ? { app, model } : undefined;
}
/** Returns whether a group is the exact canonical empty Recipe shape. */
function emptyGroup(group) { return Boolean(group) && group.kind === "group" && group.join === "and" && !group.negated && Array.isArray(group.children) && group.children.length === 0; }
/** Returns whether a Recipe is the canonical empty rows draft. */
export function isCanonicalEmptyQueryRecipe(recipe) { return recipe?.version === 2 && recipe.mode === "rows" && Array.isArray(recipe.computed) && !recipe.computed.length && Array.isArray(recipe.groupBy) && !recipe.groupBy.length && Array.isArray(recipe.orderBy) && !recipe.orderBy.length && emptyGroup(recipe.where) && emptyGroup(recipe.postFilter); }
/** Converts untrusted schema names into a direct Django identifier. */
function identifier(value) { const text = typeof value === "string" ? value.trim() : ""; return text.length <= 64 && !text.includes("__") && /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? text : ""; }
/** Creates a stable bounded alias that cannot collide with occupied schema identifiers. */
function alias(base, occupied) {
  const raw = String(base).replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "") || "value"; const stem = raw.toLowerCase().startsWith("djs_") ? `example_${raw}` : raw;
  for (let index = 1; index <= 100; index += 1) { const suffix = index === 1 ? "" : `_${index}`; const value = `${stem.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`; if (!occupied.has(value)) { occupied.add(value); return value; } } return "";
}
/** Produces a stable unique bounded node-id stem from an eligible direct schema path. */
function exampleId(kind, path) { let hash = 2166136261; for (const character of `${kind}:${path}`) { hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); } const safe = String(path).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 20); return `example-${kind}-${safe}-${(hash >>> 0).toString(36)}`; }
/** Returns concrete, non-computed root columns in their supplied schema order. */
function columnsFor(columns) {
  const result = []; const seen = new Set();
  for (const [index, column] of (Array.isArray(columns) ? columns : []).entries()) {
    if (column?.computed || column?.annotation || column?.annotated || column?.relation) { continue; }
    const rawPath = typeof column?.name === "string" && column.name.trim() ? column.name : column?.attname; const path = identifier(rawPath); if (typeof rawPath === "string" && !path) { return []; } if (path && seen.has(path)) { return []; } if (!path) { continue; }
    seen.add(path); result.push({ column, index, path });
  }
  return result;
}
/** Selects the documented categorical grouping column without sorting input schema. */
function groupingColumn(columns) {
  const named = (candidate) => CATEGORICAL_NAMES.indexOf(candidate.path);
  let best;
  for (const candidate of columns) {
    if (candidate.column?.pk || !Array.isArray(candidate.column?.choices) || !candidate.column.choices.length || named(candidate) < 0) { continue; }
    if (!best || named(candidate) < named(best)) { best = candidate; }
  }
  if (best) { return best; }
  for (const candidate of columns) { if (!candidate.column?.pk && Array.isArray(candidate.column?.choices) && candidate.column.choices.length) { return candidate; } }
  for (const candidate of columns) {
    if (candidate.column?.pk || !TEXT_TYPES.has(candidate.column?.type) || named(candidate) < 0) { continue; }
    if (!best || named(candidate) < named(best)) { best = candidate; }
  }
  if (best) { return best; }
  return columns.find((candidate) => !candidate.column?.pk && candidate.column?.type === "BooleanField");
}
/** Returns one safely correlatable relation, preferring to-many relations. */
function safeRelation(relations, columns) {
  const paths = new Set(columns.map((candidate) => candidate.path)); const relationPaths = new Set(); const candidates = [];
  for (const [index, relation] of (Array.isArray(relations) ? relations : []).entries()) {
    const path = identifier(relation?.queryName || relation?.name); if (!path || relationPaths.has(path)) { return undefined; } relationPaths.add(path);
    if (!path || !identifier(relation?.filterField) || !identifier(relation?.outerField) || !paths.has(relation.outerField) || !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(String(relation?.target || ""))) { continue; }
    candidates.push({ index, relation, path });
  }
  return candidates.find((candidate) => candidate.relation.single === false) || candidates[0];
}
/** Selects one deterministic direct text column for a Formula candidate. */
function textColumn(columns) { return [...columns].filter((candidate) => !candidate.column?.pk && TEXT_TYPES.has(candidate.column?.type)).sort((left, right) => { const leftIndex = TEXT_NAMES.indexOf(left.path); const rightIndex = TEXT_NAMES.indexOf(right.path); return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex) || left.index - right.index; })[0]; }
/** Selects a different direct scalar ordering column for a Window candidate. */
function windowOrderColumn(columns, group) { const temporalNames = ["created_at", "updated_at", "date", "timestamp"]; const temporalTypes = ["DateTimeField", "DateField", "TimeField"]; const candidates = columns.filter((candidate) => candidate.path !== group?.path).map((candidate) => ({ candidate, score: temporalNames.includes(candidate.path) && temporalTypes.includes(candidate.column?.type) ? temporalNames.indexOf(candidate.path) : temporalTypes.includes(candidate.column?.type) ? 10 : !candidate.column?.pk && WINDOW_NUMERIC_TYPES.has(candidate.column?.type) ? 20 : candidate.column?.pk ? 30 : undefined })).filter((entry) => entry.score !== undefined); return candidates.sort((left, right) => left.score - right.score || left.candidate.index - right.candidate.index)[0]?.candidate; }
/** Creates the grouped Count/HAVING progressive Recipe candidate. */
function aggregateExample(column, source, occupied) {
  const id = exampleId("count", column.path); const countAlias = alias("row_count", occupied); if (!countAlias) { return undefined; } const recipe = createEmptyQueryRecipe(source);
  recipe.mode = "summary"; recipe.groupBy = [{ kind: "field", path: column.path }];
  recipe.computed = [{ alias: countAlias, distinct: "auto", enabled: true, field: { kind: "all" }, filter: { children: [], join: "and", kind: "group", negated: false, nodeId: `${id}-filter` }, function: "count", kind: "aggregate", nodeId: id }];
  recipe.postFilter.children = [{ kind: "comparison", lhs: { alias: countAlias, kind: "computed" }, lookup: "gte", negated: false, nodeId: `${id}-having`, rhs: { kind: "literal", value: 2 } }];
  recipe.orderBy = [{ direction: "desc", nodeId: `${id}-order`, ref: { alias: countAlias, kind: "computed" } }];
  const display = column.column.label && column.column.label !== column.path ? `${column.column.label} — ${column.path}` : column.path;
  return { controlKey: `computed:${id}:alias`, description: "Aggregate summary: group rows, count each group, keep counts of at least 2, and order largest groups first.", fallbackId: "queryComputedLegend", id, label: `Group ${display}; Count ≥ 2`, recipe, source: { ...source }, stage: "calculatedValues" };
}
/** Creates the correlated Exists progressive Recipe candidate. */
function existsExample(candidate, source, occupied) {
  const id = exampleId("exists", candidate.path); const existsAlias = alias(`has_${candidate.path}`, occupied); if (!existsAlias) { return undefined; } const recipe = createEmptyQueryRecipe(source);
  recipe.computed = [{ alias: existsAlias, correlations: [], enabled: true, kind: "exists", nodeId: id, source: { kind: "relation", relation: candidate.path }, where: { children: [], join: "and", kind: "group", negated: false, nodeId: `${id}-where` } }];
  recipe.postFilter.children = [{ kind: "comparison", lhs: { alias: existsAlias, kind: "computed" }, lookup: "exact", negated: false, nodeId: `${id}-filter`, rhs: { kind: "literal", value: true } }];
  return { controlKey: `computed:${id}:alias`, description: "Correlated Exists annotation: calculate whether related rows exist, then filter by that result.", fallbackId: "queryComputedLegend", id, label: `Related ${candidate.path} via Exists`, recipe, source: { ...source }, stage: "calculatedValues" };
}
/** Creates the chained Formula progressive Recipe candidate. */
function formulaExample(column, source, occupied) { const allocated = new Set(occupied); const id = exampleId("formula", column.path); const normalized = alias(`normalized_${column.path}`, allocated); const length = alias(`${column.path}_length`, allocated); if (!normalized || !length) { return undefined; } allocated.forEach((value) => occupied.add(value)); const recipe = createEmptyQueryRecipe(source); recipe.computed = [{ alias: normalized, enabled: true, expression: { args: [{ args: [{ kind: "field", path: column.path }], function: "trim", kind: "function" }], function: "lower", kind: "function" }, kind: "formula", nodeId: `${id}-normalized`, outputType: "text" }, { alias: length, enabled: true, expression: { args: [{ alias: normalized, kind: "computed" }], function: "length", kind: "function" }, kind: "formula", nodeId: `${id}-length`, outputType: "integer" }]; recipe.postFilter.children = [{ kind: "comparison", lhs: { alias: length, kind: "computed" }, lookup: "gte", negated: false, nodeId: `${id}-filter`, rhs: { kind: "literal", value: 8 } }]; recipe.orderBy = [{ direction: "desc", nodeId: `${id}-length-order`, ref: { alias: length, kind: "computed" } }, { direction: "asc", nodeId: `${id}-normalized-order`, ref: { alias: normalized, kind: "computed" } }]; const display = column.column.label || column.path; return { controlKey: `computed:${id}-normalized:alias`, description: "Chained Formula annotations: trim and lowercase the field, calculate length from the earlier alias, keep values of at least 8 characters, and order longest first.", fallbackId: "queryComputedLegend", id, label: `Normalize ${display}; Length ≥ 8`, recipe, source: { ...source }, stage: "calculatedValues" }; }
/** Creates the partitioned Window-ranking progressive Recipe candidate. */
function windowExample(group, order, source, occupied) { const id = exampleId("window", group.path); const rank = alias(`rank_within_${group.path}`, occupied); if (!rank) { return undefined; } const recipe = createEmptyQueryRecipe(source); recipe.computed = [{ alias: rank, enabled: true, function: "row_number", kind: "window", nodeId: id, orderBy: [{ direction: "desc", nodeId: `${id}-inner-order`, ref: { kind: "field", path: order.path } }], partitionBy: [{ kind: "field", path: group.path }] }]; recipe.postFilter.children = [{ kind: "comparison", lhs: { alias: rank, kind: "computed" }, lookup: "lte", negated: false, nodeId: `${id}-filter`, rhs: { kind: "literal", value: 3 } }]; recipe.orderBy = [{ direction: "asc", nodeId: `${id}-group-order`, ref: { kind: "field", path: group.path } }, { direction: "asc", nodeId: `${id}-rank-order`, ref: { alias: rank, kind: "computed" } }]; return { controlKey: `computed:${id}:alias`, description: "Window RowNumber: partition rows by the category, order each partition descending, keep the first 3, and order the result by category and rank.", fallbackId: "queryComputedLegend", id, label: `Top 3 ${order.column.label || order.path} per ${group.column.label || group.path}`, recipe, source: { ...source }, stage: "calculatedValues" }; }
/** Builds zero to four detached progressive starter examples. */
export function buildQueryExamples({ columns, relations, source } = {}) {
  const identity = sourceIdentity(source); if (!identity) { return []; }
  const concrete = columnsFor(columns); const occupied = new Set([...concrete.map((candidate) => candidate.path), ...(Array.isArray(relations) ? relations.flatMap((relation) => [relation?.name, relation?.queryName, relation?.filterField].map(identifier)) : [])]);
  const examples = []; const add = (candidate) => { if (candidate) { examples.push(candidate); } }; const grouping = groupingColumn(concrete); if (grouping) { add(aggregateExample(grouping, identity, occupied)); }
  const relation = safeRelation(relations, concrete); if (relation) { add(existsExample(relation, identity, occupied)); }
  const text = textColumn(concrete); if (text) { add(formulaExample(text, identity, occupied)); }
  const order = windowOrderColumn(concrete, grouping); if (grouping && order) { add(windowExample(grouping, order, identity, occupied)); }
  return examples.map((example, index) => ({ ...example, label: `${index + 1} · ${example.label}` }));
}
/** Clears all prior example content and removes the mount from layout. */
function clearAndHide(mount) { mount?.replaceChildren?.(); if (mount) { mount.hidden = true; } }
/** Creates a compact, text-node-only progressive example view. */
export function createQueryExamplesView({ el, mount, onChoose } = {}) {
  let destroyed = false;
  /** Renders an accessible example action without interpolating markup. */
  function action(actions, example) { const button = el("button", { ariaLabel: `${example.label}. ${example.description || ""}`, className: "secondary query-example-action", title: example.description || "", type: "button" }, example.label); button.addEventListener("click", () => onChoose?.(example)); actions.appendChild(button); }
  return {
    /** Permanently stops view rendering. */
    destroy() { destroyed = true; clearAndHide(mount); },
    /** Renders only canonical-empty drafts and at most four candidate actions. */
    render({ draft, examples, source } = {}) {
      if (destroyed || !mount || !isCanonicalEmptyQueryRecipe(draft)) { clearAndHide(mount); return; }
      const actions = Array.isArray(examples) ? examples.slice(0, 4) : []; mount.replaceChildren(); mount.hidden = false;
      mount.appendChild(el("strong", { className: "query-examples-title" }, `Progressive examples for ${source?.app || ""}.${source?.model || ""}`)); mount.appendChild(el("p", { className: "query-examples-help" }, "Draft only—Apply stays manual."));
      if (!actions.length) { mount.appendChild(el("p", { className: "query-examples-empty" }, "No safe advanced example is available for this model.")); return; }
      const controls = el("div", { className: "query-examples-actions" }); actions.forEach((example) => action(controls, example)); mount.appendChild(controls);
    }
  };
}

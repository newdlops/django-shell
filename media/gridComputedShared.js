// Shared Recipe-first helpers for computed-column builders and their nested predicates.
import { createPredicateBuilder } from "./gridPredicateBuilder.js";

let computedPredicateSequence = 0;

/** Creates an identifier for a local predicate edit without relying on clock resolution. */
function nextComputedPredicateId(prefix) { computedPredicateSequence += 1; return `${prefix}-${computedPredicateSequence}`; }

/** Deep-clones one JSON-safe Recipe value. */
export function cloneComputedValue(value) { return JSON.parse(JSON.stringify(value)); }

/** Creates a stable empty predicate group for one computed-column child editor. */
export function emptyComputedGroup(nodeId) { return { children: [], join: "and", kind: "group", negated: false, nodeId }; }

/** Creates a valid initial computed item for the fixed UI kind ordering. */
export function createComputedDraft(kind, nodeId, alias = "") {
  const group = (suffix) => emptyComputedGroup(`${nodeId}-${suffix}`);
  if (kind === "aggregate") { return { alias, distinct: "auto", enabled: true, field: { kind: "all" }, filter: group("filter"), function: "count", kind, nodeId }; }
  if (kind === "scalarSubquery") { return { alias, correlations: [], enabled: true, kind, nodeId, onEmpty: { kind: "literal", value: null }, orderBy: [], outputType: "auto", select: { field: { kind: "field", path: "" }, kind: "field" }, source: { kind: "relation", relation: "" }, where: group("where") }; }
  if (kind === "exists") { return { alias, correlations: [], enabled: true, kind, nodeId, source: { kind: "relation", relation: "" }, where: group("where") }; }
  if (kind === "window") { return { alias, enabled: true, function: "row_number", kind, nodeId, orderBy: [], partitionBy: [] }; }
  if (kind === "codeExpression") { return { alias, enabled: true, expression: "", kind, nodeId, outputType: "auto", when: group("when") }; }
  return { alias, enabled: true, expression: { kind: "literal", value: null }, kind: "formula", nodeId, outputType: "auto" };
}

/** Returns a deterministic alias suggestion that never overwrites user-entered aliases. */
export function suggestComputedAlias(kind, computed) {
  const base = { aggregate: "count", codeExpression: "expression", exists: "exists", formula: "value", scalarSubquery: "subquery", window: "row_number" }[kind] || "value";
  const used = new Set((computed || []).map((item) => String(item.alias || "").toLowerCase()));
  if (!used.has(base)) { return base; }
  let index = 2;
  while (used.has(`${base}_${index}`)) { index += 1; }
  return `${base}_${index}`;
}

/** Returns only aliases declared before this item and currently enabled. */
export function previousEnabledAliases(computed, nodeId) {
  const index = (computed || []).findIndex((item) => item.nodeId === nodeId);
  return (computed || []).slice(0, Math.max(0, index)).filter((item) => item.enabled && item.alias).map((item) => item.alias);
}

/** Reports why an item remains visible but unavailable in explicit Summary mode. */
export function summaryUnavailable(recipe, item) {
  return recipe?.mode === "summary" && item?.kind !== "aggregate";
}

/** Finds one node plus direct parent in an independent predicate tree. */
function findPredicate(root, nodeId) {
  if (root?.nodeId === nodeId) { return { node: root, parent: undefined }; }
  let found;
  const visit = (group) => {
    for (const node of group?.children || []) {
      if (node.nodeId === nodeId) { found = { node, parent: group }; return; }
      if (node.kind === "group") { visit(node); }
      if (node.kind === "existsPredicate") { visit(node.where); }
      if (found) { return; }
    }
  };
  visit(root);
  return found;
}

/** Regenerates nested identifiers for a duplicated standalone predicate branch. */
function clonePredicateNode(node) {
  let sequence = 0;
  const copy = cloneComputedValue(node);
  const rewrite = (value) => {
    if (!value || typeof value !== "object") { return; }
    if (typeof value.nodeId === "string") { sequence += 1; value.nodeId = `${value.kind || "node"}-copy-${sequence}`; }
    (value.children || []).forEach(rewrite);
    if (value.where) { rewrite(value.where); }
    (value.correlations || []).forEach(rewrite);
    (value.orderBy || []).forEach(rewrite);
  };
  rewrite(copy);
  return copy;
}

/** Applies the structural subset emitted by the shared Predicate Builder to an independent predicate root. */
export function reduceComputedPredicate(root, action) {
  const next = cloneComputedValue(root);
  const found = findPredicate(next, action.nodeId);
  const parent = findPredicate(next, action.parentId || next.nodeId)?.node;
  const add = (node) => { if (parent?.kind === "group") { parent.children.push(node); } };
  if (action.type === "ADD_COMPARISON") { add({ kind: "comparison", lhs: { kind: "field", path: "" }, lookup: "exact", negated: false, nodeId: nextComputedPredicateId("comparison"), rhs: { kind: "literal", value: null } }); }
  else if (action.type === "ADD_GROUP") { add(emptyComputedGroup(nextComputedPredicateId("group"))); }
  else if (action.type === "ADD_EXISTS_PREDICATE") { add({ correlations: [], kind: "existsPredicate", negated: false, nodeId: nextComputedPredicateId("exists"), source: { kind: "relation", relation: "" }, where: emptyComputedGroup(nextComputedPredicateId("exists-where")) }); }
  else if (action.type === "UPDATE_NODE" && found) { Object.assign(found.node, action.changes || {}); }
  else if (action.type === "REMOVE_NODE" && found?.parent) { found.parent.children.splice(found.parent.children.indexOf(found.node), 1); }
  else if (action.type === "DUPLICATE_NODE" && found?.parent) { const index = found.parent.children.indexOf(found.node); found.parent.children.splice(index + 1, 0, clonePredicateNode(found.node)); }
  else if ((action.type === "MOVE_NODE_UP" || action.type === "MOVE_NODE_DOWN") && found?.parent) { const index = found.parent.children.indexOf(found.node); const target = index + (action.type === "MOVE_NODE_UP" ? -1 : 1); if (target >= 0 && target < found.parent.children.length) { [found.parent.children[index], found.parent.children[target]] = [found.parent.children[target], found.parent.children[index]]; } }
  return next;
}

/** Creates a Predicate Builder attached to one computed item's filter/where/when group through immutable store actions. */
export function createComputedPredicateEditor({ context, dispatch, el, getRecipe, getScope, item, key, metadata, onChange, validation }) {
  const root = item?.[key];
  if (!root?.nodeId) { return undefined; }
  const update = (action) => {
    const next = reduceComputedPredicate(root, action);
    if (onChange) { onChange(next); return; }
    dispatch({ changes: { [key]: next }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" });
  };
  return createPredicateBuilder({ context, dispatch: update, el, getRecipe: () => root, getScope, metadata, rootNodeId: root.nodeId, validation });
}

/** Builds a compact select using native controls and theme-owned generic styles. */
export function computedSelect(el, label, options, value, onChange) {
  const select = el("select", { ariaLabel: label, className: "query-computed-select" });
  for (const option of options) { select.appendChild(el("option", { value: option.value }, option.label)); }
  select.value = value ?? "";
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

/** Builds a labeled native text input with an explicit accessible label. */
export function computedInput(el, label, value, onChange, options = {}) {
  const input = el("input", { ariaLabel: label, className: "query-computed-input", maxLength: options.maxLength, placeholder: options.placeholder || "", type: options.type || "text", value: value == null ? "" : String(value) });
  input.addEventListener(options.event || "input", () => onChange(input.value));
  return input;
}

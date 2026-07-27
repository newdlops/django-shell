// Immutable Recipe action reducer and canonical Query Builder node factories.

let nextNodeSequence = 0;

/** Creates one monotonic, webview-local Recipe node identifier. */
function nextNodeId(prefix = "node") {
  nextNodeSequence += 1;
  return `${prefix}-${nextNodeSequence}`;
}

/** Deep-clones one JSON-only Recipe value without retaining nested references. */
export function cloneQueryRecipe(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Creates the canonical empty v2 Recipe without importing host TypeScript into the webview. */
export function createEmptyQueryRecipe(source) {
  return {
    computed: [], groupBy: [], mode: "rows", orderBy: [], postFilter: emptyGroup("post-root"),
    source: { app: String(source?.app || ""), model: String(source?.model || "") }, version: 2, where: emptyGroup("where-root")
  };
}

/** Creates one empty predicate group with the supplied stable identifier. */
function emptyGroup(nodeId) {
  return { children: [], join: "and", kind: "group", negated: false, nodeId };
}

/** Creates the safe default comparison used by a newly added predicate condition. */
function comparisonNode(nodeId = nextNodeId("comparison")) {
  return { kind: "comparison", lhs: { kind: "field", path: "" }, lookup: "exact", negated: false, nodeId, rhs: { kind: "literal", value: null } };
}

/** Creates the minimal formula column that becomes valid after the user completes it. */
function computedColumn(nodeId = nextNodeId("computed")) {
  return { alias: "", enabled: true, expression: { kind: "literal", value: null }, kind: "formula", nodeId, outputType: "auto" };
}

/** Visits every nested predicate node with its owning group. */
function walkNodes(group, visit) {
  for (const node of group?.children || []) {
    visit(node, group);
    if (node.kind === "group") { walkNodes(node, visit); }
    if (node.kind === "existsPredicate") { walkNodes(node.where, visit); }
  }
}

/** Finds a predicate group by identifier across normal and Exists predicate branches. */
function findGroup(root, nodeId) {
  if (root?.nodeId === nodeId) { return root; }
  let found;
  walkNodes(root, (node) => {
    if (!found && node.kind === "group" && node.nodeId === nodeId) { found = node; }
    if (!found && node.kind === "existsPredicate" && node.where?.nodeId === nodeId) { found = node.where; }
  });
  return found;
}

/** Finds a predicate node and its direct parent group by stable identifier. */
function findNode(root, nodeId) {
  let found;
  walkNodes(root, (node, parent) => { if (!found && node.nodeId === nodeId) { found = { node, parent }; } });
  return found;
}

/** Regenerates every nested node identifier so a duplicated branch cannot collide. */
function cloneWithNewNodeIds(value) {
  const copy = cloneQueryRecipe(value);
  const rewrite = (node) => {
    if (!node || typeof node !== "object") { return; }
    if (typeof node.nodeId === "string") { node.nodeId = nextNodeId(node.kind || "node"); }
    if (Array.isArray(node.children)) { node.children.forEach(rewrite); }
    if (node.where) { rewrite(node.where); }
    if (Array.isArray(node.correlations)) { node.correlations.forEach(rewrite); }
    if (Array.isArray(node.orderBy)) { node.orderBy.forEach(rewrite); }
  };
  rewrite(copy);
  return copy;
}

/** Moves one list entry by a single bounded direction. */
function move(items, index, direction) {
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= items.length) { return; }
  [items[index], items[destination]] = [items[destination], items[index]];
}

/** Removes one list entry that has a matching stable node identifier. */
function removeById(items, nodeId) {
  const index = items.findIndex((entry) => entry.nodeId === nodeId);
  if (index >= 0) { items.splice(index, 1); }
}

/** Returns a deep-cloned Recipe after applying one supported Query Builder action. */
export function reduceQueryRecipe(recipe, action = {}) {
  const next = cloneQueryRecipe(recipe);
  const root = action.scope === "postFilter" ? next.postFilter : next.where;
  const group = () => findGroup(root, action.parentId || root.nodeId);
  const node = () => findNode(root, action.nodeId);
  if (action.type === "ADD_COMPARISON") { group()?.children.push(cloneQueryRecipe(action.node || comparisonNode())); }
  else if (action.type === "ADD_GROUP") { group()?.children.push(cloneQueryRecipe(action.group || { ...emptyGroup(nextNodeId("group")), nodeId: nextNodeId("group") })); }
  else if (action.type === "ADD_EXISTS_PREDICATE") {
    group()?.children.push(cloneQueryRecipe(action.node || { correlations: [], kind: "existsPredicate", negated: false, nodeId: nextNodeId("exists"), source: { kind: "relation", relation: "" }, where: { ...emptyGroup(nextNodeId("exists-where")), nodeId: nextNodeId("exists-where") } }));
  } else if (action.type === "UPDATE_NODE") { const found = node(); if (found) { Object.assign(found.node, cloneQueryRecipe(action.changes || {})); } }
  else if (action.type === "REMOVE_NODE") { const found = node(); if (found && found.node.nodeId !== root.nodeId) { found.parent.children.splice(found.parent.children.indexOf(found.node), 1); } }
  else if (action.type === "DUPLICATE_NODE") { const found = node(); if (found) { const index = found.parent.children.indexOf(found.node); found.parent.children.splice(index + 1, 0, cloneWithNewNodeIds(found.node)); } }
  else if (action.type === "MOVE_NODE_UP" || action.type === "MOVE_NODE_DOWN") { const found = node(); if (found) { move(found.parent.children, found.parent.children.indexOf(found.node), action.type === "MOVE_NODE_UP" ? -1 : 1); } }
  else if (action.type === "ADD_COMPUTED") { next.computed.push(cloneQueryRecipe(action.computed || computedColumn())); }
  else if (action.type === "UPDATE_COMPUTED") { const item = next.computed.find((entry) => entry.nodeId === action.nodeId); if (item) { Object.assign(item, cloneQueryRecipe(action.changes || {})); } }
  else if (action.type === "REMOVE_COMPUTED") { removeById(next.computed, action.nodeId); }
  else if (action.type === "DUPLICATE_COMPUTED") { const index = next.computed.findIndex((entry) => entry.nodeId === action.nodeId); if (index >= 0) { next.computed.splice(index + 1, 0, cloneWithNewNodeIds(next.computed[index])); } }
  else if (action.type === "MOVE_COMPUTED_UP" || action.type === "MOVE_COMPUTED_DOWN") { move(next.computed, next.computed.findIndex((entry) => entry.nodeId === action.nodeId), action.type === "MOVE_COMPUTED_UP" ? -1 : 1); }
  else if (action.type === "TOGGLE_COMPUTED") { const item = next.computed.find((entry) => entry.nodeId === action.nodeId); if (item) { item.enabled = !item.enabled; } }
  else if (action.type === "SET_MODE") { next.mode = action.mode === "summary" ? "summary" : "rows"; if (next.mode === "rows") { next.groupBy = []; } }
  else if (action.type === "ADD_GROUP_BY") { next.groupBy.push(cloneQueryRecipe(action.field || { kind: "field", path: "" })); }
  else if (action.type === "REMOVE_GROUP_BY") { next.groupBy.splice(Number(action.index), 1); }
  else if (action.type === "ADD_ORDER") { next.orderBy.push(cloneQueryRecipe(action.order || { direction: "asc", nodeId: nextNodeId("order"), ref: { kind: "field", path: "" } })); }
  else if (action.type === "UPDATE_ORDER") { const item = next.orderBy.find((entry) => entry.nodeId === action.nodeId); if (item) { Object.assign(item, cloneQueryRecipe(action.changes || {})); } }
  else if (action.type === "REMOVE_ORDER") { removeById(next.orderBy, action.nodeId); }
  else if (action.type === "REPLACE_DRAFT") { return cloneQueryRecipe(action.recipe); }
  return next;
}

// Keeps ordinary row filtering compact without concealing advanced or unrelated query changes.

/** Returns whether the entire editable draft can be represented by the compact filter surface. */
export function supportsQuickFilters(snapshot) {
  const draft = snapshot?.draft, applied = snapshot?.applied;
  if (!draft?.where || !applied) { return false; }
  /** Projects the query parts which quick filtering must leave unchanged. */
  const withoutWhere = ({ where, ...rest }) => rest;
  if (JSON.stringify(withoutWhere(draft)) !== JSON.stringify(withoutWhere(applied))) { return false; }
  return supportsGroup(draft.where);
}

/** Keeps nested Boolean groups and typed comparisons visible in the same filter composer. */
function supportsGroup(group, depth = 1) {
  if (depth > 5 || group.kind !== "group" || !Array.isArray(group.children)) { return false; }
  return group.children.every((node) => node.kind === "group" ? supportsGroup(node, depth + 1) : node.kind === "comparison" && node.lhs?.kind === "field" && ["literal", "list", "range", "field", "relativeTime"].includes(node.rhs?.kind));
}

/** Removes only source-row predicates while preserving calculated columns, result filters, ordering, and identity. */
export function clearRowFiltersAction(recipe) {
  return { changes: { children: [], join: "and", negated: false }, nodeId: recipe.where.nodeId, scope: "where", type: "UPDATE_NODE" };
}

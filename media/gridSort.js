// Pure grid-sort helpers for cycling headers and translating Recipe order terms.

/** Projects a Recipe's outer order terms into the model grid's compact sort state. */
export function gridOrderFromRecipe(recipe) {
  return (recipe?.orderBy || []).map((term) => {
    const field = term?.ref?.kind === "computed" ? term.ref.alias : term?.ref?.path;
    return field ? { desc: term.direction === "desc", field } : undefined;
  }).filter(Boolean);
}

/** Returns the next single-column order for an asc → desc → default header cycle. */
export function nextGridOrder(order, field) {
  const current = Array.isArray(order) ? order[0] : undefined;
  if (current?.field === field && !current.desc) { return [{ desc: true, field }]; }
  if (current?.field === field && current.desc) { return []; }
  return [{ desc: false, field }];
}

/** Collects every Recipe node identifier so a direct sort cannot collide with a draft-owned node. */
function collectNodeIds(value, ids = new Set()) {
  if (Array.isArray(value)) { value.forEach((item) => collectNodeIds(item, ids)); return ids; }
  if (!value || typeof value !== "object") { return ids; }
  if (typeof value.nodeId === "string") { ids.add(value.nodeId); }
  Object.values(value).forEach((item) => collectNodeIds(item, ids));
  return ids;
}

/** Allocates a bounded stable-looking node identifier outside the Recipe's current identifier set. */
function gridOrderNodeId(recipe, field) {
  const slug = String(field).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "field";
  const base = `grid-order-${slug}`;
  const used = collectNodeIds(recipe);
  let candidate = base; let suffix = 2;
  while (used.has(candidate)) { candidate = `${base}-${suffix}`; suffix += 1; }
  return candidate;
}

/** Copies an applied Recipe with one header-selected order or its default order. */
export function recipeWithGridOrder(recipe, field, descending) {
  const computed = (recipe?.computed || []).some((item) => item?.enabled && item.alias === field);
  const ref = computed ? { alias: field, kind: "computed" } : { kind: "field", path: field };
  const orderBy = descending === undefined ? [] : [{ direction: descending ? "desc" : "asc", nodeId: gridOrderNodeId(recipe, field), ref }];
  return { ...recipe, orderBy };
}

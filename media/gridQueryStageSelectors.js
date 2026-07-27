// Pure stage labels, counts, and issue mapping for the Query Builder workspace.

export { stageForQueryIssue as stageForIssue } from "./gridQueryIssueTarget.js";

export const QUERY_STAGES = ["filterRows", "calculatedValues", "filterResults", "result"];

/** Counts editable predicate nodes, including related-row predicates and their inner conditions. */
function predicateCount(group) {
  let count = 0;
  for (const node of group?.children || []) {
    count += 1;
    if (node.kind === "group") { count += predicateCount(node); }
    if (node.kind === "existsPredicate") { count += predicateCount(node.where); }
  }
  return count;
}

/** Returns bounded, human-readable stage counts from an immutable Recipe. */
export function queryStageCounts(recipe = {}) {
  return {
    calculatedValues: Array.isArray(recipe.computed) ? recipe.computed.length : 0,
    filterResults: predicateCount(recipe.postFilter),
    filterRows: predicateCount(recipe.where),
    result: (Array.isArray(recipe.groupBy) ? recipe.groupBy.filter((item) => item?.path || item?.alias).length : 0) + (Array.isArray(recipe.orderBy) ? recipe.orderBy.filter((item) => item?.ref?.path || item?.ref?.alias).length : 0)
  };
}

/** Returns a stable stage label with count for compact navigation controls. */
export function stageLabel(stage, count) {
  const labels = { calculatedValues: "Calculated Values", filterResults: "Filter Results", filterRows: "Filter Rows", result: "Result" };
  return `${labels[stage] || labels.filterRows}${count ? ` (${count})` : ""}`;
}

/** Exposes pure helpers for stage-navigation tests. */
export const __test = { predicateCount };

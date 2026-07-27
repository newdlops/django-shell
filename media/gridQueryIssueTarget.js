// Pure validation issue-to-Query Builder stage routing.

/** Maps a Recipe validation path or control key to its owning workspace stage. */
export function stageForQueryIssue(issue = {}) {
  const path = String(issue.path || issue.controlKey || "");
  if (path.includes("postFilter") || path.includes("having")) { return "filterResults"; }
  if (path.includes("computed") || path.includes("annotation") || path.includes("subquery") || path.includes("formula")) { return "calculatedValues"; }
  if (path.includes("groupBy") || path.includes("orderBy") || path.includes("mode") || path.includes("result")) { return "result"; }
  return "filterRows";
}

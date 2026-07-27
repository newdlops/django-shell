// Recipe result-mode, response, pagination, and query-log presentation helpers.

export const MAX_OUTER_ORDER_TERMS = 8;

/** Returns one stable identity for a field or computed reference. */
export function queryReferenceKey(ref) {
  if (ref?.kind === "computed") { return `computed:${String(ref.alias || "")}`; }
  return `field:${String(ref?.path || "")}`;
}

/** Returns client-side issues for an outer order list before the host validates it. */
export function outerOrderIssues(terms) {
  const issues = [];
  const seen = new Set();
  for (const [index, term] of (Array.isArray(terms) ? terms : []).entries()) {
    const key = queryReferenceKey(term?.ref);
    if (!term?.ref || !key.slice(key.indexOf(":") + 1)) {
      issues.push(resultIssue("ORDER_REFERENCE_REQUIRED", `Choose a field or computed column for order term ${index + 1}.`, term?.nodeId, `/orderBy/${index}/ref`));
    } else if (seen.has(key)) {
      issues.push(resultIssue("ORDER_REFERENCE_DUPLICATE", "Use each outer order reference only once.", term?.nodeId, `/orderBy/${index}/ref`));
    }
    seen.add(key);
    if (term?.direction !== "asc" && term?.direction !== "desc") {
      issues.push(resultIssue("ORDER_DIRECTION_REQUIRED", "Choose ascending or descending order.", term?.nodeId, `/orderBy/${index}/direction`));
    }
  }
  if ((terms || []).length > MAX_OUTER_ORDER_TERMS) {
    issues.push(resultIssue("ORDER_TERM_LIMIT", `Use at most ${MAX_OUTER_ORDER_TERMS} outer order terms.`, undefined, "/orderBy"));
  }
  return issues;
}

/** Describes the visible result shape without exposing Recipe JSON. */
export function describeResultMode(recipe) {
  if (recipe?.mode !== "summary") { return "Rows"; }
  const groups = Array.isArray(recipe.groupBy) ? recipe.groupBy.length : 0;
  return groups ? `Summary · ${groups} group field${groups === 1 ? "" : "s"}` : "Summary · global";
}

/** Returns the footer noun appropriate for a result response. */
export function resultCountLabel(recipe, count) {
  const value = Number(count) || 0;
  if (recipe?.mode !== "summary") { return `${value} row${value === 1 ? "" : "s"}`; }
  if (!(recipe.groupBy || []).length) { return "1 summary row"; }
  return `${value} group${value === 1 ? "" : "s"}`;
}

/** Selects the only pagination mode that preserves Recipe result semantics. */
export function recipePaginationMode(recipe) {
  const hasComputed = (recipe?.computed || []).some((item) => item?.enabled);
  const hasWindow = (recipe?.computed || []).some((item) => item?.enabled && item.kind === "window");
  if (!recipe?.orderBy?.length && !hasComputed && !hasWindow) { return "pk-keyset"; }
  return "offset";
}

/** Merges client and backend issues by the protocol's stable de-duplication key. */
export function mergeRecipeIssues(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const issue of Array.isArray(group) ? group : []) {
      if (!issue || typeof issue !== "object") { continue; }
      const key = `${issue.code || ""}\u0000${issue.nodeId || ""}\u0000${issue.path || ""}`;
      if (seen.has(key)) { continue; }
      seen.add(key);
      merged.push(issue);
    }
  }
  return merged;
}

/** Builds a compact, safe query-log label from host-provided Recipe provenance. */
export function recipeLogLabel(action, meta) {
  if (!meta || typeof meta !== "object") { return action; }
  const revision = Number.isSafeInteger(meta.revision) ? `Recipe rev ${meta.revision}` : "Recipe";
  const summary = typeof meta.summary === "string" && meta.summary.trim() ? ` · ${meta.summary.trim()}` : "";
  return `${action} · ${revision}${summary}`;
}

/** Creates one UI-shaped issue without requiring host TypeScript modules in the webview. */
function resultIssue(code, fix, nodeId, path) {
  return { code, fix, message: code.toLowerCase().replaceAll("_", " "), nodeId, path, severity: "error" };
}

// Safe human-readable summaries for ModelQueryRecipeV2 draft and applied states.

/** Counts recursive predicate nodes without relying on DOM state. */
export function countPredicateNodes(group) {
  return (group?.children || []).reduce((count, node) => count + 1 + (node.kind === "group" ? countPredicateNodes(node) : node.kind === "existsPredicate" ? countPredicateNodes(node.where) : 0), 0);
}

/** Summarizes applied source-row and result-filter trees without changing their semantics. */
export function summarizeRecipeFilters(recipe = {}) {
  const sourceCount = countPredicateNodes(recipe.where);
  const resultCount = countPredicateNodes(recipe.postFilter);
  return {
    resultCount,
    resultText: resultCount > 0 ? predicateSummary(recipe.postFilter, true) : "",
    sourceCount,
    sourceText: sourceCount > 0 ? predicateSummary(recipe.where, true) : "",
    totalCount: sourceCount + resultCount
  };
}

/** Returns a compact, user-facing description of a Recipe without executing it. */
export function describeQueryRecipe(recipe) {
  const where = predicateSummary(recipe?.where, true);
  const computed = computedSummary(recipe?.computed);
  const { resultCount, resultText } = summarizeRecipeFilters(recipe);
  const result = resultSummary(recipe);
  return [where, computed, resultCount > 0 ? `Result filter: ${resultText}` : "", result].filter(Boolean).join(" · ");
}

/** Produces the expanded text used beside the ORM preview from the same AST renderer as the summary band. */
export function renderRecipeNarrative(recipe) {
  return `Recipe: ${describeQueryRecipe(recipe)}`;
}

/** Combines the shared Recipe narrative with an optional host-generated ORM preview. */
export function renderRecipePreview(recipe, ormPreview) {
  const narrative = renderRecipeNarrative(recipe);
  return typeof ormPreview === "string" && ormPreview.trim() ? `${narrative}\n\nDjango ORM\n${ormPreview.trim()}` : narrative;
}

/** Renders the collapsed summary band using textContent-only updates. */
export function renderQuerySummary(elements, snapshot) {
  const recipe = snapshot?.applied;
  const { resultCount, resultText, sourceCount, sourceText, totalCount } = summarizeRecipeFilters(recipe);
  const columnCount = (recipe?.computed || []).filter((item) => item.enabled).length;
  const text = `Applied · ${describeQueryRecipe(recipe)}`;
  elements.queryFilterButton.textContent = `Filters ${totalCount}`;
  elements.queryFilterButton.title = `Applied filters: ${sourceCount} row condition(s), ${resultCount} result condition(s). Open the Filter Rows draft editor.`;
  elements.queryColumnsButton.textContent = `Columns ${columnCount}`;
  elements.queryColumnsButton.title = "Applied calculated columns. Open the Calculated Values draft editor.";
  elements.queryModeButton.textContent = recipe?.mode === "summary" ? "Summary" : "Rows";
  elements.queryModeButton.title = "Applied result mode. Open the Result draft editor.";
  elements.queryHumanSummary.textContent = text;
  elements.queryHumanSummary.title = text;
  elements.queryAppliedWhere.hidden = sourceCount === 0;
  elements.queryAppliedWhere.textContent = sourceCount > 0 ? `Rows · ${sourceText}` : "";
  elements.queryAppliedWhere.title = sourceCount > 0 ? `Rows · ${sourceText}` : "";
  elements.queryAppliedPostFilter.hidden = resultCount === 0;
  elements.queryAppliedPostFilter.textContent = resultCount > 0 ? `Results · ${resultText}` : "";
  elements.queryAppliedPostFilter.title = resultCount > 0 ? `Results · ${resultText}` : "";
  elements.queryAppliedFilters.hidden = totalCount === 0;
  elements.queryAppliedFiltersEmpty.hidden = totalCount > 0;
  elements.queryDirtyState.hidden = !snapshot?.dirty;
}

/** Renders a boolean predicate group with explicit parentheses and NOT preservation. */
function predicateSummary(group, root = false) {
  const children = Array.isArray(group?.children) ? group.children : [];
  if (!children.length) { return root ? "All rows" : "all rows"; }
  const join = group?.join === "or" ? " OR " : " AND ";
  const body = children.map(predicateNodeSummary).join(join);
  const parenthesized = children.length > 1 ? `(${body})` : body;
  return group?.negated ? `NOT ${parenthesized}` : parenthesized;
}

/** Renders one predicate node without executing or exposing any raw payload. */
function predicateNodeSummary(node) {
  if (node?.kind === "group") { return predicateSummary(node); }
  if (node?.kind === "existsPredicate") {
    const source = node.source?.kind === "relation" ? node.source.relation : `${node.source?.app || "?"}.${node.source?.model || "?"}`;
    const correlation = Array.isArray(node.correlations) && node.correlations.length ? ` correlated by ${node.correlations.map((item) => `${item.outerPath}=${item.targetPath}`).join(", ")}` : "";
    const text = `EXISTS ${source}${correlation} where ${predicateSummary(node.where)}`;
    return node.negated ? `NOT (${text})` : text;
  }
  if (node?.kind === "comparison") {
    if (node.lookup === "isnull") { return `${referenceSummary(node.lhs)} ${isNullSummary(node)}`; }
    const text = `${referenceSummary(node.lhs)} ${String(node.lookup || "exact")} ${valueSummary(node.rhs)}`;
    return node.negated ? `NOT (${text})` : text;
  }
  return "invalid condition";
}

/** Returns a direct null-state summary after applying the comparison's leaf-level Not flag. */
function isNullSummary(node) { return Boolean(node?.rhs?.value) !== Boolean(node?.negated) ? "is null" : "has a value"; }

/** Renders a field or computed reference. */
function referenceSummary(reference) {
  return reference?.kind === "computed" ? `@${reference.alias || "computed"}` : reference?.path || "field";
}

/** Renders a comparison RHS in a compact, non-executable form. */
function valueSummary(value) {
  if (!value || typeof value !== "object") { return literalSummary(value); }
  if (value.kind === "field") { return value.path || "field"; }
  if (value.kind === "outerField") { return `outer.${value.path || "field"}`; }
  if (value.kind === "list") { return `[${(value.values || []).map(literalSummary).join(", ")}]`; }
  if (value.kind === "relativeTime") { return `${value.amount || 0} ${value.unit || "time"} ${value.direction || "ago"}`; }
  return literalSummary(value.value);
}

/** Converts a JSON literal into a deliberately short human-readable token. */
function literalSummary(value) {
  if (value === null || value === undefined) { return "null"; }
  if (typeof value === "string") { return JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}…` : value); }
  return String(value);
}

/** Describes enabled computed columns including implicit correlation, ordering, and distinct behavior. */
function computedSummary(computed) {
  const enabled = (computed || []).filter((item) => item?.enabled);
  if (!enabled.length) { return "no computed columns"; }
  const descriptions = enabled.map((item) => {
    if (item.kind === "aggregate") { return `${item.alias || "aggregate"} (${item.function || "aggregate"}${item.distinct && item.distinct !== "never" ? `, distinct ${item.distinct}` : ""})`; }
    if (item.kind === "scalarSubquery") {
      const correlation = item.correlations?.length ? `${item.correlations.length} correlation${item.correlations.length === 1 ? "" : "s"}` : "no correlation";
      const order = item.orderBy?.length ? `${item.orderBy.length} inner order term${item.orderBy.length === 1 ? "" : "s"}` : "target primary-key ascending";
      return `${item.alias || "subquery"} (subquery; ${correlation}; ${order})`;
    }
    return item.alias || item.kind || "computed";
  });
  return `${enabled.length} computed column${enabled.length === 1 ? "" : "s"}: ${descriptions.join(", ")}`;
}

/** Describes rows or grouped/global summary output and every outer order term. */
function resultSummary(recipe) {
  const mode = recipe?.mode === "summary" ? "Summary" : "Rows";
  const grouping = recipe?.mode === "summary" ? (recipe.groupBy?.length ? ` grouped by ${recipe.groupBy.map(referenceSummary).join(", ")}` : " global summary") : "";
  const order = recipe?.orderBy?.length ? ` ordered by ${recipe.orderBy.map((term) => `${referenceSummary(term.ref)} ${term.direction === "desc" ? "descending" : "ascending"}`).join(", ")}` : " ordered by primary key ascending";
  return `${mode}${grouping}${order}`;
}

// Pure, bounded explanations for Model Query Builder state without DOM or ORM generation.

import { guidanceForComputedKind, guidanceForLookup } from "./gridQueryGuidanceCopy.js";

/** Splits backtick-marked safe identifiers into text and code rendering tokens. */
export function queryExplanationTokens(value) {
  const text = String(value || "");
  const tokens = [];
  let cursor = 0;
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    if (match.index > cursor) { tokens.push({ kind: "text", value: text.slice(cursor, match.index) }); }
    tokens.push({ kind: "code", value: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length || !tokens.length) { tokens.push({ kind: "text", value: text.slice(cursor) }); }
  return tokens;
}

/** Reassembles explanation tokens for non-DOM compatibility consumers. */
export function formatExplanationText(tokens) {
  return (tokens || []).map((token) => token?.kind === "code" ? `\`${token.value || ""}\`` : token?.value || "").join("");
}

/** Formats a literal as bounded display text without exposing a large raw expression. */
export function formatQueryLiteral(value, limit = 80) {
  if (value === null || value === undefined) { return "null"; }
  const text = typeof value === "string" ? `“${value.replace(/”/g, "\\”").replace(/“/g, "\\“") }”` : String(value);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

/** Resolves a display name for a reference from context metadata without trusting arbitrary objects. */
export function describeReference(reference, context = {}) {
  if (reference?.kind === "computed") { return `calculated value \`${String(reference.alias || "value")}\``; }
  const path = String(reference?.path || "");
  const field = context.fields?.[path] || context.fieldByPath?.(path);
  const label = String(field?.label || field?.verboseName || "").trim();
  return label ? `${label} (\`${path}\`)` : `\`${path || "field"}\``;
}

/** Returns the first error belonging to a node when validation data is available. */
function nodeIssue(node, context) { return (context?.issues || []).find((issue) => issue?.nodeId === node?.nodeId && issue?.severity !== "warning"); }

/** Determines whether a RHS needs a user-entered value for the active lookup. */
function rhsMissing(node) {
  const rhs = node?.rhs;
  if (!rhs || typeof rhs !== "object") { return true; }
  if (["blank", "not_blank"].includes(node?.lookup)) { return false; }
  if (node?.lookup === "in") { return !Array.isArray(rhs.values) || rhs.values.length === 0; }
  if (node?.lookup === "range") { return rhs.lower === null || rhs.lower === undefined || rhs.upper === null || rhs.upper === undefined; }
  if (node?.lookup === "isnull") { return typeof rhs.value !== "boolean"; }
  if (["field", "outerField"].includes(rhs.kind)) { return !rhs.path; }
  if (rhs.kind === "relativeTime") { return !rhs.amount || !rhs.unit || !rhs.anchor || !rhs.direction; }
  return rhs.value === null || rhs.value === undefined || rhs.value === "";
}

/** Explains the next required comparison choice or the completed comparison meaning. */
export function explainComparison(node, context = {}) {
  const issue = nodeIssue(node, context);
  if (issue) { return { state: "error", text: issue.title || issue.fix || "This comparison needs attention.", technical: issue.code }; }
  if (!node?.lhs || (!(node.lhs.path || node.lhs.alias))) { return { state: "incomplete", text: "Choose the field or calculated value you want to filter." }; }
  if (context.metadataState === "pending") { return { state: "incomplete", text: "Loading fields for this model…" }; }
  if (context.metadataState === "error") { return { state: "error", text: "Field details could not be loaded. Retry before choosing a field." }; }
  const lhs = describeReference(node.lhs, context);
  if (!node.lookup) { return { state: "incomplete", text: `Choose how ${lhs} should be compared.` }; }
  if (!node.rhs?.kind && !["blank", "not_blank"].includes(node.lookup)) { return { state: "incomplete", text: "Choose whether to compare with a value, another field, or a relative time." }; }
  if (rhsMissing(node)) { return { state: "incomplete", text: `Enter the value to compare with ${lhs}.` }; }
  if (node.lookup === "isnull") { return { state: "complete", text: `${context.postFilter ? "Keeps calculated results where" : "Keeps rows where"} ${lhs} ${isNullPhrase(node)}.` }; }
  const lookup = guidanceForLookup(node.lookup);
  const rhs = describeRhs(node.rhs, context);
  const prefix = context.postFilter ? "Keeps calculated results where" : node.negated ? "Excludes rows where" : "Keeps rows where";
  return { state: "complete", text: `${prefix} ${lhs} ${lookup.label} ${rhs}${lookup.qualifier || ""}.` };
}

/** Returns the effective null-state phrase after applying one leaf-level Not flag. */
function isNullPhrase(node) { return Boolean(node?.rhs?.value) !== Boolean(node?.negated) ? "is null" : "has a value"; }

/** Describes one supported RHS in one bounded sentence fragment. */
function describeRhs(rhs, context) {
  if (!rhs || typeof rhs !== "object") { return "a value"; }
  if (rhs.kind === "field") { return describeReference(rhs, context); }
  if (rhs.kind === "outerField") { return `current outer-row ${describeReference(rhs, context)}`; }
  if (rhs.kind === "list") { return `${Math.max(0, rhs.values?.length || 0)} listed value${rhs.values?.length === 1 ? "" : "s"}`; }
  if (rhs.kind === "range") { return `${formatQueryLiteral(rhs.lower)} and ${formatQueryLiteral(rhs.upper)}`; }
  if (rhs.kind === "relativeTime") { return `${rhs.amount || 0} ${rhs.unit || "days"} ${rhs.direction === "future" ? "after" : "before"} ${rhs.anchor || "now"}`; }
  return formatQueryLiteral(rhs.value);
}

/** Explains the Boolean behavior of a predicate group, including empty roots. */
export function explainPredicateGroup(group, context = {}) {
  const count = Array.isArray(group?.children) ? group.children.length : 0;
  if (!count) {
    if (context.postFilter) { return { state: "empty", text: "No calculated-result filter. All calculated rows or groups will remain." }; }
    return { state: "empty", text: context.root === false ? "This nested group has no conditions. Add a condition or remove the group." : "No source-row filter. Applying this draft would include every row." };
  }
  const text = group?.join === "or" ? "At least one condition in this group must match." : "Every condition in this group must match.";
  return { state: "complete", text: group?.negated ? "Rows that match this whole group will be excluded." : text };
}

/** Explains a relation- or model-based EXISTS predicate without compiling it. */
export function explainExistsPredicate(node, context = {}) {
  const target = node?.source?.kind === "relation" ? String(node.source.relation || "related") : `${node?.source?.target?.app || ""}.${node?.source?.target?.model || "model"}`;
  if (!node?.source) { return { state: "incomplete", text: "Choose a related source for this existence check." }; }
  if (node.source.kind === "model" && !(node.correlations || []).some((item) => item?.targetPath && item?.outerPath)) { return { state: "incomplete", text: "Choose both target and current-row fields to complete this connection." }; }
  const text = node.negated ? `Keeps rows only when no ${target} row matches the selected conditions.` : `Keeps rows when at least one ${target} row matches the selected conditions.`;
  return { state: "complete", text };
}

/** Explains one computed column based on its declared kind and completion state. */
export function explainComputedColumn(item, context = {}) {
  if (!item?.kind) { return { state: "incomplete", text: "Choose the kind of calculated value to add." }; }
  if (!item?.alias) { return { state: "incomplete", text: "Name this calculated value so later filters and ordering can refer to it." }; }
  const guidance = guidanceForComputedKind(item.kind);
  const disabled = item.enabled === false;
  return { state: disabled ? "warning" : "complete", text: disabled ? `\`${item.alias}\` is disabled and will not affect this query.` : `Adds \`${item.alias}\`: ${guidance.description}`, technical: guidance.limit };
}

/** Explains a subquery correlation without exposing raw objects. */
export function explainCorrelation(item, context = {}) {
  if (!item?.targetPath || !item?.outerPath) { return { state: "incomplete", text: "Choose both target and current-row fields to complete this connection." }; }
  return { state: "complete", text: `Connect target \`${item.targetPath}\` to current-row \`${item.outerPath}\`.` };
}

/** Summarizes rows, summary grouping, and visible ordering. */
export function explainResult(recipe, context = {}) {
  if (recipe?.mode === "summary") {
    return { state: "complete", text: recipe.groupBy?.length ? "The query returns one summary row for each unique combination of the selected fields." : "No group field is selected. The query returns one global summary row." };
  }
  return { state: "complete", text: recipe?.orderBy?.length ? `Orders results by ${recipe.orderBy.map((term) => `${describeReference(term.ref, context)} ${term.direction === "desc" ? "descending" : "ascending"}`).join(", then ")}.` : "No order is selected. Rows use the primary key ascending." };
}

/** Lists non-obvious compiler behavior once for a ready draft. */
export function explainImplicitBehavior(recipe, validation = {}, context = {}) {
  const messages = [];
  const codes = new Set((validation.issues || []).map((issue) => issue?.code));
  if (!recipe?.orderBy?.length && recipe?.mode !== "summary") { messages.push("Order rows by the primary key ascending because no result order is set."); }
  if ((recipe?.computed || []).some((item) => item?.kind === "scalarSubquery" && !item.orderBy?.length) && !codes.has("SUBQUERY_IMPLICIT_ORDER")) { messages.push("Order the subquery by its primary key ascending because no inner order is set."); }
  if (context.transport) { messages.push(`Run through ${context.transport}.`); }
  messages.push("Keep the previous grid visible until this draft applies successfully.");
  return messages;
}

/** Returns the exact availability state and recovery sentence for Apply controls. */
export function applyAvailability(snapshot = {}, state = {}) {
  const revision = snapshot.draftRevision ?? state.draftRevision ?? 0;
  const errors = (state.validation?.issues || []).filter((issue) => issue?.severity !== "warning").length;
  if (!state.source && !snapshot.draft?.source) { return { state: "disabled", text: "Open a model before applying a query." }; }
  if (state.applying) { return { state: "applying", text: `Applying Recipe revision ${revision}. You can continue editing a newer draft.` }; }
  if (state.metadataState === "pending") { return { state: "checking", text: "Loading field details before the query can be validated." }; }
  if (state.checking) { return { state: "checking", text: "Checking this draft against the current model and transport." }; }
  if (state.stale) { return { state: "checking", text: "Waiting for validation of the latest draft." }; }
  if (errors) { return { state: "error", text: `Fix ${errors} error${errors === 1 ? "" : "s"} before applying this draft.` }; }
  return snapshot.dirty ? { state: "ready", text: "Ready to apply. The grid will update only after the query succeeds." } : { state: "current", text: "This draft matches the applied query." };
}

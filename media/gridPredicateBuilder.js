// Recursive accessible ModelQueryRecipeV2 predicate editor shared by WHERE, Result, aggregate, subquery, and Case contexts.

import { LOOKUP_LABELS, createPredicateValueEditor, defaultLookup, lookupsForField, rhsIsCompatible, rhsKindsFor } from "./gridPredicateValue.js";
import { createGridCombobox } from "./gridCombobox.js";
import { createQueryFieldPicker } from "./gridQueryFieldPicker.js";
import { explainComparison, explainPredicateGroup } from "./gridQueryExplanation.js";
import { createMeaningLine } from "./gridQueryGuidanceView.js";

const MAX_CHILDREN = 16;
const MAX_DEPTH = 5;
const MAX_CORRELATIONS = 4;

/** Returns the Recipe store scope used by its generic structural action reducer. */
function actionScope(context) {
  return context === "postFilter" ? "postFilter" : "where";
}

/** Returns all groups and predicate nodes below a root while preserving visual child order. */
function walk(group, visit, depth = 1) {
  if (!group || group.kind !== "group") { return; }
  visit(group, undefined, depth);
  for (const node of group.children || []) {
    visit(node, group, depth);
    if (node.kind === "group") { walk(node, visit, depth + 1); }
    if (node.kind === "existsPredicate") { walk(node.where, visit, depth + 1); }
  }
}

/** Finds a predicate group by stable identifier in a recipe or standalone group. */
function findGroup(value, nodeId) {
  let found;
  const roots = value?.kind === "group" ? [value] : [value?.where, value?.postFilter].filter(Boolean);
  for (const root of roots) { walk(root, (node) => { if (!found && node.kind === "group" && node.nodeId === nodeId) { found = node; } }); }
  return found;
}

/** Finds a predicate node and direct group parent by stable identifier. */
function findNode(value, nodeId) {
  let found;
  const roots = value?.kind === "group" ? [value] : [value?.where, value?.postFilter].filter(Boolean);
  for (const root of roots) { walk(root, (node, parent) => { if (!found && node.nodeId === nodeId) { found = { node, parent }; } }); }
  return found;
}

/** Returns a shallow-safe field descriptor from source columns and metadata tree fields. */
function fieldsFor(scope, metadata) {
  const target = scope?.target || scope?.source || scope?.modelRef;
  const tree = target ? metadata?.getState?.(target)?.tree : undefined;
  const fromTree = (tree?.fields || []).map((field) => ({ ...field, path: field.name, role: "field" }));
  const fromColumns = (scope?.columns || []).map((field) => ({ ...field, path: field.attname || field.name, role: "field" }));
  const fromComputed = (scope?.computedFields || scope?.computed || []).filter((field) => field?.enabled !== false && (field?.alias || field?.path)).map((field) => ({ alias: field.alias || field.path, path: field.alias || field.path, role: "computed", type: field.outputType || "" }));
  const seen = new Set();
  return [...fromTree, ...fromColumns, ...fromComputed].filter((field) => field.path && !seen.has(`${field.role}:${field.path}`) && seen.add(`${field.role}:${field.path}`));
}

/** Returns a live field descriptor for a selected Recipe path, preserving invalid paths as unresolved. */
function fieldForPath(path, fields) {
  return fields.find((field) => field.path === path) || { path, role: "field", type: "" };
}

/** Returns validation issues associated with one stable node id. */
function issuesFor(validation, nodeId) {
  const source = typeof validation === "function" ? validation() : validation;
  return (source?.issues || []).filter((issue) => issue?.nodeId === nodeId);
}

/** Returns one complete node replacement while retaining required Recipe fields instead of silently normalizing it. */
function nodeChanges(node, changes) {
  return { ...node, ...changes };
}

/** Creates the recursive native-control predicate builder; controller/store wiring supplies the immutable Recipe. */
export function createPredicateBuilder({ context = "where", dispatch, el, getRecipe, getScope, metadata, requestRender, rootNodeId, validation, popoverLayer } = {}) {
  const node = el("fieldset", { ariaLabel: `${context} predicate builder`, className: "query-predicate-builder", dataset: { context, role: "predicate-builder" } });
  const legend = el("legend", {}, contextLabel(context));
  const body = el("div", { className: "query-predicate-body" });
  const status = el("div", { ariaLive: "polite", className: "query-predicate-status", role: "status" });
  node.append(legend, status, body);
  let disposed = false;
  let pickerDisposables = [];
  let requestedFocus;

  /** Retains one nested picker until this predicate subtree is rebuilt or destroyed. */
  function trackPicker(picker) { pickerDisposables.push(picker); return picker; }

  /** Releases nested picker listeners before their containing DOM is discarded. */
  function releasePickers() { for (const picker of pickerDisposables) { picker.destroy?.(); picker.dispose?.(); } pickerDisposables = []; }

  /** Reads the configured root group from the latest immutable Recipe snapshot. */
  function root() { return findGroup(getRecipe?.(), rootNodeId) || (getRecipe?.()?.kind === "group" ? getRecipe() : undefined); }

  /** Sends an action and requests a follow-up render; callers may independently render through store subscription. */
  function act(action, focus) {
    requestedFocus = focus;
    dispatch?.({ ...action, scope: action.scope || actionScope(context) });
    const structural = action.type !== "UPDATE_NODE" || action.history?.mode !== "text";
    if (structural) {
      if (requestRender) { requestRender(); }
      else { queueMicrotask(() => { if (!disposed) { render(); } }); }
    }
  }

  /** Ensures root metadata is requested without hiding the editor behind a flat-field fallback. */
  function requestMetadata() {
    const scope = getScope?.() || {};
    const target = scope.target || scope.source || scope.modelRef;
    if (!target || !metadata?.loadTree) { return; }
    const state = metadata.getState?.(target);
    if (!state?.tree && !state?.pending && !state?.error) { metadata.loadTree(target).catch(() => {}); }
  }

  /** Rebuilds the complete bounded subtree from the current draft recipe. */
  function render() {
    requestMetadata();
    const group = root();
    releasePickers();
    body.replaceChildren();
    if (!group) {
      body.appendChild(el("p", { className: "query-builder-empty" }, "Loading predicate group…"));
      return;
    }
    const scope = getScope?.() || {};
    const target = scope.target || scope.source || scope.modelRef;
    const state = target ? metadata?.getState?.(target) : undefined;
    if (state?.pending && !state.tree) { status.textContent = "Loading fields…"; }
    else if (state?.error && !state.tree) {
      status.replaceChildren("Field metadata failed. ");
      const retry = el("button", { type: "button" }, "Retry");
      retry.addEventListener("click", () => metadata.retry?.(target).catch(() => {}));
      status.appendChild(retry);
    } else { status.textContent = ""; }
    renderGroup(group, body, 1);
    restoreFocus();
  }

  /** Renders a nested group with its join/not state, structural actions, child rows, and inline issues. */
  function renderGroup(group, container, depth) {
    const section = el("fieldset", { className: "query-predicate-group", dataset: { depth: String(depth), queryNodeId: group.nodeId, role: "predicate-group" } });
    const heading = el("legend", {}, depth === 1 ? "Conditions" : "Nested conditions");
    const toolbar = el("div", { className: "query-predicate-toolbar" });
    const join = nativeSelect([{ label: "Match all (AND)", value: "and" }, { label: "Match any (OR)", value: "or" }], group.join, "Join conditions");
    join.addEventListener("change", () => act({ changes: { join: join.value }, nodeId: group.nodeId, type: "UPDATE_NODE" }));
    const negated = el("input", { ariaLabel: "Negate group", checked: Boolean(group.negated), type: "checkbox" });
    negated.addEventListener("change", () => act({ changes: { negated: negated.checked }, nodeId: group.nodeId, type: "UPDATE_NODE" }));
    const notLabel = el("label", { className: "query-predicate-not" }, negated, "Exclude this group (NOT)");
    const addComparison = structuralButton("Add condition", "Add condition to this group", () => act({ parentId: group.nodeId, type: "ADD_COMPARISON" }, { nodeId: group.nodeId, role: "lhs" }));
    const addGroup = structuralButton("Add group", "Add nested condition group", () => act({ parentId: group.nodeId, type: "ADD_GROUP" }, { nodeId: group.nodeId, role: "lhs" }));
    const addExists = structuralButton("Add existence check", "Add related-row existence check", () => act({ parentId: group.nodeId, type: "ADD_EXISTS_PREDICATE" }, { nodeId: group.nodeId, role: "lhs" }));
    const blocked = depth >= MAX_DEPTH || (group.children || []).length >= MAX_CHILDREN;
    addComparison.disabled = blocked; addGroup.disabled = blocked; addExists.disabled = blocked || !allowsExists(context);
    addComparison.title = blocked ? `Maximum depth ${MAX_DEPTH} or ${MAX_CHILDREN} children reached` : "Add condition";
    addGroup.title = blocked ? `Maximum depth ${MAX_DEPTH} or ${MAX_CHILDREN} children reached` : "Add nested group";
    if ((group.children || []).length > 1) { toolbar.appendChild(join); }
    toolbar.append(notLabel, addComparison, addGroup);
    if (allowsExists(context)) { toolbar.appendChild(addExists); }
    section.append(heading, toolbar, inlineIssues(group.nodeId));
    const children = el("div", { className: "query-predicate-children" });
    for (const child of group.children || []) {
      if (child.kind === "group") { renderGroup(child, children, depth + 1); }
      else if (child.kind === "comparison") { renderComparison(child, children); }
      else if (child.kind === "existsPredicate") { renderExists(child, children, depth); }
    }
    if (!(group.children || []).length) { children.appendChild(createMeaningLine({ el, explanation: explainPredicateGroup(group, { postFilter: context === "postFilter", root: depth === 1 }), id: `query-meaning-${group.nodeId}` })); }
    section.appendChild(children);
    if (depth > 1) { section.appendChild(nodeActions(group, group)); }
    container.appendChild(section);
  }

  /** Renders path, lookup, RHS kind/value, and structural controls without coercing incompatible prior values. */
  function renderComparison(comparison, container) {
    const scope = getScope?.() || {};
    const fields = fieldsFor(scope, metadata);
    const path = comparison.lhs?.kind === "computed" ? comparison.lhs.alias : (comparison.lhs?.kind === "field" ? comparison.lhs.path : "");
    const field = fieldForPath(path, fields);
    const row = el("div", { className: "query-predicate-row", dataset: { queryNodeId: comparison.nodeId, role: "comparison" } });
    const fieldPicker = trackPicker(createQueryFieldPicker({ ariaLabel: "Condition field", computed: scope.computedFields || scope.computed || [], current: path, el, metadata, onChange: (selectedPath) => { const computed = fields.some((entry) => entry.role === "computed" && entry.path === selectedPath); act({ changes: { lhs: computed ? { alias: selectedPath, kind: "computed" } : { kind: "field", path: selectedPath } }, nodeId: comparison.nodeId, type: "UPDATE_NODE" }); }, popoverLayer, source: scope.target || scope.source, allowRelationTerminal: comparison.lookup === "isnull" }));
    fieldPicker.node.dataset.focusRole = "lhs";
    const lookups = lookupsForField(field);
    const lookup = nativeSelect(lookups.map((value) => ({ label: LOOKUP_LABELS[value] || value, value })), comparison.lookup, "Comparison");
    lookup.setAttribute("aria-description", "(i) means case-insensitive.");
    lookup.addEventListener("change", () => act({ changes: lookupChanges(comparison, lookup.value), nodeId: comparison.nodeId, type: "UPDATE_NODE" }));
    const rhsKinds = rhsKindsFor({ context, field, lookup: comparison.lookup });
    const rhsKind = nativeSelect(rhsKinds.map((value) => ({ label: rhsLabel(value), value })), comparison.rhs?.kind, "Compare with");
    rhsKind.addEventListener("change", () => act({ changes: { rhs: starterRhs(rhsKind.value) }, nodeId: comparison.nodeId, type: "UPDATE_NODE" }));
    const rhs = comparison.rhs?.kind === rhsKind.value ? comparison.rhs : starterRhs(rhsKind.value);
    const valueEditor = createPredicateValueEditor({ context, el, field, lookup: comparison.lookup, onChange: (next) => act({ changes: { rhs: next }, history: { group: `predicate:${comparison.nodeId}:rhs`, mode: "text" }, nodeId: comparison.nodeId, type: "UPDATE_NODE" }), outerFields: scope.outerFields || [], popoverLayer, rhs, scopeFields: fields });
    if (valueEditor.destroy) { trackPicker(valueEditor); }
    const negate = el("input", { ariaLabel: "Negate condition", checked: Boolean(comparison.negated), type: "checkbox" });
    negate.addEventListener("change", () => act({ changes: { negated: negate.checked }, nodeId: comparison.nodeId, type: "UPDATE_NODE" }));
    row.append(el("label", {}, "Field", fieldPicker.node), el("label", {}, "Comparison", lookup), el("label", {}, "Compare with", rhsKind), el("label", {}, "Value", valueEditor.node), el("label", {}, negate, "Not"), nodeActions(comparison));
    if (!rhsIsCompatible(comparison.rhs, context, field, comparison.lookup)) { row.dataset.invalid = "true"; row.appendChild(el("span", { className: "query-predicate-help", role: "note" }, "Value is incompatible with the selected field or lookup. Choose a new value.")); }
    row.appendChild(inlineIssues(comparison.nodeId));
    row.appendChild(createMeaningLine({ el, explanation: explainComparison(comparison, { fields: Object.fromEntries(fields.map((item) => [item.path, item])), issues: issuesFor(validation, comparison.nodeId), metadataState: metadata?.getState?.(scope.target || scope.source)?.pending ? "pending" : "ready", postFilter: context === "postFilter" }), id: `query-meaning-${comparison.nodeId}` }));
    container.appendChild(row);
  }

  /** Renders an Exists node and its isolated nested target predicate group. */
  function renderExists(exists, container, depth) {
    const scope = getScope?.() || {};
    const row = el("section", { ariaLabel: "Exists predicate", className: "query-predicate-exists", dataset: { queryNodeId: exists.nodeId, role: "exists" } });
    const source = exists.source || { kind: "relation", relation: "" };
    const type = nativeSelect([{ label: "Relation", value: "relation" }, { label: "Model", value: "model" }], source.kind, "Exists source type");
    type.addEventListener("change", () => act({ changes: { correlations: [], source: type.value === "model" ? { kind: "model", target: { app: "", model: "" } } : { kind: "relation", relation: "" } }, nodeId: exists.nodeId, type: "UPDATE_NODE" }));
    row.append(el("strong", {}, "Exists"), type);
    if (source.kind === "relation") {
      const relations = scope.relations || [];
      const relation = trackPicker(createGridCombobox({ el, label: "Exists relation", onChange: (value) => act({ changes: { source: { kind: "relation", relation: value } }, nodeId: exists.nodeId, type: "UPDATE_NODE" }), options: [{ label: "Choose relation", value: "" }, ...relations.map((item) => ({ description: `${item.kind || "relation"}. ${item.target || "related model"}`, label: `${item.label || item.name} → ${item.target || "related model"}`, value: item.queryName || item.name }))], popoverLayer, value: source.relation }));
      row.appendChild(relation.node);
      row.appendChild(el("span", { className: "query-predicate-static", role: "note" }, source.relation ? "Correlation is generated from this relation." : "Choose a relation to show its generated correlation."));
    } else {
      const models = metadata?.getCatalog?.() || [];
      const current = source.target ? `${source.target.app}.${source.target.model}` : "";
      const model = trackPicker(createGridCombobox({ el, label: "Exists target model", onChange: (value) => { const [app, ...rest] = value.split("."); act({ changes: { source: { kind: "model", target: { app, model: rest.join(".") } } }, nodeId: exists.nodeId, type: "UPDATE_NODE" }); }, options: [{ label: "Choose model", value: "" }, ...models.map((item) => ({ label: `${item.app}.${item.model}`, value: `${item.app}.${item.model}` }))], popoverLayer, value: current }));
      row.appendChild(model.node);
      renderCorrelations(exists, row, scope);
    }
    const negated = el("input", { ariaLabel: "Negate Exists", checked: Boolean(exists.negated), type: "checkbox" });
    negated.addEventListener("change", () => act({ changes: { negated: negated.checked }, nodeId: exists.nodeId, type: "UPDATE_NODE" }));
    row.append(el("label", {}, negated, "Not"), nodeActions(exists), inlineIssues(exists.nodeId));
    if (exists.where?.kind === "group") { renderGroup(exists.where, row, depth + 1); }
    container.appendChild(row);
  }

  /** Renders editable custom-model correlations while preserving the 1–4 backend contract. */
  function renderCorrelations(exists, container, scope) {
    const correlations = Array.isArray(exists.correlations) ? exists.correlations : [];
    const region = el("fieldset", { className: "query-correlations" });
    region.appendChild(el("legend", {}, "Correlations"));
    for (const [index, correlation] of correlations.entries()) {
      const target = trackPicker(createQueryFieldPicker({ ariaLabel: "Target field", current: correlation.targetPath || "", el, metadata, onChange: updateTarget, popoverLayer, source: exists.source?.target }));
      const outer = trackPicker(createQueryFieldPicker({ ariaLabel: "Current outer-row field", current: correlation.outerPath || "", el, metadata, onChange: updateOuter, popoverLayer, source: scope?.source || scope?.target }));
      const remove = structuralButton("Remove", "Remove correlation", () => { const next = correlations.filter((_, itemIndex) => itemIndex !== index); act({ changes: { correlations: next }, nodeId: exists.nodeId, type: "UPDATE_NODE" }); });
      /** Updates only the inner target path selected by the metadata-backed picker. */
      function updateTarget(path) { update({ targetPath: path }); }
      /** Updates only the outer-row path selected by the metadata-backed picker. */
      function updateOuter(path) { update({ outerPath: path }); }
      /** Applies one correlation patch without discarding the adjacent picker selection. */
      function update(changes) { const next = correlations.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item); act({ changes: { correlations: next }, nodeId: exists.nodeId, type: "UPDATE_NODE" }); }
      region.append(el("div", { className: "query-correlation" }, target.node, el("span", { ariaHidden: "true" }, "= current-row"), outer.node, remove, createMeaningLine({ el, explanation: { state: correlation.targetPath && correlation.outerPath ? "complete" : "incomplete", text: correlation.targetPath && correlation.outerPath ? `Connect target \`${correlation.targetPath}\` to current-row \`${correlation.outerPath}\`.` : "Choose both target and current-row fields to complete this connection." }, id: `query-correlation-${correlation.nodeId}` })));
    }
    const add = structuralButton("+ correlation", "Add correlation", () => act({ changes: { correlations: [...correlations, { nodeId: `correlation-${Date.now()}`, outerPath: "", targetPath: "" }] }, nodeId: exists.nodeId, type: "UPDATE_NODE" }));
    add.disabled = correlations.length >= MAX_CORRELATIONS;
    region.appendChild(add); container.appendChild(region);
  }

  /** Renders equivalent visible move, duplicate, and remove buttons for every non-root node. */
  function nodeActions(predicate) {
    const actions = el("span", { className: "query-predicate-actions" });
    actions.append(
      structuralButton("Up", "Move up", () => act({ nodeId: predicate.nodeId, type: "MOVE_NODE_UP" }, { nodeId: predicate.nodeId, role: "lhs" })),
      structuralButton("Down", "Move down", () => act({ nodeId: predicate.nodeId, type: "MOVE_NODE_DOWN" }, { nodeId: predicate.nodeId, role: "lhs" })),
      structuralButton("Duplicate", "Duplicate", () => act({ nodeId: predicate.nodeId, type: "DUPLICATE_NODE" }, { nodeId: predicate.nodeId, role: "lhs" })),
      structuralButton("Remove", "Remove", () => removeNode(predicate.nodeId))
    );
    return actions;
  }

  /** Removes a node and restores focus to the following sibling, prior sibling, or parent add action. */
  function removeNode(nodeId) {
    const found = findNode(getRecipe?.(), nodeId);
    const siblings = found?.parent?.children || [];
    const index = siblings.findIndex((item) => item.nodeId === nodeId);
    const fallback = siblings[index + 1]?.nodeId || siblings[index - 1]?.nodeId || found?.parent?.nodeId;
    act({ nodeId, type: "REMOVE_NODE" }, { nodeId: fallback, role: fallback === found?.parent?.nodeId ? "add" : "lhs" });
  }

  /** Renders node-specific validation message and fix text with text-plus-state semantics. */
  function inlineIssues(nodeId) {
    const region = el("div", { className: "query-predicate-issues", dataset: { queryIssueNodeId: nodeId } });
    renderInlineIssues(region, nodeId);
    return region;
  }

  /** Refreshes only mounted inline issue regions, preserving controls and active text selection. */
  function updateValidation() {
    for (const region of node.querySelectorAll("[data-query-issue-node-id]")) { renderInlineIssues(region, region.dataset.queryIssueNodeId); }
  }

  /** Rebuilds one issue-message subtree without replacing its owning predicate editor. */
  function renderInlineIssues(region, nodeId) {
    region.id = `query-node-issues-${nodeId}`;
    region.replaceChildren();
    for (const issue of issuesFor(validation, nodeId)) { region.appendChild(el("p", { dataset: { severity: issue.severity || "error" }, role: "note" }, `${issue.severity === "warning" ? "Warning" : "Error"}: ${issue.message || issue.code}. ${issue.fix || ""}`)); }
  }

  /** Restores deferred structural focus after an immutable re-render. */
  function restoreFocus() {
    if (!requestedFocus) { return; }
    const request = requestedFocus; requestedFocus = undefined;
    const container = node.querySelector(`[data-query-node-id="${escapeSelector(request.nodeId)}"]`);
    const selector = request.role === "add" ? "button" : "[data-focus-role=lhs], input, select, button";
    container?.querySelector(selector)?.focus();
  }

  /** Supports keyboard equivalents for move and duplicate without removing the visible buttons. */
  function onKeydown(event) {
    if (!event.altKey && !(event.ctrlKey || event.metaKey)) { return; }
    const target = event.target?.closest?.("[data-query-node-id]");
    const nodeId = target?.dataset?.queryNodeId;
    if (!nodeId) { return; }
    if (event.altKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); act({ nodeId, type: event.key === "ArrowUp" ? "MOVE_NODE_UP" : "MOVE_NODE_DOWN" }, { nodeId, role: "lhs" }); }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "d") { event.preventDefault(); act({ nodeId, type: "DUPLICATE_NODE" }, { nodeId, role: "lhs" }); }
  }

  /** Releases event wiring; callers own the containing drawer and its DOM lifecycle. */
  function destroy() { disposed = true; releasePickers(); node.removeEventListener("keydown", onKeydown); }

  node.addEventListener("keydown", onKeydown);
  render();
  return { destroy, focusNode: (nodeId) => { requestedFocus = { nodeId, role: "lhs" }; render(); }, node, render, updateValidation };
}

/** Creates a compact accessible select with only allowlisted option values. */
function nativeSelect(options, value, ariaLabel) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", ariaLabel);
  for (const option of options.length ? options : [{ label: "Unavailable", value: "" }]) {
    const child = document.createElement("option"); child.value = option.value; child.textContent = option.label; select.appendChild(child);
  }
  select.value = options.some((option) => option.value === value) ? value : options[0]?.value || "";
  return select;
}

/** Creates a compact secondary structural button following the existing VS Code-native button language. */
function structuralButton(label, ariaLabel, onClick) {
  const button = document.createElement("button");
  button.type = "button"; button.textContent = label; button.setAttribute("aria-label", ariaLabel); button.addEventListener("click", onClick); return button;
}

/** Returns a canonical starter RHS that never masks incompatibility in the existing node. */
function starterRhs(kind) {
  if (kind === "list") { return { kind, values: [] }; }
  if (kind === "range") { return { kind, lower: null, upper: null }; }
  if (kind === "relativeTime") { return { amount: 1, anchor: "now", direction: "past", kind, unit: "days" }; }
  return kind === "literal" ? { kind, value: null } : { kind, path: "" };
}

/** Returns the complete comparison patch required when a lookup changes its RHS value contract. */
function lookupChanges(comparison, lookup) {
  if (lookup === "isnull") { return { lookup, rhs: { kind: "literal", value: true } }; }
  return comparison?.lookup === "isnull" ? { lookup, rhs: { kind: "literal", value: null } } : { lookup };
}

/** Returns the visible label for one structured RHS variant. */
function rhsLabel(kind) {
  return { field: "field", literal: "value", outerField: "outer field", relativeTime: "relative time" }[kind] || kind;
}

/** Returns whether the current context permits an Exists predicate. */
function allowsExists(context) { return context === "where" || context === "postFilter" || context === "subquery"; }

/** Returns a stable visual context label without exposing internal enum names. */
function contextLabel(context) { return { aggregateFilter: "Aggregate filter", case: "Case condition", postFilter: "Result filter", subquery: "Subquery filter", where: "WHERE" }[context] || "Conditions"; }

/** Escapes an opaque node id for the builder's focus-only attribute selector. */
function escapeSelector(value) { return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : String(value || "").replace(/[^A-Za-z0-9_-]/g, "\\$&"); }

/** Exposes structural and context helpers for non-DOM unit tests. */
export const __test = { actionScope, allowsExists, findGroup, findNode, lookupChanges, rhsLabel, starterRhs, MAX_CHILDREN, MAX_CORRELATIONS, MAX_DEPTH };

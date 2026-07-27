// Scalar Subquery and Exists computed-column editors with explicit correlation state.
import { createComputedPredicateEditor, computedInput, computedSelect } from "./gridComputedShared.js";
import { createGridCombobox } from "./gridCombobox.js";
import { createQueryFieldPicker } from "./gridQueryFieldPicker.js";
import { MODEL_QUERY_AGGREGATE_FUNCTIONS, MODEL_QUERY_OUTPUT_TYPES, MODEL_QUERY_RECIPE_LIMITS } from "./gridQueryRecipeLimits.js";

/** Returns app-qualified metadata catalog entries, preserving the backend's explicit model identity. */
function catalog(metadata) { return metadata?.getCatalog?.() || []; }

/** Parses a backend app-qualified model label into the picker target shape. */
function targetFromLabel(label) {
  const value = String(label || "");
  const boundary = value.lastIndexOf(".");
  return boundary > 0 ? { app: value.slice(0, boundary), model: value.slice(boundary + 1) } : undefined;
}

/** Resolves the selected scalar source into the model whose fields can be safely picked. */
function sourceTarget(source, scope) {
  if (source?.kind === "model") { return source.target?.app && source.target?.model ? { app: source.target.app, model: source.target.model } : undefined; }
  return targetFromLabel((scope?.relations || []).find((relation) => relation?.name === source?.relation || relation?.queryName === source?.relation)?.target);
}

/** Returns the filter-query identity required by Recipe validation while retaining the accessor label in the UI. */
function relationValue(relation) { return relation?.queryName || relation?.name || ""; }

/** Retains one picker disposer in the specialized builder that owns its DOM lifetime. */
function trackPicker(pickers, picker) {
  if (picker) { pickers?.push(() => { picker.destroy?.(); picker.dispose?.(); }); }
  return picker;
}

/** Releases every nested picker or predicate editor retained by one specialized builder. */
function releasePickers(pickers) { for (const dispose of pickers || []) { dispose(); } }

/** Moves one bounded subquery-order entry without mutating the prior Recipe array. */
function moveSubqueryOrder(entries, index, delta) {
  const next = [...(entries || [])];
  const target = index + delta;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) { return next; }
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Creates a metadata-backed field picker or a direct explanation until its source is complete. */
function sourceFieldPicker({ ariaLabel, computed, dispatch, el, item, metadata, onChange, pickers, popoverLayer, scope, value }) {
  const target = sourceTarget(item.source, scope);
  if (!target) { return el("p", { className: "query-control-help" }, "Choose a relation or model source before selecting a field."); }
  const picker = trackPicker(pickers, createQueryFieldPicker({ ariaLabel, computed, current: value, el, metadata, onChange, popoverLayer, source: target, context: "subquery" }));
  return picker.node;
}

/** Renders one source picker for a scalar Subquery or Exists column. */
function sourceControls({ dispatch, el, item, metadata, pickers, popoverLayer, scope }) {
  const wrap = el("fieldset", { className: "query-subquery-source" });
  wrap.appendChild(el("legend", {}, "1. Source"));
  const source = item.source || { kind: "relation", relation: "" };
  const kind = computedSelect(el, "Subquery source type", [{ label: "Relation", value: "relation" }, { label: "Model", value: "model" }], source.kind, (value) => dispatch({ changes: { source: value === "model" ? { kind: "model", target: { app: "", model: "" } } : { kind: "relation", relation: "" } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  wrap.appendChild(el("label", {}, "Source", kind));
  if (source.kind === "relation") {
    const relation = trackPicker(pickers, createGridCombobox({ el, label: "Relation", onChange: (value) => dispatch({ changes: { source: { kind: "relation", relation: value } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), options: [{ label: "Choose related rows", value: "" }, ...(scope?.relations || []).map((entry) => ({ description: `${entry.kind || "relation"}. ${entry.target || "related model"}`, label: `${entry.label || entry.name} → ${entry.target || "related model"}`, value: relationValue(entry) }))], popoverLayer, value: source.relation }));
    wrap.appendChild(el("label", {}, "Relation", relation.node));
  } else {
    const target = `${source.target?.app || ""}.${source.target?.model || ""}`.replace(/^\.|\.$/g, "");
    const model = trackPicker(pickers, createGridCombobox({ el, label: "Subquery model", onChange: (value) => { const split = value.lastIndexOf("."); dispatch({ changes: { source: { kind: "model", target: split > 0 ? { app: value.slice(0, split), model: value.slice(split + 1) } : { app: "", model: "" } } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }); }, options: [{ label: "Choose model", value: "" }, ...catalog(metadata).map((entry) => ({ label: `${entry.app}.${entry.model}`, value: `${entry.app}.${entry.model}` }))], popoverLayer, value: target }));
    wrap.appendChild(el("label", {}, "Model", model.node));
  }
  return wrap;
}

/** Renders bounded custom-model correlation controls; relation correlation stays read-only and implicit. */
function correlationControls({ dispatch, el, item, metadata, pickers, popoverLayer, scope }) {
  const root = el("fieldset", { className: "query-subquery-correlations" });
  root.appendChild(el("legend", {}, "2. Connection"));
  if (item.source?.kind === "relation") { root.appendChild(el("p", { className: "query-builder-empty" }, "The selected relation supplies correlation automatically.")); return root; }
  const entries = item.correlations || [];
  for (const [index, correlation] of entries.entries()) {
    const row = el("div", { className: "query-subquery-correlation", dataset: { queryNodeId: correlation.nodeId } });
    const outer = trackPicker(pickers, createQueryFieldPicker({ ariaLabel: "Outer field", current: correlation.outerPath, el, metadata, onChange: (value) => change(index, { outerPath: value }), popoverLayer, source: scope?.source, context: "subquery" }));
    const target = sourceFieldPicker({ ariaLabel: "Target field", dispatch, el, item, metadata, onChange: (value) => change(index, { targetPath: value }), pickers, popoverLayer, scope, value: correlation.targetPath });
    const remove = el("button", { ariaLabel: "Remove correlation", className: "secondary", type: "button" }, "Remove");
    remove.addEventListener("click", () => dispatch({ changes: { correlations: entries.filter((_, entryIndex) => entryIndex !== index) }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
    row.append(el("label", {}, "Outer", outer.node), el("label", {}, "Target", target), remove); root.appendChild(row);
    /** Updates one correlation without altering siblings or their source-order semantics. */
    function change(entryIndex, changes) { dispatch({ changes: { correlations: entries.map((entry, current) => current === entryIndex ? { ...entry, ...changes } : entry) }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }); }
  }
  const add = el("button", { className: "secondary", type: "button" }, "Add correlation");
  add.disabled = entries.length >= MODEL_QUERY_RECIPE_LIMITS.subqueryCorrelations;
  add.addEventListener("click", () => dispatch({ changes: { correlations: [...entries, { nodeId: `${item.nodeId}-correlation-${entries.length + 1}`, outerPath: "", targetPath: "" }] }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  root.appendChild(add);
  return root;
}

/** Renders the scalar-only select, order, empty-value, and output-type controls. */
function scalarControls({ dispatch, el, item, metadata, pickers, popoverLayer, scope }) {
  const root = el("div", { className: "query-subquery-scalar" });
  const select = item.select || { field: { kind: "field", path: "" }, kind: "field" };
  const returned = el("fieldset", { className: "query-subquery-returned" });
  returned.appendChild(el("legend", {}, "4. Returned value"));
  const kind = computedSelect(el, "Subquery select type", [{ label: "Field", value: "field" }, { label: "Aggregate", value: "aggregate" }], select.kind, (value) => dispatch({ changes: { select: value === "aggregate" ? { distinct: "auto", field: { kind: "all" }, function: "count", kind: "aggregate" } : { field: { kind: "field", path: "" }, kind: "field" } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  returned.appendChild(el("label", {}, "Select", kind));
  if (select.kind === "field") {
    const field = sourceFieldPicker({ ariaLabel: "Subquery field", dispatch, el, item, metadata, onChange: (value) => dispatch({ changes: { select: { field: { kind: "field", path: value }, kind: "field" } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), pickers, popoverLayer, scope, value: select.field?.path });
    returned.appendChild(el("label", {}, "Field", field));
  } else {
    returned.appendChild(el("label", {}, "Aggregate", computedSelect(el, "Subquery aggregate", MODEL_QUERY_AGGREGATE_FUNCTIONS.map((value) => ({ label: value, value })), select.function, (value) => dispatch({ changes: { select: { ...select, function: value } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }))));
  }
  root.appendChild(returned);
  const orders = item.orderBy || [];
  const orderGroup = el("fieldset", { className: "query-subquery-orders" });
  orderGroup.appendChild(el("legend", {}, "5. Row choice"));
  orderGroup.appendChild(el("p", { className: "query-control-help" }, `Order the matching rows before returning one value (up to ${MODEL_QUERY_RECIPE_LIMITS.subqueryOrderTerms}).`));
  for (const [index, entry] of orders.entries()) {
    const row = el("div", { className: "query-subquery-order", dataset: { queryNodeId: entry.nodeId } });
    const path = sourceFieldPicker({ ariaLabel: "Subquery order field", dispatch, el, item, metadata, onChange: (value) => changeOrder(index, { ref: { kind: "field", path: value } }), pickers, popoverLayer, scope, value: entry.ref?.path });
    const direction = computedSelect(el, "Subquery order direction", [{ label: "Ascending", value: "asc" }, { label: "Descending", value: "desc" }], entry.direction, (value) => changeOrder(index, { direction: value }));
    const up = el("button", { ariaLabel: "Move subquery order up", className: "secondary", type: "button" }, "Up");
    up.disabled = index === 0;
    up.addEventListener("click", () => dispatch({ changes: { orderBy: moveSubqueryOrder(orders, index, -1) }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
    const down = el("button", { ariaLabel: "Move subquery order down", className: "secondary", type: "button" }, "Down");
    down.disabled = index === orders.length - 1;
    down.addEventListener("click", () => dispatch({ changes: { orderBy: moveSubqueryOrder(orders, index, 1) }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
    const remove = el("button", { ariaLabel: "Remove subquery order", className: "secondary", type: "button" }, "Remove");
    remove.addEventListener("click", () => dispatch({ changes: { orderBy: orders.filter((_, current) => current !== index) }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
    row.append(el("label", {}, "Field", path), el("label", {}, "Direction", direction), up, down, remove); orderGroup.appendChild(row);
  }
  const addOrder = el("button", { className: "secondary", type: "button" }, "Add order");
  addOrder.disabled = orders.length >= MODEL_QUERY_RECIPE_LIMITS.subqueryOrderTerms;
  addOrder.addEventListener("click", () => dispatch({ changes: { orderBy: [...orders, { direction: "asc", nodeId: `${item.nodeId}-order-${orders.length + 1}`, ref: { kind: "field", path: "" } }] }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  orderGroup.appendChild(addOrder);
  root.appendChild(orderGroup);
  const outputGroup = el("fieldset", { className: "query-subquery-output" });
  outputGroup.appendChild(el("legend", {}, "6. Output"));
  const empty = computedInput(el, "Empty result literal", item.onEmpty?.value, (value) => dispatch({ changes: { onEmpty: { kind: "literal", value: value || null } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  const output = computedSelect(el, "Output type", MODEL_QUERY_OUTPUT_TYPES.map((value) => ({ label: value, value })), item.outputType, (value) => dispatch({ changes: { outputType: value }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  outputGroup.append(el("label", {}, "On empty", empty), el("label", {}, "Output", output));
  root.appendChild(outputGroup);
  return root;

  /** Updates one ordered term while preserving every other stable order node. */
  function changeOrder(index, changes) { dispatch({ changes: { orderBy: orders.map((entry, current) => current === index ? { ...entry, ...changes } : entry) }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }); }
}

/** Renders a Scalar Subquery item without silently dropping incompatible child state. */
export function renderSubqueryBuilder({ dispatch, el, getRecipe, getScope, item, metadata, popoverLayer, scope, validation }) {
  const root = el("div", { className: "query-computed-body query-subquery-builder" });
  const pickers = [];
  root.append(sourceControls({ dispatch, el, item, metadata, pickers, popoverLayer, scope }), correlationControls({ dispatch, el, item, metadata, pickers, popoverLayer, scope }));
  const targetFilter = el("fieldset", { className: "query-subquery-target-filter" });
  targetFilter.appendChild(el("legend", {}, "3. Target filter"));
  const predicate = createComputedPredicateEditor({ context: "subquery", dispatch, el, getRecipe, getScope: () => getScope?.(item) || {}, item, key: "where", metadata, validation });
  if (predicate) { pickers.push(() => predicate.destroy()); targetFilter.appendChild(predicate.node); predicate.render(); }
  else { targetFilter.appendChild(el("p", { className: "query-builder-empty" }, "No target filter is configured.")); }
  root.append(targetFilter, scalarControls({ dispatch, el, item, metadata, pickers, popoverLayer, scope }));
  const reset = el("button", { className: "secondary", type: "button" }, "Reset incompatible fields");
  reset.addEventListener("click", () => dispatch({ changes: { orderBy: [], select: { field: { kind: "field", path: "" }, kind: "field" }, where: { ...item.where, children: [] } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  root.appendChild(reset);
  root.__queryDestroy = () => releasePickers(pickers);
  return root;
}

/** Renders an Exists item by reusing source, correlation, and nested predicate controls only. */
export function renderExistsComputedBuilder({ dispatch, el, getRecipe, getScope, item, metadata, popoverLayer, scope, validation }) {
  const root = el("div", { className: "query-computed-body query-exists-builder" });
  const pickers = [];
  root.append(sourceControls({ dispatch, el, item, metadata, pickers, popoverLayer, scope }), correlationControls({ dispatch, el, item, metadata, pickers, popoverLayer, scope }));
  const predicate = createComputedPredicateEditor({ context: "subquery", dispatch, el, getRecipe, getScope: () => getScope?.(item) || {}, item, key: "where", metadata, validation });
  if (predicate) { pickers.push(() => predicate.destroy()); root.appendChild(predicate.node); predicate.render(); }
  root.__queryDestroy = () => releasePickers(pickers);
  return root;
}

/** Exposes bounded-source helpers for the focused Subquery unit tests. */
export const __test = {
  canAddCorrelation: (entries) => (entries || []).length < MODEL_QUERY_RECIPE_LIMITS.subqueryCorrelations,
  canAddOrder: (entries) => (entries || []).length < MODEL_QUERY_RECIPE_LIMITS.subqueryOrderTerms,
  moveSubqueryOrder,
  relationValue,
  sourceTarget,
  targetFromLabel
};

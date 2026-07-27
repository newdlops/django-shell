// Computed-column list editor that composes each bounded Recipe annotation builder.
import { createComputedDraft, suggestComputedAlias, summaryUnavailable } from "./gridComputedShared.js";
import { renderAggregateBuilder } from "./gridAggregateBuilder.js";
import { renderCodeExpressionBuilder } from "./gridCodeExpressionBuilder.js";
import { formulaMetrics, renderFormulaBuilder } from "./gridFormulaBuilder.js";
import { renderExistsComputedBuilder, renderSubqueryBuilder } from "./gridSubqueryBuilder.js";
import { renderWindowBuilder } from "./gridWindowBuilder.js";
import { explainComputedColumn } from "./gridQueryExplanation.js";
import { guidanceForComputedKind } from "./gridQueryGuidanceCopy.js";
import { createConceptHelp, createControlHelp, createMeaningLine } from "./gridQueryGuidanceView.js";

const COMPUTED_KINDS = [
  { label: "Aggregate", value: "aggregate" }, { label: "Scalar subquery", value: "scalarSubquery" },
  { label: "Exists", value: "exists" }, { label: "Formula", value: "formula" },
  { label: "Window", value: "window" }, { label: "Code expression", value: "codeExpression" }
];
let computedSequence = 0;

/** Generates a deterministic webview-local ID for a newly added computed column. */
function nextComputedId() { computedSequence += 1; return `computed-ui-${computedSequence}`; }

/** Gives each type a concise, non-ORM description suitable for the collapsed item header. */
function compactDescription(item) {
  if (item.kind === "aggregate") { return `${String(item.function || "count").toUpperCase()}(${item.field?.kind === "all" ? "*" : item.field?.path || "field"})`; }
  if (item.kind === "scalarSubquery") { return `Scalar subquery: ${item.select?.kind === "aggregate" ? item.select.function : item.select?.field?.path || "field"}`; }
  if (item.kind === "exists") { return "Exists annotation"; }
  if (item.kind === "window") { return `Window: ${item.function || "row_number"}`; }
  if (item.kind === "codeExpression") { return item.expression ? "Restricted Django expression" : "Restricted Django expression (empty)"; }
  return `Formula: ${formulaMetrics(item.expression).nodes} node${formulaMetrics(item.expression).nodes === 1 ? "" : "s"}`;
}

/** Reports whether replacing this computed kind would discard a configured body. */
export function requiresKindConfirmation(item) {
  if (!item?.kind || !item?.nodeId) { return false; }
  const body = ({ alias: _alias, enabled: _enabled, kind: _kind, nodeId: _nodeId, ...value }) => value;
  return JSON.stringify(body(item)) !== JSON.stringify(body(createComputedDraft(item.kind, item.nodeId, item.alias)));
}

/** Returns aliases improperly referenced by a Formula before its source-order declaration. */
function formulaForwardReferences(recipe, item) {
  if (item.kind !== "formula") { return []; }
  const index = recipe.computed.findIndex((entry) => entry.nodeId === item.nodeId);
  const permitted = new Set(recipe.computed.slice(0, Math.max(0, index)).filter((entry) => entry.enabled).map((entry) => entry.alias));
  const invalid = new Set();
  /** Walks Formula branches while keeping conditions outside the Formula-expression alias grammar. */
  function visit(node) {
    if (!node || typeof node !== "object") { return; }
    if (node.kind === "computed" && node.alias && !permitted.has(node.alias)) { invalid.add(node.alias); }
    if (node.kind === "binary") { visit(node.left); visit(node.right); }
    if (node.kind === "function") { (node.args || []).forEach(visit); }
    if (node.kind === "case") { (node.branches || []).forEach((branch) => visit(branch.then)); visit(node.else); }
    if (node.kind === "cast") { visit(node.expression); }
  }
  visit(item.expression);
  return [...invalid];
}

/** Selects the specialized editor for a Computed-column variant. */
function bodyFor(item, options) {
  const scoped = { ...options, scope: options.getScope?.(item) };
  if (item.kind === "aggregate") { return renderAggregateBuilder(scoped); }
  if (item.kind === "scalarSubquery") { return renderSubqueryBuilder(scoped); }
  if (item.kind === "exists") { return renderExistsComputedBuilder(scoped); }
  if (item.kind === "window") { return renderWindowBuilder(scoped); }
  if (item.kind === "codeExpression") { return renderCodeExpressionBuilder(scoped); }
  return renderFormulaBuilder(scoped);
}

/** Creates the bounded annotation editor and exposes a small renderer for controller integration. */
export function createComputedBuilder({ cancelKindChange, confirmKindChange, dispatch, el, getRecipe, getScope, metadata, onOpenChange = () => {}, openNodeIds = () => [], pendingKinds = () => [], popoverLayer, requestKindChange, validation } = {}) {
  const node = el("div", { className: "query-computed-builder" });
  const openItems = new Set(openNodeIds());
  let bodyDisposables = [];

  /** Releases specialized editor popovers before their item DOM is replaced. */
  function releaseBodies() { for (const dispose of bodyDisposables) { dispose(); } bodyDisposables = []; }

  /** Adds the selected recipe shape without compiler-side alias mutation. */
  function add(kind = "aggregate") {
    const recipe = getRecipe?.() || { computed: [] };
    const nodeId = nextComputedId();
    dispatch?.({ computed: createComputedDraft(kind, nodeId, suggestComputedAlias(kind, recipe.computed)), type: "ADD_COMPUTED" });
    openItems.add(nodeId); onOpenChange(nodeId, true);
  }

  /** Renders the add control and every source-ordered, independently collapsible computed item. */
  function render() {
    const recipe = getRecipe?.() || { computed: [] };
    releaseBodies();
    node.replaceChildren();
    const toolbar = el("div", { className: "query-computed-toolbar" });
    const kind = el("select", { ariaLabel: "Computed column kind", className: "query-computed-select" });
    for (const option of COMPUTED_KINDS) { kind.appendChild(el("option", { value: option.value }, option.label)); }
    const addButton = el("button", { type: "button" }, "Add calculated value");
    addButton.addEventListener("click", () => add(kind.value));
    toolbar.append(el("label", {}, "Kind", kind), createControlHelp({ control: kind, el, id: "query-computed-kind-help", text: guidanceForComputedKind(kind.value).description }), addButton);
    kind.addEventListener("change", () => toolbar.querySelector(".query-control-help").textContent = guidanceForComputedKind(kind.value).description);
    node.appendChild(toolbar);
    node.appendChild(createConceptHelp({ el, summary: "Which calculated value should I use?", paragraphs: ["Aggregate summarizes values. Scalar subquery returns one matched value. Exists returns true or false.", "Formula combines values, Window calculates across result rows, and Code expression is the restricted advanced option."] }));
    if (!recipe.computed.length) { node.appendChild(el("p", { className: "query-builder-empty" }, "No computed columns. Add one to annotate, calculate, or select a correlated value.")); return; }
    const list = el("div", { className: "query-computed-list" });
    recipe.computed.forEach((item, index) => list.appendChild(renderItem(item, index, recipe)));
    node.appendChild(list);
  }

  /** Returns live validation because host previews may complete without replacing editor controls. */
  function currentValidation() { return typeof validation === "function" ? validation() : validation; }

  /** Rebuilds only computed-column issue blocks after a validation transition. */
  function updateValidation() {
    for (const region of node.querySelectorAll("[data-query-computed-issue-node-id]")) { renderInlineIssues(region, region.dataset.queryComputedIssueNodeId); }
  }

  /** Writes one item's current validation messages without touching its input or disclosure DOM. */
  function renderInlineIssues(region, nodeId) {
    region.id = `query-node-issues-${nodeId}`;
    region.replaceChildren();
    const inline = (currentValidation()?.issues || []).filter((issue) => issue?.nodeId === nodeId);
    for (const issue of inline) { region.appendChild(el("p", { className: "query-node-issue", dataset: { severity: issue.severity || "error" }, role: "note" }, `${issue.severity === "warning" ? "Warning" : "Error"}: ${issue.message || issue.code || "Computed column issue"}`)); }
  }

  /** Renders one full computed column with structural actions kept separate from its field editor. */
  function renderItem(item, index, recipe) {
    const details = el("details", { className: "query-computed-item", dataset: { queryNodeId: item.nodeId } });
    details.open = openItems.has(item.nodeId);
    details.addEventListener("toggle", () => { if (details.open) { openItems.add(item.nodeId); } else { openItems.delete(item.nodeId); } onOpenChange(item.nodeId, details.open); });
    const summary = el("summary", { title: `${item.alias || "Unnamed computed column"}: ${compactDescription(item)}` });
    const enabled = el("input", { ariaLabel: `Enable ${item.alias || "computed column"}`, checked: item.enabled, type: "checkbox" });
    enabled.addEventListener("click", (event) => event.stopPropagation());
    enabled.addEventListener("change", () => dispatch?.({ nodeId: item.nodeId, type: "TOGGLE_COMPUTED" }));
    const title = el("span", { className: "query-computed-item-title" }, item.alias || "Unnamed computed column");
    const description = el("span", { className: "query-computed-item-description" }, compactDescription(item));
    summary.append(enabled, title, description);
    details.appendChild(summary);
    const content = el("div", { className: "query-computed-item-content" });
    const header = el("div", { className: "query-computed-item-header" });
    const alias = el("input", { ariaLabel: "Computed column alias", autocomplete: "off", className: "query-computed-input", dataset: { queryControlKey: `computed:${item.nodeId}:alias` }, maxLength: 64, name: `computed-${item.nodeId}-alias`, spellcheck: false, value: item.alias || "" });
    alias.addEventListener("input", () => dispatch?.({ changes: { alias: alias.value }, history: { group: `computed:${item.nodeId}:alias`, mode: "text" }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
    const type = el("select", { ariaLabel: "Computed column type", className: "query-computed-select" });
    for (const option of COMPUTED_KINDS) { type.appendChild(el("option", { value: option.value }, option.label)); }
    type.value = item.kind;
    type.addEventListener("change", () => {
      if (type.value === item.kind) { return; }
      const changes = createComputedDraft(type.value, item.nodeId, item.alias);
      if (requiresKindConfirmation(item)) { requestKindChange?.(item, type.value); type.value = item.kind; }
      else { dispatch?.({ changes, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }); }
    });
    header.append(el("label", {}, "Alias", alias), el("label", {}, "Type", type), structuralButton(el, "Up", "Move computed column up", () => dispatch?.({ nodeId: item.nodeId, type: "MOVE_COMPUTED_UP" }), index === 0), structuralButton(el, "Down", "Move computed column down", () => dispatch?.({ nodeId: item.nodeId, type: "MOVE_COMPUTED_DOWN" }), index === recipe.computed.length - 1), structuralButton(el, "Duplicate", "Duplicate computed column", () => dispatch?.({ nodeId: item.nodeId, type: "DUPLICATE_COMPUTED" })), structuralButton(el, "Remove", "Remove computed column", () => dispatch?.({ nodeId: item.nodeId, type: "REMOVE_COMPUTED" })));
    content.appendChild(createControlHelp({ control: alias, el, id: `query-alias-help-${item.nodeId}`, text: "Use a Python-style name. Later result filters, formulas, and ordering can refer to it." }));
    content.appendChild(createControlHelp({ control: type, el, id: `query-computed-type-help-${item.nodeId}`, text: guidanceForComputedKind(item.kind).description, technical: guidanceForComputedKind(item.kind).limit }));
    content.appendChild(header);
    const pending = pendingKinds().find((entry) => entry.nodeId === item.nodeId);
    if (pending) {
      const confirmation = el("div", { className: "query-kind-confirmation", role: "alert" });
      const confirm = structuralButton(el, "Change type", "Change calculated value type", () => confirmKindChange?.(item, pending.kind));
      const cancel = structuralButton(el, "Cancel", "Cancel calculated value type change", () => cancelKindChange?.(item.nodeId));
      confirmation.append(`Changing type will replace this item’s configured fields. `, confirm, cancel);
      content.appendChild(confirmation);
    }
    if (summaryUnavailable(recipe, item)) { content.appendChild(el("p", { className: "query-node-issue", role: "note" }, "This computed column is unavailable in Summary mode; use an Aggregate column or switch to Rows mode.")); }
    const forward = formulaForwardReferences(recipe, item);
    if (forward.length) { content.appendChild(el("p", { className: "query-node-issue", role: "note" }, `Formula aliases must come from enabled columns above: ${forward.join(", ")}.`)); }
    const issueRegion = el("div", { className: "query-computed-issues", dataset: { queryComputedIssueNodeId: item.nodeId } });
    renderInlineIssues(issueRegion, item.nodeId);
    content.appendChild(issueRegion);
    const body = bodyFor(item, { dispatch, el, getRecipe, getScope, item, metadata, popoverLayer, validation });
    if (body.__queryDestroy) { bodyDisposables.push(body.__queryDestroy); }
    content.appendChild(body);
    content.appendChild(createMeaningLine({ el, explanation: explainComputedColumn(item), id: `query-computed-meaning-${item.nodeId}` }));
    details.appendChild(content);
    return details;
  }

  render();
  return { add, destroy: releaseBodies, node, render, updateValidation };
}

/** Creates one consistently-labelled computed list structural button. */
function structuralButton(el, label, ariaLabel, onClick, disabled = false) {
  const button = el("button", { ariaLabel, className: "secondary", type: "button" }, label);
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

/** Exposes pure behavior checks without requiring a VS Code webview DOM. */
export const __test = { compactDescription, formulaForwardReferences };

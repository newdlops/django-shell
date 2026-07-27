// Aggregate computed-column controls with distinct and to-many safety feedback.
import { createGridCombobox } from "./gridCombobox.js";
import { createComputedPredicateEditor, computedSelect } from "./gridComputedShared.js";

const FUNCTIONS = ["count", "sum", "avg", "min", "max"];

/** Returns selectable concrete field descriptors from the provided computed-builder scope. */
function fields(scope) { return (scope?.fields || scope?.columns || []).filter((field) => field?.path || field?.attname || field?.name).map((field) => ({ ...field, path: field.path || field.attname || field.name })); }

/** Returns bounded-picker entries while preserving an invalid legacy field for repair. */
export function aggregateFieldOptions(candidates, current) {
  const options = [{ label: "All rows", value: "*" }, ...(candidates || []).map((entry) => ({ description: entry.type || "", label: entry.label || entry.path, value: entry.path }))];
  if (current && current !== "*" && !options.some((option) => option.value === current)) { options.splice(1, 0, { description: "Choose a supported replacement.", disabled: true, disabledReason: "Unavailable field", label: `Unavailable field: ${current}`, value: current }); }
  return options;
}

/** Renders one Aggregate computed column and its shared aggregate-filter predicate. */
export function renderAggregateBuilder({ dispatch, el, getRecipe, getScope, item, metadata, popoverLayer, validation }) {
  const scope = getScope?.(item) || {};
  const root = el("div", { className: "query-computed-body query-aggregate-builder" });
  const field = item.field?.kind === "field" ? item.field.path : "*";
  const candidates = fields(scope);
  const functionSelect = computedSelect(el, "Aggregate function", FUNCTIONS.map((value) => ({ label: value.toUpperCase(), value })), item.function, (functionName) => dispatch({ changes: { function: functionName, ...(functionName !== "count" ? { distinct: "auto", field: field === "*" ? { kind: "field", path: "" } : item.field } : {}) }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  const fieldPicker = createGridCombobox({ el, label: "Aggregate field", onChange: (path) => dispatch({ changes: { field: path === "*" ? { kind: "all" } : { kind: "field", path } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), options: aggregateFieldOptions(candidates, field), popoverLayer, value: field });
  const distinct = computedSelect(el, "Count distinct", [{ label: "Automatic", value: "auto" }, { label: "Always distinct", value: "always" }], item.distinct, (value) => dispatch({ changes: { distinct: value }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  const nonCount = item.function !== "count";
  distinct.disabled = nonCount;
  root.append(el("label", {}, "Function", functionSelect), el("label", {}, "Field", fieldPicker.node), el("label", {}, "Distinct", distinct));
  root.__queryDestroy = () => fieldPicker.destroy();
  const selected = candidates.find((entry) => entry.path === field);
  if (nonCount && selected?.toMany) { root.appendChild(el("p", { className: "query-node-issue", role: "alert" }, "A non-Count aggregate over a to-many path is unsafe. Choose a concrete or Count field.")); }
  const predicate = createComputedPredicateEditor({ context: "aggregate", dispatch, el, getRecipe, getScope: () => scope, item, key: "filter", metadata, validation });
  if (predicate) { root.appendChild(predicate.node); predicate.render(); }
  return root;
}

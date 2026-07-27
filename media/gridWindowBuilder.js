// Window computed-column controls for partitioning and required ordering.
import { createGridCombobox } from "./gridCombobox.js";
import { computedSelect } from "./gridComputedShared.js";
import { MODEL_QUERY_WINDOW_FUNCTIONS } from "./gridQueryRecipeLimits.js";

/** Returns one concrete-field option list from a computed-builder scope. */
function fields(scope) { return (scope?.fields || scope?.columns || []).map((field) => field?.path || field?.attname || field?.name).filter(Boolean); }

/** Formats one bounded Window picker list with an explicit unset option. */
export function windowFieldOptions(values, unsetLabel) { return [{ label: unsetLabel, value: "" }, ...(values || []).map((value) => ({ label: value, value }))]; }

/** Renders a Window expression editor while retaining invalid no-order state for validation. */
export function renderWindowBuilder({ dispatch, el, getScope, item, popoverLayer }) {
  const root = el("div", { className: "query-computed-body query-window-builder" });
  const available = fields(getScope?.(item) || {});
  const functionSelect = computedSelect(el, "Window function", MODEL_QUERY_WINDOW_FUNCTIONS.map((value) => ({ label: value, value })), item.function, (functionName) => dispatch({ changes: { function: functionName }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  const field = createGridCombobox({ el, label: "Window field", onChange: (path) => dispatch({ changes: { field: path ? { kind: "field", path } : undefined }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), options: windowFieldOptions(available, "No field"), popoverLayer, value: item.field?.path || "" });
  const order = createGridCombobox({ el, label: "Window order field", onChange: (path) => dispatch({ changes: { orderBy: path ? [{ direction: "asc", nodeId: `${item.nodeId}-order-1`, ref: { kind: "field", path } }] : [] }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), options: windowFieldOptions(available, "Choose order"), popoverLayer, value: item.orderBy?.[0]?.ref?.path || "" });
  const partition = createGridCombobox({ el, label: "Partition field", onChange: (path) => dispatch({ changes: { partitionBy: path ? [{ kind: "field", path }] : [] }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), options: windowFieldOptions(available, "No partition"), popoverLayer, value: item.partitionBy?.[0]?.path || "" });
  root.append(el("label", {}, "Function", functionSelect), el("label", {}, "Field", field.node), el("label", {}, "Order", order.node), el("label", {}, "Partition", partition.node));
  root.__queryDestroy = () => { field.destroy(); order.destroy(); partition.destroy(); };
  if (!item.orderBy?.length) { root.appendChild(el("p", { className: "query-node-issue", role: "alert" }, "A Window expression requires an order before it can run.")); }
  return root;
}

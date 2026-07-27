// Persistent metadata-backed controls for the Query Builder Result stage.
import { createGridCombobox } from "./gridCombobox.js";
import { createStableListKeyReconciler } from "./gridQueryStableListKeys.js";

/** Returns direct-field and enabled-calculated options grouped for Result controls. */
export function resultReferenceOptions(fields = [], computed = []) {
  return [...fields.map((field) => ({ group: "Fields", label: field.label, value: field.path })), ...computed.filter((item) => item?.enabled).map((item) => ({ group: "Calculated values", label: `calculated value ${item.alias}`, value: `@${item.alias}` }))];
}

/** Builds a persistent Result renderer with bounded pickers and deterministic cleanup. */
export function createQueryResultControls({ dispatch, el, groupByMount, orderByMount, popoverLayer, replaceGroupBy } = {}) {
  let pickers = [];
  const groupByKeys = createStableListKeyReconciler("result-group");

  /** Releases dynamic picker listeners before replacing Result controls. */
  function dispose() {
    for (const picker of pickers) { picker.destroy(); }
    pickers = [];
  }

  /** Creates a bounded picker and retains it for the Result renderer lifetime. */
  function picker(entries, current, label, onChange, key) {
    const control = createGridCombobox({ dataset: { queryControlKey: key }, el, label, onChange, options: [{ label: "Choose field", value: "" }, ...entries], popoverLayer, value: entries.some((entry) => entry.value === current) ? current : "" });
    pickers.push(control);
    return control.node;
  }

  /** Renders the current immutable Result recipe without retaining stale controls. */
  function render(recipe, fields = []) {
    dispose();
    while (groupByMount.children.length > 1) { groupByMount.lastElementChild.remove(); }
    const direct = fields.map((field) => ({ group: "Fields", label: field.label, value: field.path }));
    if (recipe.mode === "summary") {
      const groupKeys = groupByKeys.reconcile(recipe.groupBy);
      const grouping = el("fieldset", { className: "query-result-row" });
      grouping.append(el("legend", {}, "One summary row per value"), el("p", { className: "query-control-help" }, recipe.groupBy.length ? "The query returns one summary row for each unique combination of the selected fields." : "No group field is selected. The query returns one global summary row."));
      for (const [index, item] of recipe.groupBy.entries()) {
        const reference = picker(direct, item.path, "Summary group field", (path) => replaceGroupBy(recipe, index, path), groupKeys[index]);
        const remove = el("button", { ariaLabel: "Remove group field", className: "secondary", type: "button" }, "Remove");
        remove.addEventListener("click", () => dispatch({ index, type: "REMOVE_GROUP_BY" }));
        grouping.append(reference, remove);
      }
      const add = el("button", { className: "secondary", type: "button" }, "Add group field");
      add.disabled = recipe.groupBy.length >= 8;
      add.addEventListener("click", () => dispatch({ type: "ADD_GROUP_BY" }));
      grouping.appendChild(add);
      groupByMount.appendChild(grouping);
    }
    orderByMount.replaceChildren();
    const order = el("fieldset", { className: "query-result-row" });
    order.append(el("legend", {}, "Result order"), el("p", { className: "query-control-help" }, recipe.orderBy.length ? "Choose the order used for the returned results." : recipe.mode === "summary" ? "No order is selected. The database’s summary order is not guaranteed." : "No order is selected. Rows use the primary key ascending."));
    const references = resultReferenceOptions(fields, recipe.computed);
    for (const term of recipe.orderBy) {
      let selected = term.ref?.kind === "computed" ? `@${term.ref.alias}` : term.ref?.path || "";
      const direction = el("select", { ariaLabel: "Order direction", dataset: { queryControlKey: `result-order-direction-${term.nodeId}` } }, el("option", { value: "asc" }, "Ascending"), el("option", { value: "desc" }, "Descending"));
      direction.value = term.direction || "asc";
      const update = () => dispatch({ changes: { direction: direction.value, ref: selected.startsWith("@") ? { alias: selected.slice(1), kind: "computed" } : { kind: "field", path: selected } }, nodeId: term.nodeId, type: "UPDATE_ORDER" });
      const reference = picker(references, selected, "Order field", (path) => { selected = path; update(); }, `result-order-${term.nodeId}`);
      direction.addEventListener("change", update);
      const remove = el("button", { ariaLabel: "Remove order term", className: "secondary", dataset: { queryControlKey: `result-order-remove-${term.nodeId}` }, type: "button" }, "Remove");
      remove.addEventListener("click", () => dispatch({ nodeId: term.nodeId, type: "REMOVE_ORDER" }));
      order.append(reference, direction, remove);
    }
    const addOrder = el("button", { className: "secondary", type: "button" }, "Add order");
    addOrder.disabled = recipe.orderBy.length >= 8;
    addOrder.addEventListener("click", () => dispatch({ type: "ADD_ORDER" }));
    order.appendChild(addOrder);
    orderByMount.appendChild(order);
  }

  return { destroy: dispose, render };
}

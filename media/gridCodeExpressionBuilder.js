// Restricted raw Django expression computed-column controls.
import { createComputedPredicateEditor, computedInput, computedSelect } from "./gridComputedShared.js";
import { MODEL_QUERY_OUTPUT_TYPES, MODEL_QUERY_RECIPE_LIMITS } from "./gridQueryRecipeLimits.js";

const activeWhenEditors = new Set();

/** Renders the advanced single-line Code expression editor and optional shared predicate. */
export function renderCodeExpressionBuilder({ dispatch, el, getRecipe, getScope, item, metadata, validation }) {
  const root = el("div", { className: "query-computed-body query-code-expression-builder" });
  const disposables = [];
  root.appendChild(el("p", { className: "query-builder-empty", role: "note" }, `Advanced: restricted Django expression only; no newlines and at most ${MODEL_QUERY_RECIPE_LIMITS.rawCodeExpressionCharacters} characters.`));
  const expression = computedInput(el, "Restricted Django expression", item.expression, (value) => dispatch({ changes: { expression: value }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), { maxLength: MODEL_QUERY_RECIPE_LIMITS.rawCodeExpressionCharacters });
  expression.pattern = "[^\\r\\n]*";
  root.appendChild(el("label", {}, "Expression", expression));
  const whenOn = activeWhenEditors.has(item.nodeId) || Boolean(item.when?.children?.length);
  const toggle = el("input", { ariaLabel: "Only when", checked: whenOn, type: "checkbox" });
  toggle.addEventListener("change", () => {
    if (toggle.checked) { activeWhenEditors.add(item.nodeId); }
    else { activeWhenEditors.delete(item.nodeId); }
    dispatch({ changes: { when: toggle.checked ? item.when : { children: [], join: "and", kind: "group", negated: false, nodeId: `${item.nodeId}-when` } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" });
  });
  root.appendChild(el("label", {}, toggle, "Only when"));
  if (whenOn) {
    const predicate = createComputedPredicateEditor({ context: "case", dispatch, el, getRecipe, getScope: () => getScope?.(item) || {}, item, key: "when", metadata, validation });
    if (predicate) { disposables.push(() => predicate.destroy()); root.appendChild(predicate.node); predicate.render(); }
  }
  root.appendChild(el("label", {}, "Output type", computedSelect(el, "Code expression output type", MODEL_QUERY_OUTPUT_TYPES.map((value) => ({ label: value, value })), item.outputType, (value) => dispatch({ changes: { outputType: value }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }))));
  root.__queryDestroy = () => { for (const dispose of disposables) { dispose(); } };
  return root;
}

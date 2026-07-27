// Formula computed-column editor for bounded expression trees, Case, and Cast.
import { createQueryFieldPicker } from "./gridQueryFieldPicker.js";
import { createComputedPredicateEditor, computedInput, computedSelect, previousEnabledAliases } from "./gridComputedShared.js";
import { MODEL_QUERY_FORMULA_FUNCTIONS, MODEL_QUERY_OUTPUT_TYPES, MODEL_QUERY_RECIPE_LIMITS } from "./gridQueryRecipeLimits.js";

const BINARY = ["+", "-", "*", "/", "%"];

/** Counts formula-tree nodes and depth for immediate non-destructive limit feedback. */
export function formulaMetrics(node, depth = 1) {
  if (!node || typeof node !== "object") { return { depth, nodes: 0 }; }
  const children = node.kind === "binary" ? [node.left, node.right] : node.kind === "function" ? node.args || [] : node.kind === "case" ? [...(node.branches || []).map((branch) => branch.then), node.else] : node.kind === "cast" ? [node.expression] : [];
  return children.reduce((total, child) => { const metric = formulaMetrics(child, depth + 1); return { depth: Math.max(total.depth, metric.depth), nodes: total.nodes + metric.nodes }; }, { depth, nodes: 1 });
}

/** Returns fixed argument counts for formula functions whose arity is not open-ended. */
export function formulaArity(functionName) {
  return { coalesce: 2, concat: 2, greatest: 2, least: 2, length: 1, lower: 1, trim: 1, upper: 1 }[functionName] || 1;
}

/** Renders one recursive Formula expression node with replacement rather than lossy coercion. */
function expressionEditor({ aliases, dispatch, disposables, el, getRecipe, getScope, item, metadata, node, onChange, popoverLayer, validation }) {
  const root = el("fieldset", { className: "query-formula-node" });
  root.appendChild(el("legend", {}, "Expression"));
  const kind = computedSelect(el, "Formula expression kind", [{ label: "Field", value: "field" }, { label: "Computed alias", value: "computed" }, { label: "Literal", value: "literal" }, { label: "Binary", value: "binary" }, { label: "Function", value: "function" }, { label: "Case", value: "case" }, { label: "Cast", value: "cast" }], node?.kind || "literal", (value) => onChange(starter(value)));
  root.appendChild(kind);
  if (node?.kind === "field") {
    const scope = getScope?.(item) || {};
    const picker = createQueryFieldPicker({ ariaLabel: "Formula field", current: node.path, el, metadata, onChange: (value) => onChange({ ...node, path: value }), popoverLayer, source: scope.target || scope.source });
    disposables?.push(() => picker.dispose());
    root.appendChild(el("label", {}, "Field", picker.node));
  }
  else if (node?.kind === "computed") { root.appendChild(el("label", {}, "Previous computed alias", computedSelect(el, "Previous computed alias", [{ label: "Choose alias", value: "" }, ...aliases.map((value) => ({ label: value, value }))], node.alias, (value) => onChange({ ...node, alias: value })))); }
  else if (node?.kind === "literal") { root.appendChild(el("label", {}, "Literal", computedInput(el, "Formula literal", node.value, (value) => onChange({ kind: "literal", value })))); }
  else if (node?.kind === "binary") {
    const operator = computedSelect(el, "Binary operator", BINARY.map((value) => ({ label: value, value })), node.operator, (value) => onChange({ ...node, operator: value }));
    root.appendChild(el("label", {}, "Operator", operator));
    root.append(expressionEditor({ aliases, dispatch, disposables, el, getRecipe, getScope, item, metadata, node: node.left, onChange: (left) => onChange({ ...node, left }), popoverLayer, validation }), expressionEditor({ aliases, dispatch, disposables, el, getRecipe, getScope, item, metadata, node: node.right, onChange: (right) => onChange({ ...node, right }), popoverLayer, validation }));
  } else if (node?.kind === "function") {
    const functionSelect = computedSelect(el, "Formula function", MODEL_QUERY_FORMULA_FUNCTIONS.map((value) => ({ label: value, value })), node.function, (value) => onChange({ ...node, args: Array.from({ length: formulaArity(value) }, (_, index) => node.args?.[index] || starter("literal")), function: value }));
    root.appendChild(el("label", {}, "Function", functionSelect));
    (node.args || []).forEach((argument, index) => root.appendChild(expressionEditor({ aliases, dispatch, disposables, el, getRecipe, getScope, item, metadata, node: argument, onChange: (value) => onChange({ ...node, args: node.args.map((entry, current) => current === index ? value : entry) }), popoverLayer, validation })));
  } else if (node?.kind === "case") {
    for (const [index, branch] of (node.branches || []).entries()) {
      const branchRoot = el("fieldset", { className: "query-formula-case-branch" });
      branchRoot.appendChild(el("legend", {}, `When ${index + 1}`));
      const predicate = createComputedPredicateEditor({ context: "case", dispatch, el, getRecipe, getScope, item: { ...item, nodeId: item.nodeId, when: branch.when }, key: "when", metadata, onChange: (when) => onChange({ ...node, branches: node.branches.map((entry, current) => current === index ? { ...entry, when } : entry) }), validation });
      if (predicate) { disposables?.push(() => predicate.destroy()); branchRoot.appendChild(predicate.node); predicate.render(); }
      branchRoot.appendChild(expressionEditor({ aliases, dispatch, disposables, el, getRecipe, getScope, item, metadata, node: branch.then, onChange: (then) => onChange({ ...node, branches: node.branches.map((entry, current) => current === index ? { ...entry, then } : entry) }), popoverLayer, validation }));
      root.appendChild(branchRoot);
    }
    const addBranch = el("button", { className: "secondary", type: "button" }, "Add case branch");
    addBranch.disabled = (node.branches || []).length >= MODEL_QUERY_RECIPE_LIMITS.caseBranches;
    addBranch.addEventListener("click", () => onChange({ ...node, branches: [...(node.branches || []), { then: starter("literal"), when: { children: [], join: "and", kind: "group", negated: false, nodeId: `${item.nodeId}-case-${(node.branches || []).length + 1}` } }] }));
    root.appendChild(addBranch);
    root.appendChild(expressionEditor({ aliases, dispatch, disposables, el, getRecipe, getScope, item, metadata, node: node.else, onChange: (otherwise) => onChange({ ...node, else: otherwise }), popoverLayer, validation }));
  } else if (node?.kind === "cast") {
    root.appendChild(el("label", {}, "Output type", computedSelect(el, "Cast output type", MODEL_QUERY_OUTPUT_TYPES.filter((value) => value !== "auto").map((value) => ({ label: value, value })), node.outputType, (value) => onChange({ ...node, outputType: value }))));
    root.appendChild(expressionEditor({ aliases, dispatch, disposables, el, getRecipe, getScope, item, metadata, node: node.expression, onChange: (expression) => onChange({ ...node, expression }), popoverLayer, validation }));
  }
  return root;
}

/** Creates one structurally valid expression starter for a selected expression kind. */
function starter(kind) {
  if (kind === "field") { return { kind, path: "" }; }
  if (kind === "computed") { return { alias: "", kind }; }
  if (kind === "binary") { return { kind, left: { kind: "literal", value: null }, operator: "+", right: { kind: "literal", value: null } }; }
  if (kind === "function") { return { args: [{ kind: "literal", value: null }, { kind: "literal", value: null }], function: "coalesce", kind }; }
  if (kind === "case") { return { branches: [], else: { kind: "literal", value: null }, kind }; }
  if (kind === "cast") { return { expression: { kind: "literal", value: null }, kind, outputType: "text" }; }
  return { kind: "literal", value: null };
}

/** Renders the Formula item with previous-alias dependency scope and immediate tree-limit feedback. */
export function renderFormulaBuilder({ dispatch, el, getRecipe, getScope, item, metadata, popoverLayer, validation }) {
  const recipe = getRecipe?.() || { computed: [] };
  const root = el("div", { className: "query-computed-body query-formula-builder" });
  const aliases = previousEnabledAliases(recipe.computed, item.nodeId);
  const disposables = [];
  root.appendChild(expressionEditor({ aliases, dispatch, disposables, el, getRecipe, getScope, item, metadata, node: item.expression, onChange: (expression) => dispatch({ changes: { expression }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), popoverLayer, validation }));
  root.appendChild(el("label", {}, "Output type", computedSelect(el, "Formula output type", MODEL_QUERY_OUTPUT_TYPES.map((value) => ({ label: value, value })), item.outputType, (value) => dispatch({ changes: { outputType: value }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }))));
  const metric = formulaMetrics(item.expression);
  if (metric.nodes > MODEL_QUERY_RECIPE_LIMITS.formulaNodes || metric.depth > MODEL_QUERY_RECIPE_LIMITS.formulaDepth) { root.appendChild(el("p", { className: "query-node-issue", role: "alert" }, `Formula is ${metric.nodes} nodes / ${metric.depth} levels; limit is ${MODEL_QUERY_RECIPE_LIMITS.formulaNodes} / ${MODEL_QUERY_RECIPE_LIMITS.formulaDepth}.`)); }
  root.__queryDestroy = () => { for (const dispose of disposables) { dispose(); } };
  return root;
}

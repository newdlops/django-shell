// Metadata-backed cascading field-path picker for safe Query Builder references.

import { createCombobox } from "./gridCombobox.js";
import { rootMetadataOptions } from "./gridQueryMetadata.js";

/** Converts a field descriptor into a readable label and bounded description. */
function fieldOption(field) {
  const name = String(field?.name || field?.path || "");
  const label = String(field?.label || "").trim();
  return { description: [field?.type, field?.null ? "Nullable" : "Required", field?.helpText].filter(Boolean).join(" · "), group: "Fields", keywords: `${name} ${label}`, label: label && label !== name ? `${label} — ${name}` : name, value: `field:${name}` };
}

/** Converts a relation descriptor into a drill-in option. */
function relationOption(relation) {
  const name = String(relation?.name || "");
  const target = String(relation?.target || "related model");
  const kind = String(relation?.kind || "relation").replace(/[_-]/g, " ");
  return { description: `${kind}. Choose to continue into the related model.`, group: "Relations", keywords: `${name} ${relation?.label || ""} ${target}`, label: `${relation?.label || name} → ${target}`, value: `relation:${name}` };
}

/** Creates a picker which only emits complete scalar paths, unless relation-null is explicitly allowed. */
export function createQueryFieldPicker({ ariaLabel = "Choose field", computed = [], current = "", el, metadata, onChange, source, context = "where", allowRelationTerminal = false, popoverLayer } = {}) {
  const node = el("div", { className: "query-field-picker", dataset: { context } });
  const segments = el("div", { className: "query-field-picker-segments" });
  const status = el("p", { className: "query-control-help", role: "status" });
  node.append(segments, status);
  let disposed = false;
  let path = String(current || "");
  let controllers = [];
  let target = source;

  /** Releases old comboboxes before recreating a deterministic segment path. */
  function disposeControllers() { for (const controller of controllers) { controller.dispose?.(); } controllers = []; }

  /** Loads one model tree with explicit error rendering and no silent flat fallback. */
  function loadTree(model, retry = false) {
    const state = metadata?.getState?.(model);
    if (state?.tree) { return Promise.resolve(state.tree); }
    return (retry ? metadata?.retry?.(model) : metadata?.loadTree?.(model)) || Promise.reject(new Error("Field metadata is unavailable."));
  }

  /** Emits an independently copied complete path after a leaf selection. */
  function emit(next) { path = String(next || ""); onChange?.(path); }

  /** Builds one segment from fields, computed aliases, and relation traversal options. */
  async function render() {
    disposeControllers(); segments.replaceChildren(); status.textContent = "";
    if (!target?.app || !target?.model) { status.textContent = "Field details are unavailable."; return; }
    try {
      const parts = path ? path.split("__") : [];
      let model = target;
      let prefix = [];
      let index = 0;
      while (!disposed) {
        const tree = await loadTree(model);
        if (disposed) { return; }
        const options = rootMetadataOptions(tree);
        const choices = [...options.fields.map(fieldOption)];
        if (index === 0) { choices.push(...computed.filter((item) => item?.enabled !== false && item?.alias).map((item) => ({ description: "Calculated value available in this query.", group: "Calculated values", label: `calculated value ${item.alias}`, value: `computed:${item.alias}` }))); }
        choices.push(...options.relations.map(relationOption));
        const selected = parts[index] || "";
        if (selected && !choices.some((choice) => choice.value.endsWith(`:${selected}`))) { choices.unshift({ description: "This field is not present in the current model metadata. Choose a replacement.", disabled: true, disabledReason: "Unavailable field", group: "Unavailable", label: `Unavailable field: ${selected}`, value: `unavailable:${selected}` }); }
        const picker = createCombobox({ ariaLabel: index === 0 ? ariaLabel : `Related field after ${prefix.join("__")}`, el, options: [{ label: index === 0 ? "Choose field or calculated value" : "Choose related field", value: "" }, ...choices], popoverLayer, value: selected ? choices.find((choice) => choice.value.endsWith(`:${selected}`))?.value || `unavailable:${selected}` : "", onChange: (value) => select(value, index, model, prefix, options) });
        controllers.push(picker); segments.appendChild(picker.node);
        if (!selected) { return; }
        const relation = options.relations.find((item) => item.name === selected);
        if (!relation) { return; }
        prefix = [...prefix, selected]; model = targetFromLabel(relation.target); index += 1;
      }
    } catch {
      if (disposed) { return; }
      status.replaceChildren("Field details could not be loaded. ");
      const retry = el("button", { type: "button" }, "Retry");
      retry.addEventListener("click", () => render()); status.appendChild(retry);
    }
  }

  /** Handles a segment choice without mutating the Recipe until a complete path is chosen. */
  function select(value, index, model, prefix, options) {
    const [kind, selected] = String(value || "").split(":", 2);
    if (!selected || kind === "unavailable") { return; }
    if (kind === "computed") { emit(selected); return; }
    if (kind === "relation") {
      const relation = options.relations.find((item) => item.name === selected);
      if (allowRelationTerminal && relation) { emit([...prefix, selected].join("__")); }
      else { path = [...prefix, selected].join("__"); render(); }
      return;
    }
    emit([...prefix, selected].join("__"));
  }

  /** Resolves an app-qualified target label used by backend relation metadata. */
  function targetFromLabel(label) { const value = String(label || ""); const index = value.lastIndexOf("."); return index > 0 ? { app: value.slice(0, index), model: value.slice(index + 1) } : { app: source.app, model: value }; }

  render();
  return { dispose() { disposed = true; disposeControllers(); }, focus() { controllers[0]?.focus?.(); }, getPath() { return path; }, getTerminal() { return path.split("__").at(-1) || ""; }, node, setCurrent(next) { path = String(next || ""); render(); } };
}

/** Exposes pure option formatting for focused tests. */
export const __test = { fieldOption, relationOption };

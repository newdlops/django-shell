// Metadata-backed native field-path picker for safe Query Builder references.
import { createQuerySelect } from "./gridQuerySelect.js";
import { rootMetadataOptions } from "./gridQueryMetadata.js";

/** Converts a field descriptor into a readable native-select option. */
function fieldOption(field) {
  const name = String(field?.name || field?.path || "");
  const label = String(field?.label || "").trim();
  return { description: [field?.type, field?.null ? "Nullable" : "Required", field?.helpText].filter(Boolean).join(" · "), group: "Fields", label: label && label !== name ? `${label} — ${name}` : name, value: `field:${name}` };
}

/** Converts a relation descriptor into a drill-in native-select option. */
function relationOption(relation) {
  const name = String(relation?.name || "");
  const target = String(relation?.target || "related model");
  const kind = String(relation?.kind || "relation").replace(/[_-]/g, " ");
  return { description: `${kind}. Choose to continue into the related model.`, group: "Relations", label: `${relation?.label || name} → ${target}`, value: `relation:${name}` };
}

/** Converts a relation descriptor into a distinct terminal null/presence option. */
function relationTerminalOption(relation) { const name = String(relation?.name || ""); return { description: "Select this relationship itself for null or presence checking.", group: "Relationship checks", label: `Check relationship ${relation?.label || name}`, value: `relationTerminal:${name}` }; }

/** Resolves an app-qualified relation target while preserving the current app fallback. */
function targetFromLabel(label, source) {
  const value = String(label || "");
  const boundary = value.lastIndexOf(".");
  return boundary > 0 ? { app: value.slice(0, boundary), model: value.slice(boundary + 1) } : { app: source?.app || "", model: value };
}

/** Creates a picker which emits only complete scalar paths or allowed relation terminals. */
export function createQueryFieldPicker({ allowRelationTerminal = false, ariaLabel = "Choose field", computed = [], context = "where", controlKey = "", current = "", el, metadata, onChange, source } = {}) {
  const node = el("div", { className: "query-field-picker", dataset: { context } });
  const segments = el("div", { className: "query-field-picker-segments" });
  const status = el("p", { className: "query-control-help", role: "status" });
  node.append(segments, status);
  let disposed = false;
  let generation = 0;
  let drillPath = "";
  let path = String(current || "");
  let controllers = [];

  /** Releases native select listeners before rebuilding the visible cascade. */
  function disposeControllers() { for (const controller of controllers) { controller.destroy?.(); } controllers = []; }
  /** Tests whether an async continuation may still write this picker. */
  function currentGeneration(value) { return !disposed && generation === value; }
  /** Loads a cached tree or requests it once without a manual-path fallback. */
  function loadTree(model, retry = false) { const state = metadata?.getState?.(model); if (state?.tree) { return Promise.resolve(state.tree); } if (state?.error && !retry) { return Promise.reject(state.error); } return (retry ? metadata?.retry?.(model) : metadata?.loadTree?.(model)) || Promise.reject(new Error("Field metadata is unavailable.")); }
  /** Appends one disabled native state select. */
  function appendState(label, index) {
    const picker = createQuerySelect({ ariaLabel: index === 0 ? ariaLabel : "Related field", disabled: true, el, options: [{ disabled: true, label, value: "" }] });
    controllers.push(picker); segments.appendChild(picker.node); return picker;
  }
  /** Emits an independently copied complete path after an allowlisted leaf choice. */
  function emit(next, kind, descriptor) { drillPath = ""; path = String(next || ""); onChange?.(path, kind, descriptor); }
  /** Returns one current selection token, preserving invalid paths visibly. */
  function selectionFor(selected, choices, terminal, traversing) { if (!selected) { return ""; } const terminalValue = `relationTerminal:${selected}`; if (terminal && !traversing && choices.some((choice) => choice.value === terminalValue)) { return terminalValue; } return choices.some((choice) => choice.value === `relation:${selected}`) ? `relation:${selected}` : choices.some((choice) => choice.value.endsWith(`:${selected}`)) ? choices.find((choice) => choice.value.endsWith(`:${selected}`)).value : `unavailable:${selected}`; }
  /** Writes human-readable terminal metadata without injecting markup. */
  function setTerminal(field) { status.textContent = [field?.type, field?.null ? "Nullable" : "Required", field?.helpText].filter(Boolean).join(" · "); }

  /** Renders one generation of the cascading metadata-backed field path. */
  async function render() {
    const renderGeneration = ++generation;
    disposeControllers(); segments.replaceChildren(); status.textContent = "";
    if (!source?.app || !source?.model) { appendState("Fields unavailable", 0); status.textContent = "Field details are unavailable."; return; }
    const parts = path ? path.split("__") : [];
    let model = source;
    let prefix = [];
    for (let index = 0; currentGeneration(renderGeneration); index += 1) {
      const state = metadata?.getState?.(model);
      const loading = !state?.tree ? appendState("Loading fields…", index) : undefined;
      let tree = state?.tree;
      try { if (!tree) { tree = await loadTree(model); } } catch {
        if (!currentGeneration(renderGeneration)) { return; }
        const errorGeneration = renderGeneration;
        loading?.node?.remove?.();
        if (loading) { controllers = controllers.filter((controller) => controller !== loading); loading.destroy?.(); }
        appendState("Fields unavailable", index);
        status.replaceChildren("Field details could not be loaded. ");
        const retry = el("button", { type: "button" }, "Retry");
        retry.addEventListener("click", () => {
          if (retry.disabled || !currentGeneration(errorGeneration)) { return; }
          retry.disabled = true;
          const retryGeneration = ++generation;
          Promise.resolve(loadTree(model, true)).catch(() => undefined).then(() => {
            if (currentGeneration(retryGeneration)) { render(); }
          });
        });
        status.appendChild(retry);
        return;
      }
      if (!currentGeneration(renderGeneration)) { return; }
      const options = rootMetadataOptions(tree);
      const choices = [...options.fields.map(fieldOption)];
      if (index === 0) { choices.push(...computed.filter((item) => item?.enabled !== false && item?.alias).map((item) => ({ description: "Calculated value available in this query.", group: "Calculated values", label: `calculated value ${item.alias}`, value: `computed:${item.alias}` }))); }
      choices.push(...options.relations.flatMap((relation) => allowRelationTerminal ? [relationOption(relation), relationTerminalOption(relation)] : [relationOption(relation)]));
      if (!choices.length) { loading?.node?.remove?.(); if (loading) { controllers = controllers.filter((controller) => controller !== loading); loading.destroy?.(); } appendState("No selectable fields.", index); return; }
      const selected = parts[index] || "";
      if (selected && !choices.some((choice) => choice.value.endsWith(`:${selected}`))) { choices.push({ disabled: true, group: "Unavailable", label: `Unavailable field: ${selected}`, value: `unavailable:${selected}` }); }
      const picker = createQuerySelect({ ariaLabel: index === 0 ? ariaLabel : `Related field after ${prefix.join("__")}`, dataset: controlKey ? { queryControlKey: `${controlKey}-${index}` } : {}, el, onChange: (value) => select(value, index, model, prefix, options), options: [{ disabled: true, label: index === 0 ? "Choose field or calculated value" : "Choose related field", value: "" }, ...choices], value: selectionFor(selected, choices, allowRelationTerminal && parts.length === index + 1, drillPath === [...prefix, selected].join("__")) });
      if (loading) {
        loading.node?.replaceWith?.(picker.node);
        controllers = controllers.filter((controller) => controller !== loading);
        loading.destroy?.();
      } else {
        segments.appendChild(picker.node);
      }
      controllers.push(picker);
      if (!selected) { return; }
      const relation = options.relations.find((item) => item.name === selected);
      const field = drillPath === [...prefix, selected].join("__") ? undefined : options.fields.find((item) => item.name === selected);
      if (field) {
        if (parts.length > index + 1) { appendState(`Unavailable field: ${parts.slice(index + 1).join("__")}`, index + 1); return; }
        setTerminal(field); return;
      }
      if (!relation) { if (parts.length > index + 1) { appendState(`Unavailable field: ${parts.slice(index + 1).join("__")}`, index + 1); } return; }
      if (allowRelationTerminal && parts.length === index + 1 && drillPath !== parts.slice(0, index + 1).join("__")) { return; }
      prefix = [...prefix, selected]; model = targetFromLabel(relation.target, source);
    }
  }

  /** Handles a native segment choice without emitting a partial relation path. */
  function select(value, index, model, prefix, options) {
    const [kind, selected] = String(value || "").split(":", 2);
    if (!selected || kind === "unavailable") { return; }
    if (kind === "computed") { const descriptor = index === 0 ? computed.find((item) => item?.enabled !== false && item.alias === selected) : undefined; if (descriptor) { emit(selected, kind, descriptor); } return; }
    if (kind === "relationTerminal") { const relation = options.relations.find((item) => item.name === selected); if (relation) { emit([...prefix, selected].join("__"), kind, relation); } return; }
    if (kind === "relation") {
      const relation = options.relations.find((item) => item.name === selected);
      if (relation) { path = [...prefix, selected].join("__"); drillPath = path; render(); }
      return;
    }
    const field = options.fields.find((item) => item.name === selected); if (kind === "field" && field) { emit([...prefix, selected].join("__"), kind, field); }
  }

  render();
  return { /** Invalidates pending loads and releases native listeners. */ dispose() { disposed = true; generation += 1; disposeControllers(); }, /** Focuses the first native select. */ focus() { controllers[0]?.focus?.(); }, /** Returns the current internal cascade path. */ getPath() { return path; }, /** Returns the last selected path segment. */ getTerminal() { return path.split("__").at(-1) || ""; }, node, /** Replaces the persisted path and begins a new guarded render. */ setCurrent(next) { drillPath = ""; path = String(next || ""); render(); } };
}

/** Exposes pure option formatting for focused tests. */
export const __test = { fieldOption, relationOption, relationTerminalOption, targetFromLabel };

// Searchable combobox widget for the model browser's filter and aggregate bars.
// A text input that type-filters an allowlisted option list (value ≠ label) and shows a dropdown. It is a drop-in
// replacement for a native <select>: the root node exposes a `value` accessor, an `_options` array, and fires a
// `change` event, so the existing cascading-filter logic keeps reading it the same way. Free text is never accepted —
// blurring without a pick reverts to the current selection, keeping every value within the option allowlist.

import { createQueryPopover } from "./gridQueryPopover.js";

const NONE = -1;
const MAX_RENDERED_OPTIONS = 60;
let comboboxSequence = 0;

/** Limits a visible option list while pinning the selected allowlisted value. */
function boundedOptions(options, current, maxRenderedOptions) {
  if (options.length <= maxRenderedOptions) { return options; }
  const selected = options.find((option) => option.value === current);
  const bounded = options.slice(0, maxRenderedOptions);
  if (!selected || bounded.includes(selected)) { return bounded; }
  return [selected, ...bounded.slice(0, Math.max(0, maxRenderedOptions - 1))];
}

/** Creates a searchable combobox. Returns { node, getValue, setValue, setOptions, focus }. */
export function createCombobox(deps) {
  const { ariaLabel = "", el, options = [], value = "", placeholder = "", onChange, title = "", dataset, maxRenderedOptions = MAX_RENDERED_OPTIONS, popoverLayer } = deps;
  let items = normalize(options);
  let current = value == null ? "" : value;
  let activeIndex = NONE;
  let open = false;
  let visible = [];

  const listId = `cbx-list-${comboboxSequence += 1}`;
  const input = el("input", { ariaAutocomplete: "list", ariaControls: listId, ariaExpanded: "false", ariaLabel: ariaLabel || title || placeholder || "Choose option", className: "cbx-input", id: `${listId}-input`, placeholder, role: "combobox", spellcheck: false, title, type: "text" });
  const list = el("div", { className: "cbx-list", id: listId, role: "listbox" });
  list.hidden = true;
  const node = el("span", { className: "combobox" }, input, list);
  const portal = popoverLayer ? createPortal(popoverLayer) : undefined;
  if (dataset) {
    Object.assign(node.dataset, dataset);
  }
  Object.defineProperty(node, "value", { configurable: true, get: () => current, set: (next) => setValue(next) });
  node._options = items;

  /** Returns normalized optional descriptive and disabled state without changing old callers. */
  function normalize(list) {
    return (list || []).map((option) => ({ description: option.description || "", disabled: Boolean(option.disabled), disabledReason: option.disabledReason || "", group: option.group || "", keywords: option.keywords || "", label: option.label == null ? String(option.value) : String(option.label), title: option.title || "", value: option.value }));
  }

  /** Returns the label for a value, or "" when the value is not in the option list. */
  function labelFor(target) {
    const found = items.find((option) => option.value === target);
    return found ? found.label : "";
  }

  /** Returns the options visible under the current search text (all of them when the input shows the selection). */
  function matches() {
    const query = input.value.trim().toLowerCase();
    if (!query || input.value === labelFor(current)) {
      return boundedOptions(items, current, maxRenderedOptions);
    }
    return boundedOptions(items.filter((option) => `${option.label} ${option.keywords} ${option.description}`.toLowerCase().includes(query)), current, maxRenderedOptions);
  }

  /** Renders the dropdown for the current filter, keeping the highlight in range. */
  function render() {
    visible = matches();
    activeIndex = nextEnabledIndex(Math.max(0, Math.min(activeIndex, visible.length - 1)), 1);
    list.innerHTML = "";
    let group = "";
    visible.forEach((option, index) => {
      if (option.group && option.group !== group) {
        group = option.group;
        list.appendChild(el("div", { ariaHidden: "true", className: "cbx-group", role: "presentation" }, group));
      }
      const optionNode = el("div", { ariaDisabled: option.disabled ? "true" : undefined, ariaSelected: String(index === activeIndex), className: `${index === activeIndex ? "cbx-opt active" : "cbx-opt"}${option.disabled ? " disabled" : ""}`, id: `${listId}-option-${index}`, role: "option", title: option.title }, option.label);
      if (option.description || option.disabledReason) { optionNode.appendChild(el("span", { className: "query-option-description" }, option.disabledReason || option.description)); }
      optionNode.addEventListener("click", () => choose(option));
      optionNode.addEventListener("mouseenter", () => { if (!option.disabled) { activeIndex = index; highlight(); } });
      list.appendChild(optionNode);
    });
    if (!visible.length) {
      list.appendChild(el("div", { className: "cbx-empty", role: "status" }, "No matches"));
    } else if (items.length > maxRenderedOptions && !input.value.trim()) {
      list.appendChild(el("div", { className: "cbx-empty", role: "status" }, `Showing the first ${maxRenderedOptions} options. Type to search all fields.`));
    }
    syncAria();
  }

  /** Repaints only the active-option styling without rebuilding the list. */
  function highlight() {
    let index = 0;
    for (const child of list.children) {
      if (child.className.indexOf("cbx-opt") !== 0) {
        continue;
      }
      child.className = `${index === activeIndex ? "cbx-opt active" : "cbx-opt"}${visible[index]?.disabled ? " disabled" : ""}`;
      child.setAttribute?.("aria-selected", String(index === activeIndex));
      index += 1;
    }
    syncAria();
  }

  /** Synchronizes combobox expanded and active-descendant state for assistive technology. */
  function syncAria() {
    input.setAttribute?.("aria-expanded", String(open));
    if (open && activeIndex !== NONE && visible[activeIndex]) {
      input.setAttribute?.("aria-activedescendant", `${listId}-option-${activeIndex}`);
    } else {
      input.removeAttribute?.("aria-activedescendant");
    }
  }

  /** Opens the dropdown and renders it. */
  function show() {
    portal?.open(list);
    open = true;
    list.hidden = false;
    const selected = matches().findIndex((option) => option.value === current);
    activeIndex = nextEnabledIndex(selected === NONE ? 0 : selected, 1);
    render();
  }

  /** Closes the dropdown and restores the input text to the current selection's label. */
  function hide() {
    open = false;
    list.hidden = true;
    portal?.close();
    input.value = labelFor(current);
    syncAria();
  }

  /** Commits a chosen option, firing change only when the value actually differs. */
  function choose(option) {
    if (option?.disabled) { return; }
    const changed = option.value !== current;
    current = option.value;
    input.value = option.label;
    open = false;
    list.hidden = true;
    syncAria();
    if (changed) {
      if (onChange) {
        onChange(current);
      }
      node.dispatchEvent(new Event("change"));
    }
  }

  /** Sets the selected value programmatically (updates the input, fires no change event). */
  function setValue(next) {
    current = next == null ? "" : next;
    input.value = labelFor(current);
  }

  /** Replaces the option list without silently clearing a now-disabled selected value. */
  function setOptions(next) {
    items = normalize(next);
    node._options = items;
    if (!items.some((option) => option.value === current)) {
      setValue("");
    } else {
      input.value = labelFor(current);
    }
    if (open) {
      render();
    }
  }

  /** Finds the next enabled option, or NONE when all visible options are disabled. */
  function nextEnabledIndex(start, direction) {
    if (!visible.length) { return NONE; }
    for (let offset = 0; offset < visible.length; offset += 1) {
      const index = (start + (offset * direction) + visible.length) % visible.length;
      if (!visible[index]?.disabled) { return index; }
    }
    return NONE;
  }

  /** Handles arrow, home/end, enter, and escape keyboard navigation. */
  function onKey(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        show();
        return;
      }
      if (!visible.length) {
        return;
      }
      activeIndex = nextEnabledIndex(activeIndex === NONE ? 0 : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length, event.key === "ArrowDown" ? 1 : -1);
      highlight();
    } else if (event.key === "Home" || event.key === "End") {
      if (!open) {
        return;
      }
      event.preventDefault();
      activeIndex = visible.length ? nextEnabledIndex(event.key === "Home" ? 0 : visible.length - 1, event.key === "Home" ? 1 : -1) : NONE;
      highlight();
    } else if (event.key === "PageDown" || event.key === "PageUp") {
      if (!open) { return; }
      event.preventDefault();
      const direction = event.key === "PageDown" ? 1 : -1;
      for (let count = 0; count < 10 && activeIndex !== NONE; count += 1) {
        activeIndex = nextEnabledIndex((activeIndex + direction + visible.length) % visible.length, direction);
      }
      highlight();
    } else if (event.key === "Enter") {
      if (open && visible[activeIndex]) {
        event.preventDefault();
        choose(visible[activeIndex]);
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        hide();
      }
    }
  }

  input.addEventListener("focus", () => { input.select(); show(); });
  input.addEventListener("input", () => { activeIndex = 0; show(); });
  input.addEventListener("blur", () => hide());
  input.addEventListener("keydown", onKey);
  // Keep focus on the input while clicking inside the dropdown so the click lands before the blur closes it.
  list.addEventListener("mousedown", (event) => event.preventDefault());

  setValue(current);
  return { dispose() { input.removeEventListener("keydown", onKey); portal?.destroy(); node.remove(); }, focus: () => input.focus(), getValue: () => current, node, setOptions, setValue };
}

/** Places one existing listbox in a fixed portal layer while retaining legacy combobox markup. */
function createPortal(layer) {
  let list;
  let popover;

  /** Resolves the original input anchor after a listbox has moved into the portal. */
  function inputFor(next) {
    if (!next.dataset.anchor) { next.dataset.anchor = next.previousElementSibling?.id || ""; }
    return next.dataset.anchor ? document.getElementById(next.dataset.anchor) : undefined;
  }

  /** Creates one reusable viewport-aware portal for the listbox's input anchor. */
  function ensurePopover(next) {
    const anchor = inputFor(next);
    if (!anchor || popover) { return popover; }
    popover = createQueryPopover({ anchor, layer, onClose: () => { if (list) { list.hidden = true; } } });
    return popover;
  }

  return {
    /** Moves the supplied list into the portal and positions it. */
    open(next) { list = next; list.classList.add("cbx-list-portal"); ensurePopover(next)?.open(next); },
    /** Hides a list while keeping the portal helper reusable. */
    close() { popover?.close("combobox"); },
    /** Cleans portal observers and list ownership. */
    destroy() { popover?.destroy(); popover = undefined; list?.remove(); list = undefined; }
  };
}

/** Creates the documented Query Builder combobox API while adapting existing callers. */
export function createGridCombobox({ describedBy, disabledReason, getOptionId, label, name, onChange, options, popoverLayer, value, ...rest } = {}) {
  const controller = createCombobox({ ariaLabel: label || name, maxRenderedOptions: 60, onChange, options, popoverLayer, value, ...rest });
  if (describedBy) { controller.node.querySelector("input")?.setAttribute("aria-describedby", describedBy); }
  if (disabledReason) { controller.node.querySelector("input").title = disabledReason; }
  return { destroy: controller.dispose, focus: controller.focus, node: controller.node, setDisabled(disabled, reason = "") { const input = controller.node.querySelector("input"); input.disabled = Boolean(disabled); input.title = reason || disabledReason || ""; }, update({ options: nextOptions, value: nextValue }) { controller.setOptions(nextOptions); controller.setValue(nextValue); } };
}

/** Exposes option bounding behavior for focused non-DOM tests. */
export const __test = { boundedOptions };

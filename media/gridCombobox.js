// Searchable combobox widget for the model browser's filter and aggregate bars.
// A text input that type-filters an allowlisted option list (value ≠ label) and shows a dropdown. It is a drop-in
// replacement for a native <select>: the root node exposes a `value` accessor, an `_options` array, and fires a
// `change` event, so the existing cascading-filter logic keeps reading it the same way. Free text is never accepted —
// blurring without a pick reverts to the current selection, keeping every value within the option allowlist.

const NONE = -1;

/** Creates a searchable combobox. Returns { node, getValue, setValue, setOptions, focus }. */
export function createCombobox(deps) {
  const { el, options = [], value = "", placeholder = "", onChange, title = "", dataset } = deps;
  let items = normalize(options);
  let current = value == null ? "" : value;
  let activeIndex = NONE;
  let open = false;
  let visible = [];

  const input = el("input", { className: "cbx-input", placeholder, spellcheck: false, title, type: "text" });
  const list = el("div", { className: "cbx-list" });
  list.hidden = true;
  const node = el("span", { className: "combobox" }, input, list);
  if (dataset) {
    Object.assign(node.dataset, dataset);
  }
  Object.defineProperty(node, "value", { configurable: true, get: () => current, set: (next) => setValue(next) });
  node._options = items;

  /** Returns the option list as {value,label,title,group} records with string labels. */
  function normalize(list) {
    return (list || []).map((option) => ({ group: option.group || "", label: option.label == null ? String(option.value) : String(option.label), title: option.title || "", value: option.value }));
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
      return items;
    }
    return items.filter((option) => option.label.toLowerCase().includes(query));
  }

  /** Renders the dropdown for the current filter, keeping the highlight in range. */
  function render() {
    visible = matches();
    activeIndex = visible.length ? Math.max(0, Math.min(activeIndex, visible.length - 1)) : NONE;
    list.innerHTML = "";
    let group = "";
    visible.forEach((option, index) => {
      if (option.group && option.group !== group) {
        group = option.group;
        list.appendChild(el("div", { className: "cbx-group" }, group));
      }
      const optionNode = el("div", { className: index === activeIndex ? "cbx-opt active" : "cbx-opt", title: option.title }, option.label);
      optionNode.addEventListener("click", () => choose(option));
      optionNode.addEventListener("mouseenter", () => { activeIndex = index; highlight(); });
      list.appendChild(optionNode);
    });
    if (!visible.length) {
      list.appendChild(el("div", { className: "cbx-empty" }, "no matches"));
    }
  }

  /** Repaints only the active-option styling without rebuilding the list. */
  function highlight() {
    let index = 0;
    for (const child of list.children) {
      if (child.className.indexOf("cbx-opt") !== 0) {
        continue;
      }
      child.className = index === activeIndex ? "cbx-opt active" : "cbx-opt";
      index += 1;
    }
  }

  /** Opens the dropdown and renders it. */
  function show() {
    open = true;
    list.hidden = false;
    render();
  }

  /** Closes the dropdown and restores the input text to the current selection's label. */
  function hide() {
    open = false;
    list.hidden = true;
    input.value = labelFor(current);
  }

  /** Commits a chosen option, firing change only when the value actually differs. */
  function choose(option) {
    const changed = option.value !== current;
    current = option.value;
    input.value = option.label;
    open = false;
    list.hidden = true;
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

  /** Replaces the option list, clearing the selection when it is no longer valid. */
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

  /** Handles arrow/enter/escape keyboard navigation. */
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
      activeIndex = activeIndex === NONE ? 0 : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
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
  return { focus: () => input.focus(), getValue: () => current, node, setOptions, setValue };
}

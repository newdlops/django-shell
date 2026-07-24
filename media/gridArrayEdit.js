// Modal mini-table editor for ArrayField and array-valued JSONField cells.

const NUMERIC_FIELD = /(?:AutoField|IntegerField|FloatField)$/;
const TEMPORAL_INPUT = { DateField: "date", DateTimeField: "datetime-local", TimeField: "time" };
let editorSequence = 0;

/** Returns whether a value is a plain JSON object suitable for column-based editing. */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parses an editable list from one column's serialized cell text, or returns undefined for non-list values. */
export function parseEditableArray(column, text) {
  if (!column || (column.type !== "ArrayField" && column.type !== "JSONField")) {
    return undefined;
  }
  const source = String(text ?? "").trim();
  if (!source && column.type === "ArrayField") {
    return { items: [], nullValue: true };
  }
  try {
    const value = JSON.parse(source);
    return Array.isArray(value) ? { items: value, nullValue: false } : undefined;
  } catch {
    return undefined;
  }
}

/** Describes a list as scalar rows or object rows with a stable union of keys. */
function arrayShape(items) {
  if (!items.length || !items.every((item) => isRecord(item))) {
    return { keys: [], kind: "scalar" };
  }
  const keys = [];
  const seen = new Set();
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return { keys, kind: "object" };
}

/** Returns a string suitable for a value input while retaining nested JSON structure. */
function inputText(value) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value ?? "");
}

/** Coerces one control's text using field metadata or the original JSON value's type. */
function coerceInput(text, sample, fieldType = "") {
  if (fieldType === "BooleanField" || typeof sample === "boolean") {
    return text === "" ? null : text === "true";
  }
  if (NUMERIC_FIELD.test(fieldType) || typeof sample === "number") {
    const numeric = Number(text);
    return text.trim() !== "" && Number.isFinite(numeric) ? numeric : text;
  }
  if (sample === null || typeof sample === "object") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Returns a useful initial value for a newly inserted list row. */
function defaultItem(column, shape, items) {
  if (shape.kind === "object") {
    return Object.fromEntries(shape.keys.map((key) => [key, ""]));
  }
  const item = column.arrayItem || {};
  if (Array.isArray(item.choices) && item.choices.length) {
    return item.choices[0][0];
  }
  if (item.type === "BooleanField") {
    return false;
  }
  const sample = items.find((value) => value !== null);
  if (typeof sample === "number") {
    return 0;
  }
  if (typeof sample === "boolean") {
    return false;
  }
  if (Array.isArray(sample)) {
    return [];
  }
  if (isRecord(sample)) {
    return {};
  }
  return "";
}

/** Creates a DOM element with optional class and text content. */
function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== "") {
    node.textContent = text;
  }
  return node;
}

/** Creates a standard button with an explicit non-submit type. */
function button(label, className, title) {
  const node = element("button", className, label);
  node.type = "button";
  node.title = title || "";
  return node;
}

/** Returns primitive suggestions already present in a scalar list for a browser-native combobox. */
function scalarSuggestions(items) {
  const values = [];
  const seen = new Set();
  for (const item of items) {
    if (item === null || typeof item === "object" || typeof item === "boolean") {
      continue;
    }
    const text = String(item);
    if (text && !seen.has(text)) {
      seen.add(text);
      values.push(text);
    }
    if (values.length >= 100) {
      break;
    }
  }
  return values;
}

/** Finds a choice index by JSON value first and string representation second. */
function choiceIndex(choices, value) {
  const exact = choices.findIndex((choice) => JSON.stringify(choice[0]) === JSON.stringify(value));
  return exact >= 0 ? exact : choices.findIndex((choice) => String(choice[0]) === String(value));
}

/** Creates a choice dropdown that preserves the original non-string choice value. */
function choiceControl(spec, value, onValue) {
  const choices = [...spec.choices];
  let selected = choiceIndex(choices, value);
  if (selected < 0) {
    choices.push([value, String(value)]);
    selected = choices.length - 1;
  }
  const select = element("select", "arrayedit-control");
  choices.forEach((choice, index) => {
    const option = element("option", "", String(choice[1]));
    option.value = String(index);
    select.appendChild(option);
  });
  select.value = String(selected);
  select.addEventListener("change", () => onValue(choices[Number(select.value)][0]));
  return select;
}

/** Creates a boolean dropdown, including null when the item field permits it. */
function booleanControl(spec, value, onValue) {
  const select = element("select", "arrayedit-control");
  const options = spec.null ? [[null, "(null)"], [true, "true"], [false, "false"]] : [[true, "true"], [false, "false"]];
  options.forEach(([optionValue, label], index) => {
    const option = element("option", "", label);
    option.value = String(index);
    select.appendChild(option);
  });
  const selected = options.findIndex(([optionValue]) => optionValue === value);
  select.value = String(selected >= 0 ? selected : 0);
  select.addEventListener("change", () => onValue(options[Number(select.value)][0]));
  return select;
}

/** Creates the best control for one list value and updates its row model on input. */
function valueControl(value, spec, suggestionsId, onValue, label) {
  if (Array.isArray(spec.choices) && spec.choices.length) {
    const control = choiceControl(spec, value, onValue);
    control.setAttribute("aria-label", label);
    return control;
  }
  if (spec.type === "BooleanField" || typeof value === "boolean") {
    const control = booleanControl(spec, value, onValue);
    control.setAttribute("aria-label", label);
    return control;
  }
  const nested = value === null || typeof value === "object";
  const fieldType = String(spec.type || "");
  const control = element(nested ? "textarea" : "input", nested ? "arrayedit-control arrayedit-json" : "arrayedit-control");
  if (!nested) {
    control.type = TEMPORAL_INPUT[fieldType] || (NUMERIC_FIELD.test(fieldType) || typeof value === "number" ? "number" : "text");
    if (control.type === "number") {
      control.step = fieldType.includes("Integer") || fieldType.includes("AutoField") ? "1" : "any";
    }
    if (control.type === "text" && suggestionsId) {
      control.setAttribute("list", suggestionsId);
    }
  }
  control.value = inputText(value);
  control.setAttribute("aria-label", label);
  control.addEventListener("input", () => onValue(coerceInput(control.value, value, spec.type)));
  return control;
}

/** Opens a modal mini-table for one list cell and returns a controller that can cancel it. */
export function openArrayEditor(td, column, start, host) {
  const parsed = parseEditableArray(column, start);
  if (!parsed) {
    return undefined;
  }
  const baseline = parsed.nullValue ? "" : JSON.stringify(parsed.items);
  const items = JSON.parse(JSON.stringify(parsed.items));
  const shape = arrayShape(items);
  const suggestions = scalarSuggestions(items);
  const suggestionsId = `arrayedit-values-${editorSequence += 1}`;
  const backdrop = element("div", "arrayedit-backdrop");
  const panel = element("section", "arrayedit-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", `Edit ${column.name || column.attname || "list"}`);
  const header = element("header", "arrayedit-head");
  const heading = element("div", "arrayedit-title", column.name || column.attname || "List");
  const count = element("span", "arrayedit-count");
  const closeButton = button("✕", "arrayedit-close", "Cancel list editing");
  header.append(heading, count, closeButton);
  const note = element("div", "arrayedit-note");
  const scroll = element("div", "arrayedit-scroll");
  const table = element("table", "arrayedit-table");
  const footer = element("footer", "arrayedit-foot");
  const addButton = button("+ Add item", "secondary", "Append a list item");
  const nullButton = column.null ? button("Set null", "secondary", "Replace this list with null") : null;
  const spacer = element("span", "arrayedit-spacer");
  const cancelButton = button("Cancel", "secondary", "Discard list changes");
  const applyButton = button("Apply", "", "Stage list changes (Ctrl/Cmd+Enter)");
  footer.append(addButton);
  if (nullButton) {
    footer.append(nullButton);
  }
  footer.append(spacer, cancelButton, applyButton);
  scroll.appendChild(table);
  panel.append(header, note, scroll, footer);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  if (suggestions.length) {
    const list = element("datalist");
    list.id = suggestionsId;
    for (const value of suggestions) {
      const option = element("option");
      option.value = value;
      list.appendChild(option);
    }
    panel.appendChild(list);
  }

  let settled = false;

  /** Removes the modal and notifies the host exactly once. */
  function finish(next) {
    if (settled) {
      return;
    }
    settled = true;
    window.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    host.closed?.();
    if (next === undefined || next === baseline) {
      host.done();
    } else {
      host.stage(next);
    }
  }

  /** Removes one row and redraws the mini-table. */
  function removeRow(index) {
    items.splice(index, 1);
    render();
  }

  /** Appends a row matching the current list shape and redraws it. */
  function addRow() {
    items.push(defaultItem(column, shape, items));
    render(true);
  }

  /** Builds one editable value cell and wires it to the in-memory row. */
  function appendValueCell(tr, value, spec, label, onValue) {
    const tdValue = element("td");
    tdValue.appendChild(valueControl(value, spec, suggestionsId, onValue, label));
    tr.appendChild(tdValue);
  }

  /** Rebuilds headers and editable rows after an add/delete operation. */
  function render(focusLast = false) {
    table.textContent = "";
    const thead = element("thead");
    const headRow = element("tr");
    headRow.appendChild(element("th", "arrayedit-index", "#"));
    if (shape.kind === "object") {
      for (const key of shape.keys) {
        headRow.appendChild(element("th", "", key));
      }
    } else {
      headRow.appendChild(element("th", "", "Value"));
    }
    headRow.appendChild(element("th", "arrayedit-actions", ""));
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = element("tbody");
    items.forEach((item, index) => {
      const tr = element("tr");
      tr.appendChild(element("td", "arrayedit-index", String(index)));
      if (shape.kind === "object") {
        shape.keys.forEach((key) => {
          appendValueCell(tr, item[key], {}, `${key}, row ${index + 1}`, (value) => { item[key] = value; });
        });
      } else {
        appendValueCell(tr, item, column.arrayItem || {}, `Value, row ${index + 1}`, (value) => { items[index] = value; });
      }
      const actions = element("td", "arrayedit-actions");
      const remove = button("−", "arrayedit-remove", `Delete row ${index + 1}`);
      remove.addEventListener("click", () => removeRow(index));
      actions.appendChild(remove);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
    if (!items.length) {
      const emptyRow = element("tr");
      const empty = element("td", "arrayedit-empty", "No items. Use “+ Add item” to create one.");
      empty.colSpan = (shape.kind === "object" ? shape.keys.length : 1) + 2;
      emptyRow.appendChild(empty);
      tbody.appendChild(emptyRow);
    }
    table.appendChild(tbody);
    count.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
    note.textContent = parsed.nullValue ? "Current value is null. Applying converts it to a list." : shape.kind === "object" ? "Object items are expanded into columns." : "Edit each item, add rows, or remove rows.";
    if (focusLast) {
      tbody.querySelector("tr:last-child .arrayedit-control")?.focus();
    }
  }

  /** Handles modal keyboard shortcuts without leaking them to the data grid. */
  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(undefined);
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      finish(JSON.stringify(items));
    }
  }

  addButton.addEventListener("click", addRow);
  applyButton.addEventListener("click", () => finish(JSON.stringify(items)));
  cancelButton.addEventListener("click", () => finish(undefined));
  closeButton.addEventListener("click", () => finish(undefined));
  nullButton?.addEventListener("click", () => finish(""));
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) {
      finish(undefined);
    }
  });
  window.addEventListener("keydown", onKey, true);
  render();
  const firstControl = panel.querySelector(".arrayedit-control");
  (firstControl || addButton).focus();

  return { cancel: () => finish(undefined), td };
}

export const __test = { arrayShape, coerceInput, defaultItem, inputText, parseEditableArray };

// media/sqlHighlight.js
var KEYWORDS = /* @__PURE__ */ new Set([
  "SELECT",
  "DISTINCT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS",
  "NULL",
  "AS",
  "ON",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "OUTER",
  "CROSS",
  "JOIN",
  "GROUP",
  "BY",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "ASC",
  "DESC",
  "UNION",
  "ALL",
  "EXISTS",
  "LIKE",
  "ILIKE",
  "BETWEEN",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "RETURNING",
  "USING",
  "WITH",
  "TRUE",
  "FALSE"
]);
var TOKEN = /('(?:[^']|'')*')|("(?:[^"]|"")*")|(\d+(?:\.\d+)?)|(%\(\w+\)s|%s|\$\d+|\?)|([A-Za-z_][A-Za-z0-9_$]*)|(\s+)|([^\s])/g;
var CLAUSE = /\s+\b(FROM|WHERE|GROUP BY|HAVING|ORDER BY|LIMIT|OFFSET|UNION ALL|UNION|INNER JOIN|LEFT OUTER JOIN|LEFT JOIN|RIGHT JOIN|CROSS JOIN|JOIN|RETURNING)\b/gi;
function formatSqlText(sql) {
  let text = String(sql || "").replace(/\s+/g, " ").trim();
  text = text.replace(CLAUSE, "\n$1");
  const lines = text.split("\n");
  const head = lines[0].match(/^(SELECT(?:\s+DISTINCT)?)\s+([\s\S]*)$/i);
  if (head) {
    lines[0] = `${head[1]}
  ${head[2].split(/,\s*/).join(",\n  ")}`;
  }
  return lines.join("\n");
}
function highlightSqlInto(parent, sql) {
  const text = formatSqlText(sql);
  let match;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(text)) !== null) {
    if (match[6]) {
      parent.appendChild(document.createTextNode(match[6]));
      continue;
    }
    const span = document.createElement("span");
    span.textContent = match[0];
    span.className = tokenClass(match);
    parent.appendChild(span);
  }
}
function appendLogEntry(logbody, action, sqlList, orm, max) {
  const list = Array.isArray(sqlList) ? sqlList : [];
  const entry2 = document.createElement("div");
  entry2.className = "logentry";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${(/* @__PURE__ */ new Date()).toLocaleTimeString()}  \xB7  ${action}`;
  entry2.appendChild(meta);
  if (orm) {
    const command = document.createElement("code");
    command.className = "ormcmd";
    command.textContent = orm;
    entry2.appendChild(command);
  }
  if (!list.length) {
    const empty = document.createElement("code");
    empty.className = "sql";
    empty.textContent = "(no SQL)";
    entry2.appendChild(empty);
  }
  for (const item of list) {
    const code = document.createElement("code");
    code.className = "sql";
    highlightSqlInto(code, item.sql);
    if (item.time) {
      const time = document.createElement("span");
      time.className = "sql-time";
      time.textContent = `   \u2014 ${item.time}s`;
      code.appendChild(time);
    }
    entry2.appendChild(code);
  }
  logbody.insertBefore(entry2, logbody.firstChild);
  while (logbody.childElementCount > max) {
    logbody.removeChild(logbody.lastChild);
  }
}
function tokenClass(match) {
  if (match[1]) {
    return "sql-str";
  }
  if (match[2]) {
    return "sql-ident";
  }
  if (match[3]) {
    return "sql-num";
  }
  if (match[4]) {
    return "sql-param";
  }
  if (match[5]) {
    return KEYWORDS.has(match[5].toUpperCase()) ? "sql-kw" : "sql-name";
  }
  return "sql-punct";
}

// media/gridArrayEdit.js
var NUMERIC_FIELD = /(?:AutoField|IntegerField|FloatField)$/;
var TEMPORAL_INPUT = { DateField: "date", DateTimeField: "datetime-local", TimeField: "time" };
var editorSequence = 0;
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseEditableArray(column, text) {
  if (!column || column.type !== "ArrayField" && column.type !== "JSONField") {
    return void 0;
  }
  const source = String(text ?? "").trim();
  if (!source && column.type === "ArrayField") {
    return { items: [], nullValue: true };
  }
  try {
    const value = JSON.parse(source);
    return Array.isArray(value) ? { items: value, nullValue: false } : void 0;
  } catch {
    return void 0;
  }
}
function arrayShape(items) {
  if (!items.length || !items.every((item) => isRecord(item))) {
    return { keys: [], kind: "scalar" };
  }
  const keys = [];
  const seen = /* @__PURE__ */ new Set();
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
function inputText(value) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value ?? "");
}
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
function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== "") {
    node.textContent = text;
  }
  return node;
}
function button(label, className, title) {
  const node = element("button", className, label);
  node.type = "button";
  node.title = title || "";
  return node;
}
function icon(name) {
  const node = document.createElement("span");
  node.className = `codicon codicon-${name}`;
  node.setAttribute("aria-hidden", "true");
  return node;
}
function scalarSuggestions(items) {
  const values = [];
  const seen = /* @__PURE__ */ new Set();
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
function choiceIndex(choices, value) {
  const exact = choices.findIndex((choice) => JSON.stringify(choice[0]) === JSON.stringify(value));
  return exact >= 0 ? exact : choices.findIndex((choice) => String(choice[0]) === String(value));
}
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
function valueControl(value, spec, suggestionsId, onValue, label) {
  if (Array.isArray(spec.choices) && spec.choices.length) {
    const control2 = choiceControl(spec, value, onValue);
    control2.setAttribute("aria-label", label);
    return control2;
  }
  if (spec.type === "BooleanField" || typeof value === "boolean") {
    const control2 = booleanControl(spec, value, onValue);
    control2.setAttribute("aria-label", label);
    return control2;
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
function openArrayEditor(td, column, start, host) {
  const parsed = parseEditableArray(column, start);
  if (!parsed) {
    return void 0;
  }
  const baseline = parsed.nullValue ? "" : JSON.stringify(parsed.items);
  const items = JSON.parse(JSON.stringify(parsed.items));
  const shape = arrayShape(items);
  const suggestions = scalarSuggestions(items);
  const editorId = editorSequence += 1;
  const suggestionsId = `arrayedit-values-${editorId}`;
  const previousFocus = document.activeElement;
  const backdrop = element("div", "arrayedit-backdrop");
  const panel = element("section", "arrayedit-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", `Edit ${column.name || column.attname || "list"}`);
  const header = element("header", "arrayedit-head");
  const heading = element("div", "arrayedit-title", column.name || column.attname || "List");
  heading.id = `arrayedit-title-${editorId}`;
  panel.setAttribute("aria-labelledby", heading.id);
  const count = element("span", "arrayedit-count");
  count.setAttribute("aria-live", "polite");
  const closeButton = button("", "arrayedit-close", "Cancel list editing");
  closeButton.appendChild(icon("close"));
  closeButton.setAttribute("aria-label", "Cancel list editing");
  header.append(heading, count, closeButton);
  const note = element("div", "arrayedit-note");
  const scroll = element("div", "arrayedit-scroll");
  const table = element("table", "arrayedit-table");
  table.setAttribute("aria-label", `${column.name || column.attname || "List"} items`);
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
  function finish(next) {
    if (settled) {
      return;
    }
    settled = true;
    window.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    host.closed?.();
    if (next === void 0 || next === baseline) {
      host.done();
    } else {
      host.stage(next);
    }
    previousFocus?.focus?.();
  }
  function removeRow(index) {
    items.splice(index, 1);
    render();
  }
  function addRow() {
    items.push(defaultItem(column, shape, items));
    render(true);
  }
  function appendValueCell(tr, value, spec, label, onValue) {
    const tdValue = element("td");
    tdValue.appendChild(valueControl(value, spec, suggestionsId, onValue, label));
    tr.appendChild(tdValue);
  }
  function render(focusLast = false) {
    table.textContent = "";
    const thead = element("thead");
    const headRow = element("tr");
    const indexHead = element("th", "arrayedit-index", "#");
    indexHead.scope = "col";
    indexHead.setAttribute("aria-label", "Item number");
    headRow.appendChild(indexHead);
    if (shape.kind === "object") {
      for (const key of shape.keys) {
        const keyHead = element("th", "", key);
        keyHead.scope = "col";
        headRow.appendChild(keyHead);
      }
    } else {
      const valueHead = element("th", "", "Value");
      valueHead.scope = "col";
      headRow.appendChild(valueHead);
    }
    const actionsHead = element("th", "arrayedit-actions", "");
    actionsHead.scope = "col";
    actionsHead.setAttribute("aria-label", "Row actions");
    headRow.appendChild(actionsHead);
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = element("tbody");
    items.forEach((item, index) => {
      const tr = element("tr");
      tr.appendChild(element("td", "arrayedit-index", String(index)));
      if (shape.kind === "object") {
        shape.keys.forEach((key) => {
          appendValueCell(tr, item[key], {}, `${key}, row ${index + 1}`, (value) => {
            item[key] = value;
          });
        });
      } else {
        appendValueCell(tr, item, column.arrayItem || {}, `Value, row ${index + 1}`, (value) => {
          items[index] = value;
        });
      }
      const actions = element("td", "arrayedit-actions");
      const remove = button("\u2212", "arrayedit-remove", `Delete row ${index + 1}`);
      remove.setAttribute("aria-label", `Delete row ${index + 1}`);
      remove.addEventListener("click", () => removeRow(index));
      actions.appendChild(remove);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
    if (!items.length) {
      const emptyRow = element("tr");
      const empty = element("td", "arrayedit-empty", "No items. Use \u201C+ Add item\u201D to create one.");
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
  function onKey(event) {
    if (event.key === "Tab") {
      const focusable = [...panel.querySelectorAll("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])")];
      if (!focusable.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(void 0);
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      finish(JSON.stringify(items));
    }
  }
  addButton.addEventListener("click", addRow);
  applyButton.addEventListener("click", () => finish(JSON.stringify(items)));
  cancelButton.addEventListener("click", () => finish(void 0));
  closeButton.addEventListener("click", () => finish(void 0));
  nullButton?.addEventListener("click", () => finish(""));
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) {
      finish(void 0);
    }
  });
  window.addEventListener("keydown", onKey, true);
  render();
  const firstControl = panel.querySelector(".arrayedit-control");
  (firstControl || addButton).focus();
  return { cancel: () => finish(void 0), td };
}

// media/gridPin.js
function togglePin(col, button2, state2, gridwrap) {
  if (state2.pinned.has(col)) {
    state2.pinned.delete(col);
    button2.classList.remove("active");
    button2.title = "Pin column (freeze left)";
  } else {
    state2.pinned.add(col);
    button2.classList.add("active");
    button2.title = "Unpin column";
  }
  repaintPins(gridwrap, state2);
}
function repaintPins(gridwrap, state2) {
  const headRow = gridwrap.querySelector("thead tr");
  const body = gridwrap.querySelector("tbody");
  if (!headRow) {
    return;
  }
  const lefts = {};
  let offset = headRow.querySelector(".rownum")?.offsetWidth || 0;
  const headerCells = [...headRow.querySelectorAll("[data-key]")];
  for (const cell of headerCells) {
    const key = cell.dataset.key;
    if (key && state2.pinned.has(key)) {
      lefts[key] = offset;
      offset += cell.offsetWidth;
    }
  }
  for (const cell of headerCells) {
    setPin(cell, lefts[cell.dataset.key]);
  }
  if (body) {
    for (const row of body.children) {
      if (!row.dataset.pk) {
        continue;
      }
      for (const cell of row.querySelectorAll("[data-key]")) {
        setPin(cell, lefts[cell.dataset.key]);
      }
    }
  }
}
function setPin(cell, left) {
  if (!cell) {
    return;
  }
  if (left === void 0) {
    cell.classList.remove("pinned");
    cell.style.left = "";
    cell.style.position = "";
    return;
  }
  cell.classList.add("pinned");
  cell.style.position = "sticky";
  cell.style.left = `${left}px`;
}

// media/gridFkPicker.js
var DEBOUNCE_MS = 200;
function openFkPicker(td, column, start, host) {
  const wrap = document.createElement("div");
  wrap.className = "fkpick";
  const input = document.createElement("input");
  input.className = "celledit";
  input.value = start;
  input.spellcheck = false;
  input.autocomplete = "off";
  const results = document.createElement("div");
  results.className = "fkresults";
  results.hidden = true;
  wrap.appendChild(input);
  wrap.appendChild(results);
  td.textContent = "";
  td.appendChild(wrap);
  input.focus();
  input.select();
  const state2 = { current: 0, highlight: -1, options: [], settled: false, timer: null };
  function finish(value) {
    if (state2.settled) {
      return;
    }
    state2.settled = true;
    if (state2.timer) {
      clearTimeout(state2.timer);
    }
    if (value !== null && value !== start) {
      host.stage(value);
    } else {
      host.done();
    }
  }
  function query(immediate) {
    if (state2.timer) {
      clearTimeout(state2.timer);
    }
    const run = () => {
      state2.current = host.allocId();
      host.post({ q: input.value.trim(), requestId: state2.current, target: column.relation.target, type: "lookupRelated" });
    };
    if (immediate) {
      run();
    } else {
      state2.timer = setTimeout(run, DEBOUNCE_MS);
    }
  }
  function render() {
    results.textContent = "";
    results.hidden = !state2.options.length;
    state2.options.forEach((option, index) => {
      const row = document.createElement("div");
      row.className = index === state2.highlight ? "fkopt active" : "fkopt";
      row.textContent = option.label;
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        finish(String(option.pk));
      });
      results.appendChild(row);
    });
  }
  function move2(delta) {
    if (!state2.options.length) {
      return;
    }
    state2.highlight = (state2.highlight + delta + state2.options.length) % state2.options.length;
    render();
  }
  input.addEventListener("input", () => query(false));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move2(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move2(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      finish(state2.highlight >= 0 ? String(state2.options[state2.highlight].pk) : input.value.trim());
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(null);
    }
  });
  input.addEventListener("blur", () => setTimeout(() => finish(input.value.trim()), 0));
  query(true);
  return {
    /** Renders backend candidates when they answer the latest query. */
    fill(message) {
      if (state2.settled || message.requestId !== state2.current) {
        return;
      }
      const result = message.result || {};
      state2.options = result.ok && Array.isArray(result.rows) ? result.rows : [];
      state2.highlight = state2.options.length ? 0 : -1;
      render();
    }
  };
}

// media/gridEdit.js
function buildControl(column, start) {
  if (Array.isArray(column.choices) && column.choices.length) {
    return buildSelect(choiceOptions(column), start);
  }
  if (column.type === "BooleanField") {
    return buildSelect(booleanOptions(column.null), start);
  }
  const picker = { DateField: "date", DateTimeField: "datetime-local", TimeField: "time" }[column.type];
  if (picker) {
    return buildPicker(picker, column.type, start);
  }
  return buildText(start);
}
function buildText(start) {
  const input = document.createElement("input");
  input.className = "celledit";
  input.value = start;
  return { commitOnChange: false, initial: start, input, selectable: true };
}
function buildPicker(kind, type, start) {
  const input = document.createElement("input");
  input.className = "celledit";
  input.type = kind;
  if (kind !== "date") {
    input.step = "1";
  }
  input.value = normalizeTemporal(type, start);
  return { commitOnChange: false, initial: input.value, input, selectable: false };
}
function buildSelect(options, start) {
  const input = document.createElement("select");
  input.className = "celledit";
  let matched = false;
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    matched = matched || value === start;
    input.appendChild(option);
  }
  if (!matched && start !== "") {
    const option = document.createElement("option");
    option.value = start;
    option.textContent = start;
    input.appendChild(option);
  }
  input.value = start;
  return { commitOnChange: true, initial: input.value, input, selectable: false };
}
function choiceOptions(column) {
  const options = column.null ? [["", "(null)"]] : [];
  for (const [value, label] of column.choices) {
    options.push([String(value), label]);
  }
  return options;
}
function booleanOptions(nullable) {
  const options = nullable ? [["", "(null)"]] : [];
  options.push(["true", "true"], ["false", "false"]);
  return options;
}
function normalizeTemporal(type, raw) {
  if (!raw) {
    return "";
  }
  if (type === "DateField") {
    return raw.slice(0, 10);
  }
  if (type === "TimeField") {
    return cleanTime(raw);
  }
  if (type === "DateTimeField") {
    const value = raw.replace(" ", "T");
    const split = value.indexOf("T");
    return split < 0 ? value : `${value.slice(0, split + 1)}${cleanTime(value.slice(split + 1))}`;
  }
  return raw;
}
function cleanTime(time) {
  return time.replace(/(?:Z|[+-]\d{2}:?\d{2})$/, "").split(".")[0];
}
function stagedDisplay(column, staged) {
  if (staged === "") {
    return "(empty)";
  }
  if (column && Array.isArray(column.choices)) {
    const match = column.choices.find((choice) => String(choice[0]) === staged);
    if (match) {
      return match[1];
    }
  }
  return staged;
}
function createEditor(ctx) {
  const pending = /* @__PURE__ */ new Map();
  let activeArrayEditor = null;
  let activePicker = null;
  let lookupSeq = 0;
  function pendingCount() {
    let total = 0;
    for (const entry2 of pending.values()) {
      total += Object.keys(entry2.fields).length;
    }
    return total;
  }
  function stage2(td, value) {
    const tr = td.closest("tr");
    const key = tr.dataset.pk;
    let entry2 = pending.get(key);
    if (!entry2) {
      entry2 = { fields: {}, pk: tr._pk };
      pending.set(key, entry2);
    }
    entry2.fields[td.dataset.attname] = value;
    td.dataset.staged = value;
    ctx.paintCell(td);
    ctx.onChange(pendingCount());
  }
  function applyStaged(tr) {
    const entry2 = pending.get(tr.dataset.pk);
    if (!entry2) {
      return;
    }
    for (const td of tr.children) {
      const attname = td.dataset && td.dataset.attname;
      if (attname && Object.prototype.hasOwnProperty.call(entry2.fields, attname)) {
        td.dataset.staged = entry2.fields[attname];
        ctx.paintCell(td);
      }
    }
  }
  function editForeignKey(td, column, start) {
    activePicker = openFkPicker(td, column, start, {
      allocId: () => lookupSeq += 1,
      done: () => ctx.paintCell(td),
      post: (message) => ctx.post(message),
      stage: (value) => stage2(td, value)
    });
  }
  function editArray(td, column, start) {
    activeArrayEditor?.cancel();
    let opened;
    opened = openArrayEditor(td, column, start, {
      closed: () => {
        if (activeArrayEditor === opened) {
          activeArrayEditor = null;
        }
      },
      done: () => ctx.paintCell(td),
      stage: (value) => stage2(td, value)
    });
    activeArrayEditor = opened || null;
  }
  function onLookup(message) {
    if (activePicker) {
      activePicker.fill(message);
    }
  }
  function editCell(td) {
    if (!td || !td.dataset.attname || td.querySelector("input, select, textarea")) {
      return;
    }
    const column = td._column || {};
    const start = td.dataset.staged !== void 0 ? td.dataset.staged : td._editval ?? "";
    if (parseEditableArray(column, start)) {
      editArray(td, column, start);
      return;
    }
    if (column.relation) {
      editForeignKey(td, column, start);
      return;
    }
    const control = buildControl(column, start);
    const input = control.input;
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    if (control.selectable) {
      input.select();
    }
    let settled = false;
    const finish = (save) => {
      if (settled) {
        return;
      }
      settled = true;
      if (save && input.value !== control.initial) {
        stage2(td, input.value);
      } else {
        ctx.paintCell(td);
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    if (control.commitOnChange) {
      input.addEventListener("change", () => finish(true));
    }
  }
  function commitEdits() {
    if (!pendingCount()) {
      return;
    }
    ctx.onCommitStart?.(pendingCount());
    ctx.post({ changes: [...pending.values()], type: "commitEdits" });
  }
  function discardEdits() {
    if (!pending.size) {
      return;
    }
    activeArrayEditor?.cancel();
    pending.clear();
    ctx.onChange(0);
    ctx.reload();
  }
  function handleResult(result) {
    const data = result || {};
    if (data.ok) {
      activeArrayEditor?.cancel();
      pending.clear();
      ctx.onChange(0);
      ctx.onCommitEnd?.();
      ctx.notify(`Saved ${data.saved} changes.`);
      ctx.reload();
      return;
    }
    ctx.onCommitEnd?.();
    ctx.notify(`Commit failed: ${summarize(data)}`);
  }
  function summarize(data) {
    if (data.error) {
      return data.error.split("\n").pop();
    }
    const failed = (data.results || []).filter((row) => !row.ok);
    return failed.map((row) => `pk=${row.pk} ${row.error || Object.entries(row.fieldErrors || {}).map(([field, messages]) => `${field}: ${messages[0]}`).join("; ")}`).join(" \xB7 ") || "validation error";
  }
  function reset() {
    activeArrayEditor?.cancel();
    pending.clear();
    ctx.onChange(0);
  }
  return { applyStaged, commitEdits, discardEdits, editCell, handleResult, onLookup, pendingCount, reset };
}

// media/gridQuery.js
var queryPost;
var geometryFrame = 0;
var lastGeometryKey = "";
function enterQueryMode(post, initialCode = "") {
  const input = document.getElementById("queryinput");
  queryPost = post;
  if (typeof initialCode === "string") {
    input.value = initialCode;
  }
  document.getElementById("querybar").hidden = false;
  document.getElementById("filterbar").hidden = true;
  const count = document.getElementById("count");
  if (count) {
    count.hidden = true;
  }
  if (input.dataset.queryOverlayWired) {
    requestQueryOverlay(true);
    return;
  }
  input.dataset.queryOverlayWired = "true";
  const run = () => post({ code: input.value, type: "runQuery", useOverlay: true });
  document.getElementById("runQuery").addEventListener("click", run);
  input.addEventListener("input", () => post({ code: input.value, type: "queryDraftChanged" }));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      run();
    }
  });
  input.addEventListener("click", () => requestQueryOverlay(true));
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => scheduleQueryGeometry()).observe(input);
  }
  window.addEventListener("resize", scheduleQueryGeometry);
  window.addEventListener("scroll", scheduleQueryGeometry, true);
  window.visualViewport?.addEventListener("resize", scheduleQueryGeometry);
  window.visualViewport?.addEventListener("scroll", scheduleQueryGeometry);
  requestQueryOverlay(true);
}
function measureQueryEditor(show = false) {
  if (show) {
    requestQueryOverlay(true);
  } else {
    scheduleQueryGeometry();
  }
}
function setQueryDraft(code) {
  const input = document.getElementById("queryinput");
  if (input && typeof code === "string") {
    input.value = code;
  }
}
function scheduleQueryGeometry() {
  if (geometryFrame) {
    return;
  }
  geometryFrame = requestAnimationFrame(() => {
    geometryFrame = 0;
    requestQueryOverlay(false);
  });
}
function requestQueryOverlay(show) {
  const input = document.getElementById("queryinput");
  if (!input || !queryPost) {
    return;
  }
  const rect = input.getBoundingClientRect();
  if (rect.width <= 40 || rect.height <= 40) {
    return;
  }
  const geometry = { height: rect.height, left: rect.left, top: rect.top, width: rect.width };
  const key = `${geometry.left}:${geometry.top}:${geometry.width}:${geometry.height}`;
  if (!show && key === lastGeometryKey) {
    return;
  }
  lastGeometryKey = key;
  queryPost({ rect: geometry, type: show ? "showQueryOverlay" : "queryEditorGeometry" });
}

// media/gridResize.js
var MIN_WIDTH = 72;
var MAX_WIDTH = 480;
function clampWidth(width) {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));
}
function announceWidth(th, width) {
  const handle = th.querySelector(".colresize");
  handle?.setAttribute("aria-valuenow", String(width));
  handle?.setAttribute("aria-valuetext", `${width} pixels`);
}
function setWidth(th, width, state2, onResize) {
  const next = clampWidth(width);
  th.style.width = `${next}px`;
  announceWidth(th, next);
  if (th.dataset.key) {
    state2.widths[th.dataset.key] = next;
  }
  onResize?.();
}
function freezeLayout(table, state2) {
  if (table.dataset.fixed === "1") {
    return;
  }
  for (const th of table.tHead.rows[0].cells) {
    const key = th.dataset.key;
    const width = state2.widths[key] || Math.round(th.getBoundingClientRect().width);
    th.style.width = `${width}px`;
    announceWidth(th, width);
    if (key) {
      state2.widths[key] = width;
    }
  }
  table.style.tableLayout = "fixed";
  table.dataset.fixed = "1";
}
function applyStoredWidths(table, state2) {
  let applied = false;
  for (const th of table.tHead.rows[0].cells) {
    const width = state2.widths[th.dataset.key];
    if (width) {
      th.style.width = `${width}px`;
      announceWidth(th, width);
      applied = true;
    }
  }
  if (applied) {
    table.style.tableLayout = "fixed";
    table.dataset.fixed = "1";
  }
}
function makeResizable(table, state2, onResize) {
  applyStoredWidths(table, state2);
  table.tHead.addEventListener("mousedown", (event) => {
    const handle = event.target.closest(".colresize");
    if (!handle) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    freezeLayout(table, state2);
    const th = handle.closest("th");
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    const move2 = (moveEvent) => {
      setWidth(th, startWidth + (moveEvent.clientX - startX), state2, onResize);
    };
    const up = () => {
      document.removeEventListener("mousemove", move2);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", move2);
    document.addEventListener("mouseup", up);
  });
  table.tHead.addEventListener("keydown", (event) => {
    const handle = event.target.closest(".colresize");
    if (!handle) {
      return;
    }
    const th = handle.closest("th");
    const current = Number(state2.widths[th.dataset.key] || th.getBoundingClientRect().width);
    const amount = event.shiftKey ? 32 : 8;
    const next = event.key === "ArrowLeft" ? current - amount : event.key === "ArrowRight" ? current + amount : event.key === "Home" ? MIN_WIDTH : event.key === "End" ? MAX_WIDTH : void 0;
    if (next === void 0) {
      return;
    }
    event.preventDefault();
    freezeLayout(table, state2);
    setWidth(th, next, state2, onResize);
  });
}

// media/gridRelated.js
function rawOf(cell) {
  return cell !== null && typeof cell === "object" ? cell.v : cell;
}
function textOf(cell) {
  return cell === null || cell === void 0 ? "" : typeof cell === "object" ? (cell.edit ?? cell.v) == null ? "" : String(cell.edit ?? cell.v) : String(cell);
}
function paintRelatedCell(td, el2, renderValue2) {
  const column = td._column;
  td.textContent = "";
  if (td.dataset.staged !== void 0) {
    td.classList.add("dirty");
    td.appendChild(el2("span", {}, stagedDisplay(column, td.dataset.staged)));
    return;
  }
  td.classList.remove("dirty");
  td.appendChild(renderValue2(td._cell));
  if (column.relation && rawOf(td._cell) !== null && rawOf(td._cell) !== void 0) {
    td.appendChild(document.createTextNode(" "));
    td.appendChild(el2("button", { ariaLabel: `Open ${column.relation.target} filtered to this row`, className: "linkbtn", dataset: { act: "open", target: column.relation.target, val: String(rawOf(td._cell)) }, title: `Open ${column.relation.target} filtered to this row` }, el2("span", { ariaHidden: "true", className: "codicon codicon-open-preview" })));
  }
}
function buildEditableRelatedTable(result, deps) {
  const { el: el2, renderValue: renderValue2, post } = deps;
  const columns = result.columns || [];
  const pkName = result.pk || "id";
  const canEdit = Boolean(result.app && result.model && !result.single);
  const wrap = el2("div", {});
  let commitBtn = null;
  const editor2 = canEdit ? createEditor({
    notify: () => void 0,
    onChange: (count) => {
      if (commitBtn) {
        commitBtn.textContent = count ? `Commit ${result.model} (${count})` : `Commit ${result.model}`;
        commitBtn.disabled = !count;
      }
    },
    paintCell: (td) => paintRelatedCell(td, el2, renderValue2),
    post: (message) => {
      if (message.type === "commitEdits") {
        post({ app: result.app, changes: message.changes, columns, model: result.model, type: "commitRelated" });
      }
    },
    reload: () => void 0
  }) : null;
  if (editor2) {
    commitBtn = el2("button", { className: "linkbtn", title: "Commit edits to the related model" }, `Commit ${result.model}`);
    commitBtn.disabled = true;
    commitBtn.addEventListener("click", () => editor2.commitEdits());
    const bar = el2("div", { className: "nestedhead" });
    bar.appendChild(commitBtn);
    wrap.appendChild(bar);
  }
  const table = el2("table", {});
  const headRow = el2("tr", {});
  for (const column of columns) {
    headRow.appendChild(el2("th", {}, column.attname));
  }
  table.appendChild(el2("thead", {}, headRow));
  const tbody = el2("tbody", {});
  for (const row of result.rows) {
    const pk = rawOf(row[pkName]);
    const tr = el2("tr", {});
    tr.dataset.pk = String(pk);
    tr._pk = pk;
    for (const column of columns) {
      const td = el2("td", {});
      td._cell = row[column.attname];
      td._column = column;
      td._pk = pk;
      if (canEdit && column.editable && !column.relation) {
        td.classList.add("editable");
        td.dataset.attname = column.attname;
        td._editval = textOf(td._cell);
        td.title = "Double-click to edit";
      }
      paintRelatedCell(td, el2, renderValue2);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  if (editor2) {
    table.addEventListener("dblclick", (event) => {
      const td = event.target.closest("td.editable");
      if (td) {
        event.stopPropagation();
        editor2.editCell(td);
      }
    });
  }
  wrap.appendChild(table);
  return wrap;
}

// media/gridViewport.js
var DEFAULT_COLUMN_WIDTH = 160;
var DEFAULT_ROW_HEIGHT = 24;
var DOM_CELL_BUDGET = 1200;
var MAX_COLUMN_WIDTH = 480;
var MIN_COLUMN_WIDTH = 72;
var ROW_OVERSCAN = 8;
var COLUMN_OVERSCAN = 2;
function columnWidth(key, widths) {
  const value = Number(widths && widths[key]);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_COLUMN_WIDTH;
  }
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(value)));
}
function logicalColumns(columns, relations, widths) {
  const fields3 = (columns || []).map((column) => ({
    key: column.attname,
    kind: "field",
    source: column,
    width: columnWidth(column.attname, widths)
  }));
  const relationColumns = (relations || []).map((relation) => ({
    key: `rel:${relation.name}`,
    kind: "relation",
    source: relation,
    width: columnWidth(`rel:${relation.name}`, widths)
  }));
  return [...fields3, ...relationColumns];
}
function calculateColumnWindow(columns, pinnedKeys, scrollLeft, viewportWidth) {
  const available = columns || [];
  const byKey = new Map(available.map((column) => [column.key, column]));
  const pinned = [];
  for (const key of pinnedKeys || []) {
    const column = byKey.get(key);
    if (column?.kind === "field") {
      pinned.push(column);
    }
  }
  const pinnedKeySet = new Set(pinned.map((column) => column.key));
  const scrollable = available.filter((column) => !pinnedKeySet.has(column.key));
  const width = Math.max(1, Number(viewportWidth) || 1);
  let before = 0;
  let first = 0;
  while (first < scrollable.length && before + scrollable[first].width <= scrollLeft) {
    before += scrollable[first].width;
    first += 1;
  }
  let visibleEnd = first;
  let covered = before;
  const target = scrollLeft + width;
  while (visibleEnd < scrollable.length && covered < target) {
    covered += scrollable[visibleEnd].width;
    visibleEnd += 1;
  }
  const start = Math.max(0, first - COLUMN_OVERSCAN);
  const end = Math.min(scrollable.length, visibleEnd + COLUMN_OVERSCAN);
  const leftSpacerWidth = scrollable.slice(0, start).reduce((sum, column) => sum + column.width, 0);
  const visible = scrollable.slice(start, end);
  const rightSpacerWidth = scrollable.slice(end).reduce((sum, column) => sum + column.width, 0);
  const pinnedWidth = pinned.reduce((sum, column) => sum + column.width, 0);
  const totalWidth = 46 + pinnedWidth + leftSpacerWidth + visible.reduce((sum, column) => sum + column.width, 0) + rightSpacerWidth;
  const logicalColumnIndices = Object.fromEntries([...pinned, ...scrollable].map((column, index) => [column.key, index + 2]));
  return { end, leftSpacerWidth, logicalColumnIndices, pinned, rightSpacerWidth, scrollable, start, totalWidth, visible };
}
function calculateRowWindow({ maxRows = Number.POSITIVE_INFINITY, rowCount, rowHeight = DEFAULT_ROW_HEIGHT, scrollTop, viewportHeight }) {
  const count = Math.max(0, Number(rowCount) || 0);
  const height = Math.max(1, Number(rowHeight) || DEFAULT_ROW_HEIGHT);
  const rowLimit = Number.isFinite(Number(maxRows)) ? Math.max(1, Number(maxRows)) : Number.POSITIVE_INFINITY;
  const first = Math.max(0, Math.floor(Math.max(0, Number(scrollTop) || 0) / height) - ROW_OVERSCAN);
  const visible = Math.ceil(Math.max(0, Number(viewportHeight) || 0) / height) + ROW_OVERSCAN * 2;
  const end = Math.min(count, first + Math.max(1, Math.min(visible, rowLimit)));
  return { bottomSpacerHeight: Math.max(0, count - end) * height, end, first, topSpacerHeight: first * height };
}
function createGridViewport(ctx) {
  let columns = [];
  let snapshot = calculateColumnWindow(columns, ctx.pinned(), 0, ctx.scroller.clientWidth);
  let scheduled = false;
  function schedule() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      refresh();
    });
  }
  function refresh(force = false) {
    const next = calculateColumnWindow(columns, ctx.pinned(), ctx.scroller.scrollLeft, ctx.scroller.clientWidth);
    const changed = force || next.start !== snapshot.start || next.end !== snapshot.end || next.pinned.map((column) => column.key).join(",") !== snapshot.pinned.map((column) => column.key).join(",") || next.totalWidth !== snapshot.totalWidth;
    snapshot = next;
    if (changed) {
      ctx.onChange(snapshot);
    }
    return snapshot;
  }
  function offsetFor(key) {
    let offset = 0;
    for (const column of snapshot.scrollable) {
      if (column.key === key) {
        return offset;
      }
      offset += column.width;
    }
    return void 0;
  }
  function scrollToKey(key) {
    if (!key || snapshot.pinned.some((column) => column.key === key)) {
      return false;
    }
    const offset = offsetFor(key);
    if (offset === void 0) {
      return false;
    }
    const target = Math.max(0, offset - Math.max(0, (ctx.scroller.clientWidth - columnWidth(key, ctx.widths())) / 2));
    ctx.scroller.scrollLeft = target;
    refresh(true);
    return true;
  }
  ctx.scroller.addEventListener("scroll", schedule, { passive: true });
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => refresh(true)).observe(ctx.scroller);
  }
  return {
    /** Replaces logical columns and forces an initial render. */
    setColumns(next) {
      columns = next || [];
      refresh(true);
    },
    /** Forces a geometry refresh after pinning or resizing. */
    refresh,
    /** Returns the current rendered column band. */
    snapshot() {
      return snapshot;
    },
    /** Scrolls an offscreen column into view. */
    scrollToKey,
    /** Returns whether row virtualization is required for the current logical grid. */
    shouldVirtualizeRows(rowCount) {
      return rowCount > 80 || rowCount * (columns.length + 1) > 900;
    }
  };
}

// media/gridVirtual.js
var RENDER_ALL_MAX = 80;
function createVirtualRows(ctx) {
  let rows = [];
  let rowH = DEFAULT_ROW_HEIGHT;
  let measured = false;
  let renderedFirst = 0;
  let renderedEnd = 0;
  function settleActiveEditor() {
    const active = document.activeElement;
    if (active && ctx.scroller.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) {
      active.blur();
    }
  }
  function spacer(height) {
    const tr = document.createElement("tr");
    tr.className = "vspacer";
    const td = document.createElement("td");
    td.colSpan = ctx.columnSpan();
    td.style.cssText = `padding:0;border:0;height:${Math.max(0, Math.round(height))}px`;
    tr.appendChild(td);
    return tr;
  }
  function windowRange() {
    return calculateRowWindow({ maxRows: ctx.maxRows?.(), rowCount: rows.length, rowHeight: rowH, scrollTop: ctx.scroller.scrollTop, viewportHeight: ctx.scroller.clientHeight || 0 });
  }
  function paintWindow(first, end) {
    const body = ctx.getBody();
    if (!body) {
      return;
    }
    const frag = document.createDocumentFragment();
    if (first > 0) {
      frag.appendChild(spacer(first * rowH));
    }
    for (let i = first; i < end; i += 1) {
      frag.appendChild(ctx.buildRow(rows[i], i));
    }
    if (end < rows.length) {
      frag.appendChild(spacer((rows.length - end) * rowH));
    }
    body.replaceChildren(frag);
    renderedFirst = first;
    renderedEnd = end;
    if (!measured) {
      measure(body);
    }
    afterRender();
  }
  function paintAll() {
    const body = ctx.getBody();
    if (!body) {
      return;
    }
    const frag = document.createDocumentFragment();
    for (let i = 0; i < rows.length; i += 1) {
      frag.appendChild(ctx.buildRow(rows[i], i));
    }
    body.replaceChildren(frag);
    renderedFirst = 0;
    renderedEnd = rows.length;
    afterRender();
  }
  function measure(body) {
    const sample = body.querySelector("tr[data-pk]");
    const height = sample ? sample.offsetHeight : 0;
    measured = true;
    if (height > 4 && Math.abs(height - rowH) > 1) {
      rowH = height;
      render();
    }
  }
  function afterRender() {
    if (ctx.onRender) {
      ctx.onRender();
    }
  }
  function needsWindowing() {
    return rows.length > RENDER_ALL_MAX || Boolean(ctx.shouldWindow?.(rows.length));
  }
  function render() {
    if (!needsWindowing()) {
      paintAll();
    } else {
      const range = windowRange();
      paintWindow(range.first, range.end);
    }
  }
  function onScroll() {
    if (!needsWindowing()) {
      return;
    }
    const top = ctx.scroller.scrollTop;
    const viewH = ctx.scroller.clientHeight || 0;
    const needFirst = Math.floor(top / rowH);
    const needEnd = Math.ceil((top + viewH) / rowH);
    if (needFirst < renderedFirst || needEnd > renderedEnd) {
      settleActiveEditor();
      const range = windowRange();
      paintWindow(range.first, range.end);
    }
  }
  ctx.scroller.addEventListener("scroll", onScroll, { passive: true });
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (needsWindowing()) {
        render();
      }
    }).observe(ctx.scroller);
  }
  return {
    /** Replaces (or appends to) the row data and renders; a fresh (non-append) load resets the scroll. */
    setRows(next, append) {
      rows = append ? rows.concat(next || []) : (next || []).slice();
      if (!append) {
        measured = false;
        ctx.scroller.scrollTop = 0;
      }
      render();
      return rows.length;
    },
    /** Re-renders the current window in place (use after external row-data mutations). */
    refresh() {
      render();
    },
    /** Total rows currently held by the controller. */
    count() {
      return rows.length;
    }
  };
}

// media/gridKeyboard.js
function installGridKeyboard(table, ctx) {
  function activate(cell) {
    for (const peer of table.querySelectorAll('[role="gridcell"][tabindex="0"]')) {
      peer.tabIndex = -1;
    }
    cell.tabIndex = 0;
  }
  function focus(rowIndex, key) {
    const selector = `tr[data-row-index="${rowIndex}"] [role="gridcell"][data-key="${CSS.escape(key)}"]`;
    const cell = table.querySelector(selector);
    if (cell) {
      activate(cell);
      cell.focus();
      return;
    }
    ctx.reveal(rowIndex, key);
  }
  table.addEventListener("focusin", (event) => {
    const cell = event.target.closest('[role="gridcell"]');
    if (cell) {
      activate(cell);
    }
  });
  table.addEventListener("keydown", (event) => {
    if (event.target.matches("input,select,textarea,button")) {
      return;
    }
    const cell = event.target.closest('[role="gridcell"]');
    if (!cell) {
      return;
    }
    const row = cell.closest("tr[data-row-index]");
    const rowIndex = Number(row?.dataset.rowIndex);
    const key = cell.dataset.key;
    const keys = ctx.logicalKeys();
    const columnIndex = keys.indexOf(key);
    if (!Number.isFinite(rowIndex) || columnIndex < 0) {
      return;
    }
    let nextRow = rowIndex;
    let nextKey = key;
    if (event.key === "ArrowLeft") {
      nextKey = keys[Math.max(0, columnIndex - 1)];
    } else if (event.key === "ArrowRight") {
      nextKey = keys[Math.min(keys.length - 1, columnIndex + 1)];
    } else if (event.key === "ArrowUp") {
      nextRow = Math.max(0, rowIndex - 1);
    } else if (event.key === "ArrowDown") {
      nextRow = Math.min(ctx.rowCount() - 1, rowIndex + 1);
    } else if (event.key === "Home") {
      nextKey = keys[0];
      nextRow = event.metaKey || event.ctrlKey ? 0 : rowIndex;
    } else if (event.key === "End") {
      nextKey = keys[keys.length - 1];
      nextRow = event.metaKey || event.ctrlKey ? Math.max(0, ctx.rowCount() - 1) : rowIndex;
    } else if (event.key === "PageUp") {
      nextRow = Math.max(0, rowIndex - Math.max(1, ctx.viewportRows?.() ?? 10));
    } else if (event.key === "PageDown") {
      nextRow = Math.min(ctx.rowCount() - 1, rowIndex + Math.max(1, ctx.viewportRows?.() ?? 10));
    } else if (event.key === "Escape" && ctx.closeDetail?.()) {
      event.preventDefault();
      return;
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      ctx.activate(cell);
      return;
    } else {
      return;
    }
    event.preventDefault();
    focus(nextRow, nextKey);
  });
}

// media/gridDiagnostics.js
function reportGridRender({ logicalRows, post, snapshot, startedAt, table }) {
  const renderedCells = table.querySelectorAll('[role="gridcell"]').length;
  post({
    grid: {
      logicalColumns: snapshot.pinned.length + snapshot.scrollable.length + 1,
      logicalRows,
      ms: Math.round((performance.now() - startedAt) * 10) / 10,
      renderedCells,
      renderedColumns: snapshot.pinned.length + snapshot.visible.length + 1,
      renderedRows: table.querySelectorAll("tbody tr[data-row-index]").length
    },
    type: "gridRendered"
  });
}

// media/modelBrowserIcons.js
function codicon(name) {
  const icon2 = document.createElement("span");
  icon2.className = `codicon codicon-${name}`;
  icon2.setAttribute("aria-hidden", "true");
  return icon2;
}

// media/gridRenderer.js
function createGridHeaderRenderer({ el: el2, relationKindLabel: relationKindLabel2, relationModelName: relationModelName2, state: state2 }) {
  function buildHead(snapshot) {
    const head = el2("thead", {});
    const row = el2("tr", { ariaRowIndex: "1", role: "row" });
    row.appendChild(el2("th", { ariaColIndex: "1", ariaLabel: "Row number", className: "rownum", role: "columnheader", title: "Row number" }, "#"));
    for (const descriptor of snapshot.pinned) {
      appendHeaderCell(row, descriptor, snapshot);
    }
    appendGridSpacer(row, snapshot.leftSpacerWidth, "left");
    for (const descriptor of snapshot.visible) {
      appendHeaderCell(row, descriptor, snapshot);
    }
    appendGridSpacer(row, snapshot.rightSpacerWidth, "right");
    head.appendChild(row);
    return head;
  }
  function appendHeaderCell(row, descriptor, snapshot) {
    const ariaColIndex = String(snapshot.logicalColumnIndices?.[descriptor.key] ?? 1);
    if (descriptor.kind === "relation") {
      const relation = descriptor.source;
      const th2 = el2("th", { ariaColIndex, className: "relcol", dataset: { key: descriptor.key }, role: "columnheader", title: `${relationKindLabel2(relation.kind)} \u2192 ${relation.target}` }, document.createTextNode(relation.name), el2("span", { className: "coltype" }, `${relationKindLabel2(relation.kind)} (${relationModelName2(relation.target)})`), el2("span", { ariaLabel: `Resize ${relation.name} column`, ariaOrientation: "vertical", ariaValueMax: 480, ariaValueMin: 72, ariaValueNow: descriptor.width, className: "colresize", dataset: { key: descriptor.key }, role: "separator", tabIndex: 0, title: "Drag to resize" }));
      th2.style.width = `${descriptor.width}px`;
      row.appendChild(th2);
      return;
    }
    const column = descriptor.source;
    const sortable = !column.computed;
    const headClass = column.annotation ? "annotation" : column.computed ? "computed" : "sortable";
    const headTitle = sortable ? `Sort by ${column.name} (${column.type})` : `${column.name} (computed @property \u2014 read-only)`;
    const order = state2.order.find((term) => term.field === column.attname);
    const th = el2("th", { ariaColIndex, ariaSort: sortable ? order ? order.desc ? "descending" : "ascending" : "none" : void 0, className: headClass, dataset: { key: column.attname }, role: "columnheader", title: headTitle });
    th.style.width = `${descriptor.width}px`;
    const pinned = state2.pinned.has(column.attname);
    th.appendChild(el2("button", { ariaLabel: pinned ? `Unpin ${column.attname} column` : `Pin ${column.attname} column`, className: pinned ? "pinbtn active" : "pinbtn", dataset: { act: "pin", col: column.attname }, title: pinned ? "Unpin column" : "Pin column (freeze left)" }, codicon(pinned ? "pinned" : "pin")));
    if (column.computed) {
      const loading = state2.computedActive.has(column.attname);
      const cost = column.annotated ? "DB annotation \u2014 single query" : "per-row @property \u2014 N+1";
      th.appendChild(el2("button", { ariaLabel: `${loading ? "Reload" : "Load"} ${column.attname} computed values`, className: loading ? "loadbtn active" : "loadbtn", dataset: { act: "loadComputed", field: column.attname }, title: `${loading ? "Reload" : "Load"} this column for loaded rows (${cost})` }, codicon(loading ? "refresh" : "triangle-right")));
    }
    if (sortable) {
      th.appendChild(el2("button", { ariaLabel: headTitle, className: "sortbtn", dataset: { act: "sort", col: column.attname } }, column.attname));
    } else {
      th.appendChild(document.createTextNode(column.attname));
    }
    if (column.pk) {
      th.appendChild(el2("span", { ariaLabel: "Primary key", className: "pkmark", title: "primary key" }, codicon("key")));
    }
    if (sortable) {
      th.appendChild(el2("span", { className: "sortarrow", dataset: { arrow: column.attname } }, ""));
    }
    th.appendChild(el2("span", { className: "coltype" }, column.relation ? `\u2192 ${column.relation.target}` : column.computed ? column.annotated ? "@property \xB7 1 query" : "@property" : column.type));
    th.appendChild(el2("span", { ariaLabel: `Resize ${column.attname} column`, ariaOrientation: "vertical", ariaValueMax: 480, ariaValueMin: 72, ariaValueNow: descriptor.width, className: "colresize", dataset: { key: descriptor.key }, role: "separator", tabIndex: 0, title: "Drag to resize" }));
    row.appendChild(th);
  }
  function appendGridSpacer(row, width, side) {
    if (!width) {
      return;
    }
    const spacer = el2("th", { ariaHidden: "true", className: "gridspacer", role: "presentation" });
    spacer.dataset.side = side;
    spacer.style.width = `${width}px`;
    row.appendChild(spacer);
  }
  return { buildHead };
}

// media/modelBrowserLogDrawer.js
function installLogDrawer({ panel, resizeHandle, toggle, vscode: vscode2 }) {
  if (!resizeHandle || !panel) {
    return;
  }
  const savedState = vscode2.getState() || {};
  toggleLogPanel({ open: Boolean(savedState.logOpen), panel, toggle });
  setPanelHeight(savedState.logHeight || panel.offsetHeight || 220, resizeHandle);
  resizeHandle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panel.offsetHeight;
    resizeHandle.classList.add("dragging");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const move2 = (moveEvent) => {
      setPanelHeight(startHeight + (startY - moveEvent.clientY), resizeHandle);
    };
    const up = () => {
      document.removeEventListener("mousemove", move2);
      document.removeEventListener("mouseup", up);
      resizeHandle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      vscode2.setState({ ...vscode2.getState() || {}, logHeight: Math.round(panel.offsetHeight) });
    };
    document.addEventListener("mousemove", move2);
    document.addEventListener("mouseup", up);
  });
  resizeHandle.addEventListener("keydown", (event) => {
    const maximum = maximumLogHeight();
    const current = panel.offsetHeight || 220;
    const step = event.shiftKey ? 64 : 16;
    let next;
    if (event.key === "ArrowUp") {
      next = current + step;
    } else if (event.key === "ArrowDown") {
      next = current - step;
    } else if (event.key === "Home") {
      next = 72;
    } else if (event.key === "End") {
      next = maximum;
    }
    if (next === void 0) {
      return;
    }
    event.preventDefault();
    setPanelHeight(next, resizeHandle);
    vscode2.setState({ ...vscode2.getState() || {}, logHeight: Math.round(clampLogHeight(next)) });
  });
}
function toggleLogPanel({ open, panel, toggle }) {
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
}
function clampLogHeight(value) {
  return Math.max(72, Math.min(value, maximumLogHeight()));
}
function maximumLogHeight() {
  return Math.max(120, Math.min(Math.floor(window.innerHeight * 0.6), window.innerHeight - 160));
}
function setPanelHeight(value, resizeHandle) {
  const next = clampLogHeight(value);
  document.documentElement.style.setProperty("--log-h", `${next}px`);
  resizeHandle.setAttribute("aria-valuemin", "72");
  resizeHandle.setAttribute("aria-valuemax", String(maximumLogHeight()));
  resizeHandle.setAttribute("aria-valuenow", String(Math.round(next)));
}

// media/queryRunUi.js
function createQueryRunUi(ctx) {
  const run = document.getElementById("runQuery");
  const interrupt = document.getElementById("interruptQuery");
  const openConsole = document.getElementById("openQueryConsole");
  const guarded = ["transport", "reload", "more"].map((id) => document.getElementById(id)).filter(Boolean);
  let snapshot;
  let timer = 0;
  let lastSecond = -1;
  let announcedState = "";
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
  }
  function text() {
    if (!snapshot) {
      return "";
    }
    const seconds = Math.max(0, Math.floor((Date.now() - (snapshot.startedAt || Date.now())) / 1e3));
    if (snapshot.state === "idle") {
      return "Ready to run a Django ORM query.";
    }
    if (snapshot.state === "running") {
      return `Running query \xB7 ${seconds}s`;
    }
    if (snapshot.state === "slow") {
      return `Still running in the live Django shell \xB7 ${seconds}s`;
    }
    if (snapshot.state === "cancelling") {
      return "Interrupting query\u2026";
    }
    if (snapshot.state === "timedOut") {
      return `Query interrupted after ${Math.round((snapshot.timeoutMs || 0) / 1e3)}s.`;
    }
    if (snapshot.state === "cancelled") {
      return snapshot.error ? "Interrupt could not be confirmed. Open Django Shell and use Restart Kernel." : "Query interrupted.";
    }
    return snapshot.error || "";
  }
  function render(next) {
    snapshot = next;
    const active = ["running", "slow", "cancelling"].includes(next?.state);
    document.querySelector(".app")?.setAttribute("aria-busy", String(active));
    run.disabled = active;
    run.textContent = ["failed", "timedOut"].includes(next?.state) ? "Retry" : "Run query";
    interrupt.hidden = !active;
    interrupt.disabled = next?.state === "cancelling";
    interrupt.setAttribute("aria-hidden", String(!active));
    if (openConsole) {
      const needsRecovery = next?.state === "cancelled" && Boolean(next.error);
      openConsole.hidden = !needsRecovery;
      openConsole.setAttribute("aria-hidden", String(!needsRecovery));
    }
    for (const control of guarded) {
      if (active) {
        control.dataset.queryRunDisabled = control.disabled ? "preserve" : "restore";
        control.disabled = true;
      } else if (control.dataset.queryRunDisabled === "restore") {
        control.disabled = false;
        delete control.dataset.queryRunDisabled;
      }
    }
    if (active) {
      updateStatus();
      if (!timer) {
        timer = setInterval(updateStatus, 250);
      }
    } else {
      stop();
      const message = text();
      if (message) {
        ctx.status.textContent = message;
      }
    }
    if (next?.state && next.state !== announcedState) {
      announcedState = next.state;
      (next.state === "failed" ? ctx.announcer?.announceError : ctx.announcer?.announceStatus)?.(text());
    }
  }
  function updateStatus() {
    const second = Math.max(0, Math.floor((Date.now() - (snapshot?.startedAt || Date.now())) / 1e3));
    if (second === lastSecond && ctx.status.textContent) {
      return;
    }
    lastSecond = second;
    ctx.status.textContent = text();
  }
  function successText(rowCount) {
    const seconds = Math.max(0, Number(snapshot?.elapsedMs) || 0) / 1e3;
    return `Loaded ${rowCount} row${rowCount === 1 ? "" : "s"} in ${seconds.toFixed(seconds < 10 ? 1 : 0)}s.`;
  }
  interrupt.addEventListener("click", () => ctx.post({ type: "interruptQuery" }));
  openConsole?.addEventListener("click", () => ctx.post({ type: "openConsole" }));
  return { render, successText };
}

// media/uiAnnouncer.js
function createAnnouncer(root = document) {
  const polite = root.getElementById("politeAnnouncements");
  const assertive = root.getElementById("assertiveAnnouncements");
  function announce(target, message) {
    if (!target || !message) {
      return;
    }
    target.textContent = "";
    requestAnimationFrame(() => {
      target.textContent = String(message);
    });
  }
  return {
    /** Announces normal progress and completion without interrupting speech. */
    announceStatus(message) {
      announce(polite, message);
    },
    /** Announces an actionable failure immediately. */
    announceError(message) {
      announce(assertive, message);
    }
  };
}

// media/uiOverflowMenu.js
function createOverflowMenu({
  actions,
  compactContainer,
  menu,
  narrowAt = 640,
  trigger,
  wideAt = 960,
  wideContainer
}) {
  let open = false;
  let lastCompact = false;
  const root = trigger.closest("[data-overflow-root]") || document.body;
  function menuItems() {
    return [...menu.querySelectorAll('[role="menuitem"]:not([hidden]):not([disabled])')];
  }
  function close({ restoreFocus = false } = {}) {
    if (!open) {
      return;
    }
    open = false;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) {
      trigger.focus();
    }
  }
  function show() {
    const items = menuItems();
    if (!items.length) {
      return;
    }
    open = true;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    items[0].focus();
  }
  function layout(width = root.clientWidth) {
    const compact = width < wideAt;
    const narrow = width < narrowAt;
    for (const action of actions) {
      const { element: element3, priority } = action;
      const overflow = priority === "secondary" || priority === "context" && narrow;
      const destination = compact && overflow ? menu : compact && priority === "context" ? compactContainer : wideContainer;
      if (element3.parentElement !== destination) {
        destination.appendChild(element3);
      }
      element3.hidden = false;
      if (destination === menu) {
        element3.setAttribute("role", "menuitem");
      } else {
        element3.removeAttribute("role");
      }
    }
    compactContainer.hidden = !compactContainer.childElementCount;
    lastCompact = compact;
    const hasMenuItems = menu.querySelectorAll('[role="menuitem"]').length > 0;
    trigger.hidden = !hasMenuItems;
    if (!hasMenuItems) {
      close();
    }
  }
  function onMenuKeydown(event) {
    const items = menuItems();
    const index = items.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close({ restoreFocus: true });
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      items[(index + direction + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items.at(-1)?.focus();
    }
  }
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", menu.id);
  trigger.addEventListener("click", () => open ? close({ restoreFocus: true }) : show());
  menu.addEventListener("keydown", onMenuKeydown);
  menu.addEventListener("click", () => close());
  document.addEventListener("pointerdown", (event) => {
    if (open && !root.contains(event.target)) {
      close();
    }
  });
  root.addEventListener("focusout", () => {
    requestAnimationFrame(() => {
      if (open && !root.contains(document.activeElement)) {
        close();
      }
    });
  });
  const observer = new ResizeObserver((entries2) => layout(entries2[0]?.contentRect.width));
  observer.observe(root);
  layout();
  return {
    /** Closes the menu and disconnects its observer. */
    dispose() {
      observer.disconnect();
      close();
    },
    /** Re-evaluates action placement after a caller changes visibility. */
    refresh() {
      layout();
    },
    /** Reports whether actions are currently using compact placement. */
    isCompact() {
      return lastCompact;
    }
  };
}

// media/modelBrowserChrome.js
function installModelBrowserChrome(root = document) {
  const trigger = root.getElementById("browserOverflow");
  const menu = root.getElementById("browserOverflowMenu");
  const wideContainer = root.getElementById("browserWideActions");
  const compactContainer = root.getElementById("browserCompactActions");
  if (!trigger || !menu || !wideContainer || !compactContainer) {
    return { dispose() {
    }, refresh() {
    } };
  }
  const actions = [
    { element: root.getElementById("queryDrawerToggle") || root.getElementById("groupToggle"), priority: "secondary" },
    { element: root.getElementById("logToggle"), priority: "secondary" },
    { element: root.getElementById("reload"), priority: "context" }
  ].filter((action) => action.element);
  return createOverflowMenu({ actions, compactContainer, menu, trigger, wideContainer });
}

// media/modelBrowserSurface.js
function isQuerySurface(root = document) {
  return root.querySelector(".app")?.dataset.surface === "query";
}
function renderBrowserError({ create, grid, message, onOpenConsole, onRetry, status }) {
  const detail = conciseError(message);
  grid.innerHTML = "";
  const box = create("div", { className: "error-state" }, create("strong", {}, "Could not load Django data"), create("span", {}, detail));
  box.append(create("button", { className: "secondary", type: "button" }, "Retry"), create("button", { className: "secondary", type: "button" }, "Open Django Shell"));
  const [retry, openConsole] = box.querySelectorAll("button");
  retry.addEventListener("click", onRetry);
  openConsole.addEventListener("click", onOpenConsole);
  grid.appendChild(box);
  status.textContent = detail;
  return detail;
}
function conciseError(message) {
  const text = String(message || "Django Shell could not load this result.").split(/\r?\n/)[0].replace(/^[\w.]+(?:Error|Exception):\s*/, "").trim();
  return text.length <= 220 ? text || "Django Shell could not load this result." : `${text.slice(0, 217)}...`;
}

// media/gridQueryPopover.js
function popoverPosition(anchorRect, contentRect, viewport = {}) {
  const margin = 8;
  const width = Math.min(contentRect.width || 0, Math.max(0, (viewport.width || 0) - margin * 2));
  const below = (viewport.height || 0) - anchorRect.bottom;
  const above = anchorRect.top;
  const placeAbove = below < contentRect.height && above > below;
  return {
    left: Math.max(margin, Math.min(anchorRect.left, (viewport.width || 0) - width - margin)),
    maxHeight: Math.max(80, (placeAbove ? above : below) - margin),
    top: placeAbove ? Math.max(margin, anchorRect.top - Math.min(contentRect.height, above - margin)) : Math.min((viewport.height || 0) - margin, anchorRect.bottom),
    width
  };
}
function createQueryPopover({ anchor, layer, onClose, root = document } = {}) {
  const view = root.defaultView || window;
  const node = root.createElement("div");
  node.className = "query-popover";
  node.hidden = true;
  layer.appendChild(node);
  let frame;
  let opened = false;
  function reposition() {
    frame = void 0;
    if (!opened) {
      return;
    }
    const anchorRect = anchor.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const position = popoverPosition(anchorRect, rect, { height: view.innerHeight, width: view.innerWidth });
    node.style.left = `${position.left}px`;
    node.style.maxHeight = `${position.maxHeight}px`;
    node.style.top = `${position.top}px`;
    node.style.width = `${position.width}px`;
  }
  function schedule() {
    if (!opened || frame !== void 0) {
      return;
    }
    frame = view.requestAnimationFrame(reposition);
  }
  function close(reason = "programmatic") {
    if (!opened) {
      return;
    }
    opened = false;
    node.hidden = true;
    node.replaceChildren();
    onClose?.(reason);
  }
  function open(content) {
    node.replaceChildren(content);
    opened = true;
    node.hidden = false;
    schedule();
  }
  view.addEventListener("resize", schedule);
  root.addEventListener("scroll", schedule, true);
  return {
    /** Closes the portal and removes all observers. */
    destroy() {
      if (frame !== void 0) {
        view.cancelAnimationFrame(frame);
      }
      view.removeEventListener("resize", schedule);
      root.removeEventListener("scroll", schedule, true);
      close("destroy");
      node.remove();
    },
    close,
    node,
    open,
    reposition: schedule
  };
}

// media/gridCombobox.js
var NONE = -1;
var MAX_RENDERED_OPTIONS = 60;
var comboboxSequence = 0;
function boundedOptions(options, current, maxRenderedOptions) {
  if (options.length <= maxRenderedOptions) {
    return options;
  }
  const selected = options.find((option) => option.value === current);
  const bounded = options.slice(0, maxRenderedOptions);
  if (!selected || bounded.includes(selected)) {
    return bounded;
  }
  return [selected, ...bounded.slice(0, Math.max(0, maxRenderedOptions - 1))];
}
function createCombobox(deps) {
  const { ariaLabel = "", el: el2, options = [], value = "", placeholder = "", onChange, title = "", dataset, maxRenderedOptions = MAX_RENDERED_OPTIONS, popoverLayer } = deps;
  let items = normalize(options);
  let current = value == null ? "" : value;
  let activeIndex = NONE;
  let open = false;
  let visible = [];
  const listId = `cbx-list-${comboboxSequence += 1}`;
  const input = el2("input", { ariaAutocomplete: "list", ariaControls: listId, ariaExpanded: "false", ariaLabel: ariaLabel || title || placeholder || "Choose option", className: "cbx-input", id: `${listId}-input`, placeholder, role: "combobox", spellcheck: false, title, type: "text" });
  const list = el2("div", { className: "cbx-list", id: listId, role: "listbox" });
  list.hidden = true;
  const node = el2("span", { className: "combobox" }, input, list);
  const portal = popoverLayer ? createPortal(popoverLayer) : void 0;
  if (dataset) {
    Object.assign(node.dataset, dataset);
  }
  Object.defineProperty(node, "value", { configurable: true, get: () => current, set: (next) => setValue(next) });
  node._options = items;
  function normalize(list2) {
    return (list2 || []).map((option) => ({ description: option.description || "", disabled: Boolean(option.disabled), disabledReason: option.disabledReason || "", group: option.group || "", keywords: option.keywords || "", label: option.label == null ? String(option.value) : String(option.label), title: option.title || "", value: option.value }));
  }
  function labelFor(target) {
    const found = items.find((option) => option.value === target);
    return found ? found.label : "";
  }
  function matches() {
    const query = input.value.trim().toLowerCase();
    if (!query || input.value === labelFor(current)) {
      return boundedOptions(items, current, maxRenderedOptions);
    }
    return boundedOptions(items.filter((option) => `${option.label} ${option.keywords} ${option.description}`.toLowerCase().includes(query)), current, maxRenderedOptions);
  }
  function render() {
    visible = matches();
    activeIndex = nextEnabledIndex(Math.max(0, Math.min(activeIndex, visible.length - 1)), 1);
    list.innerHTML = "";
    let group = "";
    visible.forEach((option, index) => {
      if (option.group && option.group !== group) {
        group = option.group;
        list.appendChild(el2("div", { ariaHidden: "true", className: "cbx-group", role: "presentation" }, group));
      }
      const optionNode = el2("div", { ariaDisabled: option.disabled ? "true" : void 0, ariaSelected: String(index === activeIndex), className: `${index === activeIndex ? "cbx-opt active" : "cbx-opt"}${option.disabled ? " disabled" : ""}`, id: `${listId}-option-${index}`, role: "option", title: option.title }, option.label);
      if (option.description || option.disabledReason) {
        optionNode.appendChild(el2("span", { className: "query-option-description" }, option.disabledReason || option.description));
      }
      optionNode.addEventListener("click", () => choose(option));
      optionNode.addEventListener("mouseenter", () => {
        if (!option.disabled) {
          activeIndex = index;
          highlight();
        }
      });
      list.appendChild(optionNode);
    });
    if (!visible.length) {
      list.appendChild(el2("div", { className: "cbx-empty", role: "status" }, "No matches"));
    } else if (items.length > maxRenderedOptions && !input.value.trim()) {
      list.appendChild(el2("div", { className: "cbx-empty", role: "status" }, `Showing the first ${maxRenderedOptions} options. Type to search all fields.`));
    }
    syncAria();
  }
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
  function syncAria() {
    input.setAttribute?.("aria-expanded", String(open));
    if (open && activeIndex !== NONE && visible[activeIndex]) {
      input.setAttribute?.("aria-activedescendant", `${listId}-option-${activeIndex}`);
    } else {
      input.removeAttribute?.("aria-activedescendant");
    }
  }
  function show() {
    portal?.open(list);
    open = true;
    list.hidden = false;
    const selected = matches().findIndex((option) => option.value === current);
    activeIndex = nextEnabledIndex(selected === NONE ? 0 : selected, 1);
    render();
  }
  function hide() {
    open = false;
    list.hidden = true;
    portal?.close();
    input.value = labelFor(current);
    syncAria();
  }
  function choose(option) {
    if (option?.disabled) {
      return;
    }
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
  function setValue(next) {
    current = next == null ? "" : next;
    input.value = labelFor(current);
  }
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
  function nextEnabledIndex(start, direction) {
    if (!visible.length) {
      return NONE;
    }
    for (let offset = 0; offset < visible.length; offset += 1) {
      const index = (start + offset * direction + visible.length) % visible.length;
      if (!visible[index]?.disabled) {
        return index;
      }
    }
    return NONE;
  }
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
      if (!open) {
        return;
      }
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
  input.addEventListener("focus", () => {
    input.select();
    show();
  });
  input.addEventListener("input", () => {
    activeIndex = 0;
    show();
  });
  input.addEventListener("blur", () => hide());
  input.addEventListener("keydown", onKey);
  list.addEventListener("mousedown", (event) => event.preventDefault());
  setValue(current);
  return { dispose() {
    input.removeEventListener("keydown", onKey);
    portal?.destroy();
    node.remove();
  }, focus: () => input.focus(), getValue: () => current, node, setOptions, setValue };
}
function createPortal(layer) {
  let list;
  let popover;
  function inputFor(next) {
    if (!next.dataset.anchor) {
      next.dataset.anchor = next.previousElementSibling?.id || "";
    }
    return next.dataset.anchor ? document.getElementById(next.dataset.anchor) : void 0;
  }
  function ensurePopover(next) {
    const anchor = inputFor(next);
    if (!anchor || popover) {
      return popover;
    }
    popover = createQueryPopover({ anchor, layer, onClose: () => {
      if (list) {
        list.hidden = true;
      }
    } });
    return popover;
  }
  return {
    /** Moves the supplied list into the portal and positions it. */
    open(next) {
      list = next;
      list.classList.add("cbx-list-portal");
      ensurePopover(next)?.open(next);
    },
    /** Hides a list while keeping the portal helper reusable. */
    close() {
      popover?.close("combobox");
    },
    /** Cleans portal observers and list ownership. */
    destroy() {
      popover?.destroy();
      popover = void 0;
      list?.remove();
      list = void 0;
    }
  };
}
function createGridCombobox({ describedBy, disabledReason, getOptionId, label, name, onChange, options, popoverLayer, value, ...rest } = {}) {
  const controller = createCombobox({ ariaLabel: label || name, maxRenderedOptions: 60, onChange, options, popoverLayer, value, ...rest });
  if (describedBy) {
    controller.node.querySelector("input")?.setAttribute("aria-describedby", describedBy);
  }
  if (disabledReason) {
    controller.node.querySelector("input").title = disabledReason;
  }
  return { destroy: controller.dispose, focus: controller.focus, node: controller.node, setDisabled(disabled, reason = "") {
    const input = controller.node.querySelector("input");
    input.disabled = Boolean(disabled);
    input.title = reason || disabledReason || "";
  }, update({ options: nextOptions, value: nextValue }) {
    controller.setOptions(nextOptions);
    controller.setValue(nextValue);
  } };
}

// media/gridQueryRecipeReducer.js
var nextNodeSequence = 0;
function nextNodeId(prefix = "node") {
  nextNodeSequence += 1;
  return `${prefix}-${nextNodeSequence}`;
}
function cloneQueryRecipe(value) {
  return value === void 0 ? void 0 : JSON.parse(JSON.stringify(value));
}
function createEmptyQueryRecipe(source) {
  return {
    computed: [],
    groupBy: [],
    mode: "rows",
    orderBy: [],
    postFilter: emptyGroup("post-root"),
    source: { app: String(source?.app || ""), model: String(source?.model || "") },
    version: 2,
    where: emptyGroup("where-root")
  };
}
function emptyGroup(nodeId) {
  return { children: [], join: "and", kind: "group", negated: false, nodeId };
}
function comparisonNode(nodeId = nextNodeId("comparison")) {
  return { kind: "comparison", lhs: { kind: "field", path: "" }, lookup: "exact", negated: false, nodeId, rhs: { kind: "literal", value: null } };
}
function computedColumn(nodeId = nextNodeId("computed")) {
  return { alias: "", enabled: true, expression: { kind: "literal", value: null }, kind: "formula", nodeId, outputType: "auto" };
}
function walkNodes(group, visit) {
  for (const node of group?.children || []) {
    visit(node, group);
    if (node.kind === "group") {
      walkNodes(node, visit);
    }
    if (node.kind === "existsPredicate") {
      walkNodes(node.where, visit);
    }
  }
}
function findGroup(root, nodeId) {
  if (root?.nodeId === nodeId) {
    return root;
  }
  let found;
  walkNodes(root, (node) => {
    if (!found && node.kind === "group" && node.nodeId === nodeId) {
      found = node;
    }
    if (!found && node.kind === "existsPredicate" && node.where?.nodeId === nodeId) {
      found = node.where;
    }
  });
  return found;
}
function findNode(root, nodeId) {
  let found;
  walkNodes(root, (node, parent) => {
    if (!found && node.nodeId === nodeId) {
      found = { node, parent };
    }
  });
  return found;
}
function cloneWithNewNodeIds(value) {
  const copy2 = cloneQueryRecipe(value);
  const rewrite = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (typeof node.nodeId === "string") {
      node.nodeId = nextNodeId(node.kind || "node");
    }
    if (Array.isArray(node.children)) {
      node.children.forEach(rewrite);
    }
    if (node.where) {
      rewrite(node.where);
    }
    if (Array.isArray(node.correlations)) {
      node.correlations.forEach(rewrite);
    }
    if (Array.isArray(node.orderBy)) {
      node.orderBy.forEach(rewrite);
    }
  };
  rewrite(copy2);
  return copy2;
}
function move(items, index, direction) {
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= items.length) {
    return;
  }
  [items[index], items[destination]] = [items[destination], items[index]];
}
function removeById(items, nodeId) {
  const index = items.findIndex((entry2) => entry2.nodeId === nodeId);
  if (index >= 0) {
    items.splice(index, 1);
  }
}
function reduceQueryRecipe(recipe, action = {}) {
  const next = cloneQueryRecipe(recipe);
  const root = action.scope === "postFilter" ? next.postFilter : next.where;
  const group = () => findGroup(root, action.parentId || root.nodeId);
  const node = () => findNode(root, action.nodeId);
  if (action.type === "ADD_COMPARISON") {
    group()?.children.push(cloneQueryRecipe(action.node || comparisonNode()));
  } else if (action.type === "ADD_GROUP") {
    group()?.children.push(cloneQueryRecipe(action.group || { ...emptyGroup(nextNodeId("group")), nodeId: nextNodeId("group") }));
  } else if (action.type === "ADD_EXISTS_PREDICATE") {
    group()?.children.push(cloneQueryRecipe(action.node || { correlations: [], kind: "existsPredicate", negated: false, nodeId: nextNodeId("exists"), source: { kind: "relation", relation: "" }, where: { ...emptyGroup(nextNodeId("exists-where")), nodeId: nextNodeId("exists-where") } }));
  } else if (action.type === "UPDATE_NODE") {
    const found = node();
    if (found) {
      Object.assign(found.node, cloneQueryRecipe(action.changes || {}));
    }
  } else if (action.type === "REMOVE_NODE") {
    const found = node();
    if (found && found.node.nodeId !== root.nodeId) {
      found.parent.children.splice(found.parent.children.indexOf(found.node), 1);
    }
  } else if (action.type === "DUPLICATE_NODE") {
    const found = node();
    if (found) {
      const index = found.parent.children.indexOf(found.node);
      found.parent.children.splice(index + 1, 0, cloneWithNewNodeIds(found.node));
    }
  } else if (action.type === "MOVE_NODE_UP" || action.type === "MOVE_NODE_DOWN") {
    const found = node();
    if (found) {
      move(found.parent.children, found.parent.children.indexOf(found.node), action.type === "MOVE_NODE_UP" ? -1 : 1);
    }
  } else if (action.type === "ADD_COMPUTED") {
    next.computed.push(cloneQueryRecipe(action.computed || computedColumn()));
  } else if (action.type === "UPDATE_COMPUTED") {
    const item = next.computed.find((entry2) => entry2.nodeId === action.nodeId);
    if (item) {
      Object.assign(item, cloneQueryRecipe(action.changes || {}));
    }
  } else if (action.type === "REMOVE_COMPUTED") {
    removeById(next.computed, action.nodeId);
  } else if (action.type === "DUPLICATE_COMPUTED") {
    const index = next.computed.findIndex((entry2) => entry2.nodeId === action.nodeId);
    if (index >= 0) {
      next.computed.splice(index + 1, 0, cloneWithNewNodeIds(next.computed[index]));
    }
  } else if (action.type === "MOVE_COMPUTED_UP" || action.type === "MOVE_COMPUTED_DOWN") {
    move(next.computed, next.computed.findIndex((entry2) => entry2.nodeId === action.nodeId), action.type === "MOVE_COMPUTED_UP" ? -1 : 1);
  } else if (action.type === "TOGGLE_COMPUTED") {
    const item = next.computed.find((entry2) => entry2.nodeId === action.nodeId);
    if (item) {
      item.enabled = !item.enabled;
    }
  } else if (action.type === "SET_MODE") {
    next.mode = action.mode === "summary" ? "summary" : "rows";
    if (next.mode === "rows") {
      next.groupBy = [];
    }
  } else if (action.type === "ADD_GROUP_BY") {
    next.groupBy.push(cloneQueryRecipe(action.field || { kind: "field", path: "" }));
  } else if (action.type === "REMOVE_GROUP_BY") {
    next.groupBy.splice(Number(action.index), 1);
  } else if (action.type === "ADD_ORDER") {
    next.orderBy.push(cloneQueryRecipe(action.order || { direction: "asc", nodeId: nextNodeId("order"), ref: { kind: "field", path: "" } }));
  } else if (action.type === "UPDATE_ORDER") {
    const item = next.orderBy.find((entry2) => entry2.nodeId === action.nodeId);
    if (item) {
      Object.assign(item, cloneQueryRecipe(action.changes || {}));
    }
  } else if (action.type === "REMOVE_ORDER") {
    removeById(next.orderBy, action.nodeId);
  } else if (action.type === "REPLACE_DRAFT") {
    return cloneQueryRecipe(action.recipe);
  }
  return next;
}

// media/gridQueryRecipeStore.js
function sameRecipe(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function createQueryRecipeStore(initialRecipe) {
  let snapshot = {
    applied: cloneQueryRecipe(initialRecipe),
    appliedRevision: 0,
    applyingRevision: void 0,
    draft: cloneQueryRecipe(initialRecipe),
    draftRevision: 0,
    canRedo: false,
    canUndo: false,
    dirty: false,
    validation: { issues: [], ok: true, warnings: [] },
    validationRevision: 0
  };
  const listeners = /* @__PURE__ */ new Set();
  const history = { future: [], past: [], pendingGroup: void 0 };
  const historyLimit = 50;
  const publish = () => {
    snapshot = { ...snapshot, dirty: !sameRecipe(snapshot.draft, snapshot.applied) };
    listeners.forEach((listener) => listener(snapshot));
  };
  const set = (changes) => {
    snapshot = { ...snapshot, ...changes };
    publish();
  };
  function setHistoryFlags() {
    snapshot = { ...snapshot, canRedo: history.future.length > 0, canUndo: history.past.length > 0 };
  }
  function checkpoint(options = {}) {
    const group = options.group;
    const text = options.mode === "text";
    const now = Date.now();
    const coalesce = text && group && history.pendingGroup?.group === group && now - history.pendingGroup.at <= 600;
    if (!coalesce) {
      history.past.push(cloneQueryRecipe(snapshot.draft));
      if (history.past.length > historyLimit) {
        history.past.shift();
      }
      history.future = [];
    }
    history.pendingGroup = text && group ? { at: now, group } : void 0;
    setHistoryFlags();
  }
  function clearHistory() {
    history.future = [];
    history.past = [];
    history.pendingGroup = void 0;
    setHistoryFlags();
  }
  function endHistoryGroup() {
    history.pendingGroup = void 0;
  }
  function replaceDraft(draft) {
    set({ draft, draftRevision: snapshot.draftRevision + 1, validationRevision: -1, canRedo: history.future.length > 0, canUndo: history.past.length > 0 });
  }
  return {
    /** Returns an immutable-copy snapshot that callers cannot mutate in place. */
    getSnapshot() {
      return cloneQueryRecipe(snapshot);
    },
    /** Applies one action to draft state and records one bounded undo checkpoint. */
    dispatch(action = {}) {
      const next = reduceQueryRecipe(snapshot.draft, action);
      if (sameRecipe(next, snapshot.draft)) {
        return;
      }
      checkpoint(action.history || {});
      replaceDraft(next);
    },
    /** Adds one observer and returns an unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Replaces the successful applied Recipe while retaining any newer draft edits. */
    setApplied(recipe, revision) {
      set({ applied: cloneQueryRecipe(recipe), appliedRevision: revision, applyingRevision: void 0 });
    },
    /** Restores draft from the last applied snapshot with undo support. */
    resetDraft() {
      const next = cloneQueryRecipe(snapshot.applied);
      if (!sameRecipe(next, snapshot.draft)) {
        checkpoint();
        replaceDraft(next);
      }
    },
    /** Clears draft to the canonical source-specific empty Recipe with undo support. */
    clearDraft(source) {
      const next = createEmptyQueryRecipe(source || snapshot.applied.source);
      if (!sameRecipe(next, snapshot.draft)) {
        checkpoint();
        replaceDraft(next);
      }
    },
    /** Records the exact revision and draft revision used for one in-flight Apply. */
    beginApply(revision, recipe) {
      set({ applyingDraftRevision: snapshot.draftRevision, applyingRecipe: cloneQueryRecipe(recipe), applyingRevision: revision });
    },
    /** Accepts a normalized Recipe only for the matching Apply revision. */
    finishApply(revision, normalizedRecipe) {
      if (snapshot.applyingRevision !== revision) {
        return;
      }
      const changes = { applied: cloneQueryRecipe(normalizedRecipe), appliedRevision: revision, applyingRecipe: void 0, applyingRevision: void 0 };
      if (snapshot.applyingDraftRevision === snapshot.draftRevision) {
        changes.draft = cloneQueryRecipe(normalizedRecipe);
      }
      set(changes);
    },
    /** Hydrates an initial host Recipe after its source schema is known, without treating it as a user edit. */
    hydrate(recipe, revision) {
      if (!Number.isSafeInteger(revision) || revision < snapshot.appliedRevision) {
        return;
      }
      clearHistory();
      set({ applied: cloneQueryRecipe(recipe), appliedRevision: revision, applyingRecipe: void 0, applyingRevision: void 0, canRedo: false, canUndo: false, draft: cloneQueryRecipe(recipe), draftRevision: revision, validationRevision: -1 });
    },
    /** Retains draft/applied Recipes and records server rejection for the matching Apply. */
    failApply(revision, issues) {
      if (snapshot.applyingRevision === revision) {
        set({ applyingRecipe: void 0, applyingRevision: void 0, validation: { issues: cloneQueryRecipe(issues || []), ok: false, warnings: [] }, validationRevision: snapshot.draftRevision });
      }
    },
    /** Merges authoritative runtime rejection issues while preserving an unrelated newer draft. */
    mergeValidationIssues(issues) {
      const merged = cloneQueryRecipe(issues || []);
      set({ validation: { issues: merged, ok: !merged.some((issue) => issue?.severity !== "warning"), warnings: merged.filter((issue) => issue?.severity === "warning") }, validationRevision: snapshot.draftRevision });
    },
    /** Records validation that still belongs to the current draft revision. */
    setValidation(validation, validationRevision) {
      if (validationRevision === snapshot.draftRevision) {
        set({ validation: cloneQueryRecipe(validation), validationRevision });
      }
    },
    /** Ends the active coalesced text-edit history group. */
    endHistoryGroup,
    /** Restores the prior Recipe draft without changing the applied query. */
    undo() {
      endHistoryGroup();
      const previous = history.past.pop();
      if (!previous) {
        return;
      }
      history.future.unshift(cloneQueryRecipe(snapshot.draft));
      if (history.future.length > historyLimit) {
        history.future.pop();
      }
      setHistoryFlags();
      replaceDraft(previous);
    },
    /** Reapplies the next Recipe draft without changing the applied query. */
    redo() {
      endHistoryGroup();
      const next = history.future.shift();
      if (!next) {
        return;
      }
      history.past.push(cloneQueryRecipe(snapshot.draft));
      if (history.past.length > historyLimit) {
        history.past.shift();
      }
      setHistoryFlags();
      replaceDraft(next);
    }
  };
}

// media/gridQueryScalarEditor.js
var NUMERIC_TYPES = /Integer|Float|Decimal|AutoField/;
var EXTRACT_LOOKUPS = /* @__PURE__ */ new Set(["year", "quarter", "month", "week_day", "day", "hour", "minute", "second"]);
function inputTypeForQueryScalar(field, lookup) {
  const type = EXTRACT_LOOKUPS.has(lookup) || lookup?.startsWith("length") ? "IntegerField" : lookup === "date" ? "DateField" : field?.type;
  if (type === "DateField") {
    return "date";
  }
  if (type === "DateTimeField") {
    return "datetime-local";
  }
  if (type === "TimeField") {
    return "time";
  }
  return NUMERIC_TYPES.test(String(type || "")) ? "number" : "text";
}
function parseQueryScalar(field, raw) {
  if (raw === "") {
    return null;
  }
  if (field?.type === "BooleanField") {
    return raw === true || raw === "true";
  }
  if (NUMERIC_TYPES.test(String(field?.type || "")) && typeof raw === "string") {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : raw;
  }
  return raw;
}

// media/gridPredicateValue.js
var NUMERIC_TYPES2 = /Integer|Float|Decimal|AutoField/;
var TEXT_TYPES = /Char|Text|Email|Slug|URL|FilePath/;
var GENERIC_TEXT_TYPES = /UUID|IP|Duration|File|Generic/;
var DATE_TYPES = /* @__PURE__ */ new Set(["DateField", "DateTimeField", "TimeField"]);
var VALUE_ONLY_LOOKUPS = /* @__PURE__ */ new Set(["in", "isnull", "range", "blank", "not_blank"]);
var LOOKUP_LABELS = Object.freeze({
  blank: "is blank",
  contains: "contains",
  date: "date =",
  endswith: "ends with",
  exact: "=",
  gt: ">",
  gte: "\u2265",
  icontains: "contains (i)",
  iexact: "= (i)",
  iendswith: "ends with (i)",
  in: "in list",
  isnull: "is null",
  istartswith: "starts with (i)",
  length: "length =",
  length__gt: "length >",
  length__gte: "length \u2265",
  length__lt: "length <",
  length__lte: "length \u2264",
  lt: "<",
  lte: "\u2264",
  not_blank: "is not blank",
  quarter: "quarter",
  range: "between",
  second: "second",
  startswith: "starts with",
  trim: "trimmed =",
  week_day: "weekday",
  year: "year",
  month: "month",
  day: "day",
  hour: "hour",
  minute: "minute"
});
function lookupsForField(field, allowed = Object.keys(LOOKUP_LABELS)) {
  const available = new Set(allowed);
  const type = String(field?.type || "");
  let names;
  if (field?.role === "relation") {
    names = ["isnull"];
  } else if (type === "BooleanField") {
    names = ["exact", "isnull"];
  } else if (type === "DateTimeField") {
    names = ["exact", "gt", "gte", "lt", "lte", "range", "date", "year", "quarter", "month", "week_day", "day", "hour", "minute", "second", "isnull"];
  } else if (type === "DateField") {
    names = ["exact", "gt", "gte", "lt", "lte", "range", "year", "quarter", "month", "week_day", "day", "isnull"];
  } else if (type === "TimeField") {
    names = ["exact", "gt", "gte", "lt", "lte", "range", "hour", "minute", "second", "isnull"];
  } else if (NUMERIC_TYPES2.test(type)) {
    names = ["exact", "gt", "gte", "lt", "lte", "in", "range", "isnull"];
  } else if (TEXT_TYPES.test(type)) {
    names = ["exact", "iexact", "contains", "icontains", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "blank", "not_blank", "trim", "length", "length__gt", "length__gte", "length__lt", "length__lte"];
  } else if (GENERIC_TEXT_TYPES.test(type)) {
    names = ["exact", "iexact", "contains", "icontains", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull"];
  } else {
    names = ["exact", "in", "isnull"];
  }
  return names.filter((name) => available.has(name));
}
function rhsKindsFor({ context = "where", field, lookup } = {}) {
  if (!lookup || VALUE_ONLY_LOOKUPS.has(lookup)) {
    return ["literal"];
  }
  const kinds = ["literal", "field"];
  if (context === "subquery") {
    kinds.push("outerField");
  }
  if ((context === "where" || context === "subquery") && DATE_TYPES.has(String(field?.type || ""))) {
    kinds.push("relativeTime");
  }
  return kinds;
}
function rhsIsCompatible(rhs, context, field, lookup) {
  if (!rhs || typeof rhs !== "object") {
    return false;
  }
  return rhsKindsFor({ context, field, lookup }).includes(rhs.kind);
}
function inputTypeFor(field, lookup) {
  return inputTypeForQueryScalar(field, lookup);
}
function scalarFromInput(field, raw) {
  return parseQueryScalar(field, raw);
}
function selectControl(el2, ariaLabel, options, value, onChange) {
  const select = el2("select", { ariaLabel, className: "query-predicate-select" });
  for (const option of options) {
    select.appendChild(el2("option", { value: option.value }, option.label));
  }
  select.value = options.some((option) => String(option.value) === String(value)) ? String(value) : String(options[0]?.value || "");
  select.addEventListener("change", () => onChange(select.value));
  return select;
}
function createPredicateValueEditor({ context, el: el2, field, lookup, onChange, popoverLayer, rhs = { kind: "literal", value: null }, scopeFields = [], outerFields = [] }) {
  const node = el2("span", { className: "query-predicate-value", dataset: { role: "predicate-value" } });
  const kind = lookup === "in" ? "list" : lookup === "range" ? "range" : rhsIsCompatible(rhs, context, field, lookup) ? rhs.kind : rhs?.kind || "literal";
  function emit(next) {
    onChange?.(next);
  }
  function fieldReference(kindName, options) {
    const picker = createGridCombobox({ el: el2, label: kindName === "outerField" ? "Outer field" : "Compare to field", onChange: (path) => emit({ kind: kindName, path }), options: [{ label: "Choose field", value: "" }, ...options.map((entry2) => ({ description: entry2.type || "", label: entry2.label || entry2.path, value: entry2.path }))], popoverLayer, value: rhs.path || "" });
    node.appendChild(picker.node);
    return picker;
  }
  if (kind === "field") {
    const picker = fieldReference("field", scopeFields);
    return { destroy: picker.destroy, node };
  }
  if (kind === "outerField") {
    const picker = fieldReference("outerField", outerFields);
    return { destroy: picker.destroy, node };
  }
  if (kind === "relativeTime") {
    let updateRelative2 = function() {
      emit({ amount: Number(amount.value), anchor: anchor.value, direction: direction.value, kind: "relativeTime", unit: unit.value });
    };
    var updateRelative = updateRelative2;
    const amount = el2("input", { ariaLabel: "Relative time amount", min: "1", max: "10000", type: "number", value: String(rhs.amount || 1) });
    const anchor = selectControl(el2, "Relative time anchor", [{ label: "now", value: "now" }, { label: "today", value: "today" }], rhs.anchor || "now", updateRelative2);
    const direction = selectControl(el2, "Relative time direction", [{ label: "past", value: "past" }, { label: "future", value: "future" }], rhs.direction || "past", updateRelative2);
    const unit = selectControl(el2, "Relative time unit", ["minutes", "hours", "days", "weeks"].map((value) => ({ label: value, value })), rhs.unit || "days", updateRelative2);
    amount.addEventListener("input", updateRelative2);
    node.append(amount, anchor, direction, unit);
    return { node };
  }
  if (lookup === "isnull") {
    node.appendChild(selectControl(el2, "Null state", [{ label: "has value", value: "false" }, { label: "is null", value: "true" }], String(Boolean(rhs.value)), (value) => emit({ kind: "literal", value: value === "true" })));
    return { node };
  }
  if (lookup === "blank" || lookup === "not_blank") {
    node.appendChild(el2("span", { className: "query-predicate-static", role: "note" }, "No value needed"));
    return { node };
  }
  if (field?.type === "BooleanField" && kind === "literal") {
    node.appendChild(selectControl(el2, "Boolean value", [{ label: "true", value: "true" }, { label: "false", value: "false" }], String(rhs.value === true), (value) => emit({ kind: "literal", value: value === "true" })));
    return { node };
  }
  if (Array.isArray(field?.choices) && field.choices.length && kind === "literal") {
    node.appendChild(selectControl(el2, "Field value", field.choices.map((choice) => ({ label: String(choice[1]), value: String(choice[0]) })), rhs.value, (value) => emit({ kind: "literal", value })));
    return { node };
  }
  if (kind === "list") {
    const values = Array.isArray(rhs.values) ? [...rhs.values] : [];
    const chips = el2("span", { ariaLabel: "List values", className: "query-value-chips" });
    const input2 = el2("input", { ariaLabel: "Add list value", placeholder: "Add value", type: inputTypeFor(field, "exact") });
    const add = el2("button", { ariaLabel: "Add list value", type: "button" }, "Add");
    const redraw = () => {
      chips.replaceChildren(...values.map((value, index) => {
        const remove = el2("button", { ariaLabel: `Remove ${String(value)}`, type: "button" }, "Remove");
        remove.addEventListener("click", () => {
          values.splice(index, 1);
          emit({ kind: "list", values: [...values] });
          redraw();
        });
        return el2("span", { className: "query-value-chip" }, String(value), remove);
      }));
    };
    add.addEventListener("click", () => {
      if (input2.value !== "") {
        values.push(scalarFromInput(field, input2.value));
        input2.value = "";
        emit({ kind: "list", values: [...values] });
        redraw();
        input2.focus();
      }
    });
    input2.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        add.click();
      }
    });
    redraw();
    node.append(chips, input2, add);
    return { node };
  }
  if (kind === "range") {
    const lower = el2("input", { ariaLabel: "Range lower bound", placeholder: "From", type: inputTypeFor(field, "exact"), value: rhs.lower == null ? "" : String(rhs.lower) });
    const upper = el2("input", { ariaLabel: "Range upper bound", placeholder: "To", type: inputTypeFor(field, "exact"), value: rhs.upper == null ? "" : String(rhs.upper) });
    const update = () => emit({ kind: "range", lower: scalarFromInput(field, lower.value), upper: scalarFromInput(field, upper.value) });
    lower.addEventListener("input", update);
    upper.addEventListener("input", update);
    node.append(lower, upper);
    return { node };
  }
  if (kind === "literal" && (field?.type === "BooleanField" || lookupIsValueFree(field, rhs))) {
    return { node };
  }
  const input = el2("input", { ariaLabel: "Comparison value", type: inputTypeFor(field, "exact"), value: rhs.value == null ? "" : String(rhs.value) });
  input.addEventListener("input", () => emit({ kind: "literal", value: scalarFromInput(field, input.value) }));
  node.appendChild(input);
  return { node };
}
function lookupIsValueFree(_field, rhs) {
  return rhs?.kind === "literal" && rhs.value === void 0;
}

// media/gridQueryMetadata.js
function modelKey(target) {
  return `${String(target?.app || "")}.${String(target?.model || "")}`;
}
function treeFromMessage(message) {
  const result = message?.result || message;
  return result?.ok && Array.isArray(result?.fields) && Array.isArray(result?.relations) ? result : void 0;
}
function rootMetadataOptions(tree) {
  if (!tree) {
    return { fields: [], relations: [] };
  }
  return {
    fields: (tree.fields || []).filter((field) => field && typeof field.name === "string").map((field) => ({ ...field, path: field.name, role: "field" })),
    relations: (tree.relations || []).filter((relation) => relation && typeof relation.name === "string").map((relation) => ({ ...relation, path: relation.name, role: "relation" }))
  };
}
function createQueryMetadataService({ post, onChange } = {}) {
  const cache = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  let sequence = 0;
  function publish(target) {
    onChange?.(getState(target));
  }
  function getState(target) {
    const entry2 = cache.get(modelKey(target));
    return entry2 ? { error: entry2.error, pending: Boolean(entry2.pending), target: { ...entry2.target }, tree: entry2.tree } : { error: void 0, pending: false, target: { ...target }, tree: void 0 };
  }
  function loadTree(target, { retry: retry2 = false } = {}) {
    const key = modelKey(target);
    const existing = cache.get(key);
    if (existing?.tree && !retry2) {
      return Promise.resolve(existing.tree);
    }
    if (existing?.promise && !retry2) {
      return existing.promise;
    }
    const normalized = { app: String(target?.app || ""), model: String(target?.model || "") };
    if (!normalized.app || !normalized.model || typeof post !== "function") {
      const error = "Field metadata is unavailable.";
      cache.set(key, { error, pending: false, target: normalized, tree: void 0 });
      publish(normalized);
      return Promise.reject(new Error(error));
    }
    const requestId = `query-meta-${sequence += 1}`;
    let rejectRequest;
    let resolveRequest;
    const promise = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    pending.set(requestId, { key, reject: rejectRequest, resolve: resolveRequest, target: normalized });
    cache.set(key, { error: void 0, pending: true, promise, requestId, target: normalized, tree: void 0 });
    post({ app: normalized.app, model: normalized.model, requestId, type: "filterFields" });
    publish(normalized);
    return promise;
  }
  function onMessage(message) {
    const requestId = message?.requestId;
    if (typeof requestId !== "string" || !requestId.startsWith("query-meta-")) {
      return false;
    }
    const request = pending.get(requestId);
    if (!request) {
      return true;
    }
    pending.delete(requestId);
    const tree = treeFromMessage(message);
    if (tree) {
      cache.set(request.key, { error: void 0, pending: false, target: request.target, tree });
      request.resolve(tree);
    } else {
      const error = message?.result?.error || message?.error || "Could not load field metadata.";
      cache.set(request.key, { error: String(error), pending: false, target: request.target, tree: void 0 });
      request.reject(new Error(String(error)));
    }
    publish(request.target);
    return true;
  }
  function retry(target) {
    return loadTree(target, { retry: true });
  }
  function setCatalog(models) {
    cache.catalog = Array.isArray(models) ? models.filter((model) => model && typeof model.app === "string" && typeof model.model === "string").map((model) => ({ app: model.app, model: model.model })) : [];
  }
  function getCatalog() {
    return [...cache.catalog || []].sort((left, right) => modelKey(left).localeCompare(modelKey(right)));
  }
  return { getCatalog, getState, loadTree, onMessage, retry, setCatalog };
}

// media/gridQueryFieldPicker.js
function fieldOption(field) {
  const name = String(field?.name || field?.path || "");
  const label = String(field?.label || "").trim();
  return { description: [field?.type, field?.null ? "Nullable" : "Required", field?.helpText].filter(Boolean).join(" \xB7 "), group: "Fields", keywords: `${name} ${label}`, label: label && label !== name ? `${label} \u2014 ${name}` : name, value: `field:${name}` };
}
function relationOption(relation) {
  const name = String(relation?.name || "");
  const target = String(relation?.target || "related model");
  const kind = String(relation?.kind || "relation").replace(/[_-]/g, " ");
  return { description: `${kind}. Choose to continue into the related model.`, group: "Relations", keywords: `${name} ${relation?.label || ""} ${target}`, label: `${relation?.label || name} \u2192 ${target}`, value: `relation:${name}` };
}
function createQueryFieldPicker({ ariaLabel = "Choose field", computed = [], current = "", el: el2, metadata, onChange, source, context = "where", allowRelationTerminal = false, popoverLayer } = {}) {
  const node = el2("div", { className: "query-field-picker", dataset: { context } });
  const segments = el2("div", { className: "query-field-picker-segments" });
  const status = el2("p", { className: "query-control-help", role: "status" });
  node.append(segments, status);
  let disposed = false;
  let path = String(current || "");
  let controllers = [];
  let target = source;
  function disposeControllers() {
    for (const controller of controllers) {
      controller.dispose?.();
    }
    controllers = [];
  }
  function loadTree(model, retry = false) {
    const state2 = metadata?.getState?.(model);
    if (state2?.tree) {
      return Promise.resolve(state2.tree);
    }
    return (retry ? metadata?.retry?.(model) : metadata?.loadTree?.(model)) || Promise.reject(new Error("Field metadata is unavailable."));
  }
  function emit(next) {
    path = String(next || "");
    onChange?.(path);
  }
  async function render() {
    disposeControllers();
    segments.replaceChildren();
    status.textContent = "";
    if (!target?.app || !target?.model) {
      status.textContent = "Field details are unavailable.";
      return;
    }
    try {
      const parts = path ? path.split("__") : [];
      let model = target;
      let prefix = [];
      let index = 0;
      while (!disposed) {
        const tree = await loadTree(model);
        if (disposed) {
          return;
        }
        const options = rootMetadataOptions(tree);
        const choices = [...options.fields.map(fieldOption)];
        if (index === 0) {
          choices.push(...computed.filter((item) => item?.enabled !== false && item?.alias).map((item) => ({ description: "Calculated value available in this query.", group: "Calculated values", label: `calculated value ${item.alias}`, value: `computed:${item.alias}` })));
        }
        choices.push(...options.relations.map(relationOption));
        const selected = parts[index] || "";
        if (selected && !choices.some((choice) => choice.value.endsWith(`:${selected}`))) {
          choices.unshift({ description: "This field is not present in the current model metadata. Choose a replacement.", disabled: true, disabledReason: "Unavailable field", group: "Unavailable", label: `Unavailable field: ${selected}`, value: `unavailable:${selected}` });
        }
        const picker = createCombobox({ ariaLabel: index === 0 ? ariaLabel : `Related field after ${prefix.join("__")}`, el: el2, options: [{ label: index === 0 ? "Choose field or calculated value" : "Choose related field", value: "" }, ...choices], popoverLayer, value: selected ? choices.find((choice) => choice.value.endsWith(`:${selected}`))?.value || `unavailable:${selected}` : "", onChange: (value) => select(value, index, model, prefix, options) });
        controllers.push(picker);
        segments.appendChild(picker.node);
        if (!selected) {
          return;
        }
        const relation = options.relations.find((item) => item.name === selected);
        if (!relation) {
          return;
        }
        prefix = [...prefix, selected];
        model = targetFromLabel2(relation.target);
        index += 1;
      }
    } catch {
      if (disposed) {
        return;
      }
      status.replaceChildren("Field details could not be loaded. ");
      const retry = el2("button", { type: "button" }, "Retry");
      retry.addEventListener("click", () => render());
      status.appendChild(retry);
    }
  }
  function select(value, index, model, prefix, options) {
    const [kind, selected] = String(value || "").split(":", 2);
    if (!selected || kind === "unavailable") {
      return;
    }
    if (kind === "computed") {
      emit(selected);
      return;
    }
    if (kind === "relation") {
      const relation = options.relations.find((item) => item.name === selected);
      if (allowRelationTerminal && relation) {
        emit([...prefix, selected].join("__"));
      } else {
        path = [...prefix, selected].join("__");
        render();
      }
      return;
    }
    emit([...prefix, selected].join("__"));
  }
  function targetFromLabel2(label) {
    const value = String(label || "");
    const index = value.lastIndexOf(".");
    return index > 0 ? { app: value.slice(0, index), model: value.slice(index + 1) } : { app: source.app, model: value };
  }
  render();
  return { dispose() {
    disposed = true;
    disposeControllers();
  }, focus() {
    controllers[0]?.focus?.();
  }, getPath() {
    return path;
  }, getTerminal() {
    return path.split("__").at(-1) || "";
  }, node, setCurrent(next) {
    path = String(next || "");
    render();
  } };
}

// media/gridQueryGuidanceCopy.js
function entry(label, description, extra = {}) {
  return Object.freeze({ label, description, ...extra });
}
var QUERY_SECTION_GUIDANCE = Object.freeze({
  where: entry("Filter source rows", "Choose which model rows enter the query. An empty section includes every row.", { technical: "WHERE" }),
  computed: entry("Add calculated values", "Create values for filtering, sorting, or display without changing the database.", { technical: "Computed columns" }),
  postFilter: entry("Filter calculated results", "Filter after calculated values are available. Use this for computed aliases and summary totals.", { technical: "Result filter" }),
  result: entry("Shape and order the result", "Choose row-level data or a summary, then control grouping and order.", { technical: "Result" }),
  preview: entry("Understand and validate", "Review the plain meaning, implicit behavior, and Django ORM before applying the draft.", { technical: "Preview" })
});
var QUERY_LOOKUP_GUIDANCE = Object.freeze({
  exact: entry("equals", "Matches the same value."),
  iexact: entry("equals, ignoring case", "Matches the same text regardless of letter case.", { qualifier: " (case-insensitive)" }),
  contains: entry("contains", "Matches text containing the value."),
  icontains: entry("contains, ignoring case", "Matches text containing the value regardless of letter case.", { qualifier: " (case-insensitive)" }),
  startswith: entry("starts with", "Matches text beginning with the value."),
  istartswith: entry("starts with, ignoring case", "Matches text beginning with the value regardless of letter case.", { qualifier: " (case-insensitive)" }),
  endswith: entry("ends with", "Matches text ending with the value."),
  iendswith: entry("ends with, ignoring case", "Matches text ending with the value regardless of letter case.", { qualifier: " (case-insensitive)" }),
  gt: entry("is greater than", "Uses a strict numeric or date comparison."),
  gte: entry("is at least", "Includes the lower boundary."),
  lt: entry("is less than", "Uses a strict numeric or date comparison."),
  lte: entry("is at most", "Includes the upper boundary."),
  in: entry("is in this list", "Any listed value may match."),
  range: entry("is between", "Includes both boundaries."),
  isnull: entry("has or lacks a value", "Checks a database null, not empty text."),
  blank: entry("is blank", "Uses the existing null-or-empty blank semantics."),
  not_blank: entry("is not blank", "Keeps values that are neither null nor empty."),
  trim: entry("equals after trimming spaces", "Trims surrounding spaces before comparison."),
  length: entry("has length equal to", "Compares text length."),
  length__gt: entry("has length greater than", "Compares text length."),
  length__gte: entry("has length at least", "Compares text length."),
  length__lt: entry("has length less than", "Compares text length."),
  length__lte: entry("has length at most", "Compares text length."),
  date: entry("has date equal to", "Compares the date part of a date-time."),
  year: entry("is in year", "Extracts the year."),
  quarter: entry("is in quarter", "Uses 1 through 4."),
  month: entry("is in month", "Uses 1 through 12."),
  week_day: entry("is on weekday", "Uses Django numbering: Sunday 1 through Saturday 7."),
  day: entry("is on day of month", "Uses 1 through 31."),
  hour: entry("is in hour", "Uses 0 through 23."),
  minute: entry("is in minute", "Uses 0 through 59."),
  second: entry("is in second", "Uses 0 through 59.")
});
var QUERY_RHS_GUIDANCE = Object.freeze({
  literal: entry("A value", "Compare with a fixed value you enter."),
  field: entry("Another field in this row", "Compare with a field from the same model row (Django F expression)."),
  outerField: entry("Field from the current outer row", "Use a field from the row that opened this subquery (Django OuterRef)."),
  relativeTime: entry("Relative date or time", "Build a value relative to now or today when the query runs.")
});
var QUERY_COMPUTED_KIND_GUIDANCE = Object.freeze({
  aggregate: entry("Count or summarize values", "Create Count, Sum, Average, Minimum, or Maximum.", { limit: "Fan-out safety and distinct rules apply." }),
  scalarSubquery: entry("Bring back one matched value", "Run a bounded subquery for each current row and return one value.", { limit: "A correlation and order are often needed." }),
  exists: entry("Check whether a match exists", "Create a true/false value from a related or custom-model match.", { limit: "It does not select a scalar value." }),
  formula: entry("Combine values", "Build arithmetic, text, function, Case, or Cast expressions.", { limit: "Only earlier calculated aliases are available." }),
  window: entry("Rank or calculate across rows", "Create rank, row number, or running aggregate values.", { limit: "A stable order is required." }),
  codeExpression: entry("Restricted Django expression", "Advanced: enter the allowlisted single-line expression form.", { limit: "Transport support and the 800-character limit apply." })
});
var QUERY_FORMULA_KIND_GUIDANCE = Object.freeze({
  field: entry("Field", "Use a value from the current model row."),
  computed: entry("Calculated value", "Use an enabled value declared earlier in this list."),
  literal: entry("Fixed value", "Use a JSON-safe fixed value."),
  binary: entry("Math", "Combine two numeric values."),
  function: entry("Function", "Apply one of the supported expression functions."),
  case: entry("Conditional value", "Choose a value based on conditions."),
  cast: entry("Convert type", "Declare the result type used by the expression.")
});
var QUERY_RESULT_MODE_GUIDANCE = Object.freeze({
  rows: entry("Rows", "Keep one result row per matching model row. Calculated values appear as extra columns."),
  summary: entry("Summary", "Return grouped or global totals. Summary results are read-only.")
});
var QUERY_STATUS_GUIDANCE = Object.freeze({
  draft: entry("Draft changed", "The grid still shows the applied Recipe revision."),
  checking: entry("Checking the latest draft\u2026", "The builder is validating this query."),
  valid: entry("Ready to apply.", "No validation errors were found."),
  warning: entry("Ready to apply with warnings.", "Review the warnings before applying."),
  applying: entry("Applying Recipe\u2026", "You can continue editing a newer draft."),
  rejected: entry("The draft was not applied.", "The previous grid remains visible."),
  metadataError: entry("Field details are unavailable.", "Retry to continue."),
  transportUnsupported: entry("This draft cannot run through this link.", "Change the query or select a supported link.")
});
function sentenceCase(value) {
  return String(value || "Query option").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^./, (character) => character.toUpperCase());
}
function guidanceForLookup(name) {
  return QUERY_LOOKUP_GUIDANCE[name] || entry(sentenceCase(name), "This option is supported by the current query contract.");
}
function guidanceForComputedKind(kind) {
  return QUERY_COMPUTED_KIND_GUIDANCE[kind] || entry(sentenceCase(kind), "This option is supported by the current query contract.");
}

// media/gridQueryExplanation.js
function queryExplanationTokens(value) {
  const text = String(value || "");
  const tokens = [];
  let cursor = 0;
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    if (match.index > cursor) {
      tokens.push({ kind: "text", value: text.slice(cursor, match.index) });
    }
    tokens.push({ kind: "code", value: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length || !tokens.length) {
    tokens.push({ kind: "text", value: text.slice(cursor) });
  }
  return tokens;
}
function formatQueryLiteral(value, limit = 80) {
  if (value === null || value === void 0) {
    return "null";
  }
  const text = typeof value === "string" ? `\u201C${value.replace(/”/g, "\\\u201D").replace(/“/g, "\\\u201C")}\u201D` : String(value);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}\u2026` : text;
}
function describeReference(reference, context = {}) {
  if (reference?.kind === "computed") {
    return `calculated value \`${String(reference.alias || "value")}\``;
  }
  const path = String(reference?.path || "");
  const field = context.fields?.[path] || context.fieldByPath?.(path);
  const label = String(field?.label || field?.verboseName || "").trim();
  return label ? `${label} (\`${path}\`)` : `\`${path || "field"}\``;
}
function nodeIssue(node, context) {
  return (context?.issues || []).find((issue) => issue?.nodeId === node?.nodeId && issue?.severity !== "warning");
}
function rhsMissing(node) {
  const rhs = node?.rhs;
  if (!rhs || typeof rhs !== "object") {
    return true;
  }
  if (["blank", "not_blank"].includes(node?.lookup)) {
    return false;
  }
  if (node?.lookup === "in") {
    return !Array.isArray(rhs.values) || rhs.values.length === 0;
  }
  if (node?.lookup === "range") {
    return rhs.lower === null || rhs.lower === void 0 || rhs.upper === null || rhs.upper === void 0;
  }
  if (node?.lookup === "isnull") {
    return typeof rhs.value !== "boolean";
  }
  if (["field", "outerField"].includes(rhs.kind)) {
    return !rhs.path;
  }
  if (rhs.kind === "relativeTime") {
    return !rhs.amount || !rhs.unit || !rhs.anchor || !rhs.direction;
  }
  return rhs.value === null || rhs.value === void 0 || rhs.value === "";
}
function explainComparison(node, context = {}) {
  const issue = nodeIssue(node, context);
  if (issue) {
    return { state: "error", text: issue.title || issue.fix || "This comparison needs attention.", technical: issue.code };
  }
  if (!node?.lhs || !(node.lhs.path || node.lhs.alias)) {
    return { state: "incomplete", text: "Choose the field or calculated value you want to filter." };
  }
  if (context.metadataState === "pending") {
    return { state: "incomplete", text: "Loading fields for this model\u2026" };
  }
  if (context.metadataState === "error") {
    return { state: "error", text: "Field details could not be loaded. Retry before choosing a field." };
  }
  const lhs = describeReference(node.lhs, context);
  if (!node.lookup) {
    return { state: "incomplete", text: `Choose how ${lhs} should be compared.` };
  }
  if (!node.rhs?.kind && !["blank", "not_blank"].includes(node.lookup)) {
    return { state: "incomplete", text: "Choose whether to compare with a value, another field, or a relative time." };
  }
  if (rhsMissing(node)) {
    return { state: "incomplete", text: `Enter the value to compare with ${lhs}.` };
  }
  if (node.lookup === "isnull") {
    return { state: "complete", text: `${context.postFilter ? "Keeps calculated results where" : "Keeps rows where"} ${lhs} ${isNullPhrase(node)}.` };
  }
  const lookup = guidanceForLookup(node.lookup);
  const rhs = describeRhs(node.rhs, context);
  const prefix = context.postFilter ? "Keeps calculated results where" : node.negated ? "Excludes rows where" : "Keeps rows where";
  return { state: "complete", text: `${prefix} ${lhs} ${lookup.label} ${rhs}${lookup.qualifier || ""}.` };
}
function isNullPhrase(node) {
  return Boolean(node?.rhs?.value) !== Boolean(node?.negated) ? "is null" : "has a value";
}
function describeRhs(rhs, context) {
  if (!rhs || typeof rhs !== "object") {
    return "a value";
  }
  if (rhs.kind === "field") {
    return describeReference(rhs, context);
  }
  if (rhs.kind === "outerField") {
    return `current outer-row ${describeReference(rhs, context)}`;
  }
  if (rhs.kind === "list") {
    return `${Math.max(0, rhs.values?.length || 0)} listed value${rhs.values?.length === 1 ? "" : "s"}`;
  }
  if (rhs.kind === "range") {
    return `${formatQueryLiteral(rhs.lower)} and ${formatQueryLiteral(rhs.upper)}`;
  }
  if (rhs.kind === "relativeTime") {
    return `${rhs.amount || 0} ${rhs.unit || "days"} ${rhs.direction === "future" ? "after" : "before"} ${rhs.anchor || "now"}`;
  }
  return formatQueryLiteral(rhs.value);
}
function explainPredicateGroup(group, context = {}) {
  const count = Array.isArray(group?.children) ? group.children.length : 0;
  if (!count) {
    if (context.postFilter) {
      return { state: "empty", text: "No calculated-result filter. All calculated rows or groups will remain." };
    }
    return { state: "empty", text: context.root === false ? "This nested group has no conditions. Add a condition or remove the group." : "No source-row filter. Applying this draft would include every row." };
  }
  const text = group?.join === "or" ? "At least one condition in this group must match." : "Every condition in this group must match.";
  return { state: "complete", text: group?.negated ? "Rows that match this whole group will be excluded." : text };
}
function explainComputedColumn(item, context = {}) {
  if (!item?.kind) {
    return { state: "incomplete", text: "Choose the kind of calculated value to add." };
  }
  if (!item?.alias) {
    return { state: "incomplete", text: "Name this calculated value so later filters and ordering can refer to it." };
  }
  const guidance = guidanceForComputedKind(item.kind);
  const disabled = item.enabled === false;
  return { state: disabled ? "warning" : "complete", text: disabled ? `\`${item.alias}\` is disabled and will not affect this query.` : `Adds \`${item.alias}\`: ${guidance.description}`, technical: guidance.limit };
}
function explainResult(recipe, context = {}) {
  if (recipe?.mode === "summary") {
    return { state: "complete", text: recipe.groupBy?.length ? "The query returns one summary row for each unique combination of the selected fields." : "No group field is selected. The query returns one global summary row." };
  }
  return { state: "complete", text: recipe?.orderBy?.length ? `Orders results by ${recipe.orderBy.map((term) => `${describeReference(term.ref, context)} ${term.direction === "desc" ? "descending" : "ascending"}`).join(", then ")}.` : "No order is selected. Rows use the primary key ascending." };
}
function explainImplicitBehavior(recipe, validation = {}, context = {}) {
  const messages = [];
  const codes = new Set((validation.issues || []).map((issue) => issue?.code));
  if (!recipe?.orderBy?.length && recipe?.mode !== "summary") {
    messages.push("Order rows by the primary key ascending because no result order is set.");
  }
  if ((recipe?.computed || []).some((item) => item?.kind === "scalarSubquery" && !item.orderBy?.length) && !codes.has("SUBQUERY_IMPLICIT_ORDER")) {
    messages.push("Order the subquery by its primary key ascending because no inner order is set.");
  }
  if (context.transport) {
    messages.push(`Run through ${context.transport}.`);
  }
  messages.push("Keep the previous grid visible until this draft applies successfully.");
  return messages;
}
function applyAvailability(snapshot = {}, state2 = {}) {
  const revision = snapshot.draftRevision ?? state2.draftRevision ?? 0;
  const errors = (state2.validation?.issues || []).filter((issue) => issue?.severity !== "warning").length;
  if (!state2.source && !snapshot.draft?.source) {
    return { state: "disabled", text: "Open a model before applying a query." };
  }
  if (state2.applying) {
    return { state: "applying", text: `Applying Recipe revision ${revision}. You can continue editing a newer draft.` };
  }
  if (state2.metadataState === "pending") {
    return { state: "checking", text: "Loading field details before the query can be validated." };
  }
  if (state2.checking) {
    return { state: "checking", text: "Checking this draft against the current model and transport." };
  }
  if (state2.stale) {
    return { state: "checking", text: "Waiting for validation of the latest draft." };
  }
  if (errors) {
    return { state: "error", text: `Fix ${errors} error${errors === 1 ? "" : "s"} before applying this draft.` };
  }
  return snapshot.dirty ? { state: "ready", text: "Ready to apply. The grid will update only after the query succeeds." } : { state: "current", text: "This draft matches the applied query." };
}

// media/gridQueryGuidanceView.js
function appendDescribedBy(control, id) {
  if (!control || !id) {
    return;
  }
  const tokens = new Set(String(control.getAttribute?.("aria-describedby") || "").split(/\s+/).filter(Boolean));
  tokens.add(id);
  control.setAttribute?.("aria-describedby", [...tokens].join(" "));
}
function createControlHelp({ control, el: el2, id, text, technical }) {
  const help = el2("p", { className: "query-control-help", id }, text || "");
  if (technical) {
    help.appendChild(el2("span", { className: "query-technical-detail" }, ` ${technical}`));
  }
  appendDescribedBy(control, id);
  return help;
}
function createMeaningLine({ el: el2, explanation, id }) {
  const state2 = explanation?.state || "empty";
  const prefix = state2 === "error" ? "Needs attention: " : state2 === "incomplete" ? "Next: " : state2 === "warning" ? "Note: " : "Meaning: ";
  const node = el2("p", { className: "query-meaning", dataset: { state: state2 }, id }, `${prefix}${explanation?.text || ""}`);
  if (explanation?.technical) {
    node.appendChild(el2("span", { className: "query-technical-detail" }, ` ${explanation.technical}`));
  }
  return node;
}
function createConceptHelp({ el: el2, summary, paragraphs = [], examples = [] }) {
  const details = el2("details", { className: "query-concept-help" });
  details.appendChild(el2("summary", {}, summary));
  const body = el2("div", { className: "query-concept-help-body" });
  for (const paragraph of paragraphs) {
    body.appendChild(el2("p", {}, paragraph));
  }
  if (examples.length) {
    body.appendChild(el2("ul", { className: "query-example-list" }, ...examples.map((example) => el2("li", {}, example))));
  }
  details.appendChild(body);
  return details;
}
function renderSectionGuidance({ el: el2, mount, guidance }) {
  if (!mount || !guidance) {
    return;
  }
  mount.replaceChildren(el2("div", { className: "query-section-heading" }, el2("span", {}, guidance.label), el2("span", { className: "query-section-technical-name" }, guidance.technical || "")), el2("p", { className: "query-section-intro" }, guidance.description));
}
function renderApplyHelp(element3, availability) {
  if (!element3) {
    return;
  }
  element3.dataset.state = availability?.state || "";
  element3.textContent = availability?.text || "";
}

// media/gridPredicateBuilder.js
var MAX_CHILDREN = 16;
var MAX_DEPTH = 5;
var MAX_CORRELATIONS = 4;
function actionScope(context) {
  return context === "postFilter" ? "postFilter" : "where";
}
function walk(group, visit, depth = 1) {
  if (!group || group.kind !== "group") {
    return;
  }
  visit(group, void 0, depth);
  for (const node of group.children || []) {
    visit(node, group, depth);
    if (node.kind === "group") {
      walk(node, visit, depth + 1);
    }
    if (node.kind === "existsPredicate") {
      walk(node.where, visit, depth + 1);
    }
  }
}
function findGroup2(value, nodeId) {
  let found;
  const roots = value?.kind === "group" ? [value] : [value?.where, value?.postFilter].filter(Boolean);
  for (const root of roots) {
    walk(root, (node) => {
      if (!found && node.kind === "group" && node.nodeId === nodeId) {
        found = node;
      }
    });
  }
  return found;
}
function findNode2(value, nodeId) {
  let found;
  const roots = value?.kind === "group" ? [value] : [value?.where, value?.postFilter].filter(Boolean);
  for (const root of roots) {
    walk(root, (node, parent) => {
      if (!found && node.nodeId === nodeId) {
        found = { node, parent };
      }
    });
  }
  return found;
}
function fieldsFor(scope, metadata) {
  const target = scope?.target || scope?.source || scope?.modelRef;
  const tree = target ? metadata?.getState?.(target)?.tree : void 0;
  const fromTree = (tree?.fields || []).map((field) => ({ ...field, path: field.name, role: "field" }));
  const fromColumns = (scope?.columns || []).map((field) => ({ ...field, path: field.attname || field.name, role: "field" }));
  const fromComputed = (scope?.computedFields || scope?.computed || []).filter((field) => field?.enabled !== false && (field?.alias || field?.path)).map((field) => ({ alias: field.alias || field.path, path: field.alias || field.path, role: "computed", type: field.outputType || "" }));
  const seen = /* @__PURE__ */ new Set();
  return [...fromTree, ...fromColumns, ...fromComputed].filter((field) => field.path && !seen.has(`${field.role}:${field.path}`) && seen.add(`${field.role}:${field.path}`));
}
function fieldForPath(path, fields3) {
  return fields3.find((field) => field.path === path) || { path, role: "field", type: "" };
}
function issuesFor(validation, nodeId) {
  const source = typeof validation === "function" ? validation() : validation;
  return (source?.issues || []).filter((issue) => issue?.nodeId === nodeId);
}
function createPredicateBuilder({ context = "where", dispatch, el: el2, getRecipe, getScope, metadata, requestRender, rootNodeId, validation, popoverLayer } = {}) {
  const node = el2("fieldset", { ariaLabel: `${context} predicate builder`, className: "query-predicate-builder", dataset: { context, role: "predicate-builder" } });
  const legend = el2("legend", {}, contextLabel(context));
  const body = el2("div", { className: "query-predicate-body" });
  const status = el2("div", { ariaLive: "polite", className: "query-predicate-status", role: "status" });
  node.append(legend, status, body);
  let disposed = false;
  let pickerDisposables = [];
  let requestedFocus;
  function trackPicker2(picker) {
    pickerDisposables.push(picker);
    return picker;
  }
  function releasePickers2() {
    for (const picker of pickerDisposables) {
      picker.destroy?.();
      picker.dispose?.();
    }
    pickerDisposables = [];
  }
  function root() {
    return findGroup2(getRecipe?.(), rootNodeId) || (getRecipe?.()?.kind === "group" ? getRecipe() : void 0);
  }
  function act(action, focus) {
    requestedFocus = focus;
    dispatch?.({ ...action, scope: action.scope || actionScope(context) });
    const structural = action.type !== "UPDATE_NODE" || action.history?.mode !== "text";
    if (structural) {
      if (requestRender) {
        requestRender();
      } else {
        queueMicrotask(() => {
          if (!disposed) {
            render();
          }
        });
      }
    }
  }
  function requestMetadata() {
    const scope = getScope?.() || {};
    const target = scope.target || scope.source || scope.modelRef;
    if (!target || !metadata?.loadTree) {
      return;
    }
    const state2 = metadata.getState?.(target);
    if (!state2?.tree && !state2?.pending && !state2?.error) {
      metadata.loadTree(target).catch(() => {
      });
    }
  }
  function render() {
    requestMetadata();
    const group = root();
    releasePickers2();
    body.replaceChildren();
    if (!group) {
      body.appendChild(el2("p", { className: "query-builder-empty" }, "Loading predicate group\u2026"));
      return;
    }
    const scope = getScope?.() || {};
    const target = scope.target || scope.source || scope.modelRef;
    const state2 = target ? metadata?.getState?.(target) : void 0;
    if (state2?.pending && !state2.tree) {
      status.textContent = "Loading fields\u2026";
    } else if (state2?.error && !state2.tree) {
      status.replaceChildren("Field metadata failed. ");
      const retry = el2("button", { type: "button" }, "Retry");
      retry.addEventListener("click", () => metadata.retry?.(target).catch(() => {
      }));
      status.appendChild(retry);
    } else {
      status.textContent = "";
    }
    renderGroup(group, body, 1);
    restoreFocus();
  }
  function renderGroup(group, container, depth) {
    const section = el2("fieldset", { className: "query-predicate-group", dataset: { depth: String(depth), queryNodeId: group.nodeId, role: "predicate-group" } });
    const heading = el2("legend", {}, depth === 1 ? "Conditions" : "Nested conditions");
    const toolbar = el2("div", { className: "query-predicate-toolbar" });
    const join = nativeSelect([{ label: "Match all (AND)", value: "and" }, { label: "Match any (OR)", value: "or" }], group.join, "Join conditions");
    join.addEventListener("change", () => act({ changes: { join: join.value }, nodeId: group.nodeId, type: "UPDATE_NODE" }));
    const negated = el2("input", { ariaLabel: "Negate group", checked: Boolean(group.negated), type: "checkbox" });
    negated.addEventListener("change", () => act({ changes: { negated: negated.checked }, nodeId: group.nodeId, type: "UPDATE_NODE" }));
    const notLabel = el2("label", { className: "query-predicate-not" }, negated, "Exclude this group (NOT)");
    const addComparison = structuralButton("Add condition", "Add condition to this group", () => act({ parentId: group.nodeId, type: "ADD_COMPARISON" }, { nodeId: group.nodeId, role: "lhs" }));
    const addGroup = structuralButton("Add group", "Add nested condition group", () => act({ parentId: group.nodeId, type: "ADD_GROUP" }, { nodeId: group.nodeId, role: "lhs" }));
    const addExists = structuralButton("Add existence check", "Add related-row existence check", () => act({ parentId: group.nodeId, type: "ADD_EXISTS_PREDICATE" }, { nodeId: group.nodeId, role: "lhs" }));
    const blocked = depth >= MAX_DEPTH || (group.children || []).length >= MAX_CHILDREN;
    addComparison.disabled = blocked;
    addGroup.disabled = blocked;
    addExists.disabled = blocked || !allowsExists(context);
    addComparison.title = blocked ? `Maximum depth ${MAX_DEPTH} or ${MAX_CHILDREN} children reached` : "Add condition";
    addGroup.title = blocked ? `Maximum depth ${MAX_DEPTH} or ${MAX_CHILDREN} children reached` : "Add nested group";
    if ((group.children || []).length > 1) {
      toolbar.appendChild(join);
    }
    toolbar.append(notLabel, addComparison, addGroup);
    if (allowsExists(context)) {
      toolbar.appendChild(addExists);
    }
    section.append(heading, toolbar, inlineIssues(group.nodeId));
    const children = el2("div", { className: "query-predicate-children" });
    for (const child of group.children || []) {
      if (child.kind === "group") {
        renderGroup(child, children, depth + 1);
      } else if (child.kind === "comparison") {
        renderComparison(child, children);
      } else if (child.kind === "existsPredicate") {
        renderExists(child, children, depth);
      }
    }
    if (!(group.children || []).length) {
      children.appendChild(createMeaningLine({ el: el2, explanation: explainPredicateGroup(group, { postFilter: context === "postFilter", root: depth === 1 }), id: `query-meaning-${group.nodeId}` }));
    }
    section.appendChild(children);
    if (depth > 1) {
      section.appendChild(nodeActions(group, group));
    }
    container.appendChild(section);
  }
  function renderComparison(comparison, container) {
    const scope = getScope?.() || {};
    const fields3 = fieldsFor(scope, metadata);
    const path = comparison.lhs?.kind === "computed" ? comparison.lhs.alias : comparison.lhs?.kind === "field" ? comparison.lhs.path : "";
    const field = fieldForPath(path, fields3);
    const row = el2("div", { className: "query-predicate-row", dataset: { queryNodeId: comparison.nodeId, role: "comparison" } });
    const fieldPicker = trackPicker2(createQueryFieldPicker({ ariaLabel: "Condition field", computed: scope.computedFields || scope.computed || [], current: path, el: el2, metadata, onChange: (selectedPath) => {
      const computed = fields3.some((entry2) => entry2.role === "computed" && entry2.path === selectedPath);
      act({ changes: { lhs: computed ? { alias: selectedPath, kind: "computed" } : { kind: "field", path: selectedPath } }, nodeId: comparison.nodeId, type: "UPDATE_NODE" });
    }, popoverLayer, source: scope.target || scope.source, allowRelationTerminal: comparison.lookup === "isnull" }));
    fieldPicker.node.dataset.focusRole = "lhs";
    const lookups = lookupsForField(field);
    const lookup = nativeSelect(lookups.map((value) => ({ label: LOOKUP_LABELS[value] || value, value })), comparison.lookup, "Comparison");
    lookup.setAttribute("aria-description", "(i) means case-insensitive.");
    lookup.addEventListener("change", () => act({ changes: lookupChanges(comparison, lookup.value), nodeId: comparison.nodeId, type: "UPDATE_NODE" }));
    const rhsKinds = rhsKindsFor({ context, field, lookup: comparison.lookup });
    const rhsKind = nativeSelect(rhsKinds.map((value) => ({ label: rhsLabel(value), value })), comparison.rhs?.kind, "Compare with");
    rhsKind.addEventListener("change", () => act({ changes: { rhs: starterRhs(rhsKind.value) }, nodeId: comparison.nodeId, type: "UPDATE_NODE" }));
    const rhs = comparison.rhs?.kind === rhsKind.value ? comparison.rhs : starterRhs(rhsKind.value);
    const valueEditor = createPredicateValueEditor({ context, el: el2, field, lookup: comparison.lookup, onChange: (next) => act({ changes: { rhs: next }, history: { group: `predicate:${comparison.nodeId}:rhs`, mode: "text" }, nodeId: comparison.nodeId, type: "UPDATE_NODE" }), outerFields: scope.outerFields || [], popoverLayer, rhs, scopeFields: fields3 });
    if (valueEditor.destroy) {
      trackPicker2(valueEditor);
    }
    const negate = el2("input", { ariaLabel: "Negate condition", checked: Boolean(comparison.negated), type: "checkbox" });
    negate.addEventListener("change", () => act({ changes: { negated: negate.checked }, nodeId: comparison.nodeId, type: "UPDATE_NODE" }));
    row.append(el2("label", {}, "Field", fieldPicker.node), el2("label", {}, "Comparison", lookup), el2("label", {}, "Compare with", rhsKind), el2("label", {}, "Value", valueEditor.node), el2("label", {}, negate, "Not"), nodeActions(comparison));
    if (!rhsIsCompatible(comparison.rhs, context, field, comparison.lookup)) {
      row.dataset.invalid = "true";
      row.appendChild(el2("span", { className: "query-predicate-help", role: "note" }, "Value is incompatible with the selected field or lookup. Choose a new value."));
    }
    row.appendChild(inlineIssues(comparison.nodeId));
    row.appendChild(createMeaningLine({ el: el2, explanation: explainComparison(comparison, { fields: Object.fromEntries(fields3.map((item) => [item.path, item])), issues: issuesFor(validation, comparison.nodeId), metadataState: metadata?.getState?.(scope.target || scope.source)?.pending ? "pending" : "ready", postFilter: context === "postFilter" }), id: `query-meaning-${comparison.nodeId}` }));
    container.appendChild(row);
  }
  function renderExists(exists, container, depth) {
    const scope = getScope?.() || {};
    const row = el2("section", { ariaLabel: "Exists predicate", className: "query-predicate-exists", dataset: { queryNodeId: exists.nodeId, role: "exists" } });
    const source = exists.source || { kind: "relation", relation: "" };
    const type = nativeSelect([{ label: "Relation", value: "relation" }, { label: "Model", value: "model" }], source.kind, "Exists source type");
    type.addEventListener("change", () => act({ changes: { correlations: [], source: type.value === "model" ? { kind: "model", target: { app: "", model: "" } } : { kind: "relation", relation: "" } }, nodeId: exists.nodeId, type: "UPDATE_NODE" }));
    row.append(el2("strong", {}, "Exists"), type);
    if (source.kind === "relation") {
      const relations = scope.relations || [];
      const relation = trackPicker2(createGridCombobox({ el: el2, label: "Exists relation", onChange: (value) => act({ changes: { source: { kind: "relation", relation: value } }, nodeId: exists.nodeId, type: "UPDATE_NODE" }), options: [{ label: "Choose relation", value: "" }, ...relations.map((item) => ({ description: `${item.kind || "relation"}. ${item.target || "related model"}`, label: `${item.label || item.name} \u2192 ${item.target || "related model"}`, value: item.queryName || item.name }))], popoverLayer, value: source.relation }));
      row.appendChild(relation.node);
      row.appendChild(el2("span", { className: "query-predicate-static", role: "note" }, source.relation ? "Correlation is generated from this relation." : "Choose a relation to show its generated correlation."));
    } else {
      const models = metadata?.getCatalog?.() || [];
      const current = source.target ? `${source.target.app}.${source.target.model}` : "";
      const model = trackPicker2(createGridCombobox({ el: el2, label: "Exists target model", onChange: (value) => {
        const [app, ...rest] = value.split(".");
        act({ changes: { source: { kind: "model", target: { app, model: rest.join(".") } } }, nodeId: exists.nodeId, type: "UPDATE_NODE" });
      }, options: [{ label: "Choose model", value: "" }, ...models.map((item) => ({ label: `${item.app}.${item.model}`, value: `${item.app}.${item.model}` }))], popoverLayer, value: current }));
      row.appendChild(model.node);
      renderCorrelations(exists, row, scope);
    }
    const negated = el2("input", { ariaLabel: "Negate Exists", checked: Boolean(exists.negated), type: "checkbox" });
    negated.addEventListener("change", () => act({ changes: { negated: negated.checked }, nodeId: exists.nodeId, type: "UPDATE_NODE" }));
    row.append(el2("label", {}, negated, "Not"), nodeActions(exists), inlineIssues(exists.nodeId));
    if (exists.where?.kind === "group") {
      renderGroup(exists.where, row, depth + 1);
    }
    container.appendChild(row);
  }
  function renderCorrelations(exists, container, scope) {
    const correlations = Array.isArray(exists.correlations) ? exists.correlations : [];
    const region = el2("fieldset", { className: "query-correlations" });
    region.appendChild(el2("legend", {}, "Correlations"));
    for (const [index, correlation] of correlations.entries()) {
      let updateTarget2 = function(path) {
        update2({ targetPath: path });
      }, updateOuter2 = function(path) {
        update2({ outerPath: path });
      }, update2 = function(changes) {
        const next = correlations.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item);
        act({ changes: { correlations: next }, nodeId: exists.nodeId, type: "UPDATE_NODE" });
      };
      var updateTarget = updateTarget2, updateOuter = updateOuter2, update = update2;
      const target = trackPicker2(createQueryFieldPicker({ ariaLabel: "Target field", current: correlation.targetPath || "", el: el2, metadata, onChange: updateTarget2, popoverLayer, source: exists.source?.target }));
      const outer = trackPicker2(createQueryFieldPicker({ ariaLabel: "Current outer-row field", current: correlation.outerPath || "", el: el2, metadata, onChange: updateOuter2, popoverLayer, source: scope?.source || scope?.target }));
      const remove = structuralButton("Remove", "Remove correlation", () => {
        const next = correlations.filter((_, itemIndex) => itemIndex !== index);
        act({ changes: { correlations: next }, nodeId: exists.nodeId, type: "UPDATE_NODE" });
      });
      region.append(el2("div", { className: "query-correlation" }, target.node, el2("span", { ariaHidden: "true" }, "= current-row"), outer.node, remove, createMeaningLine({ el: el2, explanation: { state: correlation.targetPath && correlation.outerPath ? "complete" : "incomplete", text: correlation.targetPath && correlation.outerPath ? `Connect target \`${correlation.targetPath}\` to current-row \`${correlation.outerPath}\`.` : "Choose both target and current-row fields to complete this connection." }, id: `query-correlation-${correlation.nodeId}` })));
    }
    const add = structuralButton("+ correlation", "Add correlation", () => act({ changes: { correlations: [...correlations, { nodeId: `correlation-${Date.now()}`, outerPath: "", targetPath: "" }] }, nodeId: exists.nodeId, type: "UPDATE_NODE" }));
    add.disabled = correlations.length >= MAX_CORRELATIONS;
    region.appendChild(add);
    container.appendChild(region);
  }
  function nodeActions(predicate) {
    const actions = el2("span", { className: "query-predicate-actions" });
    actions.append(
      structuralButton("Up", "Move up", () => act({ nodeId: predicate.nodeId, type: "MOVE_NODE_UP" }, { nodeId: predicate.nodeId, role: "lhs" })),
      structuralButton("Down", "Move down", () => act({ nodeId: predicate.nodeId, type: "MOVE_NODE_DOWN" }, { nodeId: predicate.nodeId, role: "lhs" })),
      structuralButton("Duplicate", "Duplicate", () => act({ nodeId: predicate.nodeId, type: "DUPLICATE_NODE" }, { nodeId: predicate.nodeId, role: "lhs" })),
      structuralButton("Remove", "Remove", () => removeNode(predicate.nodeId))
    );
    return actions;
  }
  function removeNode(nodeId) {
    const found = findNode2(getRecipe?.(), nodeId);
    const siblings = found?.parent?.children || [];
    const index = siblings.findIndex((item) => item.nodeId === nodeId);
    const fallback = siblings[index + 1]?.nodeId || siblings[index - 1]?.nodeId || found?.parent?.nodeId;
    act({ nodeId, type: "REMOVE_NODE" }, { nodeId: fallback, role: fallback === found?.parent?.nodeId ? "add" : "lhs" });
  }
  function inlineIssues(nodeId) {
    const region = el2("div", { className: "query-predicate-issues", dataset: { queryIssueNodeId: nodeId } });
    renderInlineIssues(region, nodeId);
    return region;
  }
  function updateValidation() {
    for (const region of node.querySelectorAll("[data-query-issue-node-id]")) {
      renderInlineIssues(region, region.dataset.queryIssueNodeId);
    }
  }
  function renderInlineIssues(region, nodeId) {
    region.id = `query-node-issues-${nodeId}`;
    region.replaceChildren();
    for (const issue of issuesFor(validation, nodeId)) {
      region.appendChild(el2("p", { dataset: { severity: issue.severity || "error" }, role: "note" }, `${issue.severity === "warning" ? "Warning" : "Error"}: ${issue.message || issue.code}. ${issue.fix || ""}`));
    }
  }
  function restoreFocus() {
    if (!requestedFocus) {
      return;
    }
    const request = requestedFocus;
    requestedFocus = void 0;
    const container = node.querySelector(`[data-query-node-id="${escapeSelector(request.nodeId)}"]`);
    const selector = request.role === "add" ? "button" : "[data-focus-role=lhs], input, select, button";
    container?.querySelector(selector)?.focus();
  }
  function onKeydown(event) {
    if (!event.altKey && !(event.ctrlKey || event.metaKey)) {
      return;
    }
    const target = event.target?.closest?.("[data-query-node-id]");
    const nodeId = target?.dataset?.queryNodeId;
    if (!nodeId) {
      return;
    }
    if (event.altKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      act({ nodeId, type: event.key === "ArrowUp" ? "MOVE_NODE_UP" : "MOVE_NODE_DOWN" }, { nodeId, role: "lhs" });
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      act({ nodeId, type: "DUPLICATE_NODE" }, { nodeId, role: "lhs" });
    }
  }
  function destroy() {
    disposed = true;
    releasePickers2();
    node.removeEventListener("keydown", onKeydown);
  }
  node.addEventListener("keydown", onKeydown);
  render();
  return { destroy, focusNode: (nodeId) => {
    requestedFocus = { nodeId, role: "lhs" };
    render();
  }, node, render, updateValidation };
}
function nativeSelect(options, value, ariaLabel) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", ariaLabel);
  for (const option of options.length ? options : [{ label: "Unavailable", value: "" }]) {
    const child = document.createElement("option");
    child.value = option.value;
    child.textContent = option.label;
    select.appendChild(child);
  }
  select.value = options.some((option) => option.value === value) ? value : options[0]?.value || "";
  return select;
}
function structuralButton(label, ariaLabel, onClick) {
  const button2 = document.createElement("button");
  button2.type = "button";
  button2.textContent = label;
  button2.setAttribute("aria-label", ariaLabel);
  button2.addEventListener("click", onClick);
  return button2;
}
function starterRhs(kind) {
  if (kind === "list") {
    return { kind, values: [] };
  }
  if (kind === "range") {
    return { kind, lower: null, upper: null };
  }
  if (kind === "relativeTime") {
    return { amount: 1, anchor: "now", direction: "past", kind, unit: "days" };
  }
  return kind === "literal" ? { kind, value: null } : { kind, path: "" };
}
function lookupChanges(comparison, lookup) {
  if (lookup === "isnull") {
    return { lookup, rhs: { kind: "literal", value: true } };
  }
  return comparison?.lookup === "isnull" ? { lookup, rhs: { kind: "literal", value: null } } : { lookup };
}
function rhsLabel(kind) {
  return { field: "field", literal: "value", outerField: "outer field", relativeTime: "relative time" }[kind] || kind;
}
function allowsExists(context) {
  return context === "where" || context === "postFilter" || context === "subquery";
}
function contextLabel(context) {
  return { aggregateFilter: "Aggregate filter", case: "Case condition", postFilter: "Result filter", subquery: "Subquery filter", where: "WHERE" }[context] || "Conditions";
}
function escapeSelector(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : String(value || "").replace(/[^A-Za-z0-9_-]/g, "\\$&");
}

// media/gridComputedShared.js
var computedPredicateSequence = 0;
function nextComputedPredicateId(prefix) {
  computedPredicateSequence += 1;
  return `${prefix}-${computedPredicateSequence}`;
}
function cloneComputedValue(value) {
  return JSON.parse(JSON.stringify(value));
}
function emptyComputedGroup(nodeId) {
  return { children: [], join: "and", kind: "group", negated: false, nodeId };
}
function createComputedDraft(kind, nodeId, alias = "") {
  const group = (suffix) => emptyComputedGroup(`${nodeId}-${suffix}`);
  if (kind === "aggregate") {
    return { alias, distinct: "auto", enabled: true, field: { kind: "all" }, filter: group("filter"), function: "count", kind, nodeId };
  }
  if (kind === "scalarSubquery") {
    return { alias, correlations: [], enabled: true, kind, nodeId, onEmpty: { kind: "literal", value: null }, orderBy: [], outputType: "auto", select: { field: { kind: "field", path: "" }, kind: "field" }, source: { kind: "relation", relation: "" }, where: group("where") };
  }
  if (kind === "exists") {
    return { alias, correlations: [], enabled: true, kind, nodeId, source: { kind: "relation", relation: "" }, where: group("where") };
  }
  if (kind === "window") {
    return { alias, enabled: true, function: "row_number", kind, nodeId, orderBy: [], partitionBy: [] };
  }
  if (kind === "codeExpression") {
    return { alias, enabled: true, expression: "", kind, nodeId, outputType: "auto", when: group("when") };
  }
  return { alias, enabled: true, expression: { kind: "literal", value: null }, kind: "formula", nodeId, outputType: "auto" };
}
function suggestComputedAlias(kind, computed) {
  const base = { aggregate: "count", codeExpression: "expression", exists: "exists", formula: "value", scalarSubquery: "subquery", window: "row_number" }[kind] || "value";
  const used = new Set((computed || []).map((item) => String(item.alias || "").toLowerCase()));
  if (!used.has(base)) {
    return base;
  }
  let index = 2;
  while (used.has(`${base}_${index}`)) {
    index += 1;
  }
  return `${base}_${index}`;
}
function previousEnabledAliases(computed, nodeId) {
  const index = (computed || []).findIndex((item) => item.nodeId === nodeId);
  return (computed || []).slice(0, Math.max(0, index)).filter((item) => item.enabled && item.alias).map((item) => item.alias);
}
function summaryUnavailable(recipe, item) {
  return recipe?.mode === "summary" && item?.kind !== "aggregate";
}
function findPredicate(root, nodeId) {
  if (root?.nodeId === nodeId) {
    return { node: root, parent: void 0 };
  }
  let found;
  const visit = (group) => {
    for (const node of group?.children || []) {
      if (node.nodeId === nodeId) {
        found = { node, parent: group };
        return;
      }
      if (node.kind === "group") {
        visit(node);
      }
      if (node.kind === "existsPredicate") {
        visit(node.where);
      }
      if (found) {
        return;
      }
    }
  };
  visit(root);
  return found;
}
function clonePredicateNode(node) {
  let sequence = 0;
  const copy2 = cloneComputedValue(node);
  const rewrite = (value) => {
    if (!value || typeof value !== "object") {
      return;
    }
    if (typeof value.nodeId === "string") {
      sequence += 1;
      value.nodeId = `${value.kind || "node"}-copy-${sequence}`;
    }
    (value.children || []).forEach(rewrite);
    if (value.where) {
      rewrite(value.where);
    }
    (value.correlations || []).forEach(rewrite);
    (value.orderBy || []).forEach(rewrite);
  };
  rewrite(copy2);
  return copy2;
}
function reduceComputedPredicate(root, action) {
  const next = cloneComputedValue(root);
  const found = findPredicate(next, action.nodeId);
  const parent = findPredicate(next, action.parentId || next.nodeId)?.node;
  const add = (node) => {
    if (parent?.kind === "group") {
      parent.children.push(node);
    }
  };
  if (action.type === "ADD_COMPARISON") {
    add({ kind: "comparison", lhs: { kind: "field", path: "" }, lookup: "exact", negated: false, nodeId: nextComputedPredicateId("comparison"), rhs: { kind: "literal", value: null } });
  } else if (action.type === "ADD_GROUP") {
    add(emptyComputedGroup(nextComputedPredicateId("group")));
  } else if (action.type === "ADD_EXISTS_PREDICATE") {
    add({ correlations: [], kind: "existsPredicate", negated: false, nodeId: nextComputedPredicateId("exists"), source: { kind: "relation", relation: "" }, where: emptyComputedGroup(nextComputedPredicateId("exists-where")) });
  } else if (action.type === "UPDATE_NODE" && found) {
    Object.assign(found.node, action.changes || {});
  } else if (action.type === "REMOVE_NODE" && found?.parent) {
    found.parent.children.splice(found.parent.children.indexOf(found.node), 1);
  } else if (action.type === "DUPLICATE_NODE" && found?.parent) {
    const index = found.parent.children.indexOf(found.node);
    found.parent.children.splice(index + 1, 0, clonePredicateNode(found.node));
  } else if ((action.type === "MOVE_NODE_UP" || action.type === "MOVE_NODE_DOWN") && found?.parent) {
    const index = found.parent.children.indexOf(found.node);
    const target = index + (action.type === "MOVE_NODE_UP" ? -1 : 1);
    if (target >= 0 && target < found.parent.children.length) {
      [found.parent.children[index], found.parent.children[target]] = [found.parent.children[target], found.parent.children[index]];
    }
  }
  return next;
}
function createComputedPredicateEditor({ context, dispatch, el: el2, getRecipe, getScope, item, key, metadata, onChange, validation }) {
  const root = item?.[key];
  if (!root?.nodeId) {
    return void 0;
  }
  const update = (action) => {
    const next = reduceComputedPredicate(root, action);
    if (onChange) {
      onChange(next);
      return;
    }
    dispatch({ changes: { [key]: next }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" });
  };
  return createPredicateBuilder({ context, dispatch: update, el: el2, getRecipe: () => root, getScope, metadata, rootNodeId: root.nodeId, validation });
}
function computedSelect(el2, label, options, value, onChange) {
  const select = el2("select", { ariaLabel: label, className: "query-computed-select" });
  for (const option of options) {
    select.appendChild(el2("option", { value: option.value }, option.label));
  }
  select.value = value ?? "";
  select.addEventListener("change", () => onChange(select.value));
  return select;
}
function computedInput(el2, label, value, onChange, options = {}) {
  const input = el2("input", { ariaLabel: label, className: "query-computed-input", maxLength: options.maxLength, placeholder: options.placeholder || "", type: options.type || "text", value: value == null ? "" : String(value) });
  input.addEventListener(options.event || "input", () => onChange(input.value));
  return input;
}

// media/gridAggregateBuilder.js
var FUNCTIONS = ["count", "sum", "avg", "min", "max"];
function fields(scope) {
  return (scope?.fields || scope?.columns || []).filter((field) => field?.path || field?.attname || field?.name).map((field) => ({ ...field, path: field.path || field.attname || field.name }));
}
function aggregateFieldOptions(candidates, current) {
  const options = [{ label: "All rows", value: "*" }, ...(candidates || []).map((entry2) => ({ description: entry2.type || "", label: entry2.label || entry2.path, value: entry2.path }))];
  if (current && current !== "*" && !options.some((option) => option.value === current)) {
    options.splice(1, 0, { description: "Choose a supported replacement.", disabled: true, disabledReason: "Unavailable field", label: `Unavailable field: ${current}`, value: current });
  }
  return options;
}
function renderAggregateBuilder({ dispatch, el: el2, getRecipe, getScope, item, metadata, popoverLayer, validation }) {
  const scope = getScope?.(item) || {};
  const root = el2("div", { className: "query-computed-body query-aggregate-builder" });
  const field = item.field?.kind === "field" ? item.field.path : "*";
  const candidates = fields(scope);
  const functionSelect = computedSelect(el2, "Aggregate function", FUNCTIONS.map((value) => ({ label: value.toUpperCase(), value })), item.function, (functionName) => dispatch({ changes: { function: functionName, ...functionName !== "count" ? { distinct: "auto", field: field === "*" ? { kind: "field", path: "" } : item.field } : {} }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  const fieldPicker = createGridCombobox({ el: el2, label: "Aggregate field", onChange: (path) => dispatch({ changes: { field: path === "*" ? { kind: "all" } : { kind: "field", path } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), options: aggregateFieldOptions(candidates, field), popoverLayer, value: field });
  const distinct = computedSelect(el2, "Count distinct", [{ label: "Automatic", value: "auto" }, { label: "Always distinct", value: "always" }], item.distinct, (value) => dispatch({ changes: { distinct: value }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  const nonCount = item.function !== "count";
  distinct.disabled = nonCount;
  root.append(el2("label", {}, "Function", functionSelect), el2("label", {}, "Field", fieldPicker.node), el2("label", {}, "Distinct", distinct));
  root.__queryDestroy = () => fieldPicker.destroy();
  const selected = candidates.find((entry2) => entry2.path === field);
  if (nonCount && selected?.toMany) {
    root.appendChild(el2("p", { className: "query-node-issue", role: "alert" }, "A non-Count aggregate over a to-many path is unsafe. Choose a concrete or Count field."));
  }
  const predicate = createComputedPredicateEditor({ context: "aggregate", dispatch, el: el2, getRecipe, getScope: () => scope, item, key: "filter", metadata, validation });
  if (predicate) {
    root.appendChild(predicate.node);
    predicate.render();
  }
  return root;
}

// media/gridQueryRecipeLimits.js
var MODEL_QUERY_RECIPE_LIMITS = Object.freeze({ recipeBytes: 64 * 1024, predicateNodes: 64, predicateGroupDepth: 5, predicateGroupChildren: 16, computedColumns: 12, groupByFields: 8, outerOrderTerms: 8, subqueryCorrelations: 4, subqueryOrderTerms: 3, formulaNodes: 32, formulaDepth: 6, caseBranches: 8, inValues: 200, pathCharacters: 240, pathSegments: 12, aliasCharacters: 64, literalStringCharacters: 4096, rawCodeExpressionCharacters: 800, generatedOrmCellCharacters: 32768 });
var MODEL_QUERY_LOOKUPS = Object.freeze(["exact", "in", "isnull", "gt", "gte", "lt", "lte", "range", "iexact", "contains", "icontains", "startswith", "istartswith", "endswith", "iendswith", "blank", "not_blank", "trim", "length", "length__gt", "length__gte", "length__lt", "length__lte", "date", "year", "quarter", "month", "week_day", "day", "hour", "minute", "second"]);
var MODEL_QUERY_AGGREGATE_FUNCTIONS = Object.freeze(["count", "sum", "avg", "min", "max"]);
var MODEL_QUERY_FORMULA_FUNCTIONS = Object.freeze(["coalesce", "concat", "greatest", "least", "lower", "upper", "trim", "length"]);
var MODEL_QUERY_WINDOW_FUNCTIONS = Object.freeze(["rank", "dense_rank", "row_number", "sum", "avg", "min", "max", "count"]);
var MODEL_QUERY_OUTPUT_TYPES = Object.freeze(["auto", "boolean", "integer", "float", "decimal", "text", "date", "datetime", "time", "duration", "uuid"]);

// media/gridCodeExpressionBuilder.js
var activeWhenEditors = /* @__PURE__ */ new Set();
function renderCodeExpressionBuilder({ dispatch, el: el2, getRecipe, getScope, item, metadata, validation }) {
  const root = el2("div", { className: "query-computed-body query-code-expression-builder" });
  const disposables = [];
  root.appendChild(el2("p", { className: "query-builder-empty", role: "note" }, `Advanced: restricted Django expression only; no newlines and at most ${MODEL_QUERY_RECIPE_LIMITS.rawCodeExpressionCharacters} characters.`));
  const expression = computedInput(el2, "Restricted Django expression", item.expression, (value) => dispatch({ changes: { expression: value }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), { maxLength: MODEL_QUERY_RECIPE_LIMITS.rawCodeExpressionCharacters });
  expression.pattern = "[^\\r\\n]*";
  root.appendChild(el2("label", {}, "Expression", expression));
  const whenOn = activeWhenEditors.has(item.nodeId) || Boolean(item.when?.children?.length);
  const toggle = el2("input", { ariaLabel: "Only when", checked: whenOn, type: "checkbox" });
  toggle.addEventListener("change", () => {
    if (toggle.checked) {
      activeWhenEditors.add(item.nodeId);
    } else {
      activeWhenEditors.delete(item.nodeId);
    }
    dispatch({ changes: { when: toggle.checked ? item.when : { children: [], join: "and", kind: "group", negated: false, nodeId: `${item.nodeId}-when` } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" });
  });
  root.appendChild(el2("label", {}, toggle, "Only when"));
  if (whenOn) {
    const predicate = createComputedPredicateEditor({ context: "case", dispatch, el: el2, getRecipe, getScope: () => getScope?.(item) || {}, item, key: "when", metadata, validation });
    if (predicate) {
      disposables.push(() => predicate.destroy());
      root.appendChild(predicate.node);
      predicate.render();
    }
  }
  root.appendChild(el2("label", {}, "Output type", computedSelect(el2, "Code expression output type", MODEL_QUERY_OUTPUT_TYPES.map((value) => ({ label: value, value })), item.outputType, (value) => dispatch({ changes: { outputType: value }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }))));
  root.__queryDestroy = () => {
    for (const dispose of disposables) {
      dispose();
    }
  };
  return root;
}

// media/gridFormulaBuilder.js
var BINARY = ["+", "-", "*", "/", "%"];
function formulaMetrics(node, depth = 1) {
  if (!node || typeof node !== "object") {
    return { depth, nodes: 0 };
  }
  const children = node.kind === "binary" ? [node.left, node.right] : node.kind === "function" ? node.args || [] : node.kind === "case" ? [...(node.branches || []).map((branch) => branch.then), node.else] : node.kind === "cast" ? [node.expression] : [];
  return children.reduce((total, child) => {
    const metric = formulaMetrics(child, depth + 1);
    return { depth: Math.max(total.depth, metric.depth), nodes: total.nodes + metric.nodes };
  }, { depth, nodes: 1 });
}
function formulaArity(functionName) {
  return { coalesce: 2, concat: 2, greatest: 2, least: 2, length: 1, lower: 1, trim: 1, upper: 1 }[functionName] || 1;
}
function expressionEditor({ aliases, dispatch, disposables, el: el2, getRecipe, getScope, item, metadata, node, onChange, popoverLayer, validation }) {
  const root = el2("fieldset", { className: "query-formula-node" });
  root.appendChild(el2("legend", {}, "Expression"));
  const kind = computedSelect(el2, "Formula expression kind", [{ label: "Field", value: "field" }, { label: "Computed alias", value: "computed" }, { label: "Literal", value: "literal" }, { label: "Binary", value: "binary" }, { label: "Function", value: "function" }, { label: "Case", value: "case" }, { label: "Cast", value: "cast" }], node?.kind || "literal", (value) => onChange(starter(value)));
  root.appendChild(kind);
  if (node?.kind === "field") {
    const scope = getScope?.(item) || {};
    const picker = createQueryFieldPicker({ ariaLabel: "Formula field", current: node.path, el: el2, metadata, onChange: (value) => onChange({ ...node, path: value }), popoverLayer, source: scope.target || scope.source });
    disposables?.push(() => picker.dispose());
    root.appendChild(el2("label", {}, "Field", picker.node));
  } else if (node?.kind === "computed") {
    root.appendChild(el2("label", {}, "Previous computed alias", computedSelect(el2, "Previous computed alias", [{ label: "Choose alias", value: "" }, ...aliases.map((value) => ({ label: value, value }))], node.alias, (value) => onChange({ ...node, alias: value }))));
  } else if (node?.kind === "literal") {
    root.appendChild(el2("label", {}, "Literal", computedInput(el2, "Formula literal", node.value, (value) => onChange({ kind: "literal", value }))));
  } else if (node?.kind === "binary") {
    const operator = computedSelect(el2, "Binary operator", BINARY.map((value) => ({ label: value, value })), node.operator, (value) => onChange({ ...node, operator: value }));
    root.appendChild(el2("label", {}, "Operator", operator));
    root.append(expressionEditor({ aliases, dispatch, disposables, el: el2, getRecipe, getScope, item, metadata, node: node.left, onChange: (left) => onChange({ ...node, left }), popoverLayer, validation }), expressionEditor({ aliases, dispatch, disposables, el: el2, getRecipe, getScope, item, metadata, node: node.right, onChange: (right) => onChange({ ...node, right }), popoverLayer, validation }));
  } else if (node?.kind === "function") {
    const functionSelect = computedSelect(el2, "Formula function", MODEL_QUERY_FORMULA_FUNCTIONS.map((value) => ({ label: value, value })), node.function, (value) => onChange({ ...node, args: Array.from({ length: formulaArity(value) }, (_, index) => node.args?.[index] || starter("literal")), function: value }));
    root.appendChild(el2("label", {}, "Function", functionSelect));
    (node.args || []).forEach((argument, index) => root.appendChild(expressionEditor({ aliases, dispatch, disposables, el: el2, getRecipe, getScope, item, metadata, node: argument, onChange: (value) => onChange({ ...node, args: node.args.map((entry2, current) => current === index ? value : entry2) }), popoverLayer, validation })));
  } else if (node?.kind === "case") {
    for (const [index, branch] of (node.branches || []).entries()) {
      const branchRoot = el2("fieldset", { className: "query-formula-case-branch" });
      branchRoot.appendChild(el2("legend", {}, `When ${index + 1}`));
      const predicate = createComputedPredicateEditor({ context: "case", dispatch, el: el2, getRecipe, getScope, item: { ...item, nodeId: item.nodeId, when: branch.when }, key: "when", metadata, onChange: (when) => onChange({ ...node, branches: node.branches.map((entry2, current) => current === index ? { ...entry2, when } : entry2) }), validation });
      if (predicate) {
        disposables?.push(() => predicate.destroy());
        branchRoot.appendChild(predicate.node);
        predicate.render();
      }
      branchRoot.appendChild(expressionEditor({ aliases, dispatch, disposables, el: el2, getRecipe, getScope, item, metadata, node: branch.then, onChange: (then) => onChange({ ...node, branches: node.branches.map((entry2, current) => current === index ? { ...entry2, then } : entry2) }), popoverLayer, validation }));
      root.appendChild(branchRoot);
    }
    const addBranch = el2("button", { className: "secondary", type: "button" }, "Add case branch");
    addBranch.disabled = (node.branches || []).length >= MODEL_QUERY_RECIPE_LIMITS.caseBranches;
    addBranch.addEventListener("click", () => onChange({ ...node, branches: [...node.branches || [], { then: starter("literal"), when: { children: [], join: "and", kind: "group", negated: false, nodeId: `${item.nodeId}-case-${(node.branches || []).length + 1}` } }] }));
    root.appendChild(addBranch);
    root.appendChild(expressionEditor({ aliases, dispatch, disposables, el: el2, getRecipe, getScope, item, metadata, node: node.else, onChange: (otherwise) => onChange({ ...node, else: otherwise }), popoverLayer, validation }));
  } else if (node?.kind === "cast") {
    root.appendChild(el2("label", {}, "Output type", computedSelect(el2, "Cast output type", MODEL_QUERY_OUTPUT_TYPES.filter((value) => value !== "auto").map((value) => ({ label: value, value })), node.outputType, (value) => onChange({ ...node, outputType: value }))));
    root.appendChild(expressionEditor({ aliases, dispatch, disposables, el: el2, getRecipe, getScope, item, metadata, node: node.expression, onChange: (expression) => onChange({ ...node, expression }), popoverLayer, validation }));
  }
  return root;
}
function starter(kind) {
  if (kind === "field") {
    return { kind, path: "" };
  }
  if (kind === "computed") {
    return { alias: "", kind };
  }
  if (kind === "binary") {
    return { kind, left: { kind: "literal", value: null }, operator: "+", right: { kind: "literal", value: null } };
  }
  if (kind === "function") {
    return { args: [{ kind: "literal", value: null }, { kind: "literal", value: null }], function: "coalesce", kind };
  }
  if (kind === "case") {
    return { branches: [], else: { kind: "literal", value: null }, kind };
  }
  if (kind === "cast") {
    return { expression: { kind: "literal", value: null }, kind, outputType: "text" };
  }
  return { kind: "literal", value: null };
}
function renderFormulaBuilder({ dispatch, el: el2, getRecipe, getScope, item, metadata, popoverLayer, validation }) {
  const recipe = getRecipe?.() || { computed: [] };
  const root = el2("div", { className: "query-computed-body query-formula-builder" });
  const aliases = previousEnabledAliases(recipe.computed, item.nodeId);
  const disposables = [];
  root.appendChild(expressionEditor({ aliases, dispatch, disposables, el: el2, getRecipe, getScope, item, metadata, node: item.expression, onChange: (expression) => dispatch({ changes: { expression }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), popoverLayer, validation }));
  root.appendChild(el2("label", {}, "Output type", computedSelect(el2, "Formula output type", MODEL_QUERY_OUTPUT_TYPES.map((value) => ({ label: value, value })), item.outputType, (value) => dispatch({ changes: { outputType: value }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }))));
  const metric = formulaMetrics(item.expression);
  if (metric.nodes > MODEL_QUERY_RECIPE_LIMITS.formulaNodes || metric.depth > MODEL_QUERY_RECIPE_LIMITS.formulaDepth) {
    root.appendChild(el2("p", { className: "query-node-issue", role: "alert" }, `Formula is ${metric.nodes} nodes / ${metric.depth} levels; limit is ${MODEL_QUERY_RECIPE_LIMITS.formulaNodes} / ${MODEL_QUERY_RECIPE_LIMITS.formulaDepth}.`));
  }
  root.__queryDestroy = () => {
    for (const dispose of disposables) {
      dispose();
    }
  };
  return root;
}

// media/gridSubqueryBuilder.js
function catalog(metadata) {
  return metadata?.getCatalog?.() || [];
}
function targetFromLabel(label) {
  const value = String(label || "");
  const boundary = value.lastIndexOf(".");
  return boundary > 0 ? { app: value.slice(0, boundary), model: value.slice(boundary + 1) } : void 0;
}
function sourceTarget(source, scope) {
  if (source?.kind === "model") {
    return source.target?.app && source.target?.model ? { app: source.target.app, model: source.target.model } : void 0;
  }
  return targetFromLabel((scope?.relations || []).find((relation) => relation?.name === source?.relation || relation?.queryName === source?.relation)?.target);
}
function relationValue(relation) {
  return relation?.queryName || relation?.name || "";
}
function trackPicker(pickers, picker) {
  if (picker) {
    pickers?.push(() => {
      picker.destroy?.();
      picker.dispose?.();
    });
  }
  return picker;
}
function releasePickers(pickers) {
  for (const dispose of pickers || []) {
    dispose();
  }
}
function moveSubqueryOrder(entries2, index, delta) {
  const next = [...entries2 || []];
  const target = index + delta;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) {
    return next;
  }
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
function sourceFieldPicker({ ariaLabel, computed, dispatch, el: el2, item, metadata, onChange, pickers, popoverLayer, scope, value }) {
  const target = sourceTarget(item.source, scope);
  if (!target) {
    return el2("p", { className: "query-control-help" }, "Choose a relation or model source before selecting a field.");
  }
  const picker = trackPicker(pickers, createQueryFieldPicker({ ariaLabel, computed, current: value, el: el2, metadata, onChange, popoverLayer, source: target, context: "subquery" }));
  return picker.node;
}
function sourceControls({ dispatch, el: el2, item, metadata, pickers, popoverLayer, scope }) {
  const wrap = el2("fieldset", { className: "query-subquery-source" });
  wrap.appendChild(el2("legend", {}, "1. Source"));
  const source = item.source || { kind: "relation", relation: "" };
  const kind = computedSelect(el2, "Subquery source type", [{ label: "Relation", value: "relation" }, { label: "Model", value: "model" }], source.kind, (value) => dispatch({ changes: { source: value === "model" ? { kind: "model", target: { app: "", model: "" } } : { kind: "relation", relation: "" } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  wrap.appendChild(el2("label", {}, "Source", kind));
  if (source.kind === "relation") {
    const relation = trackPicker(pickers, createGridCombobox({ el: el2, label: "Relation", onChange: (value) => dispatch({ changes: { source: { kind: "relation", relation: value } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), options: [{ label: "Choose related rows", value: "" }, ...(scope?.relations || []).map((entry2) => ({ description: `${entry2.kind || "relation"}. ${entry2.target || "related model"}`, label: `${entry2.label || entry2.name} \u2192 ${entry2.target || "related model"}`, value: relationValue(entry2) }))], popoverLayer, value: source.relation }));
    wrap.appendChild(el2("label", {}, "Relation", relation.node));
  } else {
    const target = `${source.target?.app || ""}.${source.target?.model || ""}`.replace(/^\.|\.$/g, "");
    const model = trackPicker(pickers, createGridCombobox({ el: el2, label: "Subquery model", onChange: (value) => {
      const split = value.lastIndexOf(".");
      dispatch({ changes: { source: { kind: "model", target: split > 0 ? { app: value.slice(0, split), model: value.slice(split + 1) } : { app: "", model: "" } } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" });
    }, options: [{ label: "Choose model", value: "" }, ...catalog(metadata).map((entry2) => ({ label: `${entry2.app}.${entry2.model}`, value: `${entry2.app}.${entry2.model}` }))], popoverLayer, value: target }));
    wrap.appendChild(el2("label", {}, "Model", model.node));
  }
  return wrap;
}
function correlationControls({ dispatch, el: el2, item, metadata, pickers, popoverLayer, scope }) {
  const root = el2("fieldset", { className: "query-subquery-correlations" });
  root.appendChild(el2("legend", {}, "2. Connection"));
  if (item.source?.kind === "relation") {
    root.appendChild(el2("p", { className: "query-builder-empty" }, "The selected relation supplies correlation automatically."));
    return root;
  }
  const entries2 = item.correlations || [];
  for (const [index, correlation] of entries2.entries()) {
    let change2 = function(entryIndex, changes) {
      dispatch({ changes: { correlations: entries2.map((entry2, current) => current === entryIndex ? { ...entry2, ...changes } : entry2) }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" });
    };
    var change = change2;
    const row = el2("div", { className: "query-subquery-correlation", dataset: { queryNodeId: correlation.nodeId } });
    const outer = trackPicker(pickers, createQueryFieldPicker({ ariaLabel: "Outer field", current: correlation.outerPath, el: el2, metadata, onChange: (value) => change2(index, { outerPath: value }), popoverLayer, source: scope?.source, context: "subquery" }));
    const target = sourceFieldPicker({ ariaLabel: "Target field", dispatch, el: el2, item, metadata, onChange: (value) => change2(index, { targetPath: value }), pickers, popoverLayer, scope, value: correlation.targetPath });
    const remove = el2("button", { ariaLabel: "Remove correlation", className: "secondary", type: "button" }, "Remove");
    remove.addEventListener("click", () => dispatch({ changes: { correlations: entries2.filter((_, entryIndex) => entryIndex !== index) }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
    row.append(el2("label", {}, "Outer", outer.node), el2("label", {}, "Target", target), remove);
    root.appendChild(row);
  }
  const add = el2("button", { className: "secondary", type: "button" }, "Add correlation");
  add.disabled = entries2.length >= MODEL_QUERY_RECIPE_LIMITS.subqueryCorrelations;
  add.addEventListener("click", () => dispatch({ changes: { correlations: [...entries2, { nodeId: `${item.nodeId}-correlation-${entries2.length + 1}`, outerPath: "", targetPath: "" }] }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  root.appendChild(add);
  return root;
}
function scalarControls({ dispatch, el: el2, item, metadata, pickers, popoverLayer, scope }) {
  const root = el2("div", { className: "query-subquery-scalar" });
  const select = item.select || { field: { kind: "field", path: "" }, kind: "field" };
  const returned = el2("fieldset", { className: "query-subquery-returned" });
  returned.appendChild(el2("legend", {}, "4. Returned value"));
  const kind = computedSelect(el2, "Subquery select type", [{ label: "Field", value: "field" }, { label: "Aggregate", value: "aggregate" }], select.kind, (value) => dispatch({ changes: { select: value === "aggregate" ? { distinct: "auto", field: { kind: "all" }, function: "count", kind: "aggregate" } : { field: { kind: "field", path: "" }, kind: "field" } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  returned.appendChild(el2("label", {}, "Select", kind));
  if (select.kind === "field") {
    const field = sourceFieldPicker({ ariaLabel: "Subquery field", dispatch, el: el2, item, metadata, onChange: (value) => dispatch({ changes: { select: { field: { kind: "field", path: value }, kind: "field" } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), pickers, popoverLayer, scope, value: select.field?.path });
    returned.appendChild(el2("label", {}, "Field", field));
  } else {
    returned.appendChild(el2("label", {}, "Aggregate", computedSelect(el2, "Subquery aggregate", MODEL_QUERY_AGGREGATE_FUNCTIONS.map((value) => ({ label: value, value })), select.function, (value) => dispatch({ changes: { select: { ...select, function: value } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }))));
  }
  root.appendChild(returned);
  const orders = item.orderBy || [];
  const orderGroup = el2("fieldset", { className: "query-subquery-orders" });
  orderGroup.appendChild(el2("legend", {}, "5. Row choice"));
  orderGroup.appendChild(el2("p", { className: "query-control-help" }, `Order the matching rows before returning one value (up to ${MODEL_QUERY_RECIPE_LIMITS.subqueryOrderTerms}).`));
  for (const [index, entry2] of orders.entries()) {
    const row = el2("div", { className: "query-subquery-order", dataset: { queryNodeId: entry2.nodeId } });
    const path = sourceFieldPicker({ ariaLabel: "Subquery order field", dispatch, el: el2, item, metadata, onChange: (value) => changeOrder(index, { ref: { kind: "field", path: value } }), pickers, popoverLayer, scope, value: entry2.ref?.path });
    const direction = computedSelect(el2, "Subquery order direction", [{ label: "Ascending", value: "asc" }, { label: "Descending", value: "desc" }], entry2.direction, (value) => changeOrder(index, { direction: value }));
    const up = el2("button", { ariaLabel: "Move subquery order up", className: "secondary", type: "button" }, "Up");
    up.disabled = index === 0;
    up.addEventListener("click", () => dispatch({ changes: { orderBy: moveSubqueryOrder(orders, index, -1) }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
    const down = el2("button", { ariaLabel: "Move subquery order down", className: "secondary", type: "button" }, "Down");
    down.disabled = index === orders.length - 1;
    down.addEventListener("click", () => dispatch({ changes: { orderBy: moveSubqueryOrder(orders, index, 1) }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
    const remove = el2("button", { ariaLabel: "Remove subquery order", className: "secondary", type: "button" }, "Remove");
    remove.addEventListener("click", () => dispatch({ changes: { orderBy: orders.filter((_, current) => current !== index) }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
    row.append(el2("label", {}, "Field", path), el2("label", {}, "Direction", direction), up, down, remove);
    orderGroup.appendChild(row);
  }
  const addOrder = el2("button", { className: "secondary", type: "button" }, "Add order");
  addOrder.disabled = orders.length >= MODEL_QUERY_RECIPE_LIMITS.subqueryOrderTerms;
  addOrder.addEventListener("click", () => dispatch({ changes: { orderBy: [...orders, { direction: "asc", nodeId: `${item.nodeId}-order-${orders.length + 1}`, ref: { kind: "field", path: "" } }] }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  orderGroup.appendChild(addOrder);
  root.appendChild(orderGroup);
  const outputGroup = el2("fieldset", { className: "query-subquery-output" });
  outputGroup.appendChild(el2("legend", {}, "6. Output"));
  const empty = computedInput(el2, "Empty result literal", item.onEmpty?.value, (value) => dispatch({ changes: { onEmpty: { kind: "literal", value: value || null } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  const output = computedSelect(el2, "Output type", MODEL_QUERY_OUTPUT_TYPES.map((value) => ({ label: value, value })), item.outputType, (value) => dispatch({ changes: { outputType: value }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  outputGroup.append(el2("label", {}, "On empty", empty), el2("label", {}, "Output", output));
  root.appendChild(outputGroup);
  return root;
  function changeOrder(index, changes) {
    dispatch({ changes: { orderBy: orders.map((entry2, current) => current === index ? { ...entry2, ...changes } : entry2) }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" });
  }
}
function renderSubqueryBuilder({ dispatch, el: el2, getRecipe, getScope, item, metadata, popoverLayer, scope, validation }) {
  const root = el2("div", { className: "query-computed-body query-subquery-builder" });
  const pickers = [];
  root.append(sourceControls({ dispatch, el: el2, item, metadata, pickers, popoverLayer, scope }), correlationControls({ dispatch, el: el2, item, metadata, pickers, popoverLayer, scope }));
  const targetFilter = el2("fieldset", { className: "query-subquery-target-filter" });
  targetFilter.appendChild(el2("legend", {}, "3. Target filter"));
  const predicate = createComputedPredicateEditor({ context: "subquery", dispatch, el: el2, getRecipe, getScope: () => getScope?.(item) || {}, item, key: "where", metadata, validation });
  if (predicate) {
    pickers.push(() => predicate.destroy());
    targetFilter.appendChild(predicate.node);
    predicate.render();
  } else {
    targetFilter.appendChild(el2("p", { className: "query-builder-empty" }, "No target filter is configured."));
  }
  root.append(targetFilter, scalarControls({ dispatch, el: el2, item, metadata, pickers, popoverLayer, scope }));
  const reset = el2("button", { className: "secondary", type: "button" }, "Reset incompatible fields");
  reset.addEventListener("click", () => dispatch({ changes: { orderBy: [], select: { field: { kind: "field", path: "" }, kind: "field" }, where: { ...item.where, children: [] } }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  root.appendChild(reset);
  root.__queryDestroy = () => releasePickers(pickers);
  return root;
}
function renderExistsComputedBuilder({ dispatch, el: el2, getRecipe, getScope, item, metadata, popoverLayer, scope, validation }) {
  const root = el2("div", { className: "query-computed-body query-exists-builder" });
  const pickers = [];
  root.append(sourceControls({ dispatch, el: el2, item, metadata, pickers, popoverLayer, scope }), correlationControls({ dispatch, el: el2, item, metadata, pickers, popoverLayer, scope }));
  const predicate = createComputedPredicateEditor({ context: "subquery", dispatch, el: el2, getRecipe, getScope: () => getScope?.(item) || {}, item, key: "where", metadata, validation });
  if (predicate) {
    pickers.push(() => predicate.destroy());
    root.appendChild(predicate.node);
    predicate.render();
  }
  root.__queryDestroy = () => releasePickers(pickers);
  return root;
}

// media/gridWindowBuilder.js
function fields2(scope) {
  return (scope?.fields || scope?.columns || []).map((field) => field?.path || field?.attname || field?.name).filter(Boolean);
}
function windowFieldOptions(values, unsetLabel) {
  return [{ label: unsetLabel, value: "" }, ...(values || []).map((value) => ({ label: value, value }))];
}
function renderWindowBuilder({ dispatch, el: el2, getScope, item, popoverLayer }) {
  const root = el2("div", { className: "query-computed-body query-window-builder" });
  const available = fields2(getScope?.(item) || {});
  const functionSelect = computedSelect(el2, "Window function", MODEL_QUERY_WINDOW_FUNCTIONS.map((value) => ({ label: value, value })), item.function, (functionName) => dispatch({ changes: { function: functionName }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
  const field = createGridCombobox({ el: el2, label: "Window field", onChange: (path) => dispatch({ changes: { field: path ? { kind: "field", path } : void 0 }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), options: windowFieldOptions(available, "No field"), popoverLayer, value: item.field?.path || "" });
  const order = createGridCombobox({ el: el2, label: "Window order field", onChange: (path) => dispatch({ changes: { orderBy: path ? [{ direction: "asc", nodeId: `${item.nodeId}-order-1`, ref: { kind: "field", path } }] : [] }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), options: windowFieldOptions(available, "Choose order"), popoverLayer, value: item.orderBy?.[0]?.ref?.path || "" });
  const partition = createGridCombobox({ el: el2, label: "Partition field", onChange: (path) => dispatch({ changes: { partitionBy: path ? [{ kind: "field", path }] : [] }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }), options: windowFieldOptions(available, "No partition"), popoverLayer, value: item.partitionBy?.[0]?.path || "" });
  root.append(el2("label", {}, "Function", functionSelect), el2("label", {}, "Field", field.node), el2("label", {}, "Order", order.node), el2("label", {}, "Partition", partition.node));
  root.__queryDestroy = () => {
    field.destroy();
    order.destroy();
    partition.destroy();
  };
  if (!item.orderBy?.length) {
    root.appendChild(el2("p", { className: "query-node-issue", role: "alert" }, "A Window expression requires an order before it can run."));
  }
  return root;
}

// media/gridComputedBuilder.js
var COMPUTED_KINDS = [
  { label: "Aggregate", value: "aggregate" },
  { label: "Scalar subquery", value: "scalarSubquery" },
  { label: "Exists", value: "exists" },
  { label: "Formula", value: "formula" },
  { label: "Window", value: "window" },
  { label: "Code expression", value: "codeExpression" }
];
var computedSequence = 0;
function nextComputedId() {
  computedSequence += 1;
  return `computed-ui-${computedSequence}`;
}
function compactDescription(item) {
  if (item.kind === "aggregate") {
    return `${String(item.function || "count").toUpperCase()}(${item.field?.kind === "all" ? "*" : item.field?.path || "field"})`;
  }
  if (item.kind === "scalarSubquery") {
    return `Scalar subquery: ${item.select?.kind === "aggregate" ? item.select.function : item.select?.field?.path || "field"}`;
  }
  if (item.kind === "exists") {
    return "Exists annotation";
  }
  if (item.kind === "window") {
    return `Window: ${item.function || "row_number"}`;
  }
  if (item.kind === "codeExpression") {
    return item.expression ? "Restricted Django expression" : "Restricted Django expression (empty)";
  }
  return `Formula: ${formulaMetrics(item.expression).nodes} node${formulaMetrics(item.expression).nodes === 1 ? "" : "s"}`;
}
function requiresKindConfirmation(item) {
  if (!item?.kind || !item?.nodeId) {
    return false;
  }
  const body = ({ alias: _alias, enabled: _enabled, kind: _kind, nodeId: _nodeId, ...value }) => value;
  return JSON.stringify(body(item)) !== JSON.stringify(body(createComputedDraft(item.kind, item.nodeId, item.alias)));
}
function formulaForwardReferences(recipe, item) {
  if (item.kind !== "formula") {
    return [];
  }
  const index = recipe.computed.findIndex((entry2) => entry2.nodeId === item.nodeId);
  const permitted = new Set(recipe.computed.slice(0, Math.max(0, index)).filter((entry2) => entry2.enabled).map((entry2) => entry2.alias));
  const invalid = /* @__PURE__ */ new Set();
  function visit(node) {
    if (!node || typeof node !== "object") {
      return;
    }
    if (node.kind === "computed" && node.alias && !permitted.has(node.alias)) {
      invalid.add(node.alias);
    }
    if (node.kind === "binary") {
      visit(node.left);
      visit(node.right);
    }
    if (node.kind === "function") {
      (node.args || []).forEach(visit);
    }
    if (node.kind === "case") {
      (node.branches || []).forEach((branch) => visit(branch.then));
      visit(node.else);
    }
    if (node.kind === "cast") {
      visit(node.expression);
    }
  }
  visit(item.expression);
  return [...invalid];
}
function bodyFor(item, options) {
  const scoped = { ...options, scope: options.getScope?.(item) };
  if (item.kind === "aggregate") {
    return renderAggregateBuilder(scoped);
  }
  if (item.kind === "scalarSubquery") {
    return renderSubqueryBuilder(scoped);
  }
  if (item.kind === "exists") {
    return renderExistsComputedBuilder(scoped);
  }
  if (item.kind === "window") {
    return renderWindowBuilder(scoped);
  }
  if (item.kind === "codeExpression") {
    return renderCodeExpressionBuilder(scoped);
  }
  return renderFormulaBuilder(scoped);
}
function createComputedBuilder({ cancelKindChange, confirmKindChange, dispatch, el: el2, getRecipe, getScope, metadata, onOpenChange = () => {
}, openNodeIds = () => [], pendingKinds = () => [], popoverLayer, requestKindChange, validation } = {}) {
  const node = el2("div", { className: "query-computed-builder" });
  const openItems = new Set(openNodeIds());
  let bodyDisposables = [];
  function releaseBodies() {
    for (const dispose of bodyDisposables) {
      dispose();
    }
    bodyDisposables = [];
  }
  function add(kind = "aggregate") {
    const recipe = getRecipe?.() || { computed: [] };
    const nodeId = nextComputedId();
    dispatch?.({ computed: createComputedDraft(kind, nodeId, suggestComputedAlias(kind, recipe.computed)), type: "ADD_COMPUTED" });
    openItems.add(nodeId);
    onOpenChange(nodeId, true);
  }
  function render() {
    const recipe = getRecipe?.() || { computed: [] };
    releaseBodies();
    node.replaceChildren();
    const toolbar = el2("div", { className: "query-computed-toolbar" });
    const kind = el2("select", { ariaLabel: "Computed column kind", className: "query-computed-select" });
    for (const option of COMPUTED_KINDS) {
      kind.appendChild(el2("option", { value: option.value }, option.label));
    }
    const addButton = el2("button", { type: "button" }, "Add calculated value");
    addButton.addEventListener("click", () => add(kind.value));
    toolbar.append(el2("label", {}, "Kind", kind), createControlHelp({ control: kind, el: el2, id: "query-computed-kind-help", text: guidanceForComputedKind(kind.value).description }), addButton);
    kind.addEventListener("change", () => toolbar.querySelector(".query-control-help").textContent = guidanceForComputedKind(kind.value).description);
    node.appendChild(toolbar);
    node.appendChild(createConceptHelp({ el: el2, summary: "Which calculated value should I use?", paragraphs: ["Aggregate summarizes values. Scalar subquery returns one matched value. Exists returns true or false.", "Formula combines values, Window calculates across result rows, and Code expression is the restricted advanced option."] }));
    if (!recipe.computed.length) {
      node.appendChild(el2("p", { className: "query-builder-empty" }, "No computed columns. Add one to annotate, calculate, or select a correlated value."));
      return;
    }
    const list = el2("div", { className: "query-computed-list" });
    recipe.computed.forEach((item, index) => list.appendChild(renderItem(item, index, recipe)));
    node.appendChild(list);
  }
  function currentValidation() {
    return typeof validation === "function" ? validation() : validation;
  }
  function updateValidation() {
    for (const region of node.querySelectorAll("[data-query-computed-issue-node-id]")) {
      renderInlineIssues(region, region.dataset.queryComputedIssueNodeId);
    }
  }
  function renderInlineIssues(region, nodeId) {
    region.id = `query-node-issues-${nodeId}`;
    region.replaceChildren();
    const inline = (currentValidation()?.issues || []).filter((issue) => issue?.nodeId === nodeId);
    for (const issue of inline) {
      region.appendChild(el2("p", { className: "query-node-issue", dataset: { severity: issue.severity || "error" }, role: "note" }, `${issue.severity === "warning" ? "Warning" : "Error"}: ${issue.message || issue.code || "Computed column issue"}`));
    }
  }
  function renderItem(item, index, recipe) {
    const details = el2("details", { className: "query-computed-item", dataset: { queryNodeId: item.nodeId } });
    details.open = openItems.has(item.nodeId);
    details.addEventListener("toggle", () => {
      if (details.open) {
        openItems.add(item.nodeId);
      } else {
        openItems.delete(item.nodeId);
      }
      onOpenChange(item.nodeId, details.open);
    });
    const summary = el2("summary", { title: `${item.alias || "Unnamed computed column"}: ${compactDescription(item)}` });
    const enabled = el2("input", { ariaLabel: `Enable ${item.alias || "computed column"}`, checked: item.enabled, type: "checkbox" });
    enabled.addEventListener("click", (event) => event.stopPropagation());
    enabled.addEventListener("change", () => dispatch?.({ nodeId: item.nodeId, type: "TOGGLE_COMPUTED" }));
    const title = el2("span", { className: "query-computed-item-title" }, item.alias || "Unnamed computed column");
    const description = el2("span", { className: "query-computed-item-description" }, compactDescription(item));
    summary.append(enabled, title, description);
    details.appendChild(summary);
    const content = el2("div", { className: "query-computed-item-content" });
    const header = el2("div", { className: "query-computed-item-header" });
    const alias = el2("input", { ariaLabel: "Computed column alias", autocomplete: "off", className: "query-computed-input", dataset: { queryControlKey: `computed:${item.nodeId}:alias` }, maxLength: 64, name: `computed-${item.nodeId}-alias`, spellcheck: false, value: item.alias || "" });
    alias.addEventListener("input", () => dispatch?.({ changes: { alias: alias.value }, history: { group: `computed:${item.nodeId}:alias`, mode: "text" }, nodeId: item.nodeId, type: "UPDATE_COMPUTED" }));
    const type = el2("select", { ariaLabel: "Computed column type", className: "query-computed-select" });
    for (const option of COMPUTED_KINDS) {
      type.appendChild(el2("option", { value: option.value }, option.label));
    }
    type.value = item.kind;
    type.addEventListener("change", () => {
      if (type.value === item.kind) {
        return;
      }
      const changes = createComputedDraft(type.value, item.nodeId, item.alias);
      if (requiresKindConfirmation(item)) {
        requestKindChange?.(item, type.value);
        type.value = item.kind;
      } else {
        dispatch?.({ changes, nodeId: item.nodeId, type: "UPDATE_COMPUTED" });
      }
    });
    header.append(el2("label", {}, "Alias", alias), el2("label", {}, "Type", type), structuralButton2(el2, "Up", "Move computed column up", () => dispatch?.({ nodeId: item.nodeId, type: "MOVE_COMPUTED_UP" }), index === 0), structuralButton2(el2, "Down", "Move computed column down", () => dispatch?.({ nodeId: item.nodeId, type: "MOVE_COMPUTED_DOWN" }), index === recipe.computed.length - 1), structuralButton2(el2, "Duplicate", "Duplicate computed column", () => dispatch?.({ nodeId: item.nodeId, type: "DUPLICATE_COMPUTED" })), structuralButton2(el2, "Remove", "Remove computed column", () => dispatch?.({ nodeId: item.nodeId, type: "REMOVE_COMPUTED" })));
    content.appendChild(createControlHelp({ control: alias, el: el2, id: `query-alias-help-${item.nodeId}`, text: "Use a Python-style name. Later result filters, formulas, and ordering can refer to it." }));
    content.appendChild(createControlHelp({ control: type, el: el2, id: `query-computed-type-help-${item.nodeId}`, text: guidanceForComputedKind(item.kind).description, technical: guidanceForComputedKind(item.kind).limit }));
    content.appendChild(header);
    const pending = pendingKinds().find((entry2) => entry2.nodeId === item.nodeId);
    if (pending) {
      const confirmation = el2("div", { className: "query-kind-confirmation", role: "alert" });
      const confirm = structuralButton2(el2, "Change type", "Change calculated value type", () => confirmKindChange?.(item, pending.kind));
      const cancel = structuralButton2(el2, "Cancel", "Cancel calculated value type change", () => cancelKindChange?.(item.nodeId));
      confirmation.append(`Changing type will replace this item\u2019s configured fields. `, confirm, cancel);
      content.appendChild(confirmation);
    }
    if (summaryUnavailable(recipe, item)) {
      content.appendChild(el2("p", { className: "query-node-issue", role: "note" }, "This computed column is unavailable in Summary mode; use an Aggregate column or switch to Rows mode."));
    }
    const forward = formulaForwardReferences(recipe, item);
    if (forward.length) {
      content.appendChild(el2("p", { className: "query-node-issue", role: "note" }, `Formula aliases must come from enabled columns above: ${forward.join(", ")}.`));
    }
    const issueRegion = el2("div", { className: "query-computed-issues", dataset: { queryComputedIssueNodeId: item.nodeId } });
    renderInlineIssues(issueRegion, item.nodeId);
    content.appendChild(issueRegion);
    const body = bodyFor(item, { dispatch, el: el2, getRecipe, getScope, item, metadata, popoverLayer, validation });
    if (body.__queryDestroy) {
      bodyDisposables.push(body.__queryDestroy);
    }
    content.appendChild(body);
    content.appendChild(createMeaningLine({ el: el2, explanation: explainComputedColumn(item), id: `query-computed-meaning-${item.nodeId}` }));
    details.appendChild(content);
    return details;
  }
  render();
  return { add, destroy: releaseBodies, node, render, updateValidation };
}
function structuralButton2(el2, label, ariaLabel, onClick, disabled = false) {
  const button2 = el2("button", { ariaLabel, className: "secondary", type: "button" }, label);
  button2.disabled = disabled;
  button2.addEventListener("click", onClick);
  return button2;
}

// media/gridQueryLifecycle.js
function createValidationLifecycle() {
  return { issues: [], phase: "idle", requestId: "", revision: 0, warnings: [] };
}
function createApplyLifecycle() {
  return { phase: "idle", revision: 0 };
}
function matchesRevision(state2, event) {
  return Number.isSafeInteger(event.revision) && event.revision === state2.revision;
}
function validationPayload(validation) {
  const issues = Array.isArray(validation?.issues) ? validation.issues.map((issue) => ({ ...issue })) : [];
  const warnings = Array.isArray(validation?.warnings) ? validation.warnings.map((issue) => ({ ...issue })) : issues.filter((issue) => issue?.severity === "warning");
  return { issues, warnings };
}
function transitionValidation(state2 = createValidationLifecycle(), event = {}) {
  if (event.type === "SOURCE_CHANGED") {
    return { ...createValidationLifecycle(), revision: Number.isSafeInteger(event.revision) ? event.revision : 0 };
  }
  if (event.type === "DRAFT_CHANGED") {
    return { issues: [], phase: "pending", requestId: "", revision: event.revision, warnings: [] };
  }
  if (event.type === "PREVIEW_TIMER_FIRED" && matchesRevision(state2, event)) {
    return { ...state2, phase: "previewing", requestId: String(event.requestId || "") };
  }
  if (event.type === "PREVIEW_ACCEPTED" && matchesRevision(state2, event) && (!state2.requestId || state2.requestId === event.requestId)) {
    const payload = validationPayload(event.validation);
    return { ...state2, ...payload, phase: payload.issues.some((issue) => issue?.severity !== "warning") ? "invalid" : "ready" };
  }
  if (event.type === "PREVIEW_REJECTED" && matchesRevision(state2, event) && (!state2.requestId || state2.requestId === event.requestId)) {
    const payload = validationPayload({ issues: event.issues, warnings: [] });
    return { ...state2, ...payload, phase: "invalid" };
  }
  return state2;
}
function transitionApply(state2 = createApplyLifecycle(), event = {}) {
  if (event.type === "SOURCE_CHANGED") {
    return createApplyLifecycle();
  }
  if (event.type === "APPLY_STARTED") {
    return { phase: "applying", revision: event.revision };
  }
  if (!matchesRevision(state2, event)) {
    return state2;
  }
  if (event.type === "APPLY_ACCEPTED") {
    return { ...state2, phase: "loadingResults" };
  }
  if (event.type === "RESULTS_ACCEPTED") {
    return { phase: "idle", revision: state2.revision };
  }
  if (event.type === "APPLY_REJECTED" || event.type === "RESULTS_FAILED") {
    return { ...state2, phase: "failed" };
  }
  return state2;
}
function validationAllowsApply(state2, revision) {
  return state2?.phase === "ready" && state2.revision === revision;
}

// media/gridQueryFocus.js
function controlSelector(key) {
  const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(String(key || "")) : String(key || "").replace(/[^A-Za-z0-9_-]/g, "\\$&");
  return `[data-query-control-key="${escaped}"]`;
}
function captureQueryFocus(root = document) {
  const active = root.activeElement || document.activeElement;
  if (!active?.closest?.("[data-query-builder-root]")) {
    return void 0;
  }
  const key = active.dataset?.queryControlKey;
  if (!key) {
    return void 0;
  }
  return {
    direction: typeof active.selectionDirection === "string" ? active.selectionDirection : void 0,
    end: Number.isInteger(active.selectionEnd) ? active.selectionEnd : void 0,
    key,
    start: Number.isInteger(active.selectionStart) ? active.selectionStart : void 0
  };
}
function restoreQueryFocus(root, target, { reveal = false } = {}) {
  const key = target?.key || target?.controlKey;
  if (!key) {
    return false;
  }
  const control = root?.querySelector?.(controlSelector(key));
  if (!control?.focus) {
    return false;
  }
  if (reveal) {
    control.scrollIntoView?.({ block: "nearest" });
  }
  control.focus({ preventScroll: !reveal });
  if (Number.isInteger(target.start) && Number.isInteger(target.end) && typeof control.setSelectionRange === "function") {
    control.setSelectionRange(target.start, target.end, target.direction);
  }
  return true;
}
function createQueryFocusIntent() {
  let pending;
  return {
    /** Returns and clears the current explicit focus target. */
    consume() {
      const value = pending;
      pending = void 0;
      return value;
    },
    /** Stores one structural or issue-navigation focus target. */
    set(intent) {
      pending = intent && intent.controlKey ? { ...intent } : void 0;
    }
  };
}

// media/gridQueryDrawerResize.js
function clampHeight(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.round(Number(value) || minimum)));
}
function createQueryDrawerResize({ drawer, handle, onHeight, root = document } = {}) {
  let dragging = false;
  let startHeight = 0;
  let startY = 0;
  function bounds() {
    const viewport = Math.max(440, root.defaultView?.innerHeight || window.innerHeight || 800);
    return { maximum: Math.max(320, Math.min(660, viewport - 180)), minimum: 220 };
  }
  function setHeight(value, draggingUpdate = false) {
    const range = bounds();
    const height = clampHeight(value, range.minimum, range.maximum);
    drawer.style.height = `${height}px`;
    handle.setAttribute("aria-valuemin", String(range.minimum));
    handle.setAttribute("aria-valuemax", String(range.maximum));
    handle.setAttribute("aria-valuenow", String(height));
    onHeight?.(height, draggingUpdate, range);
  }
  function finishPointer() {
    if (!dragging) {
      return;
    }
    dragging = false;
    handle.removeAttribute("data-dragging");
    root.removeEventListener("pointermove", movePointer);
    root.removeEventListener("pointerup", finishPointer);
    root.removeEventListener("pointercancel", finishPointer);
  }
  function movePointer(event) {
    if (!dragging) {
      return;
    }
    setHeight(startHeight + (startY - event.clientY), true);
  }
  function startPointer(event) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragging = true;
    startY = event.clientY;
    startHeight = drawer.getBoundingClientRect().height;
    handle.dataset.dragging = "true";
    handle.setPointerCapture?.(event.pointerId);
    root.addEventListener("pointermove", movePointer);
    root.addEventListener("pointerup", finishPointer);
    root.addEventListener("pointercancel", finishPointer);
  }
  function onKeyDown(event) {
    const current = drawer.getBoundingClientRect().height;
    const range = bounds();
    const increment = event.shiftKey ? 48 : 16;
    const next = event.key === "ArrowUp" ? current + increment : event.key === "ArrowDown" ? current - increment : event.key === "Home" ? range.minimum : event.key === "End" ? range.maximum : void 0;
    if (next === void 0) {
      return;
    }
    event.preventDefault();
    setHeight(next);
  }
  handle.addEventListener("pointerdown", startPointer);
  handle.addEventListener("keydown", onKeyDown);
  return {
    /** Removes all local and transient document listeners. */
    destroy() {
      finishPointer();
      handle.removeEventListener("pointerdown", startPointer);
      handle.removeEventListener("keydown", onKeyDown);
    },
    /** Synchronizes a restored persisted height after the drawer opens. */
    setHeight(value) {
      setHeight(value);
    }
  };
}

// media/gridQueryRenderCoordinator.js
function createQueryRenderCoordinator({ captureFocus = () => void 0, getModel, regions = [], restoreFocus = () => {
}, schedule = queueMicrotask } = {}) {
  const signatures = /* @__PURE__ */ new Map();
  const reasons = /* @__PURE__ */ new Set();
  let destroyed = false;
  let queued = false;
  function flush() {
    queued = false;
    if (destroyed) {
      return;
    }
    const model = getModel?.();
    const focus = captureFocus?.();
    const requestReasons = [...reasons];
    reasons.clear();
    try {
      for (const region of regions) {
        const signature = region.signature?.(model);
        if (signatures.get(region.id) === signature) {
          continue;
        }
        region.update?.(model);
        signatures.set(region.id, signature);
      }
    } finally {
      restoreFocus?.(focus, model, requestReasons);
    }
  }
  return {
    /** Releases every region and prevents further scheduled writes. */
    destroy() {
      destroyed = true;
      reasons.clear();
      for (const region of regions) {
        region.destroy?.();
      }
    },
    /** Forces an immediate coherent render for initialization and tests. */
    flush,
    /** Coalesces one rendering reason into the next microtask. */
    request(reason = "unknown") {
      if (destroyed) {
        return;
      }
      reasons.add(reason);
      if (!queued) {
        queued = true;
        schedule(flush);
      }
    }
  };
}

// media/gridQueryUiState.js
var STAGES = /* @__PURE__ */ new Set(["filterRows", "calculatedValues", "filterResults", "result"]);
var INSPECTOR_TABS = /* @__PURE__ */ new Set(["meaning", "problems", "orm"]);
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}
function stage(value) {
  return STAGES.has(value) ? value : "filterRows";
}
function inspectorTab(value) {
  return INSPECTOR_TABS.has(value) ? value : "meaning";
}
function copy(value) {
  return JSON.parse(JSON.stringify(value));
}
function initialState(persisted = {}, bounds = {}) {
  const minimum = Number.isFinite(bounds.minimumHeight) ? bounds.minimumHeight : 220;
  const maximum = Number.isFinite(bounds.maximumHeight) ? bounds.maximumHeight : 620;
  const drawerHeight = clamp(persisted.queryDrawerHeight, minimum, maximum);
  return {
    activeStage: stage(persisted.queryActiveStage),
    drawerHeight,
    drawerOpen: Boolean(persisted.queryDrawerOpen),
    focusMode: false,
    inspectorScrollTops: { meaning: 0, orm: 0, problems: 0 },
    inspectorTab: inspectorTab(persisted.queryInspectorTab),
    lastFocusedControlKey: "",
    mobilePane: "editor",
    openComputedNodeIds: /* @__PURE__ */ new Set(),
    openGroupNodeIds: /* @__PURE__ */ new Set(),
    openHelpIds: /* @__PURE__ */ new Set(),
    pendingComputedKinds: /* @__PURE__ */ new Map(),
    pendingResultMode: "",
    selectedNodeId: "",
    stageScrollTops: { calculatedValues: 0, filterResults: 0, filterRows: 0, result: 0 }
  };
}
function preferences(state2) {
  return {
    queryActiveStage: state2.activeStage,
    queryDrawerHeight: state2.drawerHeight,
    queryDrawerOpen: state2.drawerOpen,
    queryInspectorTab: state2.inspectorTab
  };
}
function snapshotOf(state2) {
  return {
    ...state2,
    inspectorScrollTops: { ...state2.inspectorScrollTops },
    openComputedNodeIds: [...state2.openComputedNodeIds].sort(),
    openGroupNodeIds: [...state2.openGroupNodeIds].sort(),
    openHelpIds: [...state2.openHelpIds].sort(),
    pendingComputedKinds: [...state2.pendingComputedKinds].map(([nodeId, kind]) => ({ kind, nodeId })),
    stageScrollTops: { ...state2.stageScrollTops }
  };
}
function createQueryUiState({ bounds, getPersisted = () => ({}), persist = () => {
} } = {}) {
  let heightBounds = { maximumHeight: 620, minimumHeight: 220, ...bounds };
  let state2 = initialState(getPersisted() || {}, heightBounds);
  const listeners = /* @__PURE__ */ new Set();
  let persistTimer = 0;
  function publish() {
    const value = snapshotOf(state2);
    for (const listener of listeners) {
      listener(value);
    }
  }
  function writePreferences() {
    persistTimer = 0;
    persist(preferences(state2));
  }
  function schedulePersistence(delay = 0) {
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    if (!delay) {
      writePreferences();
      return;
    }
    persistTimer = setTimeout(writePreferences, delay);
  }
  function toggle(collection, nodeId, open) {
    if (!nodeId) {
      return;
    }
    if (open) {
      collection.add(nodeId);
    } else {
      collection.delete(nodeId);
    }
  }
  function dispatch(action = {}) {
    const type = action.type;
    if (type === "SET_ACTIVE_STAGE") {
      state2.activeStage = stage(action.stage);
      state2.mobilePane = "editor";
      schedulePersistence();
    } else if (type === "SET_DRAWER_OPEN") {
      state2.drawerOpen = Boolean(action.open);
      schedulePersistence();
    } else if (type === "SET_DRAWER_HEIGHT") {
      state2.drawerHeight = clamp(action.height, heightBounds.minimumHeight, heightBounds.maximumHeight);
      schedulePersistence(action.dragging ? 150 : 0);
    } else if (type === "SET_FOCUS_MODE") {
      state2.focusMode = Boolean(action.enabled);
    } else if (type === "SET_INSPECTOR_TAB") {
      state2.inspectorTab = inspectorTab(action.tab);
      state2.mobilePane = "review";
      schedulePersistence();
    } else if (type === "SET_MOBILE_PANE") {
      state2.mobilePane = action.pane === "review" ? "review" : "editor";
    } else if (type === "SET_SELECTED_NODE") {
      state2.selectedNodeId = String(action.nodeId || "");
    } else if (type === "SET_LAST_FOCUSED_CONTROL") {
      state2.lastFocusedControlKey = String(action.key || "");
    } else if (type === "SET_STAGE_SCROLL") {
      state2.stageScrollTops = { ...state2.stageScrollTops, [stage(action.stage)]: Math.max(0, Number(action.top) || 0) };
    } else if (type === "SET_INSPECTOR_SCROLL") {
      state2.inspectorScrollTops = { ...state2.inspectorScrollTops, [inspectorTab(action.tab)]: Math.max(0, Number(action.top) || 0) };
    } else if (type === "SET_COMPUTED_OPEN") {
      toggle(state2.openComputedNodeIds, action.nodeId, action.open);
    } else if (type === "SET_GROUP_OPEN") {
      toggle(state2.openGroupNodeIds, action.nodeId, action.open);
    } else if (type === "SET_HELP_OPEN") {
      toggle(state2.openHelpIds, action.helpId, action.open);
    } else if (type === "SET_PENDING_COMPUTED_KIND") {
      if (action.nodeId && action.kind) {
        state2.pendingComputedKinds.set(action.nodeId, action.kind);
      }
    } else if (type === "CLEAR_PENDING_COMPUTED_KIND") {
      state2.pendingComputedKinds.delete(action.nodeId);
    } else if (type === "SET_PENDING_RESULT_MODE") {
      state2.pendingResultMode = action.mode === "summary" || action.mode === "rows" ? action.mode : "";
    } else if (type === "CLEAR_PENDING_RESULT_MODE") {
      state2.pendingResultMode = "";
    } else if (type === "RESET_TRANSIENT_FOR_SOURCE") {
      const next = initialState(getPersisted() || {}, heightBounds);
      next.drawerOpen = state2.drawerOpen;
      next.drawerHeight = state2.drawerHeight;
      state2 = next;
    } else {
      return;
    }
    publish();
  }
  return {
    /** Releases pending persistence work. */
    destroy() {
      if (persistTimer) {
        clearTimeout(persistTimer);
      }
      listeners.clear();
    },
    /** Updates the current height clamp without changing the selected UI mode. */
    setBounds(nextBounds = {}) {
      heightBounds = { ...heightBounds, ...nextBounds };
      state2.drawerHeight = clamp(state2.drawerHeight, heightBounds.minimumHeight, heightBounds.maximumHeight);
      publish();
    },
    /** Returns a detached UI snapshot. */
    getSnapshot() {
      return copy(snapshotOf(state2));
    },
    /** Applies one documented UI-only action. */
    dispatch,
    /** Registers one UI observer. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

// media/gridQueryStageNav.js
function installQueryRovingTabs(items, select) {
  items.forEach((item, index) => item.button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const target = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    select(items[target].value);
    items[target].button.focus();
  }));
}

// media/gridQueryWorkspace.js
function createQueryWorkspace({ drawerResize, element: element3, elements, root, uiState }) {
  const stageSections = {
    calculatedValues: [elements.queryCalculatedValuesPanel, elements.queryStageCalculatedValues],
    filterResults: [elements.queryFilterResultsPanel, elements.queryStageFilterResults],
    filterRows: [elements.queryFilterRowsPanel, elements.queryStageFilterRows],
    result: [elements.queryResultPanel, elements.queryStageResult]
  };
  const sectionStages = { queryComputedSection: "calculatedValues", queryPostFilterSection: "filterResults", queryResultSection: "result", queryWhereSection: "filterRows" };
  function render(ui) {
    elements.queryDrawer.style.height = `${ui.drawerHeight}px`;
    elements.queryDrawer.classList.toggle("query-focus-mode", ui.focusMode);
    elements.queryFocusMode.setAttribute("aria-pressed", String(ui.focusMode));
    elements.queryFocusMode.textContent = ui.focusMode ? "Exit Focus Builder" : "Focus Builder";
    elements.queryStageSelect.value = ui.activeStage;
    for (const [name, [section, tab]] of Object.entries(stageSections)) {
      const selected = name === ui.activeStage;
      if (section) {
        section.hidden = !selected;
        section.inert = !selected;
        section.setAttribute("aria-hidden", String(!selected));
      }
      if (tab) {
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
    }
    const reviewTabs = { meaning: elements.queryInspectorMeaning, orm: elements.queryInspectorOrm, problems: elements.queryInspectorProblems };
    for (const [name, tab] of Object.entries(reviewTabs)) {
      const selected = name === ui.inspectorTab;
      if (tab) {
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
    }
    const reviewPanels = { meaning: elements.queryMeaningPanel, orm: elements.queryOrmPanel, problems: elements.queryProblemsPanel };
    for (const [name, panel] of Object.entries(reviewPanels)) {
      if (!panel) {
        continue;
      }
      const selected = name === ui.inspectorTab;
      panel.hidden = !selected;
      panel.inert = !selected;
      panel.setAttribute("aria-hidden", String(!selected));
    }
    renderMobilePane(ui);
    if (elements.queryEditorPane && Number.isFinite(ui.stageScrollTops?.[ui.activeStage])) {
      elements.queryEditorPane.scrollTop = ui.stageScrollTops[ui.activeStage];
    }
    if (elements.queryPreviewSection && Number.isFinite(ui.inspectorScrollTops?.[ui.inspectorTab])) {
      elements.queryPreviewSection.scrollTop = ui.inspectorScrollTops[ui.inspectorTab];
    }
  }
  function renderMobilePane(ui) {
    const switcher = elements.queryMobilePaneSwitch;
    if (!switcher) {
      return;
    }
    if (switcher.parentElement !== elements.queryWorkspace) {
      elements.queryWorkspace.insertBefore(switcher, elements.queryEditorPane);
    }
    switcher.hidden = false;
    switcher.replaceChildren(...["editor", "review"].map((pane) => {
      const button2 = element3("button", { ariaPressed: String(ui.mobilePane === pane), className: "secondary", type: "button" }, pane === "editor" ? "Edit query" : "Review query");
      button2.addEventListener("click", () => uiState.dispatch({ pane, type: "SET_MOBILE_PANE" }));
      return button2;
    }));
    elements.queryWorkspace.dataset.mobilePane = ui.mobilePane;
  }
  function open(section, { focus = true } = {}) {
    elements.queryDrawer.hidden = false;
    elements.queryDrawerToggle.setAttribute("aria-expanded", "true");
    uiState.dispatch({ open: true, type: "SET_DRAWER_OPEN" });
    drawerResize.setHeight(uiState.getSnapshot().drawerHeight);
    if (sectionStages[section]) {
      uiState.dispatch({ stage: sectionStages[section], type: "SET_ACTIVE_STAGE" });
    }
    if (focus) {
      window.setTimeout(() => elements[section]?.querySelector("button,input,select,textarea")?.focus(), 0);
    }
  }
  function close() {
    elements.queryDrawer.hidden = true;
    elements.queryDrawerToggle.setAttribute("aria-expanded", "false");
    uiState.dispatch({ open: false, type: "SET_DRAWER_OPEN" });
    elements.queryDrawerToggle.focus();
  }
  return { close, installRovingTabs: installQueryRovingTabs, open, render };
}

// media/gridQueryIssueTarget.js
function stageForQueryIssue(issue = {}) {
  const path = String(issue.path || issue.controlKey || "");
  if (path.includes("postFilter") || path.includes("having")) {
    return "filterResults";
  }
  if (path.includes("computed") || path.includes("annotation") || path.includes("subquery") || path.includes("formula")) {
    return "calculatedValues";
  }
  if (path.includes("groupBy") || path.includes("orderBy") || path.includes("mode") || path.includes("result")) {
    return "result";
  }
  return "filterRows";
}

// media/gridQueryStageSelectors.js
function predicateCount(group) {
  let count = 0;
  for (const node of group?.children || []) {
    count += 1;
    if (node.kind === "group") {
      count += predicateCount(node);
    }
    if (node.kind === "existsPredicate") {
      count += predicateCount(node.where);
    }
  }
  return count;
}
function queryStageCounts(recipe = {}) {
  return {
    calculatedValues: Array.isArray(recipe.computed) ? recipe.computed.length : 0,
    filterResults: predicateCount(recipe.postFilter),
    filterRows: predicateCount(recipe.where),
    result: (Array.isArray(recipe.groupBy) ? recipe.groupBy.filter((item) => item?.path || item?.alias).length : 0) + (Array.isArray(recipe.orderBy) ? recipe.orderBy.filter((item) => item?.ref?.path || item?.ref?.alias).length : 0)
  };
}
function stageLabel(stage2, count) {
  const labels = { calculatedValues: "Calculated Values", filterResults: "Filter Results", filterRows: "Filter Rows", result: "Result" };
  return `${labels[stage2] || labels.filterRows}${count ? ` (${count})` : ""}`;
}

// media/gridQueryInspector.js
function renderQueryInspector({ element: element3, elements, recipe, root, scope, validation }) {
  const paragraphs = [explainPredicateGroup(recipe.where, { root: true }).text];
  const enabled = (recipe.computed || []).filter((item) => item?.enabled);
  if (enabled.length) {
    paragraphs.push(`Add ${enabled.map((item) => `\`${item.alias || item.kind}\``).join(", ")}.`);
  }
  const post = explainPredicateGroup(recipe.postFilter, { postFilter: true, root: true });
  if (recipe.postFilter?.children?.length) {
    paragraphs.push(post.text);
  }
  paragraphs.push(explainResult(recipe, { fields: Object.fromEntries(scope.columns.map((field) => [field.attname || field.name, field])) }).text);
  elements.queryPlainMeaning.replaceChildren(...paragraphs.map((text) => explanationParagraph(element3, text)));
  const transport = root.getElementById("transport")?.value || "auto";
  const implicit = explainImplicitBehavior(recipe, validation, { transport: transport === "orm" ? "the ORM link" : transport === "tcp" ? "the socket link" : "the active link" });
  elements.queryImplicitBehavior.replaceChildren();
  if (implicit.length) {
    elements.queryImplicitBehavior.append(element3("h3", {}, "The builder will also"), element3("ul", { className: "query-implicit-behavior" }, ...implicit.map((text) => element3("li", {}, text))));
  }
}
function explanationParagraph(element3, text) {
  const paragraph = element3("p");
  for (const token of queryExplanationTokens(text)) {
    paragraph.appendChild(element3(token.kind === "code" ? "code" : "span", {}, token.value));
  }
  return paragraph;
}
async function copyQueryOrmPreview(root = document) {
  const text = root.getElementById("queryOrmPreview")?.textContent || "";
  const orm = text.includes("Django ORM\n") ? text.split("Django ORM\n").slice(1).join("Django ORM\n") : "";
  if (!orm || !navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(orm);
    return true;
  } catch {
    return false;
  }
}

// media/gridQueryResultBuilder.js
var MAX_OUTER_ORDER_TERMS = 8;
function queryReferenceKey(ref) {
  if (ref?.kind === "computed") {
    return `computed:${String(ref.alias || "")}`;
  }
  return `field:${String(ref?.path || "")}`;
}
function outerOrderIssues(terms) {
  const issues = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [index, term] of (Array.isArray(terms) ? terms : []).entries()) {
    const key = queryReferenceKey(term?.ref);
    if (!term?.ref || !key.slice(key.indexOf(":") + 1)) {
      issues.push(resultIssue("ORDER_REFERENCE_REQUIRED", `Choose a field or computed column for order term ${index + 1}.`, term?.nodeId, `/orderBy/${index}/ref`));
    } else if (seen.has(key)) {
      issues.push(resultIssue("ORDER_REFERENCE_DUPLICATE", "Use each outer order reference only once.", term?.nodeId, `/orderBy/${index}/ref`));
    }
    seen.add(key);
    if (term?.direction !== "asc" && term?.direction !== "desc") {
      issues.push(resultIssue("ORDER_DIRECTION_REQUIRED", "Choose ascending or descending order.", term?.nodeId, `/orderBy/${index}/direction`));
    }
  }
  if ((terms || []).length > MAX_OUTER_ORDER_TERMS) {
    issues.push(resultIssue("ORDER_TERM_LIMIT", `Use at most ${MAX_OUTER_ORDER_TERMS} outer order terms.`, void 0, "/orderBy"));
  }
  return issues;
}
function resultCountLabel(recipe, count) {
  const value = Number(count) || 0;
  if (recipe?.mode !== "summary") {
    return `${value} row${value === 1 ? "" : "s"}`;
  }
  if (!(recipe.groupBy || []).length) {
    return "1 summary row";
  }
  return `${value} group${value === 1 ? "" : "s"}`;
}
function mergeRecipeIssues(...groups) {
  const merged = [];
  const seen = /* @__PURE__ */ new Set();
  for (const group of groups) {
    for (const issue of Array.isArray(group) ? group : []) {
      if (!issue || typeof issue !== "object") {
        continue;
      }
      const key = `${issue.code || ""}\0${issue.nodeId || ""}\0${issue.path || ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(issue);
    }
  }
  return merged;
}
function recipeLogLabel(action, meta) {
  if (!meta || typeof meta !== "object") {
    return action;
  }
  const revision = Number.isSafeInteger(meta.revision) ? `Recipe rev ${meta.revision}` : "Recipe";
  const summary = typeof meta.summary === "string" && meta.summary.trim() ? ` \xB7 ${meta.summary.trim()}` : "";
  return `${action} \xB7 ${revision}${summary}`;
}
function resultIssue(code, fix, nodeId, path) {
  return { code, fix, message: code.toLowerCase().replaceAll("_", " "), nodeId, path, severity: "error" };
}

// media/gridQueryStableListKeys.js
function stableListEntrySignature(entry2 = {}) {
  if (entry2.kind === "computed" || entry2.alias) {
    return `computed:${String(entry2.alias || "")}`;
  }
  return `field:${String(entry2.path || "")}`;
}
function createStableListKeyReconciler(prefix = "entry") {
  let sequence = 0;
  let previous = [];
  function lcsPairs(left, right) {
    const table = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
    for (let leftIndex2 = left.length - 1; leftIndex2 >= 0; leftIndex2 -= 1) {
      for (let rightIndex2 = right.length - 1; rightIndex2 >= 0; rightIndex2 -= 1) {
        table[leftIndex2][rightIndex2] = left[leftIndex2] === right[rightIndex2] ? table[leftIndex2 + 1][rightIndex2 + 1] + 1 : Math.max(table[leftIndex2 + 1][rightIndex2], table[leftIndex2][rightIndex2 + 1]);
      }
    }
    const pairs = [];
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < left.length && rightIndex < right.length) {
      if (left[leftIndex] === right[rightIndex]) {
        pairs.push([leftIndex, rightIndex]);
        leftIndex += 1;
        rightIndex += 1;
      } else if (table[leftIndex + 1][rightIndex] >= table[leftIndex][rightIndex + 1]) {
        leftIndex += 1;
      } else {
        rightIndex += 1;
      }
    }
    return pairs;
  }
  function reconcile(entries2 = []) {
    const next = entries2.map((entry2) => ({ entry: entry2, signature: stableListEntrySignature(entry2) }));
    const keys = Array(next.length);
    const usedPrevious = /* @__PURE__ */ new Set();
    for (const [beforeIndex, nextIndex] of lcsPairs(previous.map((item) => item.signature), next.map((item) => item.signature))) {
      keys[nextIndex] = previous[beforeIndex].key;
      usedPrevious.add(beforeIndex);
    }
    for (let nextIndex = 0; nextIndex < next.length; nextIndex += 1) {
      if (keys[nextIndex]) {
        continue;
      }
      const matchingIndex = previous.findIndex((item, beforeIndex) => !usedPrevious.has(beforeIndex) && item.signature === next[nextIndex].signature);
      if (matchingIndex >= 0) {
        keys[nextIndex] = previous[matchingIndex].key;
        usedPrevious.add(matchingIndex);
        continue;
      }
      if (previous[nextIndex] && !usedPrevious.has(nextIndex)) {
        keys[nextIndex] = previous[nextIndex].key;
        usedPrevious.add(nextIndex);
        continue;
      }
      sequence += 1;
      keys[nextIndex] = `${prefix}-${sequence}`;
    }
    previous = next.map((item, index) => ({ key: keys[index], signature: item.signature }));
    return keys;
  }
  return { reconcile };
}

// media/gridQueryResultControls.js
function resultReferenceOptions(fields3 = [], computed = []) {
  return [...fields3.map((field) => ({ group: "Fields", label: field.label, value: field.path })), ...computed.filter((item) => item?.enabled).map((item) => ({ group: "Calculated values", label: `calculated value ${item.alias}`, value: `@${item.alias}` }))];
}
function createQueryResultControls({ dispatch, el: el2, groupByMount, orderByMount, popoverLayer, replaceGroupBy } = {}) {
  let pickers = [];
  const groupByKeys = createStableListKeyReconciler("result-group");
  function dispose() {
    for (const picker2 of pickers) {
      picker2.destroy();
    }
    pickers = [];
  }
  function picker(entries2, current, label, onChange, key) {
    const control = createGridCombobox({ dataset: { queryControlKey: key }, el: el2, label, onChange, options: [{ label: "Choose field", value: "" }, ...entries2], popoverLayer, value: entries2.some((entry2) => entry2.value === current) ? current : "" });
    pickers.push(control);
    return control.node;
  }
  function render(recipe, fields3 = []) {
    dispose();
    while (groupByMount.children.length > 1) {
      groupByMount.lastElementChild.remove();
    }
    const direct = fields3.map((field) => ({ group: "Fields", label: field.label, value: field.path }));
    if (recipe.mode === "summary") {
      const groupKeys = groupByKeys.reconcile(recipe.groupBy);
      const grouping = el2("fieldset", { className: "query-result-row" });
      grouping.append(el2("legend", {}, "One summary row per value"), el2("p", { className: "query-control-help" }, recipe.groupBy.length ? "The query returns one summary row for each unique combination of the selected fields." : "No group field is selected. The query returns one global summary row."));
      for (const [index, item] of recipe.groupBy.entries()) {
        const reference = picker(direct, item.path, "Summary group field", (path) => replaceGroupBy(recipe, index, path), groupKeys[index]);
        const remove = el2("button", { ariaLabel: "Remove group field", className: "secondary", type: "button" }, "Remove");
        remove.addEventListener("click", () => dispatch({ index, type: "REMOVE_GROUP_BY" }));
        grouping.append(reference, remove);
      }
      const add = el2("button", { className: "secondary", type: "button" }, "Add group field");
      add.disabled = recipe.groupBy.length >= 8;
      add.addEventListener("click", () => dispatch({ type: "ADD_GROUP_BY" }));
      grouping.appendChild(add);
      groupByMount.appendChild(grouping);
    }
    orderByMount.replaceChildren();
    const order = el2("fieldset", { className: "query-result-row" });
    order.append(el2("legend", {}, "Result order"), el2("p", { className: "query-control-help" }, recipe.orderBy.length ? "Choose the order used for the returned results." : recipe.mode === "summary" ? "No order is selected. The database\u2019s summary order is not guaranteed." : "No order is selected. Rows use the primary key ascending."));
    const references = resultReferenceOptions(fields3, recipe.computed);
    for (const term of recipe.orderBy) {
      let selected = term.ref?.kind === "computed" ? `@${term.ref.alias}` : term.ref?.path || "";
      const direction = el2("select", { ariaLabel: "Order direction", dataset: { queryControlKey: `result-order-direction-${term.nodeId}` } }, el2("option", { value: "asc" }, "Ascending"), el2("option", { value: "desc" }, "Descending"));
      direction.value = term.direction || "asc";
      const update = () => dispatch({ changes: { direction: direction.value, ref: selected.startsWith("@") ? { alias: selected.slice(1), kind: "computed" } : { kind: "field", path: selected } }, nodeId: term.nodeId, type: "UPDATE_ORDER" });
      const reference = picker(references, selected, "Order field", (path) => {
        selected = path;
        update();
      }, `result-order-${term.nodeId}`);
      direction.addEventListener("change", update);
      const remove = el2("button", { ariaLabel: "Remove order term", className: "secondary", dataset: { queryControlKey: `result-order-remove-${term.nodeId}` }, type: "button" }, "Remove");
      remove.addEventListener("click", () => dispatch({ nodeId: term.nodeId, type: "REMOVE_ORDER" }));
      order.append(reference, direction, remove);
    }
    const addOrder = el2("button", { className: "secondary", type: "button" }, "Add order");
    addOrder.disabled = recipe.orderBy.length >= 8;
    addOrder.addEventListener("click", () => dispatch({ type: "ADD_ORDER" }));
    order.appendChild(addOrder);
    orderByMount.appendChild(order);
  }
  return { destroy: dispose, render };
}

// media/gridQuerySummary.js
function countPredicateNodes(group) {
  return (group?.children || []).reduce((count, node) => count + 1 + (node.kind === "group" ? countPredicateNodes(node) : node.kind === "existsPredicate" ? countPredicateNodes(node.where) : 0), 0);
}
function describeQueryRecipe(recipe) {
  const where = predicateSummary(recipe?.where, true);
  const computed = computedSummary(recipe?.computed);
  const result = resultSummary(recipe);
  return [where, computed, result].filter(Boolean).join(" \xB7 ");
}
function renderRecipeNarrative(recipe) {
  return `Recipe: ${describeQueryRecipe(recipe)}`;
}
function renderRecipePreview(recipe, ormPreview) {
  const narrative = renderRecipeNarrative(recipe);
  return typeof ormPreview === "string" && ormPreview.trim() ? `${narrative}

Django ORM
${ormPreview.trim()}` : narrative;
}
function renderQuerySummary(elements, snapshot) {
  const recipe = snapshot?.draft;
  const filterCount = countPredicateNodes(recipe?.where);
  const columnCount = (recipe?.computed || []).filter((item) => item.enabled).length;
  const text = describeQueryRecipe(recipe);
  elements.queryFilterButton.textContent = `Filter ${filterCount}`;
  elements.queryColumnsButton.textContent = `Columns ${columnCount}`;
  elements.queryModeButton.textContent = recipe?.mode === "summary" ? "Summary" : "Rows";
  elements.queryHumanSummary.textContent = text;
  elements.queryHumanSummary.title = text;
  elements.queryDirtyState.hidden = !snapshot?.dirty;
}
function predicateSummary(group, root = false) {
  const children = Array.isArray(group?.children) ? group.children : [];
  if (!children.length) {
    return root ? "All rows" : "all rows";
  }
  const join = group?.join === "or" ? " OR " : " AND ";
  const body = children.map(predicateNodeSummary).join(join);
  const parenthesized = children.length > 1 ? `(${body})` : body;
  return group?.negated ? `NOT ${parenthesized}` : parenthesized;
}
function predicateNodeSummary(node) {
  if (node?.kind === "group") {
    return predicateSummary(node);
  }
  if (node?.kind === "existsPredicate") {
    const source = node.source?.kind === "relation" ? node.source.relation : `${node.source?.app || "?"}.${node.source?.model || "?"}`;
    const correlation = Array.isArray(node.correlations) && node.correlations.length ? ` correlated by ${node.correlations.map((item) => `${item.outerPath}=${item.targetPath}`).join(", ")}` : "";
    const text = `EXISTS ${source}${correlation} where ${predicateSummary(node.where)}`;
    return node.negated ? `NOT (${text})` : text;
  }
  if (node?.kind === "comparison") {
    if (node.lookup === "isnull") {
      return `${referenceSummary(node.lhs)} ${isNullSummary(node)}`;
    }
    const text = `${referenceSummary(node.lhs)} ${String(node.lookup || "exact")} ${valueSummary(node.rhs)}`;
    return node.negated ? `NOT (${text})` : text;
  }
  return "invalid condition";
}
function isNullSummary(node) {
  return Boolean(node?.rhs?.value) !== Boolean(node?.negated) ? "is null" : "has a value";
}
function referenceSummary(reference) {
  return reference?.kind === "computed" ? `@${reference.alias || "computed"}` : reference?.path || "field";
}
function valueSummary(value) {
  if (!value || typeof value !== "object") {
    return literalSummary(value);
  }
  if (value.kind === "field") {
    return value.path || "field";
  }
  if (value.kind === "outerField") {
    return `outer.${value.path || "field"}`;
  }
  if (value.kind === "list") {
    return `[${(value.values || []).map(literalSummary).join(", ")}]`;
  }
  if (value.kind === "relativeTime") {
    return `${value.amount || 0} ${value.unit || "time"} ${value.direction || "ago"}`;
  }
  return literalSummary(value.value);
}
function literalSummary(value) {
  if (value === null || value === void 0) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}\u2026` : value);
  }
  return String(value);
}
function computedSummary(computed) {
  const enabled = (computed || []).filter((item) => item?.enabled);
  if (!enabled.length) {
    return "no computed columns";
  }
  const descriptions = enabled.map((item) => {
    if (item.kind === "aggregate") {
      return `${item.alias || "aggregate"} (${item.function || "aggregate"}${item.distinct && item.distinct !== "never" ? `, distinct ${item.distinct}` : ""})`;
    }
    if (item.kind === "scalarSubquery") {
      const correlation = item.correlations?.length ? `${item.correlations.length} correlation${item.correlations.length === 1 ? "" : "s"}` : "no correlation";
      const order = item.orderBy?.length ? `${item.orderBy.length} inner order term${item.orderBy.length === 1 ? "" : "s"}` : "target primary-key ascending";
      return `${item.alias || "subquery"} (subquery; ${correlation}; ${order})`;
    }
    return item.alias || item.kind || "computed";
  });
  return `${enabled.length} computed column${enabled.length === 1 ? "" : "s"}: ${descriptions.join(", ")}`;
}
function resultSummary(recipe) {
  const mode = recipe?.mode === "summary" ? "Summary" : "Rows";
  const grouping = recipe?.mode === "summary" ? recipe.groupBy?.length ? ` grouped by ${recipe.groupBy.map(referenceSummary).join(", ")}` : " global summary" : "";
  const order = recipe?.orderBy?.length ? ` ordered by ${recipe.orderBy.map((term) => `${referenceSummary(term.ref)} ${term.direction === "desc" ? "descending" : "ascending"}`).join(", ")}` : " ordered by primary key ascending";
  return `${mode}${grouping}${order}`;
}

// media/gridQueryIssueGuidance.js
function entries(records) {
  return Object.freeze(Object.fromEntries(records.map(([code, title, explanation]) => [code, Object.freeze({ title, explanation })])));
}
var QUERY_ISSUE_GUIDANCE = entries([
  ["RECIPE_VERSION_UNSUPPORTED", "This query format is not supported", "The draft was created with a Recipe version this builder cannot apply."],
  ["RECIPE_SOURCE_MISMATCH", "This query belongs to another model", "The draft source does not match the model currently open in the grid."],
  ["RECIPE_TOO_LARGE", "This query is too large", "The complete draft exceeds the bounded Recipe payload size."],
  ["RECIPE_SHAPE_INVALID", "Part of the query is incomplete", "A required group, item, or value has an unsupported shape."],
  ["NODE_ID_INVALID", "A query item has an invalid identifier", "Stable internal identifiers must use the bounded generated format."],
  ["NODE_ID_DUPLICATE", "Two query items share an identifier", "Every query item needs a unique stable identifier."],
  ["PREDICATE_NODE_LIMIT", "There are too many conditions", "The query exceeds the maximum number of predicate nodes."],
  ["PREDICATE_GROUP_DEPTH_LIMIT", "Conditions are nested too deeply", "The query exceeds the maximum nested group depth."],
  ["PREDICATE_GROUP_CHILD_LIMIT", "This group has too many items", "A single group can contain only the bounded number of children."],
  ["EMPTY_NESTED_GROUP", "This nested group is empty", "Only the root group may be empty; an empty nested group has no useful meaning."],
  ["FIELD_METADATA_UNAVAILABLE", "Field details are unavailable", "The builder cannot safely validate paths and types without current model metadata."],
  ["FIELD_PATH_INVALID", "Choose an available field", "The selected path is not present in the current model metadata."],
  ["FIELD_PATH_TOO_LONG", "This field path is too long", "The relation traversal exceeds the bounded path length or segment count."],
  ["FIELD_PATH_RELATION_TERMINAL", "Choose a field inside this relation", "This comparison needs a scalar field unless it is checking whether a relation is null."],
  ["FIELD_PATH_TO_MANY_UNSAFE", "This to-many path is unsafe here", "Following this relation can duplicate source rows in a context that cannot preserve the intended result."],
  ["LOOKUP_UNSUPPORTED", "Choose a supported comparison", "The selected lookup is not in the Recipe allowlist."],
  ["LOOKUP_TYPE_MISMATCH", "This comparison does not fit the field type", "The selected lookup cannot be used with this field\u2019s Django type."],
  ["RHS_KIND_UNSUPPORTED", "Choose a supported value source", "This context cannot compare against the selected value, field, OuterRef, or relative time kind."],
  ["RHS_TYPE_MISMATCH", "The comparison values have different types", "The right-hand value cannot be safely compared with the selected field."],
  ["VALUE_REQUIRED", "Enter a comparison value", "This comparison cannot be evaluated without a value."],
  ["VALUE_INVALID", "Enter a valid value", "The value cannot be converted to the selected field and lookup type."],
  ["IN_LIST_LIMIT", "The value list is too long", "The in comparison exceeds the bounded list size."],
  ["RELATIVE_TIME_INVALID", "Complete the relative time", "Amount, unit, anchor, or direction is outside the supported range."],
  ["COMPUTED_COLUMN_LIMIT", "There are too many calculated values", "The draft exceeds the maximum number of computed columns."],
  ["ALIAS_INVALID", "Use a valid calculated-value name", "Aliases use a bounded Python-style identifier format."],
  ["ALIAS_RESERVED", "Choose a different calculated-value name", "This alias is reserved by the query or model runtime."],
  ["ALIAS_COLLISION", "This name conflicts with a model field", "A calculated value cannot hide an existing model field."],
  ["ALIAS_DUPLICATE", "This calculated-value name is already used", "Every enabled computed column needs a unique alias."],
  ["COMPUTED_REFERENCE_UNKNOWN", "Choose an available calculated value", "The referenced alias does not exist in this draft."],
  ["COMPUTED_REFERENCE_FORWARD", "Move the dependency above this formula", "A formula can use only enabled calculated values declared earlier in the list."],
  ["COMPUTED_REFERENCE_DISABLED", "Enable the referenced calculated value", "This expression depends on a computed column that is currently disabled."],
  ["COMPUTED_KIND_UNSUPPORTED_IN_SUMMARY", "This calculated value is not available in Summary", "Summary mode supports only the existing aggregate-compatible computed kinds."],
  ["AGGREGATE_FIELD_REQUIRED", "Choose a value to summarize", "This aggregate function needs a field or the supported all-rows form."],
  ["AGGREGATE_FANOUT_UNSAFE", "This aggregate can duplicate values", "The selected to-many path can multiply rows and change the aggregate result."],
  ["AGGREGATE_DISTINCT_UNSUPPORTED", "DISTINCT is not supported for this aggregate", "The selected function and distinct mode are not a supported combination."],
  ["WINDOW_ORDER_REQUIRED", "Choose an order for the window calculation", "Window results require a stable row sequence."],
  ["WINDOW_FILTER_UNSUPPORTED", "Window values cannot be filtered here", "The current query pipeline cannot apply this result filter to a window alias."],
  ["FORMULA_NODE_LIMIT", "This formula has too many parts", "The expression tree exceeds the bounded node count."],
  ["FORMULA_DEPTH_LIMIT", "This formula is nested too deeply", "The expression tree exceeds the bounded depth."],
  ["FORMULA_TYPE_MISMATCH", "Formula values have incompatible types", "The selected operation or function cannot combine these input types safely."],
  ["FORMULA_DIVIDE_BY_ZERO", "The formula divides by zero", "A fixed divisor of zero cannot produce a valid result."],
  ["OUTPUT_TYPE_REQUIRED", "Choose the result type", "The builder needs an output type to validate and compile this expression."],
  ["RAW_EXPRESSION_INVALID", "The restricted expression is not valid", "The expression contains unsupported syntax, names, or structure."],
  ["RAW_EXPRESSION_TRANSPORT_UNSUPPORTED", "This link cannot run the restricted expression", "The active transport does not support this advanced expression form."],
  ["RAW_MODEL_NAME_AMBIGUOUS", "Use an unambiguous model reference", "The restricted expression refers to a model name that cannot be resolved safely."],
  ["SUBQUERY_SOURCE_INVALID", "Choose a subquery source", "The subquery needs a valid relation or app-qualified model."],
  ["SUBQUERY_RELATION_INVALID", "Choose an available relation", "The selected relation is not present on the current source model."],
  ["SUBQUERY_CORRELATION_REQUIRED", "Connect the target to the current row", "A custom-model subquery needs at least one complete correlation."],
  ["SUBQUERY_CORRELATION_LIMIT", "There are too many subquery connections", "The subquery exceeds the bounded correlation count."],
  ["SUBQUERY_CORRELATION_INVALID", "Complete this subquery connection", "The target and current-row paths are missing or incompatible."],
  ["SUBQUERY_SELECT_INVALID", "Choose the value returned by the subquery", "The subquery select field or aggregate is incomplete or unsupported."],
  ["SUBQUERY_ORDER_LIMIT", "There are too many subquery order terms", "The subquery exceeds the bounded inner order count."],
  ["SUBQUERY_IMPLICIT_ORDER", "The subquery uses its default order", "No explicit inner order is set, so the target primary key ascending is used."],
  ["SUBQUERY_AGGREGATE_FANOUT_UNSAFE", "This subquery aggregate can duplicate values", "The selected target path can multiply rows before aggregation."],
  ["OUTER_REF_SCOPE_INVALID", "Choose a field from the current outer row", "This OuterRef points outside the scope available to the subquery."],
  ["GLOBAL_SUMMARY_POST_FILTER_UNSUPPORTED", "This global summary filter is not supported", "The current result filter needs grouping or a supported summary alias context."],
  ["PYTHON_PROPERTY_FULL_SCAN", "This filter scans Python values in memory", "The property is not a database field, so normal indexed filtering and pagination are unavailable."],
  ["PYTHON_PROPERTY_BOOLEAN_UNSUPPORTED", "This Python property cannot use this boolean filter", "The property value cannot be translated to the requested database boolean operation."],
  ["PYTHON_PROPERTY_SUMMARY_UNSUPPORTED", "Python properties are not available in Summary", "Summary mode must run in the database and cannot group or aggregate arbitrary Python properties."],
  ["AUTO_DISTINCT_APPLIED", "Duplicate source rows will be removed", "The builder adds DISTINCT because a to-many relation could otherwise duplicate the current model rows."],
  ["OFFSET_PAGINATION_REQUIRED", "This query uses offset pagination", "Calculated values, windows, or custom ordering prevent primary-key keyset pagination."],
  ["TRANSPORT_CAPABILITY_UNSUPPORTED", "The active link cannot run this query", "The draft uses a feature not supported by the selected transport."],
  ["GENERATED_QUERY_TOO_LARGE", "The generated Django query is too large", "The validated Recipe expands beyond the bounded executable ORM cell size."]
]);
function presentQueryIssue(issue = {}) {
  const guidance = QUERY_ISSUE_GUIDANCE[issue.code];
  return {
    title: guidance?.title || sentenceCase(issue.code || "Query issue"),
    explanation: guidance?.explanation || String(issue.message || "The query needs attention before it can be applied."),
    fix: String(issue.fix || "Review the highlighted query setting."),
    severity: issue.severity === "warning" ? "warning" : "error",
    technical: { code: String(issue.code || ""), path: String(issue.path || "") }
  };
}

// media/gridQueryValidationView.js
function issuesOf(validation) {
  return Array.isArray(validation?.issues) ? validation.issues.filter((issue) => issue && typeof issue === "object") : [];
}
function validationLabel(validation, checking = false) {
  if (checking) {
    return { state: "checking", text: "Checking\u2026" };
  }
  const issues = issuesOf(validation);
  const errors = issues.filter((issue) => issue.severity !== "warning");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  if (errors.length) {
    return { state: "error", text: `${errors.length} error${errors.length === 1 ? "" : "s"}` };
  }
  if (warnings.length) {
    return { state: "warning", text: `${warnings.length} warning${warnings.length === 1 ? "" : "s"}` };
  }
  return { state: "valid", text: "Valid" };
}
function renderQueryValidation({ issueSummary, validationState }, validation, options = {}) {
  const label = validationLabel(validation, Boolean(options.checking));
  validationState.dataset.state = label.state;
  validationState.textContent = label.text;
  issueSummary.replaceChildren();
  for (const [index, issue] of issuesOf(validation).entries()) {
    const presentation = presentQueryIssue(issue);
    const item = document.createElement("article");
    item.className = "query-issue-item";
    item.dataset.severity = presentation.severity;
    const button2 = document.createElement("button");
    button2.className = "query-issue";
    button2.dataset.severity = issue.severity === "warning" ? "warning" : "error";
    button2.type = "button";
    button2.textContent = `${presentation.severity === "warning" ? "Warning" : "Error"}: ${presentation.title}`;
    const detailId = `query-issue-detail-${issue.nodeId || issue.code || "unknown"}-${index}`;
    button2.setAttribute("aria-describedby", detailId);
    button2.addEventListener("click", () => options.onFocusIssue?.(issue));
    const detail = document.createElement("p");
    detail.className = "query-issue-detail";
    detail.id = detailId;
    detail.textContent = `${presentation.explanation} Fix: ${presentation.fix}`;
    item.append(button2, detail);
    issueSummary.appendChild(item);
  }
}
function applyQueryValidationAnnotations(root = document, validation) {
  for (const control of root.querySelectorAll?.("[data-query-validation-message]") || []) {
    removeDescription(control, control.dataset.queryValidationMessage);
    control.removeAttribute?.("aria-invalid");
    delete control.dataset.queryValidationMessage;
  }
  for (const issue of issuesOf(validation).filter((entry2) => entry2.severity !== "warning")) {
    const nodeId = typeof issue.nodeId === "string" ? issue.nodeId : "";
    if (!nodeId) {
      continue;
    }
    const messageId = `query-node-issues-${nodeId}`;
    const target = controlForIssue(root, issue, nodeId);
    if (!target) {
      continue;
    }
    target.setAttribute?.("aria-invalid", "true");
    addDescription(target, messageId);
    target.dataset.queryValidationMessage = messageId;
  }
}
function controlForIssue(root, issue, nodeId) {
  const controlKey = typeof issue.controlKey === "string" ? issue.controlKey : "";
  if (controlKey) {
    const exact = root.querySelector?.(`[data-query-control-key="${cssEscape(controlKey)}"]`);
    if (exact) {
      return exact;
    }
  }
  const node = root.querySelector?.(`[data-query-node-id="${cssEscape(nodeId)}"]`);
  return node?.querySelector?.("[data-focus-role=lhs], input, select, textarea, button");
}
function addDescription(control, messageId) {
  const tokens = new Set(String(control.getAttribute?.("aria-describedby") || "").split(/\s+/).filter(Boolean));
  tokens.add(messageId);
  control.setAttribute?.("aria-describedby", [...tokens].join(" "));
}
function removeDescription(control, messageId) {
  const tokens = String(control.getAttribute?.("aria-describedby") || "").split(/\s+/).filter((token) => token && token !== messageId);
  if (tokens.length) {
    control.setAttribute?.("aria-describedby", tokens.join(" "));
  } else {
    control.removeAttribute?.("aria-describedby");
  }
}
function focusQueryIssue(issue, root = document) {
  const nodeId = typeof issue?.nodeId === "string" ? issue.nodeId : "";
  if (!nodeId) {
    root.getElementById("queryDrawer")?.scrollIntoView({ block: "nearest" });
    return false;
  }
  const section = root.querySelector(`[data-query-node-id="${cssEscape(nodeId)}"]`);
  if (!section) {
    return false;
  }
  section.open = true;
  let ancestor = section.closest?.("details");
  while (ancestor) {
    ancestor.open = true;
    ancestor = ancestor.parentElement?.closest?.("details");
  }
  section.scrollIntoView({ block: "nearest" });
  section.querySelector("input,select,textarea,button,[tabindex]")?.focus();
  return true;
}
function cssEscape(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^A-Za-z0-9_-]/g, "\\$&");
}

// media/gridQueryController.js
var QUERY_IDS = ["querySummaryBand", "queryFilterButton", "queryColumnsButton", "queryModeButton", "queryHumanSummary", "queryDirtyState", "queryValidationState", "queryDrawerToggle", "queryDrawer", "queryDrawerResizeHandle", "queryDrawerHeader", "queryBuilderTitle", "queryWhereSection", "queryWhereGuide", "queryWhereRoot", "queryComputedSection", "queryComputedGuide", "queryComputedList", "queryPostFilterSection", "queryPostFilterGuide", "queryPostFilterRoot", "queryResultSection", "queryResultGuide", "queryGroupBy", "queryOrderBy", "queryPreviewSection", "queryPreviewGuide", "queryPlainMeaning", "queryImplicitBehavior", "queryOrmPreview", "queryCopyOrm", "queryIssueSummary", "queryResetDraft", "queryClearDraft", "queryDrawerApply", "queryDrawerApplyHelp", "queryDrawerStatus", "queryDraftStatus", "queryUndo", "queryRedo", "queryFocusMode", "queryMoreActions", "queryMoreMenu", "queryClose", "queryStageNav", "queryStageSelect", "queryStageFilterRows", "queryStageCalculatedValues", "queryStageFilterResults", "queryStageResult", "queryFilterRowsPanel", "queryCalculatedValuesPanel", "queryFilterResultsPanel", "queryResultPanel", "queryInspectorTabs", "queryInspectorMeaning", "queryInspectorProblems", "queryInspectorOrm", "queryMeaningPanel", "queryProblemsPanel", "queryEditorPane", "queryReviewPane", "queryOrmPanel", "queryPopoverLayer", "queryWorkspace", "queryMobilePaneSwitch", "queryDrawerFooter"];
var QUERY_STAGE_ORDINALS = { calculatedValues: 2, filterResults: 3, filterRows: 1, result: 4 };
function createQueryController(options) {
  const root = options.root || document;
  const elements = Object.fromEntries(QUERY_IDS.map((id) => [id, root.getElementById(id)]));
  if (!elements.querySummaryBand) {
    return noQueryController();
  }
  elements.queryBuilderTitle?.setAttribute("role", "heading");
  elements.queryBuilderTitle?.setAttribute("aria-level", "2");
  const post = options.post;
  const announcer2 = options.announcer;
  const status = options.status;
  let source = { app: "", model: "" };
  let requestSequence = 0;
  let previewTimer = 0;
  let observedDraftRevision = 0;
  let metadataCatalogRequest = 0;
  let sectionsMounted = false;
  let resultSignature = "";
  let computedRenderVersion = 0;
  let predicateRenderVersion = 0;
  const scope = { columns: [], relations: [], source, target: source };
  const store = createQueryRecipeStore(createEmptyQueryRecipe(source));
  const resultControls = createQueryResultControls({ dispatch: (action) => store.dispatch(action), el: element2, groupByMount: elements.queryGroupBy, orderByMount: elements.queryOrderBy, popoverLayer: elements.queryPopoverLayer, replaceGroupBy });
  const metadata = createQueryMetadataService({ onChange: () => requestBuilderRender("metadata"), post });
  let applyLifecycle = createApplyLifecycle();
  let validationLifecycle = createValidationLifecycle();
  const uiState = createQueryUiState({ getPersisted: options.getPersisted, persist: options.persist });
  const focusIntent = createQueryFocusIntent();
  let predicateBuilders = [];
  let computedBuilder;
  const menuAbort = new AbortController();
  const drawerResize = createQueryDrawerResize({ drawer: elements.queryDrawer, handle: elements.queryDrawerResizeHandle, onHeight: (height, dragging, bounds) => {
    uiState.setBounds(bounds);
    uiState.dispatch({ dragging, height, type: "SET_DRAWER_HEIGHT" });
  }, root });
  const workspace = createQueryWorkspace({ drawerResize, element: element2, elements, root, uiState });
  const openDrawer = workspace.open;
  const closeDrawer = workspace.close;
  const coordinator = createQueryRenderCoordinator({
    captureFocus: () => captureQueryFocus(root),
    getModel: () => ({ applyLifecycle, computedRenderVersion, metadataState: metadata.getState(source), predicateRenderVersion, recipe: store.getSnapshot(), scopeColumns: scope.columns, source, ui: uiState.getSnapshot(), validationLifecycle }),
    regions: [
      { id: "main", signature: (model) => JSON.stringify({ applyLifecycle: model.applyLifecycle, metadataState: model.metadataState, pendingResultMode: model.ui.pendingResultMode, recipe: model.recipe, scopeColumns: model.scopeColumns, source: model.source, validationLifecycle: model.validationLifecycle }), update: (model) => renderMain(model.recipe) },
      { id: "predicate", signature: (model) => model.predicateRenderVersion, update: () => predicateBuilders.forEach((builder) => builder.render()) },
      { id: "computed", signature: (model) => model.computedRenderVersion, update: () => computedBuilder?.render() },
      { id: "validation", signature: (model) => JSON.stringify({ revision: model.recipe.validationRevision, validation: model.recipe.validation }), update: (model) => {
        predicateBuilders.forEach((builder) => builder.updateValidation?.());
        computedBuilder?.updateValidation?.();
        applyQueryValidationAnnotations(root, model.recipe.validation);
      } },
      { id: "workspace", signature: (model) => JSON.stringify(model.ui), update: (model) => workspace.render(model.ui) }
    ],
    restoreFocus: (captured) => restoreQueryFocus(root, focusIntent.consume() || captured)
  });
  function requestRender(reason = "recipe") {
    coordinator.request(reason);
  }
  function requestBuilderRender(reason, { computed = true, predicate = true } = {}) {
    if (computed) {
      computedRenderVersion += 1;
    }
    if (predicate) {
      predicateRenderVersion += 1;
    }
    requestRender(reason);
  }
  function restoreDraft(reason, restore) {
    const beforeRevision = store.getSnapshot().draftRevision;
    restore();
    if (store.getSnapshot().draftRevision !== beforeRevision) {
      requestBuilderRender(reason);
    }
  }
  function undoDraft() {
    restoreDraft("undo", () => store.undo());
  }
  function redoDraft() {
    restoreDraft("redo", () => store.redo());
  }
  function renderMain(snapshot) {
    const checking = validationLifecycle.phase === "pending" || validationLifecycle.phase === "previewing";
    renderQuerySummary(elements, snapshot);
    const localOrderIssues = outerOrderIssues(snapshot.draft.orderBy);
    const validation = mergeValidation(snapshot.validation, localOrderIssues);
    renderQueryValidation({ issueSummary: elements.queryIssueSummary, validationState: elements.queryValidationState }, validation, { checking, onFocusIssue: focusIssue });
    const validationOk = validation.ok !== false && snapshot.validationRevision === snapshot.draftRevision;
    const canApply = Boolean(source.app && source.model && snapshot.dirty && validationOk && validationAllowsApply(validationLifecycle, snapshot.draftRevision) && applyLifecycle.phase !== "applying" && applyLifecycle.phase !== "loadingResults" && !snapshot.applyingRevision);
    if (elements.queryApply) {
      elements.queryApply.disabled = !canApply;
    }
    elements.queryDrawerApply.disabled = !canApply;
    if (elements.queryDrawerStatus) {
      elements.queryDrawerStatus.textContent = applyLifecycle.phase === "applying" ? "Applying query\u2026" : applyLifecycle.phase === "loadingResults" ? "Loading query results\u2026" : validationLifecycle.phase === "pending" || validationLifecycle.phase === "previewing" ? "Checking latest draft\u2026" : validation.ok === false ? "Fix the reported query errors." : snapshot.dirty ? "Draft is ready to apply." : "Applied query is current.";
    }
    const availability = applyAvailability(snapshot, { applying: applyLifecycle.phase === "applying" || applyLifecycle.phase === "loadingResults" || Boolean(snapshot.applyingRevision), checking, metadataState: metadata.getState(source)?.pending ? "pending" : metadata.getState(source)?.error ? "error" : "ready", source, stale: snapshot.validationRevision !== snapshot.draftRevision, validation });
    renderApplyHelp(elements.queryDrawerApplyHelp, availability);
    if (elements.queryDraftStatus) {
      elements.queryDraftStatus.textContent = snapshot.dirty ? "Draft changes are not applied" : "Draft matches applied query";
    }
    if (elements.queryUndo) {
      elements.queryUndo.disabled = !snapshot.canUndo;
    }
    if (elements.queryRedo) {
      elements.queryRedo.disabled = !snapshot.canRedo;
    }
    const countButton = root.getElementById("count");
    if (countButton) {
      const globalSummary = snapshot.applied.mode === "summary" && !snapshot.applied.groupBy.length;
      countButton.disabled = globalSummary;
      countButton.title = globalSummary ? "Global summary always has one result row" : "Count the applied query results";
    }
    elements.queryOrmPreview.textContent = renderRecipePreview(snapshot.draft, snapshot.validation?.ormPreview);
    elements.queryCopyOrm.disabled = !snapshot.validation?.ormPreview;
    renderQueryInspector({ element: element2, elements, recipe: snapshot.draft, root, scope, validation });
    const stageCounts = queryStageCounts(snapshot.draft);
    const stageButtons = { calculatedValues: elements.queryStageCalculatedValues, filterResults: elements.queryStageFilterResults, filterRows: elements.queryStageFilterRows, result: elements.queryStageResult };
    for (const [stage2, button2] of Object.entries(stageButtons)) {
      if (button2) {
        button2.textContent = `${QUERY_STAGE_ORDINALS[stage2]}. ${stageLabel(stage2, stageCounts[stage2])}`;
      }
    }
    scope.computedFields = (snapshot.draft.computed || []).filter((item) => item?.enabled).map((item) => ({ alias: item.alias, enabled: item.enabled, outputType: item.outputType || "" }));
    if (!sectionsMounted) {
      mountSectionStates(snapshot.draft);
    }
    const nextResultSignature = JSON.stringify({ computed: snapshot.draft.computed, groupBy: snapshot.draft.groupBy, mode: snapshot.draft.mode, orderBy: snapshot.draft.orderBy });
    if (resultSignature !== nextResultSignature) {
      resultSignature = nextResultSignature;
      renderResultControls(snapshot.draft);
    }
  }
  function mountSectionStates(recipe) {
    renderSectionGuidance({ el: element2, mount: elements.queryWhereGuide, guidance: QUERY_SECTION_GUIDANCE.where });
    renderSectionGuidance({ el: element2, mount: elements.queryComputedGuide, guidance: QUERY_SECTION_GUIDANCE.computed });
    renderSectionGuidance({ el: element2, mount: elements.queryPostFilterGuide, guidance: QUERY_SECTION_GUIDANCE.postFilter });
    renderSectionGuidance({ el: element2, mount: elements.queryResultGuide, guidance: QUERY_SECTION_GUIDANCE.result });
    renderSectionGuidance({ el: element2, mount: elements.queryPreviewGuide, guidance: QUERY_SECTION_GUIDANCE.preview });
    scope.computedFields = (recipe.computed || []).filter((item) => item?.enabled).map((item) => ({ alias: item.alias, enabled: item.enabled, outputType: item.outputType || "" }));
    disposePredicateBuilders();
    mountPredicateBuilder(elements.queryWhereRoot, "where", recipe.where.nodeId);
    mountComputedBuilder();
    mountPredicateBuilder(elements.queryPostFilterRoot, "postFilter", recipe.postFilter.nodeId);
    elements.queryGroupBy.replaceChildren();
    const mode = root.createElement("div");
    mode.className = "query-result-row";
    mode.append("Mode: ");
    const segmented = root.createElement("span");
    segmented.className = "query-mode-control";
    segmented.appendChild(modeButton("Rows", "rows", recipe.mode));
    segmented.appendChild(modeButton("Summary", "summary", recipe.mode));
    mode.appendChild(segmented);
    elements.queryGroupBy.appendChild(mode);
    sectionsMounted = true;
  }
  function renderResultControls(recipe) {
    const fields3 = scope.columns.filter((field) => field?.attname || field?.name).map((field) => ({ label: field.label ? `${field.label} \u2014 ${field.attname || field.name}` : field.attname || field.name, path: field.attname || field.name }));
    resultControls.render(recipe, fields3);
    renderResultModeConfirmation(recipe);
  }
  function renderResultModeConfirmation(recipe) {
    const pending = uiState.getSnapshot().pendingResultMode;
    if (pending !== "rows" || recipe.mode !== "summary" || !recipe.groupBy.length) {
      return;
    }
    const confirmation = element2("div", { className: "query-kind-confirmation", role: "alert" });
    const confirm = element2("button", { className: "secondary", type: "button" }, "Switch to Rows");
    confirm.addEventListener("click", () => {
      uiState.dispatch({ type: "CLEAR_PENDING_RESULT_MODE" });
      store.dispatch({ mode: "rows", type: "SET_MODE" });
    });
    const cancel = element2("button", { className: "secondary", type: "button" }, "Cancel");
    cancel.addEventListener("click", () => {
      uiState.dispatch({ type: "CLEAR_PENDING_RESULT_MODE" });
      renderResultControls(recipe);
    });
    confirmation.append("Switching to Rows removes the selected summary group fields. ", confirm, cancel);
    elements.queryGroupBy.appendChild(confirmation);
  }
  function replaceGroupBy(recipe, index, path) {
    const next = { ...recipe, groupBy: recipe.groupBy.map((item, itemIndex) => itemIndex === index ? { kind: "field", path } : item) };
    store.dispatch({ recipe: next, type: "REPLACE_DRAFT" });
  }
  function mountPredicateBuilder(container, context, rootNodeId) {
    container.replaceChildren();
    const builder = createPredicateBuilder({
      context,
      dispatch: (action) => store.dispatch(action),
      el: element2,
      getRecipe: () => store.getSnapshot().draft,
      getScope: () => scope,
      metadata,
      popoverLayer: elements.queryPopoverLayer,
      requestRender: () => requestBuilderRender("predicate", { computed: false }),
      rootNodeId,
      validation: () => store.getSnapshot().validation
    });
    container.appendChild(builder.node);
    predicateBuilders.push(builder);
  }
  function disposePredicateBuilders() {
    for (const builder of predicateBuilders) {
      builder.destroy();
    }
    predicateBuilders = [];
  }
  function mountComputedBuilder() {
    computedBuilder?.destroy?.();
    computedBuilder = createComputedBuilder({
      dispatch: (action) => {
        store.dispatch(action);
        const changes = action.changes || {};
        const structuralComputedChange = action.type !== "UPDATE_COMPUTED" || changes.kind || changes.source || changes.select || changes.orderBy || changes.correlations;
        if (structuralComputedChange) {
          requestBuilderRender("computed", { predicate: false });
        }
      },
      el: element2,
      getRecipe: () => store.getSnapshot().draft,
      getScope: () => scope,
      metadata,
      cancelKindChange: (nodeId) => {
        uiState.dispatch({ nodeId, type: "CLEAR_PENDING_COMPUTED_KIND" });
        requestBuilderRender("computed", { predicate: false });
      },
      confirmKindChange: (item, kind) => {
        uiState.dispatch({ nodeId: item.nodeId, type: "CLEAR_PENDING_COMPUTED_KIND" });
        store.dispatch({ changes: createComputedDraft(kind, item.nodeId, item.alias), nodeId: item.nodeId, type: "UPDATE_COMPUTED" });
        requestBuilderRender("computed", { predicate: false });
      },
      onOpenChange: (nodeId, open) => uiState.dispatch({ nodeId, open, type: "SET_COMPUTED_OPEN" }),
      openNodeIds: () => uiState.getSnapshot().openComputedNodeIds,
      pendingKinds: () => uiState.getSnapshot().pendingComputedKinds,
      popoverLayer: elements.queryPopoverLayer,
      requestKindChange: (item, kind) => {
        uiState.dispatch({ kind, nodeId: item.nodeId, type: "SET_PENDING_COMPUTED_KIND" });
        requestBuilderRender("computed", { predicate: false });
      },
      validation: () => store.getSnapshot().validation
    });
    elements.queryComputedList.replaceChildren(computedBuilder.node);
  }
  function modeButton(label, mode, current) {
    const button2 = root.createElement("button");
    button2.type = "button";
    button2.textContent = label;
    button2.setAttribute("aria-pressed", String(current === mode));
    button2.addEventListener("click", () => {
      const recipe = store.getSnapshot().draft;
      if (mode === "rows" && recipe.mode === "summary" && recipe.groupBy.length) {
        uiState.dispatch({ mode, type: "SET_PENDING_RESULT_MODE" });
        return;
      }
      store.dispatch({ type: "SET_MODE", mode });
    });
    return button2;
  }
  function setSectionText(container, text) {
    container.replaceChildren();
    const paragraph = root.createElement("p");
    paragraph.className = "query-builder-empty";
    paragraph.textContent = text;
    container.appendChild(paragraph);
  }
  function schedulePreview() {
    if (!source.app || !source.model) {
      return;
    }
    if (previewTimer) {
      window.clearTimeout(previewTimer);
    }
    const revision = store.getSnapshot().draftRevision;
    previewTimer = window.setTimeout(() => {
      const requestId = `recipe-preview-${requestSequence += 1}`;
      validationLifecycle = transitionValidation(validationLifecycle, { requestId, revision, type: "PREVIEW_TIMER_FIRED" });
      requestRender("preview-started");
      post({ recipe: store.getSnapshot().draft, requestId, revision, type: "previewQueryRecipe" });
    }, 400);
  }
  function apply() {
    const snapshot = store.getSnapshot();
    const localOrderIssues = outerOrderIssues(snapshot.draft.orderBy);
    if (!snapshot.dirty || !validationAllowsApply(validationLifecycle, snapshot.draftRevision) || snapshot.validationRevision !== snapshot.draftRevision || snapshot.validation?.ok === false || localOrderIssues.length || !source.app || !source.model) {
      return;
    }
    const revision = Math.max(snapshot.appliedRevision, snapshot.draftRevision) + 1;
    applyLifecycle = transitionApply(applyLifecycle, { revision, type: "APPLY_STARTED" });
    store.beginApply(revision, snapshot.draft);
    status.textContent = "Applying query\u2026";
    announcer2?.announceStatus("Applying query\u2026");
    post({ recipe: snapshot.draft, revision, type: "applyQueryRecipe" });
    requestRender("apply-started");
  }
  function focusIssue(issue) {
    const sectionByStage = { calculatedValues: "queryComputedSection", filterResults: "queryPostFilterSection", filterRows: "queryWhereSection", result: "queryResultSection" };
    openDrawer(sectionByStage[stageForQueryIssue(issue)], { focus: false });
    uiState.dispatch({ tab: "problems", type: "SET_INSPECTOR_TAB" });
    queueMicrotask(() => {
      if (!focusQueryIssue(issue, root)) {
        announcer2?.announceError(issue.message || issue.code || "Query issue");
      }
    });
  }
  function setSource(nextSource) {
    if (!nextSource?.app || !nextSource?.model) {
      return;
    }
    const changed = source.app !== nextSource.app || source.model !== nextSource.model;
    source = { app: nextSource.app, model: nextSource.model };
    scope.columns = Array.isArray(nextSource.columns) ? nextSource.columns : scope.columns;
    scope.relations = Array.isArray(nextSource.relations) ? nextSource.relations : scope.relations;
    scope.source = source;
    scope.target = source;
    if (!changed) {
      requestBuilderRender("source-metadata");
      return;
    }
    const empty = createEmptyQueryRecipe(source);
    store.hydrate(empty, 0);
    disposePredicateBuilders();
    computedBuilder?.destroy?.();
    computedBuilder = void 0;
    resultControls.destroy();
    sectionsMounted = false;
    resultSignature = "";
    if (uiState.getSnapshot().focusMode) {
      options.gridAdapter?.exitQueryFocusMode?.();
      uiState.dispatch({ enabled: false, type: "SET_FOCUS_MODE" });
    }
    uiState.dispatch({ type: "RESET_TRANSIENT_FOR_SOURCE" });
    metadataCatalogRequest += 1;
    post({ requestId: `query-meta-catalog-${metadataCatalogRequest}`, type: "modelList" });
    validationLifecycle = transitionValidation(validationLifecycle, { revision: store.getSnapshot().draftRevision, type: "SOURCE_CHANGED" });
    applyLifecycle = transitionApply(applyLifecycle, { type: "SOURCE_CHANGED" });
    requestBuilderRender("source-changed");
    schedulePreview();
  }
  function toggleGridOrder(field, descending) {
    const recipe = store.getSnapshot().draft;
    recipe.orderBy = descending === void 0 ? [] : [{ direction: descending ? "desc" : "asc", nodeId: `grid-order-${String(field).replace(/[^A-Za-z0-9_-]/g, "-")}`, ref: { kind: "field", path: field } }];
    store.dispatch({ recipe, type: "REPLACE_DRAFT" });
  }
  function onMessage(message) {
    if (!message || typeof message.type !== "string") {
      return false;
    }
    if (message.type === "filterFields") {
      return metadata.onMessage(message);
    }
    if (message.type === "modelList" && typeof message.requestId === "string" && message.requestId.startsWith("query-meta-catalog-")) {
      metadata.setCatalog(message.result?.ok ? message.result.models : []);
      requestBuilderRender("metadata-catalog");
      return true;
    }
    const snapshot = store.getSnapshot();
    if (message.type === "queryRecipePreview") {
      if (message.revision !== snapshot.draftRevision) {
        return true;
      }
      validationLifecycle = transitionValidation(validationLifecycle, { requestId: message.requestId, revision: message.revision, type: "PREVIEW_ACCEPTED", validation: message.validation });
      store.setValidation(message.validation || { issues: [], ok: true, warnings: [] }, message.revision);
      requestRender("preview-accepted");
      return true;
    }
    if (message.type === "queryRecipeApplied") {
      if (typeof message.revision !== "number") {
        return true;
      }
      applyLifecycle = transitionApply(applyLifecycle, { revision: message.revision, type: "APPLY_ACCEPTED" });
      if (snapshot.applyingRevision === message.revision) {
        store.finishApply(message.revision, message.recipe || snapshot.draft);
      } else {
        store.hydrate(message.recipe || snapshot.draft, message.revision);
      }
      status.textContent = "Query applied.";
      announcer2?.announceStatus("Query applied.");
      requestRender("apply-accepted");
      return true;
    }
    if (message.type === "queryRecipeRejected") {
      if (snapshot.applyingRevision === message.revision) {
        applyLifecycle = transitionApply(applyLifecycle, { revision: message.revision, type: "APPLY_REJECTED" });
      } else {
        validationLifecycle = transitionValidation(validationLifecycle, { requestId: message.requestId, revision: message.revision, type: "PREVIEW_REJECTED", issues: message.issues });
      }
      const issues = mergeRecipeIssues(snapshot.validation?.issues, message.issues);
      if (snapshot.applyingRevision === message.revision) {
        store.failApply(message.revision, issues);
      } else if (message.revision === snapshot.draftRevision) {
        store.setValidation(validationWithIssues(issues), message.revision);
      } else {
        store.mergeValidationIssues(issues);
      }
      options.onRejected?.(message);
      status.textContent = "Query was not applied. Fix the reported errors.";
      announcer2?.announceError("Query was not applied. Fix the reported errors.");
      openDrawer("queryWhereSection");
      uiState.dispatch({ tab: "problems", type: "SET_INSPECTOR_TAB" });
      requestRender("apply-rejected");
      return true;
    }
    if (message.type === "rows" && message.revision === snapshot.appliedRevision) {
      applyLifecycle = transitionApply(applyLifecycle, { revision: message.revision, type: "RESULTS_ACCEPTED" });
      options.onRows?.(message, snapshot);
      requestRender("rows-accepted");
      return true;
    }
    if (message.type === "count" && message.revision === snapshot.appliedRevision) {
      applyLifecycle = transitionApply(applyLifecycle, { revision: message.revision, type: "RESULTS_ACCEPTED" });
      options.onCount?.(message, snapshot);
      requestRender("count-accepted");
      return true;
    }
    if (message.type === "aggregate" && snapshot.applied.mode === "summary" && message.revision === snapshot.appliedRevision) {
      applyLifecycle = transitionApply(applyLifecycle, { revision: message.revision, type: "RESULTS_ACCEPTED" });
      options.onSummary?.(message, snapshot);
      requestRender("summary-accepted");
      return true;
    }
    return false;
  }
  elements.queryDrawerToggle.addEventListener("click", () => elements.queryDrawer.hidden ? openDrawer("queryWhereSection") : closeDrawer());
  elements.queryFilterButton.addEventListener("click", () => openDrawer("queryWhereSection"));
  elements.queryColumnsButton.addEventListener("click", () => openDrawer("queryComputedSection"));
  elements.queryModeButton.addEventListener("click", () => openDrawer("queryResultSection"));
  elements.queryDrawerApply.addEventListener("click", apply);
  elements.queryCopyOrm.addEventListener("click", async () => {
    const copied = await copyQueryOrmPreview(root);
    status.textContent = copied ? "Django ORM copied." : "Django ORM could not be copied; select the preview and copy it manually.";
    if (copied) {
      announcer2?.announceStatus("Django ORM copied.");
    } else {
      announcer2?.announceError("Django ORM could not be copied.");
    }
  });
  elements.queryResetDraft.addEventListener("click", () => {
    restoreDraft("reset-draft", () => store.resetDraft());
    closeMoreActions();
  });
  elements.queryClearDraft.addEventListener("click", () => {
    restoreDraft("clear-draft", () => store.clearDraft(source));
    closeMoreActions();
    status.textContent = "Draft cleared. Undo is available.";
    announcer2?.announceStatus("Draft cleared. Undo is available.");
  });
  elements.queryUndo.addEventListener("click", undoDraft);
  elements.queryRedo.addEventListener("click", redoDraft);
  elements.queryMoreActions.addEventListener("click", () => toggleMoreActions());
  elements.queryClose.addEventListener("click", closeDrawer);
  elements.queryFocusMode.addEventListener("click", () => {
    const enabled = !uiState.getSnapshot().focusMode;
    uiState.dispatch({ enabled, type: "SET_FOCUS_MODE" });
    if (enabled) {
      options.gridAdapter?.enterQueryFocusMode?.();
    } else {
      options.gridAdapter?.exitQueryFocusMode?.();
    }
  });
  const stageControls = { queryStageCalculatedValues: "calculatedValues", queryStageFilterResults: "filterResults", queryStageFilterRows: "filterRows", queryStageResult: "result" };
  for (const [id, stage2] of Object.entries(stageControls)) {
    elements[id].addEventListener("click", () => uiState.dispatch({ stage: stage2, type: "SET_ACTIVE_STAGE" }));
  }
  elements.queryStageSelect.addEventListener("change", () => uiState.dispatch({ stage: elements.queryStageSelect.value, type: "SET_ACTIVE_STAGE" }));
  const inspectorControls = { queryInspectorMeaning: "meaning", queryInspectorOrm: "orm", queryInspectorProblems: "problems" };
  for (const [id, tab] of Object.entries(inspectorControls)) {
    elements[id].addEventListener("click", () => uiState.dispatch({ tab, type: "SET_INSPECTOR_TAB" }));
  }
  workspace.installRovingTabs(Object.entries(stageControls).map(([id, value]) => ({ button: elements[id], value })), (stage2) => uiState.dispatch({ stage: stage2, type: "SET_ACTIVE_STAGE" }));
  workspace.installRovingTabs(Object.entries(inspectorControls).map(([id, value]) => ({ button: elements[id], value })), (tab) => uiState.dispatch({ tab, type: "SET_INSPECTOR_TAB" }));
  elements.queryEditorPane.addEventListener("scroll", () => {
    const ui = uiState.getSnapshot();
    if (ui.stageScrollTops[ui.activeStage] !== elements.queryEditorPane.scrollTop) {
      uiState.dispatch({ stage: ui.activeStage, top: elements.queryEditorPane.scrollTop, type: "SET_STAGE_SCROLL" });
    }
  });
  elements.queryPreviewSection.addEventListener("scroll", () => {
    const ui = uiState.getSnapshot();
    if (ui.inspectorScrollTops[ui.inspectorTab] !== elements.queryPreviewSection.scrollTop) {
      uiState.dispatch({ tab: ui.inspectorTab, top: elements.queryPreviewSection.scrollTop, type: "SET_INSPECTOR_SCROLL" });
    }
  });
  for (const link of root.querySelectorAll("[data-query-skip-target]")) {
    link.addEventListener("click", (event) => {
      const target = root.getElementById(link.dataset.querySkipTarget);
      if (!target?.focus) {
        return;
      }
      event.preventDefault();
      if (target.tabIndex < 0) {
        target.tabIndex = -1;
      }
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: "nearest" });
    }, { signal: menuAbort.signal });
  }
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.queryMoreMenu.hidden) {
      event.preventDefault();
      closeMoreActions();
      elements.queryMoreActions.focus();
      return;
    }
    const pendingKind = uiState.getSnapshot().pendingComputedKinds.at(-1);
    if (event.key === "Escape" && pendingKind) {
      event.preventDefault();
      uiState.dispatch({ nodeId: pendingKind.nodeId, type: "CLEAR_PENDING_COMPUTED_KIND" });
      requestBuilderRender("computed", { predicate: false });
      return;
    }
    if (event.key === "Escape" && uiState.getSnapshot().pendingResultMode) {
      event.preventDefault();
      uiState.dispatch({ type: "CLEAR_PENDING_RESULT_MODE" });
      requestRender("result-mode-cancelled");
      return;
    }
    if (event.key === "Escape" && uiState.getSnapshot().focusMode) {
      event.preventDefault();
      uiState.dispatch({ enabled: false, type: "SET_FOCUS_MODE" });
      options.gridAdapter?.exitQueryFocusMode?.();
      elements.queryFocusMode.focus();
      return;
    }
    if (event.key === "Escape" && !elements.queryDrawer.hidden) {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z" && !isTextEntry(event.target)) {
      event.preventDefault();
      if (event.shiftKey) {
        redoDraft();
      } else {
        undoDraft();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.altKey && !event.shiftKey && !isTextEntry(event.target)) {
      event.preventDefault();
      apply();
    }
  });
  root.addEventListener("pointerdown", (event) => {
    if (!elements.queryMoreMenu.hidden && !elements.queryMoreMenu.contains(event.target) && !elements.queryMoreActions.contains(event.target)) {
      closeMoreActions();
    }
  }, { signal: menuAbort.signal });
  elements.queryMoreMenu.addEventListener("keydown", (event) => handleMoreMenuKey(event), { signal: menuAbort.signal });
  store.subscribe((snapshot) => {
    if (snapshot.draftRevision !== observedDraftRevision) {
      observedDraftRevision = snapshot.draftRevision;
      validationLifecycle = transitionValidation(validationLifecycle, { revision: snapshot.draftRevision, type: "DRAFT_CHANGED" });
      schedulePreview();
    }
    requestRender("store");
  });
  uiState.subscribe(() => requestRender("ui"));
  coordinator.flush();
  if (uiState.getSnapshot().drawerOpen) {
    elements.queryDrawer.hidden = false;
    elements.queryDrawerToggle.setAttribute("aria-expanded", "true");
    drawerResize.setHeight(uiState.getSnapshot().drawerHeight);
  }
  return { apply, destroy() {
    menuAbort.abort();
    drawerResize.destroy();
    coordinator.destroy();
    uiState.destroy();
    disposePredicateBuilders();
    computedBuilder?.destroy?.();
    resultControls.destroy();
  }, getSnapshot: () => store.getSnapshot(), onMessage, openDrawer, setSource, toggleGridOrder };
  function toggleMoreActions() {
    const open = elements.queryMoreMenu.hidden;
    elements.queryMoreMenu.hidden = !open;
    elements.queryMoreActions.setAttribute("aria-expanded", String(open));
    if (open) {
      elements.queryMoreMenu.querySelector('[role="menuitem"]')?.focus();
    }
  }
  function closeMoreActions() {
    elements.queryMoreMenu.hidden = true;
    elements.queryMoreActions.setAttribute("aria-expanded", "false");
  }
  function handleMoreMenuKey(event) {
    const items = [...elements.queryMoreMenu.querySelectorAll('[role="menuitem"]')];
    const index = Math.max(0, items.indexOf(root.activeElement));
    if (event.key === "Escape") {
      event.preventDefault();
      closeMoreActions();
      elements.queryMoreActions.focus();
      return;
    }
    if (event.key === "Tab") {
      closeMoreActions();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
}
function element2(tagName, properties = {}, ...children) {
  const node = document.createElement(tagName);
  for (const [name, value] of Object.entries(properties)) {
    if (name === "className") {
      node.className = value;
    } else if (name === "dataset" && value && typeof value === "object") {
      Object.assign(node.dataset, value);
    } else if (name === "ariaLabel") {
      node.setAttribute("aria-label", value);
    } else if (name === "ariaLive") {
      node.setAttribute("aria-live", value);
    } else if (name === "ariaHidden") {
      node.setAttribute("aria-hidden", value);
    } else if (name === "checked") {
      node.checked = Boolean(value);
    } else if (name === "value") {
      node.value = value;
    } else {
      node.setAttribute(name, value);
    }
  }
  for (const child of children.flat()) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
function mergeValidation(validation, localIssues) {
  const issues = mergeRecipeIssues(validation?.issues, localIssues);
  return validationWithIssues(issues, validation?.warnings);
}
function validationWithIssues(issues, warnings) {
  const all = Array.isArray(issues) ? issues : [];
  const warningList = Array.isArray(warnings) ? warnings : all.filter((issue) => issue?.severity === "warning");
  return { issues: all, ok: !all.some((issue) => issue?.severity !== "warning"), warnings: warningList };
}
function isTextEntry(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable;
}
function noQueryController() {
  return { apply() {
  }, getSnapshot() {
    return void 0;
  }, onMessage() {
    return false;
  }, openDrawer() {
  }, setSource() {
  }, toggleGridOrder() {
  } };
}

// media/gridQuerySummaryTable.js
function renderQuerySummaryTable(result, helpers) {
  const { el: el2, groupBy, renderValue: renderValue2 } = helpers;
  const groups = new Set(groupBy || []);
  const columns = result.columns || [];
  const table = el2("table", { className: "aggresult" });
  const head = el2("thead", {});
  const headRow = el2("tr", {});
  for (const column of columns) {
    headRow.appendChild(el2("th", { className: groups.has(column.attname) ? "agggroupcol" : "" }, column.attname));
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el2("tbody", {});
  for (const row of result.rows || []) {
    const tr = el2("tr", {});
    for (const column of columns) {
      const td = el2("td", { className: groups.has(column.attname) ? "agggroupcol" : "" });
      td.appendChild(renderValue2(row[column.attname]));
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}

// media/modelBrowserSource.js
var vscode = acquireVsCodeApi();
var els = {};
for (const id of ["title", "subtitle", "gridwrap", "status", "countinfo", "more", "pageSize", "commit", "discard", "reload", "count", "transport", "transportInfo", "logToggle", "logpanel", "logresize", "logbody", "logClear", "logMode", "fieldfinder", "fieldfindslot", "fieldfindClose", "interruptQuery", "openQueryConsole", "detailDrawer", "detailContent"]) {
  els[id] = document.getElementById(id);
}
var announcer = createAnnouncer();
installModelBrowserChrome(document);
var MAX_LOG_ENTRIES = 200;
var ALL_PAGE_SIZE = 1e9;
var state = { columns: [], pk: "id", relations: [], rowCount: 0, totalCount: void 0, hasMore: false, order: [], model: "", pinned: /* @__PURE__ */ new Set(), widths: {}, computed: {}, computedActive: /* @__PURE__ */ new Set() };
var queryController = createQueryController({ announcer, getPersisted: () => vscode.getState() || {}, gridAdapter: createQueryFocusGridAdapter(), onCount: onQueryCount, onRejected: onQueryRejected, onRows, onSummary: onQuerySummary, persist: (preferences2) => vscode.setState({ ...vscode.getState() || {}, ...preferences2 }), post: (message) => send(message), root: document, status: els.status });
function createQueryFocusGridAdapter() {
  let saved;
  return {
    /** Temporarily removes the grid from keyboard traversal without requesting data. */
    enterQueryFocusMode() {
      const active = els.gridwrap.querySelector('[role="gridcell"][tabindex="0"]');
      saved = { activeKey: active?.dataset.key || "", rowIndex: active?.closest("tr")?.dataset.rowIndex || "", scrollLeft: els.gridwrap.scrollLeft, scrollTop: els.gridwrap.scrollTop };
      els.gridwrap.inert = true;
      els.gridwrap.setAttribute("aria-hidden", "true");
      els.gridwrap.hidden = true;
    },
    /** Restores the exact captured view state when query focus mode ends. */
    exitQueryFocusMode() {
      els.gridwrap.inert = false;
      els.gridwrap.removeAttribute("aria-hidden");
      els.gridwrap.hidden = false;
      if (!saved) {
        return;
      }
      els.gridwrap.scrollLeft = saved.scrollLeft;
      els.gridwrap.scrollTop = saved.scrollTop;
      const row = [...els.gridwrap.querySelectorAll("tr[data-row-index]")].find((node) => node.dataset.rowIndex === saved.rowIndex);
      row?.querySelectorAll('[role="gridcell"]').forEach((cell) => {
        if (cell.dataset.key === saved.activeKey) {
          cell.focus();
        }
      });
      saved = void 0;
    },
    /** Returns the documented non-mutating grid view projection. */
    getGridViewState() {
      const active = els.gridwrap.querySelector('[role="gridcell"][tabindex="0"]');
      return { activeGridFocusKey: active?.dataset.key || "", scrollLeft: els.gridwrap.scrollLeft, scrollTop: els.gridwrap.scrollTop, selectedRowKey: active?.closest("tr")?.dataset.rowIndex || "" };
    }
  };
}
var pendingRelated = /* @__PURE__ */ new Map();
var relRequestId = 0;
var progressLabel = "";
var progressStartedAt = 0;
var progressTimer = 0;
var gridSnapshot;
var gridViewport;
var detailTrigger;
var commitInFlight = false;
var editor = createEditor({
  post: (message) => vscode.postMessage(message),
  reload: () => send({ type: "reload" }),
  paintCell: (td) => paintCell(td),
  onChange: (count) => updateEditButtons(count),
  onCommitEnd: () => {
    commitInFlight = false;
    setCommitBlocked(false);
    updateEditButtons(editor.pendingCount());
  },
  onCommitStart: (count) => {
    commitInFlight = true;
    setCommitBlocked(true);
    els.status.textContent = `Committing ${count} changes\u2026`;
    announcer.announceStatus(`Committing ${count} changes\u2026`);
  },
  notify: (text) => {
    els.status.textContent = text;
  }
});
var virtual = createVirtualRows({
  scroller: els.gridwrap,
  getBody: () => document.getElementById("tbody"),
  columnSpan: () => 1 + (gridSnapshot?.pinned.length || 0) + (gridSnapshot?.visible.length || 0) + Number(Boolean(gridSnapshot?.leftSpacerWidth)) + Number(Boolean(gridSnapshot?.rightSpacerWidth)),
  buildRow: (row, index) => {
    const tr = buildRow(row, index);
    editor.applyStaged(tr);
    return tr;
  },
  maxRows: () => Math.max(1, Math.floor(DOM_CELL_BUDGET / Math.max(1, (gridSnapshot?.pinned.length || 0) + (gridSnapshot?.visible.length || 0)))),
  onRender: () => repaintPins(els.gridwrap, state),
  shouldWindow: (rowCount) => gridViewport?.shouldVirtualizeRows(rowCount) ?? rowCount > 80
});
gridViewport = createGridViewport({
  onChange: (snapshot) => renderViewport(snapshot),
  pinned: () => state.pinned,
  scroller: els.gridwrap,
  widths: () => state.widths
});
var queryRunUi = createQueryRunUi({ announcer, post: (message) => vscode.postMessage(message), status: els.status });
var gridHeader = createGridHeaderRenderer({ el, relationKindLabel, relationModelName, state });
window.addEventListener("message", (event) => handleMessage(event.data));
els.reload.addEventListener("click", () => send({ type: "reload" }));
els.more.addEventListener("click", () => send({ type: "loadMore" }));
if (els.pageSize) {
  els.pageSize.addEventListener("change", () => send({ type: "reload" }));
}
els.count.addEventListener("click", () => send({ type: "requestCount" }));
els.commit.addEventListener("click", () => editor.commitEdits());
els.discard.addEventListener("click", () => editor.discardEdits());
els.transport.addEventListener("change", () => vscode.postMessage({ type: "setTransport", mode: els.transport.value }));
els.logToggle.addEventListener("click", () => {
  const open = els.logpanel.hidden;
  toggleLogPanel({ open, panel: els.logpanel, toggle: els.logToggle });
  vscode.setState({ ...vscode.getState() || {}, logOpen: open });
});
els.logClear.addEventListener("click", () => {
  els.logbody.innerHTML = "";
});
els.logMode.addEventListener("click", () => {
  const showOrm = els.logbody.classList.toggle("mode-orm");
  els.logbody.classList.toggle("mode-sql", !showOrm);
  els.logMode.textContent = showOrm ? "View: Django ORM" : "View: SQL";
});
installLogDrawer({ panel: els.logpanel, resizeHandle: els.logresize, toggle: els.logToggle, vscode });
els.fieldfindClose.addEventListener("click", () => closeFieldFinder());
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === "f" || event.key === "F")) {
    event.preventDefault();
    toggleFieldFinder();
  } else if (event.key === "Escape" && !els.fieldfinder.hidden) {
    closeFieldFinder();
  }
});
vscode.postMessage({ type: "ready" });
function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    return;
  }
  if (queryController.onMessage(message)) {
    return;
  }
  if (message.type === "loading") {
    renderLoading(message);
  } else if (message.type === "schema") {
    onSchema(message.schema);
  } else if (message.type === "rows") {
    onRows(message);
  } else if (message.type === "related") {
    onRelated(message);
  } else if (message.type === "lookup") {
    editor.onLookup(message);
  } else if (message.type === "filterFields") {
  } else if (message.type === "computed") {
    onComputed(message);
  } else if (message.type === "count") {
    onQueryCount(message, queryController.getSnapshot());
  } else if (message.type === "commit") {
    logSql(`commit ${state.model}`, message.result && message.result.sql, message.result && message.result.orm);
    editor.handleResult(message.result);
  } else if (message.type === "transport") {
    els.transport.value = message.mode || "auto";
    els.transportInfo.innerHTML = message.mode === "orm" ? '<span class="pty">\u25CF ORM cell</span>' : message.active === "tcp" ? '<span class="on">\u25CF socket</span>' : message.active === "pty" ? '<span class="pty">\u25CF terminal</span>' : '<span class="off">\u25CB not connected</span>';
  } else if (message.type === "queryMode") {
    enterQueryMode((payload) => send(payload), message.code || "");
  } else if (message.type === "measureQueryEditor") {
    measureQueryEditor(Boolean(message.show));
  } else if (message.type === "queryDraft") {
    setQueryDraft(message.code);
  } else if (message.type === "queryStarted") {
    queryRunUi.render({ startedAt: Date.now(), state: "running" });
  } else if (message.type === "queryRunState") {
    queryRunUi.render(message.snapshot || { state: "idle" });
  } else if (message.type === "overlayRunPython") {
    const code = typeof message.text === "string" ? message.text : String(message.code || "");
    send({ code, type: "runQuery", useOverlay: false });
  } else if (message.type === "busy") {
    renderBusy(message.message);
  } else if (message.type === "error") {
    renderError(message.message);
  }
}
function renderLoading(message) {
  if (!isQuerySurface()) {
    els.title.textContent = message.model || "Model Data";
  }
  els.subtitle.textContent = message.label || "";
  const labels = { aggregate: "Running aggregate\u2026", filters: "Applying filters\u2026", more: "Loading more rows\u2026", rows: "Loading model rows\u2026", schema: "Loading model schema\u2026" };
  const label = labels[message.phase] || "Loading model rows\u2026";
  if (!document.getElementById("tbody")) {
    els.gridwrap.innerHTML = "";
    els.gridwrap.appendChild(el("div", { className: "empty" }, label));
  }
  startProgress(label);
  els.more.disabled = true;
}
function renderBusy(messageText) {
  stopProgress();
  if (!document.getElementById("tbody")) {
    els.gridwrap.innerHTML = "";
    els.gridwrap.appendChild(el("div", { className: "empty" }, messageText || "Django shell is busy."));
  }
  els.status.textContent = messageText || "Django shell is busy.";
  els.more.disabled = true;
}
function onSchema(schema) {
  const model = `${schema.app}.${schema.model}`;
  const sameModel = model === state.model && state.columns.length > 0;
  state.columns = schema.columns || [];
  state.pk = schema.pk || "id";
  state.relations = schema.relations || [];
  state.rowCount = 0;
  state.totalCount = void 0;
  state.order = [];
  if (!sameModel) {
    state.pinned = /* @__PURE__ */ new Set();
    state.computed = {};
    state.computedActive = /* @__PURE__ */ new Set();
    els.gridwrap.scrollLeft = 0;
    els.gridwrap.scrollTop = 0;
  }
  state.model = model;
  queryController.setSource({ app: schema.app, columns: state.columns, model: schema.model, relations: state.relations });
  els.title.textContent = isQuerySurface() ? "ORM Query" : model;
  els.subtitle.textContent = `${schema.label || ""} \xB7 ${schema.table || ""}`;
  els.countinfo.textContent = "";
  installGridTable();
  if (!sameModel) {
    editor.reset();
  }
}
function installGridTable() {
  const table = el("table", { ariaLabel: `${state.model || "Model"} data`, ariaReadOnly: "false", role: "grid" });
  els.gridwrap.innerHTML = "";
  els.gridwrap.appendChild(table);
  table.addEventListener("click", onTableClick);
  table.addEventListener("dblclick", onTableDblClick);
  installGridKeyboard(table, {
    activate: (cell) => {
      const button2 = cell.querySelector("button");
      if (button2) {
        button2.click();
      } else {
        editor.editCell(cell);
      }
    },
    logicalKeys: () => [...gridSnapshot?.pinned || [], ...gridSnapshot?.scrollable || []].map((column) => column.key),
    reveal: revealGridCell,
    closeDetail: closeOpenDetail,
    rowCount: () => state.rowCount,
    viewportRows: () => Math.floor(els.gridwrap.clientHeight / 24)
  });
  gridViewport.setColumns(logicalColumns(state.columns, state.relations, state.widths));
}
function onTableDblClick(event) {
  const td = event.target.closest("td.editable");
  if (td) {
    editor.editCell(td);
  }
}
function updateEditButtons(count) {
  els.commit.textContent = count ? `Commit ${count} changes` : "Commit";
  els.commit.disabled = !count || commitInFlight;
  els.discard.hidden = !count;
  els.discard.disabled = !count || commitInFlight;
  if (count && !commitInFlight) {
    els.status.textContent = `${count} uncommitted changes`;
  }
}
function setCommitBlocked(blocked) {
  for (const control of [els.reload, els.more, els.pageSize, els.count, els.transport, document.getElementById("queryApply"), document.getElementById("queryDrawerApply")]) {
    if (!control) {
      continue;
    }
    if (blocked) {
      control.dataset.commitDisabled = control.disabled ? "preserve" : "restore";
      control.disabled = true;
    } else if (control.dataset.commitDisabled === "restore") {
      control.disabled = false;
      delete control.dataset.commitDisabled;
    } else {
      delete control.dataset.commitDisabled;
    }
  }
}
function relationKindLabel(kind) {
  return { "fk": "FK", "m2m": "m2m", "o2o": "o2o", "reverse-fk": "reverseFK" }[kind] || kind;
}
function relationModelName(target) {
  return String(target || "").split(".").pop();
}
function renderViewport(snapshot) {
  const startedAt = performance.now();
  const table = els.gridwrap.querySelector("table");
  if (!table) {
    return;
  }
  gridSnapshot = snapshot;
  table.setAttribute("aria-colcount", String(1 + snapshot.pinned.length + snapshot.scrollable.length));
  table.setAttribute("aria-rowcount", state.totalCount === void 0 ? "-1" : String(state.totalCount + 1));
  table.style.width = `${Math.max(snapshot.totalWidth, els.gridwrap.clientWidth)}px`;
  table.replaceChildren(gridHeader.buildHead(snapshot), el("tbody", { id: "tbody" }));
  makeResizable(table, state, () => gridViewport.refresh(true));
  virtual.refresh();
  reportGridRender({ logicalRows: state.rowCount, post: vscode.postMessage.bind(vscode), snapshot, startedAt, table });
}
function columnAttnames(columns) {
  return (columns || []).map((column) => column.attname).join(",");
}
function onRows(message) {
  stopProgress();
  const rows = message.rows || {};
  if (!rows.ok) {
    renderError(rows.error || "Could not load rows.");
    return;
  }
  const fallbackColumns = !state.columns.length ? inferColumnsFromRows(rows.rows) : [];
  const responseColumns = Array.isArray(rows.columns) && rows.columns.length ? rows.columns : fallbackColumns;
  const columnsChanged = !message.append && responseColumns.length > 0 && columnAttnames(responseColumns) !== columnAttnames(state.columns);
  if (columnsChanged) {
    state.columns = responseColumns;
  }
  if (!document.getElementById("tbody") || columnsChanged) {
    installGridTable();
  }
  logSql(recipeLogLabel(`rows ${state.model}`, message.queryLog), rows.sql, rows.orm);
  if (!message.append) {
    state.totalCount = void 0;
  }
  updateSortArrows();
  state.rowCount = virtual.setRows(rows.rows || [], Boolean(message.append));
  if (message.append) {
    for (const field of state.computedActive) {
      vscode.postMessage({ type: "loadComputed", field });
    }
  }
  state.hasMore = Boolean(rows.hasMore);
  els.more.disabled = !state.hasMore;
  const loaded = state.rowCount ? `${state.rowCount} row${state.rowCount === 1 ? "" : "s"} loaded${state.hasMore ? " \xB7 more available" : ""}` : "No rows.";
  if (isQuerySurface() && !message.append) {
    const queryStatus = queryRunUi.successText(state.rowCount);
    els.status.textContent = queryStatus;
    announcer.announceStatus(queryStatus);
  } else {
    els.status.textContent = loaded;
  }
}
function onQueryCount(message, snapshot) {
  stopProgress();
  const summary = snapshot?.applied?.mode === "summary";
  const global = summary && !(snapshot.applied.groupBy || []).length;
  els.countinfo.textContent = global ? "\xB7 1 summary row" : message.ok ? `\xB7 ${resultCountLabel(snapshot?.applied, message.count)}` : "\xB7 count failed";
  state.totalCount = message.ok && Number.isFinite(Number(message.count)) ? Number(message.count) : void 0;
  els.gridwrap.querySelector("table")?.setAttribute("aria-rowcount", state.totalCount === void 0 ? "-1" : String(state.totalCount + 1));
  logSql(recipeLogLabel(`count ${state.model}`, message.queryLog), message.sql, message.orm);
}
function onQuerySummary(message, snapshot) {
  stopProgress();
  const result = message.result || {};
  logSql(recipeLogLabel(`summary ${state.model}`, message.queryLog), result.sql, result.orm);
  if (!result.ok) {
    renderError(result.error || "Summary query failed.");
    return;
  }
  const groupBy = (snapshot?.applied?.groupBy || []).map((field) => field.path);
  els.gridwrap.innerHTML = "";
  els.gridwrap.appendChild(renderQuerySummaryTable(result, { el, groupBy, renderValue }));
  const count = (result.rows || []).length;
  els.status.textContent = `${resultCountLabel(snapshot?.applied, count)}${result.hasMore ? " \xB7 more available" : ""}`;
  els.more.disabled = true;
}
function onQueryRejected() {
  stopProgress();
  els.more.disabled = !state.hasMore;
}
function inferColumnsFromRows(rows) {
  const sample = Array.isArray(rows) ? rows.find((row) => row && typeof row === "object" && !Array.isArray(row)) : void 0;
  if (!sample) {
    return [];
  }
  return Object.keys(sample).map((attname) => ({ attname, editable: false, name: attname, type: "Unknown" }));
}
function buildRow(row, index) {
  const pk = rawValue(row[state.pk]);
  const tr = el("tr", { ariaRowIndex: String((index ?? 0) + 2), role: "row" });
  tr.dataset.pk = String(pk);
  tr.dataset.rowIndex = String(index ?? 0);
  tr._pk = pk;
  tr.appendChild(el("td", { ariaColIndex: "1", className: "rownum", role: "rowheader", title: "Row number" }, String((index ?? 0) + 1)));
  const snapshot = gridSnapshot || { leftSpacerWidth: 0, logicalColumnIndices: {}, pinned: [], rightSpacerWidth: 0, visible: [] };
  for (const descriptor of snapshot.pinned) {
    appendRowCell(tr, row, descriptor, pk, snapshot.logicalColumnIndices[descriptor.key]);
  }
  appendRowSpacer(tr, snapshot.leftSpacerWidth, "left");
  for (const descriptor of snapshot.visible) {
    appendRowCell(tr, row, descriptor, pk, snapshot.logicalColumnIndices[descriptor.key]);
  }
  appendRowSpacer(tr, snapshot.rightSpacerWidth, "right");
  if (index === 0) {
    tr.querySelector('[role="gridcell"]')?.setAttribute("tabindex", "0");
  }
  return tr;
}
function appendRowCell(tr, row, descriptor, pk, columnIndex) {
  if (descriptor.kind === "relation") {
    const relation = descriptor.source;
    const td2 = el("td", { ariaColIndex: String(columnIndex ?? 1), ariaReadOnly: "true", className: "relcell", dataset: { key: descriptor.key }, role: "gridcell", tabIndex: -1 });
    td2.style.width = `${descriptor.width}px`;
    td2.appendChild(el("button", { ariaLabel: `Open ${relation.name} related rows`, className: "chip", dataset: { act: "rel", rel: relation.name, pk: String(pk), single: String(Boolean(relation.single)) }, title: `${relation.kind} \u2192 ${relation.target}` }, `${relation.name} \u2192`));
    tr.appendChild(td2);
    return;
  }
  const td = buildCell(row, descriptor.source, pk);
  td.dataset.key = descriptor.key;
  td.setAttribute("aria-colindex", String(columnIndex ?? 1));
  td.setAttribute("role", "gridcell");
  td.setAttribute("aria-readonly", String(!descriptor.source.editable));
  td.tabIndex = -1;
  td.style.width = `${descriptor.width}px`;
  tr.appendChild(td);
}
function appendRowSpacer(tr, width, side) {
  if (!width) {
    return;
  }
  const td = el("td", { ariaHidden: "true", className: "gridspacer", role: "presentation" });
  td.dataset.side = side;
  td.style.width = `${width}px`;
  tr.appendChild(td);
}
function buildCell(row, column, pk) {
  const td = el("td", {});
  td._column = column;
  td._pk = pk;
  if (column.computed) {
    td.classList.add("computed");
    paintComputedCell(td, column, pk);
    return td;
  }
  td._cell = row[column.attname];
  if (column.editable) {
    td.classList.add("editable");
    td.dataset.attname = column.attname;
    td.title = parseEditableArray(column, cellRawText(td._cell)) ? "Double-click to edit list items" : "Double-click to edit";
    td._editval = cellRawText(td._cell);
  }
  paintCell(td);
  return td;
}
function paintComputedCell(td, column, pk) {
  const store = state.computed[column.attname];
  const key = String(pk);
  td.textContent = "";
  if (store && Object.prototype.hasOwnProperty.call(store, key)) {
    td._cell = store[key];
    td.appendChild(renderValue(store[key]));
    td.title = "Computed @property (read-only)";
  } else if (state.computedActive.has(column.attname)) {
    td.appendChild(el("span", { className: "cellnull" }, "\u2026"));
    td.title = "Loading @property\u2026";
  } else {
    td.appendChild(el("span", { className: "cellnull" }, "\xB7"));
    td.title = "Computed @property \u2014 use Load in the header (lazy)";
  }
}
function paintCell(td) {
  const column = td._column;
  td.textContent = "";
  if (td.dataset.staged !== void 0) {
    td.classList.add("dirty");
    td.setAttribute("aria-description", "modified, not committed");
    td.appendChild(el("span", {}, stagedDisplay(column, td.dataset.staged)));
    appendArrayEditButton(td, column, td.dataset.staged);
    return;
  }
  td.classList.remove("dirty");
  td.removeAttribute("aria-description");
  const cell = td._cell;
  td.appendChild(renderValue(cell));
  appendArrayEditButton(td, column, cellRawText(cell));
  if (column.relation && rawValue(cell) !== null && rawValue(cell) !== void 0) {
    const wrap = el("span", { className: "fk" });
    wrap.appendChild(el("button", { ariaLabel: "Expand related row", className: "linkbtn", title: "Expand related row", dataset: { act: "fk", rel: column.relation.field, pk: String(td._pk), val: String(rawValue(cell)) } }, codicon("copy")));
    wrap.appendChild(el("button", { ariaLabel: `Open ${column.relation.target} filtered to this row`, className: "linkbtn", title: `Open ${column.relation.target} filtered to this row`, dataset: { act: "open", target: column.relation.target, val: String(rawValue(cell)) } }, codicon("open-preview")));
    td.appendChild(document.createTextNode(" "));
    td.appendChild(wrap);
  }
}
function cellRawText(cell) {
  if (cell === null || cell === void 0) {
    return "";
  }
  return typeof cell === "object" ? (cell.edit ?? cell.v) == null ? "" : String(cell.edit ?? cell.v) : String(cell);
}
function appendArrayEditButton(td, column, text) {
  if (!column.editable) {
    return;
  }
  const parsed = parseEditableArray(column, text);
  if (!parsed) {
    return;
  }
  const button2 = el("button", { className: "arrayedit-open", dataset: { act: "editArray" }, title: `Edit ${parsed.items.length} list item${parsed.items.length === 1 ? "" : "s"}` }, `\u25A6 ${parsed.items.length}`);
  td.insertBefore(button2, td.firstChild);
}
function renderValue(cell) {
  if (cell === null || cell === void 0) {
    return el("span", { className: "cellnull" }, "null");
  }
  if (typeof cell !== "object") {
    return document.createTextNode(String(cell));
  }
  const span = el("span", {});
  if (cell.t === "bytes") {
    span.appendChild(el("span", { className: "tag" }, `\u2039bytes ${cell.len}\u203A`));
    return span;
  }
  span.appendChild(document.createTextNode(cell.v));
  if (cell.t && cell.t !== "json" && cell.t !== "repr") {
    span.appendChild(document.createTextNode(" "));
    span.appendChild(el("span", { className: "tag" }, cell.t));
  }
  return span;
}
function onTableClick(event) {
  const node = event.target.closest("[data-act]");
  if (!node || event.target.closest(".colresize")) {
    return;
  }
  const data = node.dataset;
  if (data.act === "editArray") {
    editor.editCell(node.closest("td"));
  } else if (data.act === "pin") {
    if (!state.pinned.has(data.col) && !canPinColumn(data.col)) {
      els.status.textContent = "Unpin a field before pinning another; pinned fields can use at most half of the grid width.";
      return;
    }
    togglePin(data.col, node, state, els.gridwrap);
    gridViewport.refresh(true);
  } else if (data.act === "loadComputed") {
    toggleComputed(data.field, node);
  } else if (data.act === "sort") {
    toggleSort(data.col);
  } else if (data.act === "open") {
    const split = data.target.lastIndexOf(".");
    vscode.postMessage({ type: "openModel", app: data.target.slice(0, split), model: data.target.slice(split + 1), filterPk: data.val });
  } else if (data.act === "fk") {
    expandInto(node, { relation: data.rel, pk: coerce(data.pk), value: coerce(data.val), single: true });
  } else if (data.act === "rel") {
    expandInto(node, { relation: data.rel, pk: coerce(data.pk), single: data.single === "true" });
  }
}
function canPinColumn(key) {
  const snapshot = gridViewport.snapshot();
  const next = snapshot.pinned.find((column) => column.key === key) || snapshot.scrollable.find((column) => column.key === key);
  const pinnedWidth = snapshot.pinned.reduce((sum, column) => sum + column.width, 0);
  return Boolean(next) && pinnedWidth + next.width <= Math.max(1, els.gridwrap.clientWidth) / 2;
}
function toggleSort(col) {
  const current = state.order[0];
  if (current && current.field === col && !current.desc) {
    state.order = [{ field: col, desc: true }];
  } else if (current && current.field === col && current.desc) {
    state.order = [];
  } else {
    state.order = [{ field: col, desc: false }];
  }
  updateSortArrows();
  queryController.toggleGridOrder(col, state.order[0]?.desc);
}
function toggleComputed(field, button2) {
  const active = !state.computedActive.has(field);
  if (active) {
    state.computedActive.add(field);
    vscode.postMessage({ type: "loadComputed", field });
  } else {
    state.computedActive.delete(field);
    delete state.computed[field];
  }
  if (button2) {
    button2.classList.toggle("active", active);
    button2.replaceChildren(codicon(active ? "refresh" : "triangle-right"));
    button2.title = active ? "Reload computed values for loaded rows" : "Load this @property for loaded rows (lazy \u2014 not auto-computed)";
  }
  virtual.refresh();
}
function onComputed(message) {
  stopProgress();
  if (!state.computedActive.has(message.field)) {
    return;
  }
  if (!message.ok) {
    els.status.textContent = `Could not compute ${message.field}: ${message.error ? String(message.error).split("\n").pop() : "failed"}`;
    return;
  }
  state.computed[message.field] = message.values || {};
  virtual.refresh();
  if (typeof message.queryCount === "number") {
    const rows = typeof message.rowCount === "number" ? message.rowCount : Object.keys(message.values || {}).length;
    const shape = message.queryCount > rows ? " \xB7 N+1 (per-row property queries)" : message.queryCount <= 2 ? " \xB7 batched" : "";
    els.status.textContent = `${message.field}: ${rows} rows \xB7 ${message.queryCount} SQL queries${shape}`;
  }
}
function updateSortArrows() {
  const arrows = {};
  for (const term of state.order) {
    arrows[term.field] = term.desc ? "arrow-down" : "arrow-up";
  }
  for (const span of els.gridwrap.querySelectorAll(".sortarrow")) {
    const direction = arrows[span.dataset.arrow];
    span.textContent = "";
    span.className = direction ? `sortarrow codicon codicon-${direction}` : "sortarrow";
    span.setAttribute("aria-hidden", "true");
  }
}
function pageSizeValue() {
  const value = els.pageSize ? els.pageSize.value : "50";
  const parsed = Number(value);
  return value === "all" ? ALL_PAGE_SIZE : parsed > 0 ? parsed : 50;
}
function send(message) {
  const label = progressLabelForMessage(message);
  if (label) {
    startProgress(label);
  }
  const applied = queryController.getSnapshot?.();
  const revisioned = ["loadMore", "reload", "requestCount"].includes(message.type) && Number.isSafeInteger(applied?.appliedRevision) ? { ...message, revision: applied.appliedRevision } : message;
  vscode.postMessage({ ...revisioned, pageSize: pageSizeValue() });
}
function progressLabelForMessage(message) {
  if (message.type === "runQuery") {
    return "Running query";
  }
  if (message.type === "loadMore") {
    return "Loading more rows\u2026";
  }
  if (message.type === "reload") {
    return "Reloading rows";
  }
  if (message.type === "requestCount") {
    return "Counting rows";
  }
  if (message.type === "applyQueryRecipe") {
    return "Applying query\u2026";
  }
  return "";
}
function startProgress(label) {
  progressLabel = label;
  progressStartedAt = Date.now();
  updateProgress();
  if (progressTimer) {
    window.clearInterval(progressTimer);
  }
  progressTimer = window.setInterval(updateProgress, 1e3);
}
function updateProgress() {
  if (!progressLabel || !progressStartedAt) {
    return;
  }
  els.status.textContent = `${progressLabel} \xB7 ${durationText(progressStartedAt)} elapsed`;
}
function stopProgress() {
  if (progressTimer) {
    window.clearInterval(progressTimer);
    progressTimer = 0;
  }
  progressLabel = "";
  progressStartedAt = 0;
}
function durationText(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1e3));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
function expandInto(button2, request) {
  if (button2.dataset.open === "1") {
    closeDetail(button2);
    return;
  }
  const body = el("div", { className: "nestedscroll" }, "Loading\u2026");
  els.detailDrawer.hidden = false;
  els.detailContent.replaceChildren(nestedPanel(request.relation, button2, body));
  const requestId = relRequestId += 1;
  pendingRelated.set(requestId, { body, label: request.relation });
  button2.dataset.open = "1";
  detailTrigger = button2;
  vscode.postMessage({ type: "expandRelated", requestId, relation: request.relation, pk: request.pk, value: request.value, single: request.single });
}
function nestedPanel(title, trigger, body) {
  const head = el("div", { className: "nestedhead" });
  head.appendChild(el("span", { className: "tag" }, codicon("chevron-down"), ` ${title}`));
  head.appendChild(el("span", { className: "grow" }));
  const close = el("button", { ariaLabel: "Close related rows", className: "linkbtn", title: "Close" }, codicon("close"));
  close.addEventListener("click", () => closeDetail(trigger));
  head.appendChild(close);
  const wrap = el("div", {});
  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}
function closeDetail(button2) {
  els.detailDrawer.hidden = true;
  els.detailContent.innerHTML = "";
  button2.dataset.open = "";
  detailTrigger = void 0;
  button2.focus();
}
function closeOpenDetail() {
  if (!detailTrigger) {
    return false;
  }
  closeDetail(detailTrigger);
  return true;
}
function onRelated(message) {
  const pending = pendingRelated.get(message.requestId);
  if (!pending) {
    return;
  }
  pendingRelated.delete(message.requestId);
  const container = pending.body;
  container.innerHTML = "";
  const result = message.result || {};
  logSql(`related ${pending.label}`, result.sql, result.orm);
  if (!result.ok) {
    container.appendChild(el("span", { className: "err" }, result.error || "Could not load related rows."));
    return;
  }
  if (!result.rows.length) {
    container.appendChild(el("span", { className: "tag" }, "No related rows."));
    return;
  }
  container.appendChild(buildEditableRelatedTable(result, { el, post: (message2) => vscode.postMessage(message2), renderValue }));
}
function renderError(messageText) {
  stopProgress();
  const detail = renderBrowserError({ create: el, grid: els.gridwrap, message: messageText, onOpenConsole: () => send({ type: "openConsole" }), onRetry: () => send({ type: "reload" }), status: els.status });
  announcer.announceError(detail);
  els.more.disabled = true;
}
function logSql(action, sql, orm) {
  appendLogEntry(els.logbody, action, sql, orm, MAX_LOG_ENTRIES);
}
function rawValue(cell) {
  return cell !== null && typeof cell === "object" ? cell.v : cell;
}
function coerce(text) {
  if (text === "true" || text === "false") {
    return text === "true";
  }
  if (text !== "" && !Number.isNaN(Number(text))) {
    return Number(text);
  }
  return text;
}
function toggleFieldFinder() {
  if (els.fieldfinder.hidden) {
    openFieldFinder();
  } else {
    closeFieldFinder();
  }
}
function openFieldFinder() {
  const options = [];
  for (const column of state.columns || []) {
    const kind = column.annotation ? "computed column" : column.computed ? "@property" : column.type || "";
    options.push({ label: column.attname, title: kind, value: column.attname });
  }
  for (const relation of state.relations || []) {
    options.push({ group: "relations", label: `${relation.name} \u2192`, title: relation.target || "", value: `rel:${relation.name}` });
  }
  els.fieldfindslot.innerHTML = "";
  const combo = createCombobox({ el, onChange: (value) => scrollToField(value), options, placeholder: "type a field name\u2026" });
  els.fieldfindslot.appendChild(combo.node);
  els.fieldfinder.hidden = false;
  combo.focus();
}
function closeFieldFinder() {
  els.fieldfinder.hidden = true;
  els.fieldfindslot.innerHTML = "";
}
function scrollToField(key) {
  if (!key) {
    return;
  }
  if (gridViewport.scrollToKey(key)) {
    requestAnimationFrame(() => focusFoundField(key));
    return;
  }
  focusFoundField(key);
}
function focusFoundField(key) {
  const th = els.gridwrap.querySelector(`thead th[data-key="${key}"]`);
  if (!th) {
    return;
  }
  th.querySelector("button")?.focus();
  th.classList.add("colfound");
  setTimeout(() => th.classList.remove("colfound"), 1200);
}
function revealGridCell(rowIndex, key) {
  els.gridwrap.scrollTop = Math.max(0, rowIndex * 24);
  gridViewport.scrollToKey(key);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const cell = els.gridwrap.querySelector(`tr[data-row-index="${rowIndex}"] [role="gridcell"][data-key="${key}"]`);
    if (cell) {
      for (const peer of els.gridwrap.querySelectorAll('[role="gridcell"][tabindex="0"]')) {
        peer.tabIndex = -1;
      }
      cell.tabIndex = 0;
      cell.focus();
    }
  }));
}
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else {
      node[key] = value;
    }
  }
  for (const child of children) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

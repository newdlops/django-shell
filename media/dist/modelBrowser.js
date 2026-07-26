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
  const entry = document.createElement("div");
  entry.className = "logentry";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${(/* @__PURE__ */ new Date()).toLocaleTimeString()}  \xB7  ${action}`;
  entry.appendChild(meta);
  if (orm) {
    const command = document.createElement("code");
    command.className = "ormcmd";
    command.textContent = orm;
    entry.appendChild(command);
  }
  if (!list.length) {
    const empty = document.createElement("code");
    empty.className = "sql";
    empty.textContent = "(no SQL)";
    entry.appendChild(empty);
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
    entry.appendChild(code);
  }
  logbody.insertBefore(entry, logbody.firstChild);
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
  function move(delta) {
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
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
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
    for (const entry of pending.values()) {
      total += Object.keys(entry.fields).length;
    }
    return total;
  }
  function stage(td, value) {
    const tr = td.closest("tr");
    const key = tr.dataset.pk;
    let entry = pending.get(key);
    if (!entry) {
      entry = { fields: {}, pk: tr._pk };
      pending.set(key, entry);
    }
    entry.fields[td.dataset.attname] = value;
    td.dataset.staged = value;
    ctx.paintCell(td);
    ctx.onChange(pendingCount());
  }
  function applyStaged(tr) {
    const entry = pending.get(tr.dataset.pk);
    if (!entry) {
      return;
    }
    for (const td of tr.children) {
      const attname = td.dataset && td.dataset.attname;
      if (attname && Object.prototype.hasOwnProperty.call(entry.fields, attname)) {
        td.dataset.staged = entry.fields[attname];
        ctx.paintCell(td);
      }
    }
  }
  function editForeignKey(td, column, start) {
    activePicker = openFkPicker(td, column, start, {
      allocId: () => lookupSeq += 1,
      done: () => ctx.paintCell(td),
      post: (message) => ctx.post(message),
      stage: (value) => stage(td, value)
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
      stage: (value) => stage(td, value)
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
        stage(td, input.value);
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
    const move = (moveEvent) => {
      setWidth(th, startWidth + (moveEvent.clientX - startX), state2, onResize);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", move);
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
  const fields = (columns || []).map((column) => ({
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
  return [...fields, ...relationColumns];
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
    const move = (moveEvent) => {
      setPanelHeight(startHeight + (startY - moveEvent.clientY), resizeHandle);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      resizeHandle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      vscode2.setState({ ...vscode2.getState() || {}, logHeight: Math.round(panel.offsetHeight) });
    };
    document.addEventListener("mousemove", move);
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
      const { element: element2, priority } = action;
      const overflow = priority === "secondary" || priority === "context" && narrow;
      const destination = compact && overflow ? menu : compact && priority === "context" ? compactContainer : wideContainer;
      if (element2.parentElement !== destination) {
        destination.appendChild(element2);
      }
      element2.hidden = false;
      if (destination === menu) {
        element2.setAttribute("role", "menuitem");
      } else {
        element2.removeAttribute("role");
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
  const observer = new ResizeObserver((entries) => layout(entries[0]?.contentRect.width));
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
    { element: root.getElementById("groupToggle"), priority: "secondary" },
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

// media/gridCombobox.js
var NONE = -1;
var comboboxSequence = 0;
function createCombobox(deps) {
  const { ariaLabel = "", el: el2, options = [], value = "", placeholder = "", onChange, title = "", dataset } = deps;
  let items = normalize(options);
  let current = value == null ? "" : value;
  let activeIndex = NONE;
  let open = false;
  let visible = [];
  const listId = `cbx-list-${comboboxSequence += 1}`;
  const input = el2("input", { ariaAutocomplete: "list", ariaControls: listId, ariaExpanded: "false", ariaLabel: ariaLabel || title || placeholder || "Choose option", className: "cbx-input", placeholder, role: "combobox", spellcheck: false, title, type: "text" });
  const list = el2("div", { className: "cbx-list", id: listId, role: "listbox" });
  list.hidden = true;
  const node = el2("span", { className: "combobox" }, input, list);
  if (dataset) {
    Object.assign(node.dataset, dataset);
  }
  Object.defineProperty(node, "value", { configurable: true, get: () => current, set: (next) => setValue(next) });
  node._options = items;
  function normalize(list2) {
    return (list2 || []).map((option) => ({ group: option.group || "", label: option.label == null ? String(option.value) : String(option.label), title: option.title || "", value: option.value }));
  }
  function labelFor(target) {
    const found = items.find((option) => option.value === target);
    return found ? found.label : "";
  }
  function matches() {
    const query = input.value.trim().toLowerCase();
    if (!query || input.value === labelFor(current)) {
      return items;
    }
    return items.filter((option) => option.label.toLowerCase().includes(query));
  }
  function render() {
    visible = matches();
    activeIndex = visible.length ? Math.max(0, Math.min(activeIndex, visible.length - 1)) : NONE;
    list.innerHTML = "";
    let group = "";
    visible.forEach((option, index) => {
      if (option.group && option.group !== group) {
        group = option.group;
        list.appendChild(el2("div", { ariaHidden: "true", className: "cbx-group", role: "presentation" }, group));
      }
      const optionNode = el2("div", { ariaSelected: String(index === activeIndex), className: index === activeIndex ? "cbx-opt active" : "cbx-opt", id: `${listId}-option-${index}`, role: "option", title: option.title }, option.label);
      optionNode.addEventListener("click", () => choose(option));
      optionNode.addEventListener("mouseenter", () => {
        activeIndex = index;
        highlight();
      });
      list.appendChild(optionNode);
    });
    if (!visible.length) {
      list.appendChild(el2("div", { className: "cbx-empty", role: "status" }, "No matches"));
    }
    syncAria();
  }
  function highlight() {
    let index = 0;
    for (const child of list.children) {
      if (child.className.indexOf("cbx-opt") !== 0) {
        continue;
      }
      child.className = index === activeIndex ? "cbx-opt active" : "cbx-opt";
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
    open = true;
    list.hidden = false;
    const selected = matches().findIndex((option) => option.value === current);
    activeIndex = selected === NONE ? 0 : selected;
    render();
  }
  function hide() {
    open = false;
    list.hidden = true;
    input.value = labelFor(current);
    syncAria();
  }
  function choose(option) {
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
    } else if (event.key === "Home" || event.key === "End") {
      if (!open) {
        return;
      }
      event.preventDefault();
      activeIndex = visible.length ? event.key === "Home" ? 0 : visible.length - 1 : NONE;
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
  return { focus: () => input.focus(), getValue: () => current, node, setOptions, setValue };
}

// media/gridFilter.js
var REL = "r:";
var FIELD = "f:";
var TEXT_TYPES = /Char|Text|Email|Slug|URL|UUID|IP|File|FilePath|Duration|Generic/;
var LENGTH_TYPES = /Char|Text|Email|Slug|URL|FilePath/;
var NUM_TYPES = /Integer|Float|Decimal|AutoField/;
var LOOKUP_LABEL = {
  exact: "=",
  iexact: "= (i)",
  contains: "contains",
  icontains: "contains (i)",
  gt: ">",
  gte: "\u2265",
  lt: "<",
  lte: "\u2264",
  startswith: "starts with",
  istartswith: "starts with (i)",
  endswith: "ends with",
  iendswith: "ends with (i)",
  in: "in (list)",
  isnull: "is null",
  range: "between",
  date: "date =",
  year: "year",
  month: "month",
  day: "day",
  week_day: "weekday",
  quarter: "quarter",
  hour: "hour",
  minute: "minute",
  second: "second",
  length: "length =",
  length__gt: "length >",
  length__gte: "length \u2265",
  length__lt: "length <",
  length__lte: "length \u2264",
  trim: "trimmed ="
};
var INT_LOOKUPS = /* @__PURE__ */ new Set(["year", "month", "day", "week_day", "quarter", "hour", "minute", "second"]);
function defaultLookup(terminal, names) {
  if (!terminal || terminal.role === "relation") {
    return names[0];
  }
  if (TEXT_TYPES.test(String(terminal.type || ""))) {
    return names.includes("icontains") ? "icontains" : names[0];
  }
  return names.includes("exact") ? "exact" : names[0];
}
function splitTarget(target) {
  const at = String(target || "").lastIndexOf(".");
  return at < 0 ? { app: "", model: String(target || "") } : { app: target.slice(0, at), model: target.slice(at + 1) };
}
function lookupsForTerminal(terminal, all) {
  if (!terminal || terminal.role === "relation") {
    return ["isnull"];
  }
  if (terminal.role === "computed") {
    return all;
  }
  const type = String(terminal.type || "");
  if (type === "annotation") {
    return ["exact", "gt", "gte", "lt", "lte", "in", "range", "isnull"];
  }
  if (type === "pk") {
    return ["exact", "in", "isnull"];
  }
  if (type === "BooleanField") {
    return ["exact", "isnull"];
  }
  if (type === "DateTimeField") {
    return ["exact", "gt", "gte", "lt", "lte", "range", "date", "year", "quarter", "month", "week_day", "day", "hour", "minute", "second", "isnull"];
  }
  if (type === "DateField") {
    return ["exact", "gt", "gte", "lt", "lte", "range", "year", "quarter", "month", "week_day", "day", "isnull"];
  }
  if (type === "TimeField") {
    return ["exact", "gt", "gte", "lt", "lte", "range", "hour", "minute", "second", "isnull"];
  }
  if (NUM_TYPES.test(type)) {
    return ["exact", "gt", "gte", "lt", "lte", "in", "range", "isnull"];
  }
  if (TEXT_TYPES.test(type)) {
    const text = ["exact", "iexact", "contains", "icontains", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull"];
    if (LENGTH_TYPES.test(type)) {
      text.push("trim", "length", "length__gt", "length__gte", "length__lt", "length__lte");
    }
    return text;
  }
  return all;
}
function inputTypeFor(type) {
  if (type === "pk") {
    return "text";
  }
  if (type === "annotation") {
    return "number";
  }
  if (type === "DateField") {
    return "date";
  }
  if (type === "DateTimeField") {
    return "datetime-local";
  }
  if (type === "TimeField") {
    return "time";
  }
  if (NUM_TYPES.test(String(type || ""))) {
    return "number";
  }
  return "text";
}
function createFilterBar(deps) {
  const { el: el2, termsEl, activeEl, getState, postRaw, lookups, onRemove } = deps;
  const treeCache = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  let requestSeq = 0;
  let syncToken = 0;
  function onTreeResponse(message) {
    const entry = pending.get(message.requestId);
    if (!entry) {
      return;
    }
    pending.delete(message.requestId);
    const tree = message.result && message.result.ok ? message.result : null;
    if (tree) {
      treeCache.set(entry.target, tree);
    }
    entry.resolve(tree);
  }
  function fetchTree(target) {
    if (treeCache.has(target)) {
      return Promise.resolve(treeCache.get(target));
    }
    const parts = splitTarget(target);
    return new Promise((resolve) => {
      const requestId = ++requestSeq;
      pending.set(requestId, { resolve, target });
      postRaw({ app: parts.app, model: parts.model, requestId, type: "filterFields" });
    });
  }
  function rootOptions(tree) {
    const state2 = getState();
    const options = [];
    if (tree) {
      for (const field of tree.fields || []) {
        if (field.attname === state2.pk) {
          continue;
        }
        options.push({ choices: field.choices, label: field.attname, role: "field", type: field.type, value: `${FIELD}${field.attname}` });
      }
    } else {
      for (const column of state2.columns || []) {
        if (column.computed || column.annotation || column.attname === state2.pk) {
          continue;
        }
        options.push({ choices: column.choices, label: column.attname, role: "field", type: column.type, value: `${FIELD}${column.attname}` });
      }
    }
    const pkColumn = (state2.columns || []).find((column) => column.pk && !column.computed);
    options.push({ label: "pk", role: "field", title: "primary key", type: pkColumn ? pkColumn.type : "pk", value: `${FIELD}pk` });
    for (const column of state2.columns || []) {
      if (column.computed) {
        options.push({ label: column.attname, role: "computed", title: "computed @property", type: "property", value: `${FIELD}${column.attname}` });
      }
    }
    for (const column of state2.columns || []) {
      if (column.annotation && column.type !== "window") {
        options.push({ label: column.attname, role: "field", title: "computed column \xB7 filter as HAVING", type: "annotation", value: `${FIELD}${column.attname}` });
      }
    }
    for (const name of state2.aggregateColumns || []) {
      options.push({ label: name, role: "field", title: "aggregate column \xB7 filter as HAVING", type: "annotation", value: `${FIELD}${name}` });
    }
    for (const relation of relationsOf(tree, state2)) {
      options.push({ kind: relation.kind, label: `${relation.name} \u2192`, role: "relation", target: relation.target, title: `${relation.kind} \u2192 ${bareModel3(relation.target)} (drill in)`, value: `${REL}${relation.name}` });
    }
    return options;
  }
  function nestedOptions(tree) {
    const options = [];
    for (const field of tree && tree.fields || []) {
      options.push({ choices: field.choices, label: field.attname, role: "field", type: field.type, value: `${FIELD}${field.attname}` });
    }
    for (const relation of tree && tree.relations || []) {
      options.push({ kind: relation.kind, label: `${relation.name} \u2192`, role: "relation", target: relation.target, title: `${relation.kind} \u2192 ${bareModel3(relation.target)} (drill in)`, value: `${REL}${relation.name}` });
    }
    return options;
  }
  function relationsOf(tree, state2) {
    return tree ? tree.relations || [] : (state2.relations || []).map((relation) => ({ kind: relation.kind, name: relation.queryName || relation.name, single: relation.single, target: relation.target }));
  }
  function bareModel3(target) {
    return splitTarget(target).model;
  }
  async function addTerm(initial) {
    const term = el2("span", { ariaLabel: "Filter condition", className: "term", role: "group" });
    term._segs = [];
    const path = el2("span", { className: "path", dataset: { role: "path" } });
    const lookupCombo = createCombobox({ ariaLabel: "Filter operator", dataset: { role: "lookup" }, el: el2, onChange: () => rebuildValue(term), options: [], placeholder: "\u2014" });
    term._lookupCombo = lookupCombo;
    const value = el2("span", { className: "valwrap", dataset: { role: "value" } });
    const negate = el2("input", { ariaLabel: "Negate filter", checked: Boolean(initial && initial.negate), dataset: { role: "negate" }, type: "checkbox" });
    const remove = el2("button", { ariaLabel: "Remove filter condition", className: "linkbtn", dataset: { role: "remove" }, title: "Remove filter" }, el2("span", { ariaHidden: "true", className: "codicon codicon-close" }));
    remove.addEventListener("click", () => term.remove());
    term.append(path, lookupCombo.node, value, el2("label", { className: "neg" }, negate, "not"), remove);
    termsEl.appendChild(term);
    const token = syncToken;
    const rootTree = await fetchTree(getState().model);
    if (token !== syncToken) {
      term.remove();
      return term;
    }
    await buildSegment(term, 0, rootOptions(rootTree), initial ? segsFromPath(initial.field) : [], initial);
    return term;
  }
  function segsFromPath(field) {
    const text = String(field || "");
    if (text.startsWith("rel:")) {
      return [text.slice(4)];
    }
    return text ? text.split("__") : [];
  }
  async function buildSegment(term, level, options, preset, initial) {
    const comboOptions = options.map((option) => ({ group: option.role === "relation" ? "relations (drill in \u2192)" : "", label: option.label, title: option.title || "", value: option.value }));
    const presetValue = preset[level];
    const match = presetValue === void 0 ? null : options.find((option) => option.value === `${REL}${presetValue}` || option.value === `${FIELD}${presetValue}`);
    const combo = createCombobox({ ariaLabel: level === 0 ? "Filter field or relation" : `Related filter field ${level + 1}`, dataset: { level: String(level), role: "seg" }, el: el2, onChange: () => void onSegmentChange(term, level), options: comboOptions, placeholder: level === 0 ? "\u2014 pick field / relation \u2014" : "\u2014 exists / pick field \u2014", value: match ? match.value : "" });
    const select = combo.node;
    select._options = options;
    term._segs[level] = { combo, select };
    term.querySelector("[data-role=path]").appendChild(select);
    const chosen = currentOption(select);
    if (chosen && chosen.role === "relation" && preset.length > level + 1) {
      const tree = await fetchTree(chosen.target);
      await buildSegment(term, level + 1, nestedOptions(tree), preset, initial);
      return;
    }
    refreshLookups(term, initial);
  }
  function currentOption(select) {
    return (select._options || []).find((option) => option.value === select.value) || null;
  }
  async function onSegmentChange(term, level) {
    for (let deeper = term._segs.length - 1; deeper > level; deeper -= 1) {
      const seg = term._segs[deeper];
      if (seg && seg.select) {
        seg.select.remove();
      }
      term._segs.pop();
    }
    const select = term._segs[level].select;
    const chosen = currentOption(select);
    if (chosen && chosen.role === "relation" && select.value) {
      const expected = select.value;
      const tree = await fetchTree(chosen.target);
      if (select.value !== expected || !term._segs[level] || term._segs[level].select !== select) {
        return;
      }
      await buildSegment(term, level + 1, nestedOptions(tree), [], null);
      return;
    }
    refreshLookups(term);
  }
  function terminalOf(term) {
    for (let level = term._segs.length - 1; level >= 0; level -= 1) {
      const seg = term._segs[level];
      if (seg && seg.select && seg.select.value) {
        return currentOption(seg.select);
      }
    }
    return null;
  }
  function refreshLookups(term, initial) {
    const combo = term._lookupCombo;
    const terminal = terminalOf(term);
    if (!terminal) {
      combo.setOptions([]);
      combo.setValue("");
      term.querySelector("[data-role=value]").innerHTML = "";
      term._value = null;
      return;
    }
    const names = lookupsForTerminal(terminal, lookups);
    const preferred = initial && initial.lookup || defaultLookup(terminal, names);
    combo.setOptions(names.map((name) => ({ label: LOOKUP_LABEL[name] || name, value: name })));
    combo.setValue(names.includes(preferred) ? preferred : names[0]);
    rebuildValue(term, initial && initial.value);
  }
  function rebuildValue(term, presetValue) {
    const wrap = term.querySelector("[data-role=value]");
    const lookup = term.querySelector("[data-role=lookup]").value;
    const terminal = terminalOf(term);
    const carried = presetValue !== void 0 ? presetValue : term._value ? term._value.getValue() : void 0;
    const control = buildValueControl(terminal, lookup, carried);
    wrap.innerHTML = "";
    wrap.appendChild(control.node);
    term._value = control;
  }
  function buildValueControl(terminal, lookup, presetValue) {
    if (lookup === "isnull") {
      const select = el2("select", { ariaLabel: "Null-value filter" });
      select.append(el2("option", { value: "false" }, "has value"), el2("option", { value: "true" }, "is null"));
      select.value = isTruthy2(presetValue) ? "true" : "false";
      return { getValue: () => select.value, node: select };
    }
    if (lookup === "range") {
      return rangePair(terminal, presetValue);
    }
    if (lookup === "in") {
      return chips(presetValue);
    }
    if ((lookup === "exact" || lookup === "iexact") && terminal && terminal.type === "BooleanField") {
      const select = el2("select", { ariaLabel: "Boolean filter value" });
      select.append(el2("option", { value: "True" }, "true"), el2("option", { value: "False" }, "false"));
      select.value = isTruthy2(presetValue) ? "True" : "False";
      return { getValue: () => select.value, node: select };
    }
    if ((lookup === "exact" || lookup === "iexact") && terminal && Array.isArray(terminal.choices) && terminal.choices.length) {
      const choiceOptions2 = terminal.choices.map((choice) => ({ label: `${choice[1]}`, value: String(choice[0]) }));
      const carried = presetValue === void 0 || presetValue === null ? "" : String(presetValue);
      const selected = choiceOptions2.some((option) => option.value === carried) ? carried : choiceOptions2[0] ? choiceOptions2[0].value : "";
      const combo = createCombobox({ ariaLabel: "Filter value", el: el2, options: choiceOptions2, placeholder: "\u2014 choose \u2014", value: selected });
      return { getValue: () => combo.getValue(), node: combo.node };
    }
    const type = lookup === "date" ? "DateField" : INT_LOOKUPS.has(lookup) || String(lookup).startsWith("length") ? "IntegerField" : terminal ? terminal.type : "";
    const input = el2("input", { ariaLabel: "Filter value", type: inputTypeFor(type) });
    if (presetValue !== void 0 && presetValue !== null) {
      input.value = String(presetValue);
    }
    return { getValue: () => input.value, node: input };
  }
  function rangePair(terminal, presetValue) {
    const type = inputTypeFor(terminal ? terminal.type : "");
    const from = el2("input", { ariaLabel: "Range start", className: "rangefrom", placeholder: "from", type });
    const to = el2("input", { ariaLabel: "Range end", className: "rangeto", placeholder: "to", type });
    const parts = String(presetValue || "").split(",");
    from.value = (parts[0] || "").trim();
    to.value = (parts[1] || "").trim();
    const node = el2("span", { className: "rangewrap" }, from, document.createTextNode(" \u2013 "), to);
    return { getValue: () => `${from.value},${to.value}`, node };
  }
  function chips(presetValue) {
    const values = [];
    const node = el2("span", { ariaLabel: "Filter values", ariaLive: "polite", className: "chips", role: "group" });
    const input = el2("input", { ariaLabel: "Add filter value", className: "chipinput", placeholder: "value + Enter", type: "text" });
    const render = () => {
      node.innerHTML = "";
      values.forEach((text, index) => {
        const close = el2("button", { ariaLabel: `Remove value ${text}`, className: "chipx", title: "Remove", type: "button" }, el2("span", { ariaHidden: "true", className: "codicon codicon-close" }));
        close.addEventListener("click", () => {
          values.splice(index, 1);
          render();
        });
        node.appendChild(el2("span", { className: "filterchip" }, text, close));
      });
      node.appendChild(input);
    };
    const add = (text) => {
      const value = String(text).trim();
      if (value) {
        values.push(value);
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        add(input.value);
        input.value = "";
        render();
        input.focus();
      }
    });
    input.addEventListener("blur", () => {
      if (input.value.trim()) {
        add(input.value);
        input.value = "";
        render();
      }
    });
    for (const part of String(presetValue || "").split(",")) {
      add(part);
    }
    render();
    return { getValue: () => values.join(","), node };
  }
  function isTruthy2(value) {
    return /^(true|1|t|yes|on)$/i.test(String(value === void 0 || value === null ? "" : value).trim());
  }
  function pathOf(term) {
    const names = [];
    for (const seg of term._segs) {
      if (seg && seg.select && seg.select.value) {
        names.push(seg.select.value.slice(2));
      }
    }
    return names.join("__");
  }
  function collect() {
    const filters = [];
    for (const term of termsEl.querySelectorAll(".term")) {
      const field = pathOf(term);
      if (!field || !term._value) {
        continue;
      }
      const lookup = term.querySelector("[data-role=lookup]").value;
      const value = term._value.getValue();
      const negate = term.querySelector("[data-role=negate]").checked;
      filters.push({ field, lookup, negate, value });
    }
    return filters;
  }
  function sync(filters) {
    const token = ++syncToken;
    termsEl.innerHTML = "";
    for (const filter of filters || []) {
      if (token !== syncToken) {
        return;
      }
      void addTerm(filter);
    }
  }
  function snapshot() {
    const terms = [];
    for (const term of termsEl.querySelectorAll(".term")) {
      const lookupNode = term.querySelector("[data-role=lookup]");
      const negateNode = term.querySelector("[data-role=negate]");
      terms.push({ field: pathOf(term), lookup: lookupNode ? lookupNode.value : "", negate: Boolean(negateNode && negateNode.checked), value: term._value ? term._value.getValue() : "" });
    }
    return terms;
  }
  function refresh() {
    sync(snapshot());
  }
  function clear() {
    syncToken += 1;
    termsEl.innerHTML = "";
  }
  function renderSummary(filters) {
    if (!activeEl) {
      return;
    }
    activeEl.innerHTML = "";
    if (!filters.length) {
      activeEl.appendChild(el2("span", { className: "tag" }, "No filters"));
      return;
    }
    activeEl.appendChild(el2("span", { className: "tag" }, "Applied"));
    filters.forEach((filter, index) => {
      const remove = el2("button", { ariaLabel: `Remove filter ${describe(filter)}`, className: "chipx", title: "Remove this filter", type: "button" }, el2("span", { ariaHidden: "true", className: "codicon codicon-close" }));
      remove.addEventListener("click", () => {
        if (onRemove) {
          onRemove(filters.filter((_, other) => other !== index));
        }
      });
      activeEl.appendChild(el2("span", { className: "filterchip", title: "Applied filter \u2014 use Remove to clear" }, describe(filter), remove));
    });
  }
  function describe(filter) {
    const field = String(filter.field || "").replace(/^rel:/, "").replace(/__/g, " \u25B8 ");
    const op = LOOKUP_LABEL[filter.lookup] || filter.lookup;
    const value = filter.lookup === "isnull" ? String(filter.value).toLowerCase() : String(filter.value == null ? "" : filter.value);
    return `${filter.negate ? "not " : ""}${field} ${op} ${value}`.trim();
  }
  return { addTerm: () => void addTerm(null), clear, collect, describe, onTreeResponse, refresh, renderSummary, sync };
}

// media/gridFieldPath.js
var REL2 = "r:";
var FIELD2 = "f:";
function splitTarget2(target) {
  const at = String(target || "").lastIndexOf(".");
  return at < 0 ? { app: "", model: String(target || "") } : { app: target.slice(0, at), model: target.slice(at + 1) };
}
function bareModel(target) {
  return splitTarget2(target).model;
}
function createTreeService(postRaw) {
  const cache = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  let seq = 0;
  function onTreeResponse(message) {
    const entry = pending.get(message.requestId);
    if (!entry) {
      return;
    }
    pending.delete(message.requestId);
    const tree = message.result && message.result.ok ? message.result : null;
    if (tree) {
      cache.set(entry.target, tree);
    }
    entry.resolve(tree);
  }
  function fetchTree(target) {
    if (cache.has(target)) {
      return Promise.resolve(cache.get(target));
    }
    const parts = splitTarget2(target);
    return new Promise((resolve) => {
      const requestId = `ftp-${seq += 1}`;
      pending.set(requestId, { resolve, target });
      postRaw({ app: parts.app, model: parts.model, requestId, type: "filterFields" });
    });
  }
  return { fetchTree, onTreeResponse };
}
function createPathPicker(deps) {
  const { el: el2, fetchTree, getModel, rootOptions, onChange, placeholder } = deps;
  const node = el2("span", { className: "pathpick" });
  const segs = [];
  let token = 0;
  function nestedOptions(tree) {
    const options = [];
    for (const field of tree && tree.fields || []) {
      options.push({ choices: field.choices, label: field.attname, role: "field", type: field.type, value: `${FIELD2}${field.attname}` });
    }
    for (const relation of tree && tree.relations || []) {
      options.push({ kind: relation.kind, label: `${relation.name} \u2192`, role: "relation", target: relation.target, title: `${relation.kind} \u2192 ${bareModel(relation.target)} (drill in)`, value: `${REL2}${relation.name}` });
    }
    return options;
  }
  function currentOption(select) {
    return (select._options || []).find((option) => option.value === select.value) || null;
  }
  function terminal() {
    for (let level = segs.length - 1; level >= 0; level -= 1) {
      if (segs[level] && segs[level].select.value) {
        return currentOption(segs[level].select);
      }
    }
    return null;
  }
  function getPath() {
    const names = [];
    for (const seg of segs) {
      if (seg && seg.select.value) {
        names.push(seg.select.value.slice(2));
      }
    }
    return names.join("__");
  }
  function toMany() {
    for (const seg of segs) {
      if (seg && seg.select.value) {
        const option = currentOption(seg.select);
        if (option && option.role === "relation" && (option.kind === "reverse-fk" || option.kind === "m2m")) {
          return true;
        }
      }
    }
    return false;
  }
  function notify() {
    if (onChange) {
      onChange(terminal(), getPath());
    }
  }
  function buildSegment(level, options) {
    const comboOptions = options.map((option) => ({ group: option.role === "relation" ? "relations (drill in \u2192)" : "", label: option.label, title: option.title || "", value: option.value }));
    const combo = createCombobox({ el: el2, onChange: () => void onSegmentChange(level), options: comboOptions, placeholder: level === 0 ? placeholder || "\u2014 field \u2014" : "\u2014 field / relation \u2014", value: "" });
    combo.node._options = options;
    segs[level] = { combo, select: combo.node };
    node.appendChild(combo.node);
  }
  async function onSegmentChange(level) {
    for (let deeper = segs.length - 1; deeper > level; deeper -= 1) {
      if (segs[deeper]) {
        segs[deeper].select.remove();
      }
      segs.pop();
    }
    const select = segs[level].select;
    const chosen = currentOption(select);
    if (chosen && chosen.role === "relation" && select.value) {
      const expected = select.value;
      const myToken = token += 1;
      const tree = await fetchTree(chosen.target);
      if (myToken !== token || select.value !== expected || !segs[level] || segs[level].select !== select) {
        return;
      }
      buildSegment(level + 1, nestedOptions(tree));
    }
    notify();
  }
  async function init() {
    const myToken = token += 1;
    const tree = await fetchTree(getModel());
    if (myToken !== token) {
      return;
    }
    buildSegment(0, rootOptions(tree));
  }
  void init();
  return { getPath, node, terminal, toMany };
}

// media/gridColumnConditions.js
var MAX_CONDITIONS = 8;
var TEXT_TYPES2 = /Char|Text|Email|Slug|URL|UUID|IP|File|FilePath|Duration|Generic/;
var LENGTH_TYPES2 = /Char|Text|Email|Slug|URL|FilePath/;
var NUM_TYPES2 = /Integer|Float|Decimal|AutoField/;
var INT_LOOKUPS2 = /* @__PURE__ */ new Set(["year", "month", "day", "week_day", "quarter", "hour", "minute", "second"]);
var VALUE_ONLY_LOOKUPS = /* @__PURE__ */ new Set(["in", "isnull", "range"]);
var JOIN_OPTIONS = [{ label: "all (AND)", value: "all" }, { label: "any (OR)", value: "any" }];
var LOOKUP_LABEL2 = {
  exact: "=",
  iexact: "= (i)",
  contains: "contains",
  icontains: "contains (i)",
  gt: ">",
  gte: "\u2265",
  lt: "<",
  lte: "\u2264",
  startswith: "starts with",
  istartswith: "starts with (i)",
  endswith: "ends with",
  iendswith: "ends with (i)",
  in: "in (list)",
  isnull: "is null",
  range: "between",
  date: "date =",
  year: "year",
  month: "month",
  day: "day",
  week_day: "weekday",
  quarter: "quarter",
  hour: "hour",
  minute: "minute",
  second: "second",
  length: "length =",
  length__gt: "length >",
  length__gte: "length \u2265",
  length__lt: "length <",
  length__lte: "length \u2264",
  trim: "trimmed ="
};
function lookupsForTerminal2(terminal, allLookups) {
  const allowed = new Set(allLookups || []);
  if (!terminal || terminal.role === "relation") {
    return allowed.has("isnull") ? ["isnull"] : [];
  }
  const type = String(terminal.type || "");
  let preferred;
  if (type === "BooleanField") {
    preferred = ["exact", "isnull"];
  } else if (type === "DateTimeField") {
    preferred = ["exact", "gt", "gte", "lt", "lte", "range", "date", "year", "quarter", "month", "week_day", "day", "hour", "minute", "second", "isnull"];
  } else if (type === "DateField") {
    preferred = ["exact", "gt", "gte", "lt", "lte", "range", "year", "quarter", "month", "week_day", "day", "isnull"];
  } else if (type === "TimeField") {
    preferred = ["exact", "gt", "gte", "lt", "lte", "range", "hour", "minute", "second", "isnull"];
  } else if (NUM_TYPES2.test(type)) {
    preferred = ["exact", "gt", "gte", "lt", "lte", "in", "range", "isnull"];
  } else if (TEXT_TYPES2.test(type)) {
    preferred = ["exact", "iexact", "contains", "icontains", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull"];
    if (LENGTH_TYPES2.test(type)) {
      preferred.push("trim", "length", "length__gt", "length__gte", "length__lt", "length__lte");
    }
  } else {
    preferred = [...allowed];
  }
  return preferred.filter((lookup) => allowed.has(lookup));
}
function defaultLookup2(terminal, names) {
  if (!terminal || terminal.role === "relation") {
    return names[0] || "";
  }
  if (TEXT_TYPES2.test(String(terminal.type || "")) && names.includes("icontains")) {
    return "icontains";
  }
  return names.includes("exact") ? "exact" : names[0] || "";
}
function inputTypeFor2(type) {
  if (type === "DateField") {
    return "date";
  }
  if (type === "DateTimeField") {
    return "datetime-local";
  }
  if (type === "TimeField") {
    return "time";
  }
  if (NUM_TYPES2.test(String(type || ""))) {
    return "number";
  }
  return "text";
}
function isTruthy(value) {
  return /^(true|1|t|yes|on)$/i.test(String(value === void 0 || value === null ? "" : value).trim());
}
function literalValueComplete(lookup, value) {
  if (lookup === "isnull") {
    return true;
  }
  const parts = String(value === void 0 || value === null ? "" : value).split(",").map((part) => part.trim());
  if (lookup === "range") {
    return parts.length === 2 && parts.every(Boolean);
  }
  if (lookup === "in") {
    return parts.some(Boolean);
  }
  return String(value === void 0 || value === null ? "" : value).trim().length > 0;
}
function permitsExpressionRhs(lookup) {
  return Boolean(lookup) && !VALUE_ONLY_LOOKUPS.has(lookup);
}
function createColumnConditionBuilder(deps) {
  const { el: el2, fetchTree, getModel, rootOptions, allLookups = [], outer } = deps;
  const node = el2("span", { className: "colconditions" });
  const toolbar = el2("span", { className: "colcondition-toolbar" });
  const list = el2("span", { className: "colcondition-list", dataset: { role: "condition-list" } });
  const joinCombo = createCombobox({ dataset: { role: "condition-join" }, el: el2, options: JOIN_OPTIONS, value: "all" });
  const addButton = el2("button", { className: "linkbtn", dataset: { role: "condition-add" }, title: `Add a condition (maximum ${MAX_CONDITIONS})`, type: "button" }, "+ condition");
  toolbar.append(el2("span", { className: "tag" }, "where"), joinCombo.node, addButton);
  node.append(toolbar, list);
  function rhsKindOptions(lookup) {
    const options = [{ label: "value", value: "value" }];
    if (permitsExpressionRhs(lookup)) {
      options.push({ label: "target field (F)", value: "field" });
      if (outer) {
        options.push({ label: "current row (OuterRef)", value: "outer" });
      }
    }
    return options;
  }
  function refreshGroupUi() {
    const count = list.querySelectorAll("[data-role=column-condition]").length;
    addButton.disabled = count >= MAX_CONDITIONS;
    joinCombo.node.style.display = count > 1 ? "" : "none";
  }
  function rangeControl(terminal, presetValue) {
    const type = inputTypeFor2(terminal ? terminal.type : "");
    const from = el2("input", { className: "rangefrom", placeholder: "from", type });
    const to = el2("input", { className: "rangeto", placeholder: "to", type });
    const parts = String(presetValue || "").split(",");
    from.value = (parts[0] || "").trim();
    to.value = (parts[1] || "").trim();
    return { getValue: () => `${from.value},${to.value}`, node: el2("span", { className: "rangewrap", dataset: { role: "condition-value" } }, from, document.createTextNode(" \u2013 "), to) };
  }
  function listControl(presetValue) {
    const input = el2("input", { className: "condition-list-value", dataset: { role: "condition-value" }, placeholder: "a, b, c", type: "text" });
    input.value = presetValue == null ? "" : String(presetValue);
    return { getValue: () => input.value, node: input };
  }
  function literalControl(terminal, lookup, presetValue) {
    if (lookup === "isnull") {
      const select = el2("select", { dataset: { role: "condition-value" } });
      select.append(el2("option", { value: "false" }, "has value"), el2("option", { value: "true" }, "is null"));
      select.value = isTruthy(presetValue) ? "true" : "false";
      return { getValue: () => select.value, node: select };
    }
    if (lookup === "range") {
      return rangeControl(terminal, presetValue);
    }
    if (lookup === "in") {
      return listControl(presetValue);
    }
    if ((lookup === "exact" || lookup === "iexact") && terminal && terminal.type === "BooleanField") {
      const select = el2("select", { dataset: { role: "condition-value" } });
      select.append(el2("option", { value: "True" }, "true"), el2("option", { value: "False" }, "false"));
      select.value = isTruthy(presetValue) ? "True" : "False";
      return { getValue: () => select.value, node: select };
    }
    if ((lookup === "exact" || lookup === "iexact") && terminal && Array.isArray(terminal.choices) && terminal.choices.length) {
      const options = terminal.choices.map((choice) => ({ label: String(choice[1]), value: String(choice[0]) }));
      const selected = options.some((option) => option.value === String(presetValue)) ? String(presetValue) : options[0].value;
      const combo = createCombobox({ dataset: { role: "condition-value" }, el: el2, options, value: selected });
      return { getValue: () => combo.getValue(), node: combo.node };
    }
    const extractedType = lookup === "date" ? "DateField" : INT_LOOKUPS2.has(lookup) || lookup.startsWith("length") ? "IntegerField" : terminal ? terminal.type : "";
    const input = el2("input", { dataset: { role: "condition-value" }, type: inputTypeFor2(extractedType) });
    if (presetValue !== void 0 && presetValue !== null) {
      input.value = String(presetValue);
    }
    return { getValue: () => input.value, node: input };
  }
  function expressionControl(kind) {
    const source = kind === "outer" ? outer : { getModel, rootOptions };
    const picker = createPathPicker({ el: el2, fetchTree, getModel: source.getModel, placeholder: kind === "outer" ? "current field" : "target field", rootOptions: source.rootOptions });
    return { getValue: () => picker.getPath(), node: picker.node, picker };
  }
  function rebuildRhs(row, presetValue) {
    const slot = row.querySelector("[data-role=condition-rhs]");
    const lookup = row._lookup.node.value;
    const priorKind = row._rhsKind.node.value;
    const options = rhsKindOptions(lookup);
    row._rhsKind.setOptions(options);
    row._rhsKind.setValue(options.some((option) => option.value === priorKind) ? priorKind : "value");
    const kind = row._rhsKind.node.value;
    const control = kind === "value" ? literalControl(row._field.terminal(), lookup, presetValue) : expressionControl(kind);
    slot.innerHTML = "";
    slot.appendChild(control.node);
    row._rhs = control;
  }
  function refreshLookups(row) {
    const terminal = row._field.terminal();
    const names = lookupsForTerminal2(terminal, allLookups);
    const previous = row._lookup.node.value;
    row._lookup.setOptions(names.map((name) => ({ label: LOOKUP_LABEL2[name] || name, value: name })));
    row._lookup.setValue(names.includes(previous) ? previous : defaultLookup2(terminal, names));
    rebuildRhs(row);
  }
  function addTerm(initial) {
    if (list.querySelectorAll("[data-role=column-condition]").length >= MAX_CONDITIONS) {
      return null;
    }
    const row = el2("span", { className: "colcondition", dataset: { role: "column-condition" } });
    const fieldSlot = el2("span", { className: "pathpick", dataset: { role: "condition-field" } });
    const field = createPathPicker({ el: el2, fetchTree, getModel, onChange: () => refreshLookups(row), placeholder: "field / relation \u2192", rootOptions });
    const lookup = createCombobox({ dataset: { role: "condition-lookup" }, el: el2, onChange: () => rebuildRhs(row), options: [], placeholder: "lookup" });
    const rhsKind = createCombobox({ dataset: { role: "condition-rhs-kind" }, el: el2, onChange: () => rebuildRhs(row), options: [{ label: "value", value: "value" }], value: "value" });
    const rhsSlot = el2("span", { className: "condition-rhs", dataset: { role: "condition-rhs" } });
    const negate = el2("input", { checked: Boolean(initial && initial.negate), dataset: { role: "condition-negate" }, type: "checkbox" });
    const remove = el2("button", { ariaLabel: "Remove condition", className: "chipx", dataset: { role: "condition-remove" }, title: "Remove condition", type: "button" }, el2("span", { ariaHidden: "true", className: "codicon codicon-close" }));
    remove.addEventListener("click", () => {
      row.remove();
      refreshGroupUi();
    });
    row._field = field;
    row._lookup = lookup;
    row._rhsKind = rhsKind;
    row._rhs = null;
    fieldSlot.appendChild(field.node);
    row.append(fieldSlot, lookup.node, rhsKind.node, rhsSlot, el2("label", { className: "condition-neg" }, negate, "not"), remove);
    list.appendChild(row);
    refreshGroupUi();
    return row;
  }
  function readTerm(row) {
    const field = row._field.getPath();
    const terminal = row._field.terminal();
    const lookup = row._lookup.node.value;
    const kind = row._rhsKind.node.value;
    if (!field || !terminal || !lookup || !row._rhs || !lookupsForTerminal2(terminal, allLookups).includes(lookup)) {
      return null;
    }
    const value = row._rhs.getValue();
    if (kind === "value" && !literalValueComplete(lookup, value) || kind !== "value" && (!permitsExpressionRhs(lookup) || !value)) {
      return null;
    }
    if (kind !== "value" && (!row._rhs.picker || !row._rhs.picker.terminal() || row._rhs.picker.terminal().role === "relation")) {
      return null;
    }
    if (kind === "outer" && !outer) {
      return null;
    }
    const term = { field, lookup, rhs: kind === "value" ? { kind, value } : { field: value, kind } };
    if (terminal.type) {
      term.fieldType = terminal.type;
    }
    if (row.querySelector("[data-role=condition-negate]").checked) {
      term.negate = true;
    }
    if (row._field.toMany() || kind === "field" && row._rhs.picker && row._rhs.picker.toMany()) {
      term.toMany = true;
    }
    return term;
  }
  function collect() {
    const rows = [...list.querySelectorAll("[data-role=column-condition]")];
    if (!rows.length) {
      return { conditions: void 0, invalid: false };
    }
    if (rows.length > MAX_CONDITIONS) {
      return { conditions: void 0, invalid: true };
    }
    const terms = rows.map((row) => {
      const term = readTerm(row);
      row.classList.toggle("invalid", !term);
      return term;
    });
    if (terms.some((term) => !term)) {
      return { conditions: void 0, invalid: true };
    }
    return { conditions: { join: joinCombo.node.value === "any" ? "any" : "all", terms }, invalid: false };
  }
  addButton.addEventListener("click", () => addTerm(null));
  refreshGroupUi();
  return { addTerm: () => addTerm(null), collect, node };
}

// media/gridAggregate.js
var KINDS = [{ label: "Aggregate", value: "aggregate" }, { label: "Subquery", value: "subquery" }, { label: "Annotate", value: "annotate" }, { label: "Window", value: "window" }, { label: "Expr (F)", value: "expr" }];
var AGG_FUNCS = [{ label: "Count", value: "count" }, { label: "Sum", value: "sum" }, { label: "Avg", value: "avg" }, { label: "Min", value: "min" }, { label: "Max", value: "max" }];
var WINDOW_FUNCS = [{ label: "Rank", value: "rank" }, { label: "DenseRank", value: "dense_rank" }, { label: "RowNumber", value: "row_number" }, { label: "Sum", value: "sum" }, { label: "Avg", value: "avg" }, { label: "Min", value: "min" }, { label: "Max", value: "max" }, { label: "Count", value: "count" }];
var WINDOW_AGG = /* @__PURE__ */ new Set(["sum", "avg", "min", "max", "count"]);
var OPS = [{ label: "+", value: "+" }, { label: "\u2212", value: "-" }, { label: "\xD7", value: "*" }, { label: "\xF7", value: "/" }];
var ORDER_DIR = [{ label: "asc", value: "asc" }, { label: "desc", value: "desc" }];
var SUBQUERY_MODES = [{ label: "Relation", value: "relation" }, { label: "Model", value: "model" }];
function bareModel2(target) {
  return String(target || "").split(".").pop();
}
function createColumnBuilder(deps) {
  const { el: el2, groupEl, termsEl, getState, lookups, postRaw } = deps;
  const treeService = createTreeService(postRaw);
  const modelRequests = /* @__PURE__ */ new Map();
  let modelRequestSeq = 0;
  let modelOptionsCache = null;
  function concreteFields() {
    return (getState().columns || []).filter((column) => !column.computed && !column.annotation).map((column) => ({ label: column.attname, title: column.type, value: column.attname }));
  }
  function relationsOf(tree) {
    if (tree) {
      return tree.relations || [];
    }
    return (getState().relations || []).map((relation) => ({ ...relation, name: relation.queryName || relation.name })).filter((relation) => relation.name && relation.target);
  }
  function levelFields(tree) {
    if (tree) {
      return (tree.fields || []).map((field) => ({ attname: field.attname, choices: field.choices, type: field.type }));
    }
    return (getState().columns || []).filter((column) => !column.computed && !column.annotation).map((column) => ({ attname: column.attname, choices: column.choices, type: column.type }));
  }
  function aggRootOptions(tree) {
    const options = [];
    for (const field of levelFields(tree)) {
      options.push({ choices: field.choices, label: field.attname, role: "field", type: field.type, value: `f:${field.attname}` });
    }
    for (const column of getState().columns || []) {
      if (column.computed) {
        options.push({ group: "computed @property", label: column.attname, role: "field", title: "@property (Socket/Auto, when summarizing)", value: `f:${column.attname}` });
      }
    }
    for (const relation of relationsOf(tree)) {
      options.push({ kind: relation.kind, label: `${relation.name} \u2192`, role: "relation", target: relation.target, title: `${relation.kind} \u2192 drill in`, value: `r:${relation.name}` });
    }
    return options;
  }
  function groupRootOptions(tree) {
    const options = [];
    for (const field of levelFields(tree)) {
      options.push({ choices: field.choices, label: field.attname, role: "field", type: field.type, value: `f:${field.attname}` });
    }
    for (const relation of relationsOf(tree)) {
      options.push({ kind: relation.kind, label: `${relation.name} \u2192`, role: "relation", target: relation.target, title: `${relation.kind} \u2192 drill in`, value: `r:${relation.name}` });
    }
    return options;
  }
  function subqueryRelationOptions(tree) {
    const options = [];
    for (const relation of relationsOf(tree)) {
      options.push({ ...relation, group: "relations", label: `${relation.name} \u2192`, role: "relation", title: `${relation.kind} \u2192 ${bareModel2(relation.target)}`, value: relation.name });
    }
    if (!tree) {
      for (const column of getState().columns || []) {
        if (column.relation) {
          options.push({ ...column.relation, group: "foreign keys", kind: "fk", label: `${column.relation.field} \u2192`, name: column.relation.field, role: "relation", title: `FK \u2192 ${bareModel2(column.relation.target)}`, value: column.relation.field });
        }
      }
    }
    return options;
  }
  function subqueryTargetOptions(tree) {
    const options = [];
    for (const field of tree && tree.fields || []) {
      options.push({ choices: field.choices, label: field.attname, role: "field", type: field.type, value: `f:${field.attname}` });
    }
    for (const relation of tree && tree.relations || []) {
      options.push({ kind: relation.kind, label: `${relation.name} \u2192`, role: "relation", target: relation.target, title: `${relation.kind} \u2192 ${bareModel2(relation.target)} (drill in)`, value: `r:${relation.name}` });
    }
    return options;
  }
  function onModelListResponse(message) {
    const entry = modelRequests.get(message.requestId);
    if (!entry) {
      return;
    }
    modelRequests.delete(message.requestId);
    const result = message.result && message.result.ok ? message.result : null;
    const options = result ? (result.models || []).map((model) => ({ label: `${model.app}.${model.model}`, title: model.table || model.label || "", value: `${model.app}.${model.model}` })) : [];
    modelOptionsCache = options;
    entry.resolve(options);
  }
  function fetchModelOptions() {
    if (modelOptionsCache) {
      return Promise.resolve(modelOptionsCache);
    }
    return new Promise((resolve) => {
      const requestId = `models-${modelRequestSeq += 1}`;
      modelRequests.set(requestId, { resolve });
      postRaw({ requestId, type: "modelList" });
    });
  }
  function pathPicker(rootOptions, placeholder) {
    return createPathPicker({ el: el2, fetchTree: treeService.fetchTree, getModel: () => getState().model, placeholder, rootOptions });
  }
  function conditionSpec(builder) {
    const result = builder.collect();
    return { conditions: result.conditions, invalidConditions: result.invalid };
  }
  function addGroupBy() {
    const row = el2("span", { className: "aggchip" });
    const picker = pathPicker(groupRootOptions, "field / fk \u2192");
    const remove = el2("button", { ariaLabel: "Remove group-by field", className: "chipx", title: "Remove group-by field", type: "button" }, el2("span", { ariaHidden: "true", className: "codicon codicon-close" }));
    remove.addEventListener("click", () => row.remove());
    row._picker = picker;
    row.append(picker.node, remove);
    groupEl.appendChild(row);
  }
  function addFieldChip(wrap, value, withDirection, desc) {
    const chip = el2("span", { className: "winchip" });
    const combo = createCombobox({ el: el2, options: concreteFields(), placeholder: "field", value: value || "" });
    const dir = withDirection ? createCombobox({ el: el2, options: ORDER_DIR, value: desc ? "desc" : "asc" }) : null;
    const remove = el2("button", { ariaLabel: "Remove field", className: "chipx", title: "Remove", type: "button" }, el2("span", { ariaHidden: "true", className: "codicon codicon-close" }));
    remove.addEventListener("click", () => chip.remove());
    chip.append(combo.node, ...dir ? [dir.node] : [], remove);
    chip._read = () => withDirection ? { desc: dir.node.value === "desc", field: combo.node.value } : combo.node.value;
    wrap.appendChild(chip);
  }
  function aggregateBody(body, initial) {
    const funcCombo = createCombobox({ el: el2, options: AGG_FUNCS, value: initial && initial.func || "count" });
    const picker = pathPicker(aggRootOptions, "all rows / field / fk \u2192");
    const distinct = el2("input", { checked: Boolean(initial && initial.distinct), title: "Count distinct values", type: "checkbox" });
    const distinctLabel = el2("label", { className: "aggdistinct" }, distinct, "distinct");
    const conditions = createColumnConditionBuilder({ allLookups: lookups, el: el2, fetchTree: treeService.fetchTree, getModel: () => getState().model, rootOptions: groupRootOptions });
    const sync = () => {
      distinctLabel.style.display = funcCombo.node.value === "count" ? "" : "none";
    };
    funcCombo.node.addEventListener("change", sync);
    body.append(funcCombo.node, document.createTextNode(" of "), picker.node, distinctLabel, conditions.node);
    sync();
    return () => ({ distinct: distinct.checked, field: picker.getPath(), func: funcCombo.node.value, toMany: picker.toMany(), ...conditionSpec(conditions) });
  }
  function windowBody(body, initial) {
    const funcCombo = createCombobox({ el: el2, options: WINDOW_FUNCS, value: initial && initial.func || "row_number" });
    const fieldCombo = createCombobox({ el: el2, options: concreteFields(), value: initial && initial.field || "" });
    const partWrap = el2("span", { className: "winwrap" });
    const orderWrap = el2("span", { className: "winwrap" });
    const addPart = el2("button", { className: "linkbtn", type: "button", title: "Add partition field" }, "+part");
    const addOrder = el2("button", { className: "linkbtn", type: "button", title: "Add order field" }, "+order");
    addPart.addEventListener("click", () => addFieldChip(partWrap, "", false));
    addOrder.addEventListener("click", () => addFieldChip(orderWrap, "", true, false));
    const sync = () => {
      fieldCombo.node.style.display = WINDOW_AGG.has(funcCombo.node.value) ? "" : "none";
    };
    funcCombo.node.addEventListener("change", sync);
    for (const field of initial && initial.partitionBy || []) {
      addFieldChip(partWrap, field, false);
    }
    for (const term of initial && initial.orderBy || []) {
      addFieldChip(orderWrap, term.field, true, term.desc);
    }
    body.append(funcCombo.node, document.createTextNode(" of "), fieldCombo.node, el2("span", { className: "tag" }, "over part:"), partWrap, addPart, el2("span", { className: "tag" }, "order:"), orderWrap, addOrder);
    sync();
    return () => ({
      field: fieldCombo.node.value,
      func: funcCombo.node.value,
      orderBy: [...orderWrap.querySelectorAll(".winchip")].map((chip) => chip._read()).filter((term) => term.field),
      partitionBy: [...partWrap.querySelectorAll(".winchip")].map((chip) => chip._read()).filter(Boolean)
    });
  }
  function exprBody(body, initial) {
    const left = el2("input", { className: "aggalias", placeholder: "field / number", spellcheck: false, type: "text", value: initial && initial.left != null ? String(initial.left) : "" });
    const opCombo = createCombobox({ el: el2, options: OPS, value: initial && initial.op || "+" });
    const right = el2("input", { className: "aggalias", placeholder: "field / number", spellcheck: false, type: "text", value: initial && initial.right != null ? String(initial.right) : "" });
    body.append(left, opCombo.node, right);
    return () => ({ left: left.value.trim(), op: opCombo.node.value, right: right.value.trim() });
  }
  function subqueryBody(body, initial) {
    const modeCombo = createCombobox({ el: el2, onChange: () => rebuildMode(), options: SUBQUERY_MODES, value: initial && initial.target && !initial.relation ? "model" : "relation" });
    const content = el2("span", { className: "termbody" });
    let readMode = () => ({});
    body.append(modeCombo.node, content);
    function rebuildMode() {
      content.innerHTML = "";
      readMode = modeCombo.node.value === "model" ? subqueryModelBody(content, initial) : subqueryRelationBody(content, initial);
    }
    rebuildMode();
    return () => readMode();
  }
  function subqueryRelationBody(body, initial) {
    const relationMap = /* @__PURE__ */ new Map();
    const relationCombo = createCombobox({ el: el2, onChange: () => rebuildPickers(), options: [], placeholder: "relation \u2192", value: initial && initial.relation || "" });
    const valueSlot = el2("span", { className: "pathpick" });
    const orderSlot = el2("span", { className: "pathpick" });
    const conditionSlot = el2("span", { className: "condition-slot" });
    const dirCombo = createCombobox({ el: el2, options: ORDER_DIR, value: initial && initial.orderBy && initial.orderBy[0] && initial.orderBy[0].desc ? "desc" : "asc" });
    let targetModel = "";
    let valuePicker = null;
    let orderPicker = null;
    let conditions = null;
    body.append(document.createTextNode("from "), relationCombo.node, document.createTextNode(" take "), valueSlot, document.createTextNode(" order "), orderSlot, dirCombo.node, conditionSlot);
    treeService.fetchTree(getState().model).then((tree) => {
      const options = subqueryRelationOptions(tree);
      relationMap.clear();
      for (const option of options) {
        relationMap.set(option.value, option);
      }
      relationCombo.setOptions(options);
      if (initial && initial.relation) {
        relationCombo.setValue(initial.relation);
      }
      rebuildPickers();
    });
    function rebuildPickers() {
      const relation = relationMap.get(relationCombo.node.value);
      targetModel = relation && relation.target ? relation.target : "";
      valueSlot.innerHTML = "";
      orderSlot.innerHTML = "";
      conditionSlot.innerHTML = "";
      valuePicker = null;
      orderPicker = null;
      conditions = null;
      if (!targetModel) {
        valueSlot.appendChild(el2("span", { className: "tag" }, "field"));
        orderSlot.appendChild(el2("span", { className: "tag" }, "field"));
        return;
      }
      valuePicker = createPathPicker({ el: el2, fetchTree: treeService.fetchTree, getModel: () => targetModel, placeholder: "value field", rootOptions: subqueryTargetOptions });
      orderPicker = createPathPicker({ el: el2, fetchTree: treeService.fetchTree, getModel: () => targetModel, placeholder: "order field", rootOptions: subqueryTargetOptions });
      conditions = createColumnConditionBuilder({
        allLookups: lookups,
        el: el2,
        fetchTree: treeService.fetchTree,
        getModel: () => targetModel,
        outer: { getModel: () => getState().model, rootOptions: groupRootOptions },
        rootOptions: subqueryTargetOptions
      });
      valueSlot.appendChild(valuePicker.node);
      orderSlot.appendChild(orderPicker.node);
      conditionSlot.appendChild(conditions.node);
    }
    return () => {
      const relation = relationMap.get(relationCombo.node.value) || {};
      const orderField = orderPicker ? orderPicker.getPath() : "";
      return {
        field: valuePicker ? valuePicker.getPath() : "",
        filterField: relation.filterField,
        orderBy: orderField ? [{ desc: dirCombo.node.value === "desc", field: orderField }] : [],
        outerField: relation.outerField,
        relation: relationCombo.node.value,
        relationKind: relation.kind,
        target: relation.target,
        throughOwner: relation.throughOwner,
        throughRelation: relation.throughRelation,
        throughSource: relation.throughSource,
        throughTarget: relation.throughTarget,
        ...conditions ? conditionSpec(conditions) : {}
      };
    };
  }
  function subqueryModelBody(body, initial) {
    const modelCombo = createCombobox({ el: el2, onChange: () => rebuildTargetPickers(), options: [], placeholder: "app.Model", value: initial && initial.target || "" });
    const filterSlot = el2("span", { className: "pathpick" });
    const outerSlot = el2("span", { className: "pathpick" });
    const valueSlot = el2("span", { className: "pathpick" });
    const orderSlot = el2("span", { className: "pathpick" });
    const conditionSlot = el2("span", { className: "condition-slot" });
    const dirCombo = createCombobox({ el: el2, options: ORDER_DIR, value: initial && initial.orderBy && initial.orderBy[0] && initial.orderBy[0].desc ? "desc" : "asc" });
    let filterPicker = null;
    let outerPicker = createPathPicker({ el: el2, fetchTree: treeService.fetchTree, getModel: () => getState().model, placeholder: "current field", rootOptions: subqueryTargetOptions });
    let valuePicker = null;
    let orderPicker = null;
    let conditions = null;
    body.append(document.createTextNode("from "), modelCombo.node, document.createTextNode(" where "), filterSlot, document.createTextNode(" = current "), outerSlot, document.createTextNode(" take "), valueSlot, document.createTextNode(" order "), orderSlot, dirCombo.node, conditionSlot);
    outerSlot.appendChild(outerPicker.node);
    fetchModelOptions().then((options) => {
      modelCombo.setOptions(options);
      if (initial && initial.target) {
        modelCombo.setValue(initial.target);
      }
      rebuildTargetPickers();
    });
    function rebuildTargetPickers() {
      filterSlot.innerHTML = "";
      valueSlot.innerHTML = "";
      orderSlot.innerHTML = "";
      conditionSlot.innerHTML = "";
      filterPicker = null;
      valuePicker = null;
      orderPicker = null;
      conditions = null;
      const targetModel = modelCombo.node.value;
      if (!targetModel) {
        filterSlot.appendChild(el2("span", { className: "tag" }, "target field"));
        valueSlot.appendChild(el2("span", { className: "tag" }, "value field"));
        orderSlot.appendChild(el2("span", { className: "tag" }, "order field"));
        return;
      }
      filterPicker = createPathPicker({ el: el2, fetchTree: treeService.fetchTree, getModel: () => targetModel, placeholder: "target field", rootOptions: subqueryTargetOptions });
      valuePicker = createPathPicker({ el: el2, fetchTree: treeService.fetchTree, getModel: () => targetModel, placeholder: "value field", rootOptions: subqueryTargetOptions });
      orderPicker = createPathPicker({ el: el2, fetchTree: treeService.fetchTree, getModel: () => targetModel, placeholder: "order field", rootOptions: subqueryTargetOptions });
      conditions = createColumnConditionBuilder({
        allLookups: lookups,
        el: el2,
        fetchTree: treeService.fetchTree,
        getModel: () => targetModel,
        outer: { getModel: () => getState().model, rootOptions: groupRootOptions },
        rootOptions: subqueryTargetOptions
      });
      filterSlot.appendChild(filterPicker.node);
      valueSlot.appendChild(valuePicker.node);
      orderSlot.appendChild(orderPicker.node);
      conditionSlot.appendChild(conditions.node);
    }
    return () => {
      const orderField = orderPicker ? orderPicker.getPath() : "";
      return {
        field: valuePicker ? valuePicker.getPath() : "",
        filterField: filterPicker ? filterPicker.getPath() : "",
        orderBy: orderField ? [{ desc: dirCombo.node.value === "desc", field: orderField }] : [],
        outerField: outerPicker ? outerPicker.getPath() : "",
        target: modelCombo.node.value,
        ...conditions ? conditionSpec(conditions) : {}
      };
    };
  }
  function annotateBody(body, initial) {
    const expression = el2("input", {
      className: "aggexpr",
      placeholder: "models.F('field') / models.Subquery(...)",
      spellcheck: false,
      title: "Django expression passed to annotate(alias=...)",
      type: "text",
      value: initial && initial.expression != null ? String(initial.expression) : ""
    });
    const conditions = createColumnConditionBuilder({ allLookups: lookups, el: el2, fetchTree: treeService.fetchTree, getModel: () => getState().model, rootOptions: groupRootOptions });
    body.append(expression, conditions.node);
    return () => ({ expression: expression.value.trim(), ...conditionSpec(conditions) });
  }
  function addTerm(initial) {
    let seed = initial || {};
    const row = el2("span", { className: "aggterm" });
    const kindCombo = createCombobox({ el: el2, options: KINDS, value: seed.kind || "aggregate" });
    const body = el2("span", { className: "termbody" });
    const alias = el2("input", { className: "aggalias", placeholder: "as alias", spellcheck: false, type: "text", value: seed.alias || "" });
    const remove = el2("button", { ariaLabel: "Remove column", className: "chipx", title: "Remove column", type: "button" }, el2("span", { ariaHidden: "true", className: "codicon codicon-close" }));
    remove.addEventListener("click", () => row.remove());
    let readBody = () => ({});
    const rebuild = () => {
      body.innerHTML = "";
      const kind = kindCombo.node.value;
      readBody = kind === "annotate" ? annotateBody(body, seed) : kind === "subquery" ? subqueryBody(body, seed) : kind === "window" ? windowBody(body, seed) : kind === "expr" ? exprBody(body, seed) : aggregateBody(body, seed);
    };
    kindCombo.node.addEventListener("change", () => {
      seed = {};
      rebuild();
    });
    row._read = () => ({ alias: alias.value.trim(), kind: kindCombo.node.value, ...readBody() });
    row.append(kindCombo.node, body, document.createTextNode(" as "), alias, remove);
    termsEl.appendChild(row);
    rebuild();
  }
  function defaultAlias(spec) {
    if (spec.kind === "annotate") {
      return "annotate";
    }
    if (spec.kind === "expr") {
      return "expr";
    }
    if (spec.kind === "subquery") {
      return `${spec.relation || "related"}_${spec.field || "value"}`.replace(/[^A-Za-z0-9_]+/g, "_");
    }
    if (spec.kind === "window") {
      return spec.func + (WINDOW_AGG.has(spec.func) && spec.field ? `_${spec.field}` : "");
    }
    return `${spec.field && spec.field !== "*" ? spec.field : "rows"}_${spec.func}`;
  }
  function ensureRows() {
    if (!termsEl.querySelector(".aggterm")) {
      addTerm(null);
    }
  }
  function collect() {
    const groupBy = [];
    for (const row of groupEl.querySelectorAll(".aggchip")) {
      const value = row._picker.getPath();
      if (value && !groupBy.includes(value)) {
        groupBy.push(value);
      }
    }
    const terms = [];
    let droppedToMany = 0;
    let invalidConditions = 0;
    for (const row of termsEl.querySelectorAll(".aggterm")) {
      const spec = row._read();
      if (spec.invalidConditions) {
        invalidConditions += 1;
      }
      const conditionToMany = Boolean(spec.conditions && spec.conditions.terms && spec.conditions.terms.some((term) => term.toMany));
      if (spec.kind === "aggregate" && (spec.toMany || conditionToMany)) {
        if (spec.func === "count") {
          spec.distinct = true;
        } else {
          droppedToMany += 1;
          continue;
        }
      }
      delete spec.invalidConditions;
      delete spec.toMany;
      if (!spec.alias) {
        spec.alias = defaultAlias(spec);
      }
      terms.push(spec);
    }
    return { droppedToMany, groupBy, invalidConditions, terms };
  }
  function clear() {
    groupEl.innerHTML = "";
    termsEl.innerHTML = "";
  }
  return { addGroupBy: () => addGroupBy(), addTerm: () => addTerm(null), clear, collect, ensureRows, onModelListResponse, onTreeResponse: treeService.onTreeResponse };
}
function renderAggregateResult(result, helpers) {
  const { el: el2, renderValue: renderValue2, groupBy } = helpers;
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
for (const id of ["title", "subtitle", "gridwrap", "status", "countinfo", "more", "pageSize", "commit", "discard", "reload", "addFilter", "filterterms", "activefilters", "applyFilter", "clearFilter", "count", "transport", "transportInfo", "logToggle", "logpanel", "logresize", "logbody", "logClear", "logMode", "groupToggle", "aggregatebar", "aggregateGroupBy", "aggregateTerms", "addGroupBy", "addAggregate", "runAggregate", "aggregateOff", "fieldfinder", "fieldfindslot", "fieldfindClose", "interruptQuery", "openQueryConsole", "detailDrawer", "detailContent"]) {
  els[id] = document.getElementById(id);
}
var announcer = createAnnouncer();
installModelBrowserChrome(document);
var LOOKUPS = ["exact", "iexact", "contains", "icontains", "gt", "gte", "lt", "lte", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "range", "date", "year", "quarter", "month", "week_day", "day", "hour", "minute", "second", "length", "length__gt", "length__gte", "length__lt", "length__lte", "trim"];
var MAX_LOG_ENTRIES = 200;
var ALL_PAGE_SIZE = 1e9;
var state = { columns: [], pk: "id", relations: [], rowCount: 0, totalCount: void 0, hasMore: false, filters: [], order: [], annotations: [], model: "", pinned: /* @__PURE__ */ new Set(), widths: {}, computed: {}, computedActive: /* @__PURE__ */ new Set(), aggregateActive: false, aggregateGroupBy: [], aggregateColumns: [] };
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
var filterBar = createFilterBar({
  el,
  termsEl: els.filterterms,
  activeEl: els.activefilters,
  getState: () => state,
  postRaw: (message) => vscode.postMessage(message),
  lookups: LOOKUPS,
  onRemove: removeFilter
});
var columnBuilder = createColumnBuilder({
  el,
  groupEl: els.aggregateGroupBy,
  termsEl: els.aggregateTerms,
  getState: () => state,
  lookups: LOOKUPS,
  postRaw: (message) => vscode.postMessage(message)
});
window.addEventListener("message", (event) => handleMessage(event.data));
els.reload.addEventListener("click", () => send({ type: "reload" }));
els.more.addEventListener("click", () => send({ type: "loadMore" }));
if (els.pageSize) {
  els.pageSize.addEventListener("change", () => send({ type: "reload" }));
}
els.addFilter.addEventListener("click", () => filterBar.addTerm());
els.applyFilter.addEventListener("click", () => applyQuery());
els.clearFilter.addEventListener("click", () => clearQuery());
els.count.addEventListener("click", () => send({ type: "requestCount" }));
els.groupToggle.addEventListener("click", () => toggleColumnPanel());
els.addGroupBy.addEventListener("click", () => columnBuilder.addGroupBy());
els.addAggregate.addEventListener("click", () => columnBuilder.addTerm());
els.runAggregate.addEventListener("click", () => applyColumns());
els.aggregateOff.addEventListener("click", () => clearColumns());
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
    filterBar.onTreeResponse(message);
    columnBuilder.onTreeResponse(message);
  } else if (message.type === "modelList") {
    columnBuilder.onModelListResponse(message);
  } else if (message.type === "computed") {
    onComputed(message);
  } else if (message.type === "count") {
    stopProgress();
    els.countinfo.textContent = message.ok ? `\xB7 total ${message.count}` : `\xB7 count failed`;
    state.totalCount = message.ok && Number.isFinite(Number(message.count)) ? Number(message.count) : void 0;
    els.gridwrap.querySelector("table")?.setAttribute("aria-rowcount", state.totalCount === void 0 ? "-1" : String(state.totalCount + 1));
    logSql(`count ${state.model}`, message.sql, message.orm);
  } else if (message.type === "aggregate") {
    onAggregate(message);
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
  exitAggregateView();
  state.model = model;
  els.title.textContent = isQuerySurface() ? "ORM Query" : model;
  els.subtitle.textContent = `${schema.label || ""} \xB7 ${schema.table || ""}`;
  filterBar.sync(state.filters);
  filterBar.renderSummary(state.filters);
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
  for (const control of [els.reload, els.more, els.pageSize, els.addFilter, els.applyFilter, els.clearFilter, els.count, els.groupToggle, els.runAggregate, els.aggregateOff, els.transport]) {
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
  if (state.aggregateActive || !document.getElementById("tbody") || columnsChanged) {
    exitAggregateView();
    installGridTable();
  }
  logSql(`rows ${state.model}`, rows.sql, rows.orm);
  if (Array.isArray(message.filters)) {
    state.filters = message.filters;
  }
  if (Array.isArray(message.order)) {
    state.order = message.order;
  }
  if (!message.append) {
    state.totalCount = void 0;
    if (columnsChanged && els.filterterms.querySelector(".term")) {
      filterBar.refresh();
    } else {
      filterBar.sync(state.filters);
    }
  }
  updateSortArrows();
  filterBar.renderSummary(state.filters);
  state.rowCount = virtual.setRows(rows.rows || [], Boolean(message.append));
  if (message.append) {
    for (const field of state.computedActive) {
      vscode.postMessage({ type: "loadComputed", field });
    }
  }
  state.hasMore = Boolean(rows.hasMore);
  els.more.disabled = !state.hasMore;
  const filterText = state.filters.length ? ` \xB7 ${state.filters.length} filter${state.filters.length === 1 ? "" : "s"}` : "";
  const loaded = state.rowCount ? `${state.rowCount} row${state.rowCount === 1 ? "" : "s"} loaded${state.hasMore ? " \xB7 more available" : ""}${filterText}` : `No rows${filterText}.`;
  if (isQuerySurface() && !message.append) {
    const queryStatus = queryRunUi.successText(state.rowCount);
    els.status.textContent = queryStatus;
    announcer.announceStatus(queryStatus);
  } else {
    els.status.textContent = loaded;
  }
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
  applyQuery({ collectFilters: false });
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
function applyQuery(options = {}) {
  const collectFilters = options.collectFilters !== false;
  if (collectFilters) {
    state.filters = filterBar.collect();
  }
  filterBar.renderSummary(state.filters);
  if (state.aggregateActive) {
    applyColumns(collectFilters ? void 0 : state.filters);
    return;
  }
  send({ annotations: state.annotations, filters: state.filters, order: state.order, type: "applyQuery" });
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
  vscode.postMessage({ ...message, pageSize: pageSizeValue() });
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
  if (message.type === "aggregate") {
    return "Running aggregate\u2026";
  }
  if (message.type === "applyQuery") {
    return "Applying filters\u2026";
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
function clearQuery() {
  filterBar.clear();
  state.filters = [];
  state.order = [];
  updateSortArrows();
  filterBar.renderSummary(state.filters);
  applyQuery();
}
function toggleColumnPanel() {
  const show = els.aggregatebar.hidden;
  els.aggregatebar.hidden = !show;
  els.groupToggle.classList.toggle("active", show);
  if (show) {
    columnBuilder.ensureRows();
  }
}
function removeFilter(next) {
  state.filters = next;
  filterBar.sync(next);
  if (state.aggregateActive) {
    applyColumns(next);
    return;
  }
  filterBar.renderSummary(next);
  send({ annotations: state.annotations, filters: next, order: state.order, type: "applyQuery" });
}
function applyColumns(filtersOverride) {
  const { droppedToMany, groupBy, invalidConditions, terms } = columnBuilder.collect();
  if (invalidConditions) {
    els.status.textContent = "Complete or remove every column condition before applying.";
    return;
  }
  state.filters = filtersOverride !== void 0 ? filtersOverride : filterBar.collect();
  filterBar.renderSummary(state.filters);
  const drillNote = droppedToMany ? " \xB7 skipped Sum/Avg/Min/Max with a to-many path (use Count, or group by the related model)" : "";
  if (groupBy.length) {
    const aggregates = terms.filter((term) => term.kind === "aggregate").map((term) => ({ alias: term.alias, conditions: term.conditions, distinct: term.distinct, field: term.field, func: term.func }));
    if (!aggregates.length) {
      els.status.textContent = "Add at least one Aggregate column to summarize per group (Annotate/Window/Expr are per-row only).";
      return;
    }
    state.aggregateActive = true;
    state.aggregateGroupBy = groupBy;
    state.annotations = [];
    els.status.textContent = `Summarizing\u2026${drillNote}`;
    send({ type: "aggregate", aggregates, filters: state.filters, groupBy });
  } else {
    exitAggregateView();
    state.annotations = terms;
    applyQuery();
    if (drillNote) {
      els.status.textContent = `Loading\u2026${drillNote}`;
    }
  }
}
function clearColumns() {
  columnBuilder.clear();
  state.annotations = [];
  exitAggregateView();
  applyQuery();
}
function exitAggregateView() {
  state.aggregateActive = false;
  state.aggregateGroupBy = [];
  state.aggregateColumns = [];
}
function onAggregate(message) {
  stopProgress();
  const result = message.result || {};
  logSql(`aggregate ${state.model}`, result.sql, result.orm);
  if (!result.ok) {
    renderError(result.error || "Aggregation failed.");
    return;
  }
  state.aggregateColumns = (result.columns || []).map((column) => column.attname).filter((name) => !state.aggregateGroupBy.includes(name));
  filterBar.refresh();
  els.gridwrap.innerHTML = "";
  els.gridwrap.appendChild(renderAggregateResult(result, { el, groupBy: state.aggregateGroupBy, renderValue }));
  const count = (result.rows || []).length;
  const noun = state.aggregateGroupBy.length ? `group${count === 1 ? "" : "s"}` : "aggregate";
  const scan = result.pythonScan ? " \xB7 @property computed in Python (full scan)" : "";
  els.status.textContent = `${count} ${noun}${result.hasMore ? " \xB7 more available" : ""}${scan}`;
  els.more.disabled = true;
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

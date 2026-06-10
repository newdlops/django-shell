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

// media/gridPin.js
function togglePin(col, button, state2, gridwrap) {
  if (state2.pinned.has(col)) {
    state2.pinned.delete(col);
    button.classList.remove("active");
    button.title = "Pin column (freeze left)";
  } else {
    state2.pinned.add(col);
    button.classList.add("active");
    button.title = "Unpin column";
  }
  repaintPins(gridwrap, state2);
}
function repaintPins(gridwrap, state2) {
  const headRow = gridwrap.querySelector("thead tr");
  const body = gridwrap.querySelector("tbody");
  if (!headRow) {
    return;
  }
  const lead = headRow.children[0] && headRow.children[0].classList.contains("rownum") ? 1 : 0;
  const lefts = {};
  let offset = lead && headRow.children[0] ? headRow.children[0].offsetWidth : 0;
  for (let i = 0; i < state2.columns.length; i += 1) {
    if (state2.pinned.has(state2.columns[i].attname)) {
      lefts[i] = offset;
      offset += headRow.children[i + lead] ? headRow.children[i + lead].offsetWidth : 0;
    }
  }
  for (let i = 0; i < state2.columns.length; i += 1) {
    setPin(headRow.children[i + lead], lefts[i]);
  }
  if (body) {
    for (const row of body.children) {
      if (!row.dataset.pk) {
        continue;
      }
      for (let i = 0; i < state2.columns.length; i += 1) {
        setPin(row.children[i + lead], lefts[i]);
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
  function onLookup(message) {
    if (activePicker) {
      activePicker.fill(message);
    }
  }
  function editCell(td) {
    if (!td.dataset.attname || td.querySelector("input, select")) {
      return;
    }
    const column = td._column || {};
    const start = td.dataset.staged !== void 0 ? td.dataset.staged : td._editval ?? "";
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
    ctx.post({ changes: [...pending.values()], type: "commitEdits" });
  }
  function discardEdits() {
    if (!pending.size) {
      return;
    }
    pending.clear();
    ctx.onChange(0);
    ctx.reload();
  }
  function handleResult(result) {
    const data = result || {};
    if (data.ok) {
      pending.clear();
      ctx.onChange(0);
      ctx.notify(`Committed ${data.saved} row${data.saved === 1 ? "" : "s"}.`);
      ctx.reload();
      return;
    }
    ctx.notify(`Commit failed (nothing saved): ${summarize(data)}`);
  }
  function summarize(data) {
    if (data.error) {
      return data.error.split("\n").pop();
    }
    const failed = (data.results || []).filter((row) => !row.ok);
    return failed.map((row) => `pk=${row.pk} ${row.error || Object.entries(row.fieldErrors || {}).map(([field, messages]) => `${field}: ${messages[0]}`).join("; ")}`).join(" \xB7 ") || "validation error";
  }
  function reset() {
    pending.clear();
    ctx.onChange(0);
  }
  return { applyStaged, commitEdits, discardEdits, editCell, handleResult, onLookup, pendingCount, reset };
}

// media/gridQuery.js
function enterQueryMode(post) {
  const input = document.getElementById("queryinput");
  const run = () => post({ code: input.value, type: "runQuery" });
  document.getElementById("querybar").hidden = false;
  document.getElementById("filterbar").hidden = true;
  const count = document.getElementById("count");
  if (count) {
    count.hidden = true;
  }
  document.getElementById("runQuery").addEventListener("click", run);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      run();
    }
  });
}

// media/gridResize.js
var MIN_WIDTH = 48;
function freezeLayout(table, state2) {
  if (table.dataset.fixed === "1") {
    return;
  }
  for (const th of table.tHead.rows[0].cells) {
    const key = th.dataset.key;
    const width = state2.widths[key] || Math.round(th.getBoundingClientRect().width);
    th.style.width = `${width}px`;
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
    const key = th.dataset.key;
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    const move = (moveEvent) => {
      const width = Math.max(MIN_WIDTH, Math.round(startWidth + (moveEvent.clientX - startX)));
      th.style.width = `${width}px`;
      if (key) {
        state2.widths[key] = width;
      }
      if (onResize) {
        onResize();
      }
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

// media/gridRelated.js
function rawOf(cell) {
  return cell !== null && typeof cell === "object" ? cell.v : cell;
}
function textOf(cell) {
  return cell === null || cell === void 0 ? "" : typeof cell === "object" ? cell.v == null ? "" : String(cell.v) : String(cell);
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
    td.appendChild(el2("button", { className: "linkbtn", dataset: { act: "open", target: column.relation.target, val: String(rawOf(td._cell)) }, title: `Open ${column.relation.target} filtered to this row` }, "\u2197"));
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

// media/gridVirtual.js
var OVERSCAN = 12;
var RENDER_ALL_MAX = 80;
var DEFAULT_ROW_H = 24;
function createVirtualRows(ctx) {
  let rows = [];
  let rowH = DEFAULT_ROW_H;
  let measured = false;
  let renderedFirst = 0;
  let renderedEnd = 0;
  function isEditing() {
    const active = document.activeElement;
    return Boolean(active && ctx.scroller.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName));
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
    const top = ctx.scroller.scrollTop;
    const viewH = ctx.scroller.clientHeight || 0;
    const first = Math.max(0, Math.floor(top / rowH) - OVERSCAN);
    const count = Math.ceil(viewH / rowH) + OVERSCAN * 2;
    return { end: Math.min(rows.length, first + count), first };
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
  function render() {
    if (rows.length <= RENDER_ALL_MAX) {
      paintAll();
    } else {
      const range = windowRange();
      paintWindow(range.first, range.end);
    }
  }
  function onScroll() {
    if (rows.length <= RENDER_ALL_MAX || isEditing()) {
      return;
    }
    const top = ctx.scroller.scrollTop;
    const viewH = ctx.scroller.clientHeight || 0;
    const needFirst = Math.floor(top / rowH);
    const needEnd = Math.ceil((top + viewH) / rowH);
    if (needFirst < renderedFirst || needEnd > renderedEnd) {
      const range = windowRange();
      paintWindow(range.first, range.end);
    }
  }
  ctx.scroller.addEventListener("scroll", onScroll, { passive: true });
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (rows.length > RENDER_ALL_MAX) {
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

// media/gridCombobox.js
var NONE = -1;
function createCombobox(deps) {
  const { el: el2, options = [], value = "", placeholder = "", onChange, title = "", dataset } = deps;
  let items = normalize(options);
  let current = value == null ? "" : value;
  let activeIndex = NONE;
  let open = false;
  let visible = [];
  const input = el2("input", { className: "cbx-input", placeholder, spellcheck: false, title, type: "text" });
  const list = el2("div", { className: "cbx-list" });
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
        list.appendChild(el2("div", { className: "cbx-group" }, group));
      }
      const optionNode = el2("div", { className: index === activeIndex ? "cbx-opt active" : "cbx-opt", title: option.title }, option.label);
      optionNode.addEventListener("click", () => choose(option));
      optionNode.addEventListener("mouseenter", () => {
        activeIndex = index;
        highlight();
      });
      list.appendChild(optionNode);
    });
    if (!visible.length) {
      list.appendChild(el2("div", { className: "cbx-empty" }, "no matches"));
    }
  }
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
  function show() {
    open = true;
    list.hidden = false;
    render();
  }
  function hide() {
    open = false;
    list.hidden = true;
    input.value = labelFor(current);
  }
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
      options.push({ kind: relation.kind, label: `${relation.name} \u2192`, role: "relation", target: relation.target, title: `${relation.kind} \u2192 ${bareModel2(relation.target)} (drill in)`, value: `${REL}${relation.name}` });
    }
    return options;
  }
  function nestedOptions(tree) {
    const options = [];
    for (const field of tree && tree.fields || []) {
      options.push({ choices: field.choices, label: field.attname, role: "field", type: field.type, value: `${FIELD}${field.attname}` });
    }
    for (const relation of tree && tree.relations || []) {
      options.push({ kind: relation.kind, label: `${relation.name} \u2192`, role: "relation", target: relation.target, title: `${relation.kind} \u2192 ${bareModel2(relation.target)} (drill in)`, value: `${REL}${relation.name}` });
    }
    return options;
  }
  function relationsOf(tree, state2) {
    return tree ? tree.relations || [] : (state2.relations || []).map((relation) => ({ kind: relation.kind, name: relation.queryName || relation.name, single: relation.single, target: relation.target }));
  }
  function bareModel2(target) {
    return splitTarget(target).model;
  }
  async function addTerm(initial) {
    const term = el2("span", { className: "term" });
    term._segs = [];
    const path = el2("span", { className: "path", dataset: { role: "path" } });
    const lookupCombo = createCombobox({ dataset: { role: "lookup" }, el: el2, onChange: () => rebuildValue(term), options: [], placeholder: "\u2014" });
    term._lookupCombo = lookupCombo;
    const value = el2("span", { className: "valwrap", dataset: { role: "value" } });
    const negate = el2("input", { checked: Boolean(initial && initial.negate), dataset: { role: "negate" }, type: "checkbox" });
    const remove = el2("button", { className: "linkbtn", dataset: { role: "remove" }, title: "Remove filter" }, "\u2715");
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
    const combo = createCombobox({ dataset: { level: String(level), role: "seg" }, el: el2, onChange: () => void onSegmentChange(term, level), options: comboOptions, placeholder: level === 0 ? "\u2014 pick field / relation \u2014" : "\u2014 exists / pick field \u2014", value: match ? match.value : "" });
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
      const select = el2("select", {});
      select.append(el2("option", { value: "false" }, "has value"), el2("option", { value: "true" }, "is null"));
      select.value = isTruthy(presetValue) ? "true" : "false";
      return { getValue: () => select.value, node: select };
    }
    if (lookup === "range") {
      return rangePair(terminal, presetValue);
    }
    if (lookup === "in") {
      return chips(presetValue);
    }
    if ((lookup === "exact" || lookup === "iexact") && terminal && terminal.type === "BooleanField") {
      const select = el2("select", {});
      select.append(el2("option", { value: "True" }, "true"), el2("option", { value: "False" }, "false"));
      select.value = isTruthy(presetValue) ? "True" : "False";
      return { getValue: () => select.value, node: select };
    }
    if ((lookup === "exact" || lookup === "iexact") && terminal && Array.isArray(terminal.choices) && terminal.choices.length) {
      const choiceOptions2 = terminal.choices.map((choice) => ({ label: `${choice[1]}`, value: String(choice[0]) }));
      const carried = presetValue === void 0 || presetValue === null ? "" : String(presetValue);
      const selected = choiceOptions2.some((option) => option.value === carried) ? carried : choiceOptions2[0] ? choiceOptions2[0].value : "";
      const combo = createCombobox({ el: el2, options: choiceOptions2, placeholder: "\u2014 choose \u2014", value: selected });
      return { getValue: () => combo.getValue(), node: combo.node };
    }
    const type = lookup === "date" ? "DateField" : INT_LOOKUPS.has(lookup) || String(lookup).startsWith("length") ? "IntegerField" : terminal ? terminal.type : "";
    const input = el2("input", { type: inputTypeFor(type) });
    if (presetValue !== void 0 && presetValue !== null) {
      input.value = String(presetValue);
    }
    return { getValue: () => input.value, node: input };
  }
  function rangePair(terminal, presetValue) {
    const type = inputTypeFor(terminal ? terminal.type : "");
    const from = el2("input", { className: "rangefrom", placeholder: "from", type });
    const to = el2("input", { className: "rangeto", placeholder: "to", type });
    const parts = String(presetValue || "").split(",");
    from.value = (parts[0] || "").trim();
    to.value = (parts[1] || "").trim();
    const node = el2("span", { className: "rangewrap" }, from, document.createTextNode(" \u2013 "), to);
    return { getValue: () => `${from.value},${to.value}`, node };
  }
  function chips(presetValue) {
    const values = [];
    const node = el2("span", { className: "chips" });
    const input = el2("input", { className: "chipinput", placeholder: "value + Enter", type: "text" });
    const render = () => {
      node.innerHTML = "";
      values.forEach((text, index) => {
        const close = el2("button", { className: "chipx", title: "Remove", type: "button" }, "\u2715");
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
  function isTruthy(value) {
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
      const remove = el2("button", { className: "chipx", title: "Remove this filter", type: "button" }, "\u2715");
      remove.addEventListener("click", () => {
        if (onRemove) {
          onRemove(filters.filter((_, other) => other !== index));
        }
      });
      activeEl.appendChild(el2("span", { className: "filterchip", title: "Applied filter \u2014 \u2715 to remove" }, describe(filter), remove));
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
      options.push({ label: field.attname, role: "field", type: field.type, value: `${FIELD2}${field.attname}` });
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

// media/gridAggregate.js
var KINDS = [{ label: "Aggregate", value: "aggregate" }, { label: "Window", value: "window" }, { label: "Expr (F)", value: "expr" }];
var AGG_FUNCS = [{ label: "Count", value: "count" }, { label: "Sum", value: "sum" }, { label: "Avg", value: "avg" }, { label: "Min", value: "min" }, { label: "Max", value: "max" }];
var WINDOW_FUNCS = [{ label: "Rank", value: "rank" }, { label: "DenseRank", value: "dense_rank" }, { label: "RowNumber", value: "row_number" }, { label: "Sum", value: "sum" }, { label: "Avg", value: "avg" }, { label: "Min", value: "min" }, { label: "Max", value: "max" }, { label: "Count", value: "count" }];
var WINDOW_AGG = /* @__PURE__ */ new Set(["sum", "avg", "min", "max", "count"]);
var OPS = [{ label: "+", value: "+" }, { label: "\u2212", value: "-" }, { label: "\xD7", value: "*" }, { label: "\xF7", value: "/" }];
var ORDER_DIR = [{ label: "asc", value: "asc" }, { label: "desc", value: "desc" }];
function createColumnBuilder(deps) {
  const { el: el2, groupEl, termsEl, getState, postRaw } = deps;
  const treeService = createTreeService(postRaw);
  function concreteFields() {
    return (getState().columns || []).filter((column) => !column.computed && !column.annotation).map((column) => ({ label: column.attname, title: column.type, value: column.attname }));
  }
  function relationsOf(tree) {
    if (tree) {
      return tree.relations || [];
    }
    return (getState().relations || []).map((relation) => ({ kind: relation.kind, name: relation.queryName || relation.name, target: relation.target })).filter((relation) => relation.name && relation.target);
  }
  function levelFields(tree) {
    if (tree) {
      return (tree.fields || []).map((field) => ({ attname: field.attname, type: field.type }));
    }
    return (getState().columns || []).filter((column) => !column.computed && !column.annotation).map((column) => ({ attname: column.attname, type: column.type }));
  }
  function aggRootOptions(tree) {
    const options = [];
    for (const field of levelFields(tree)) {
      options.push({ label: field.attname, role: "field", type: field.type, value: `f:${field.attname}` });
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
      options.push({ label: field.attname, role: "field", type: field.type, value: `f:${field.attname}` });
    }
    for (const relation of relationsOf(tree)) {
      options.push({ kind: relation.kind, label: `${relation.name} \u2192`, role: "relation", target: relation.target, title: `${relation.kind} \u2192 drill in`, value: `r:${relation.name}` });
    }
    return options;
  }
  function pathPicker(rootOptions, placeholder) {
    return createPathPicker({ el: el2, fetchTree: treeService.fetchTree, getModel: () => getState().model, placeholder, rootOptions });
  }
  function addGroupBy() {
    const row = el2("span", { className: "aggchip" });
    const picker = pathPicker(groupRootOptions, "field / fk \u2192");
    const remove = el2("button", { className: "chipx", title: "Remove group-by field", type: "button" }, "\u2715");
    remove.addEventListener("click", () => row.remove());
    row._picker = picker;
    row.append(picker.node, remove);
    groupEl.appendChild(row);
  }
  function addFieldChip(wrap, value, withDirection, desc) {
    const chip = el2("span", { className: "winchip" });
    const combo = createCombobox({ el: el2, options: concreteFields(), placeholder: "field", value: value || "" });
    const dir = withDirection ? createCombobox({ el: el2, options: ORDER_DIR, value: desc ? "desc" : "asc" }) : null;
    const remove = el2("button", { className: "chipx", title: "Remove", type: "button" }, "\u2715");
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
    const sync = () => {
      distinctLabel.style.display = funcCombo.node.value === "count" ? "" : "none";
    };
    funcCombo.node.addEventListener("change", sync);
    body.append(funcCombo.node, document.createTextNode(" of "), picker.node, distinctLabel);
    sync();
    return () => ({ distinct: distinct.checked, field: picker.getPath(), func: funcCombo.node.value, toMany: picker.toMany() });
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
  function addTerm(initial) {
    let seed = initial || {};
    const row = el2("span", { className: "aggterm" });
    const kindCombo = createCombobox({ el: el2, options: KINDS, value: seed.kind || "aggregate" });
    const body = el2("span", { className: "termbody" });
    const alias = el2("input", { className: "aggalias", placeholder: "as alias", spellcheck: false, type: "text", value: seed.alias || "" });
    const remove = el2("button", { className: "chipx", title: "Remove column", type: "button" }, "\u2715");
    remove.addEventListener("click", () => row.remove());
    let readBody = () => ({});
    const rebuild = () => {
      body.innerHTML = "";
      const kind = kindCombo.node.value;
      readBody = kind === "window" ? windowBody(body, seed) : kind === "expr" ? exprBody(body, seed) : aggregateBody(body, seed);
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
    if (spec.kind === "expr") {
      return "expr";
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
    for (const row of termsEl.querySelectorAll(".aggterm")) {
      const spec = row._read();
      if (spec.kind === "aggregate" && spec.toMany) {
        if (spec.func === "count") {
          spec.distinct = true;
        } else {
          droppedToMany += 1;
          continue;
        }
      }
      delete spec.toMany;
      if (!spec.alias) {
        spec.alias = defaultAlias(spec);
      }
      terms.push(spec);
    }
    return { droppedToMany, groupBy, terms };
  }
  function clear() {
    groupEl.innerHTML = "";
    termsEl.innerHTML = "";
  }
  return { addGroupBy: () => addGroupBy(), addTerm: () => addTerm(null), clear, collect, ensureRows, onTreeResponse: treeService.onTreeResponse };
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
for (const id of ["title", "subtitle", "gridwrap", "status", "countinfo", "more", "pageSize", "commit", "discard", "reload", "addFilter", "filterterms", "activefilters", "applyFilter", "clearFilter", "count", "transport", "transportInfo", "logToggle", "logpanel", "logresize", "logbody", "logClear", "logMode", "groupToggle", "aggregatebar", "aggregateGroupBy", "aggregateTerms", "addGroupBy", "addAggregate", "runAggregate", "aggregateOff", "fieldfinder", "fieldfindslot", "fieldfindClose"]) {
  els[id] = document.getElementById(id);
}
var LOOKUPS = ["exact", "iexact", "contains", "icontains", "gt", "gte", "lt", "lte", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "range", "date", "year", "month", "day"];
var MAX_LOG_ENTRIES = 200;
var ALL_PAGE_SIZE = 1e9;
var state = { columns: [], pk: "id", relations: [], rowCount: 0, hasMore: false, filters: [], order: [], annotations: [], model: "", pinned: /* @__PURE__ */ new Set(), widths: {}, computed: {}, computedActive: /* @__PURE__ */ new Set(), aggregateActive: false, aggregateGroupBy: [], aggregateColumns: [] };
var pendingRelated = /* @__PURE__ */ new Map();
var relRequestId = 0;
var editor = createEditor({
  post: (message) => vscode.postMessage(message),
  reload: () => send({ type: "reload" }),
  paintCell: (td) => paintCell(td),
  onChange: (count) => updateEditButtons(count),
  notify: (text) => {
    els.status.textContent = text;
  }
});
var virtual = createVirtualRows({
  scroller: els.gridwrap,
  getBody: () => document.getElementById("tbody"),
  columnSpan: () => totalColumnCount(),
  buildRow: (row, index) => {
    const tr = buildRow(row, index);
    editor.applyStaged(tr);
    return tr;
  },
  onRender: () => repaintPins(els.gridwrap, state)
});
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
els.count.addEventListener("click", () => vscode.postMessage({ type: "requestCount" }));
els.groupToggle.addEventListener("click", () => toggleColumnPanel());
els.addGroupBy.addEventListener("click", () => columnBuilder.addGroupBy());
els.addAggregate.addEventListener("click", () => columnBuilder.addTerm());
els.runAggregate.addEventListener("click", () => applyColumns());
els.aggregateOff.addEventListener("click", () => clearColumns());
els.commit.addEventListener("click", () => editor.commitEdits());
els.discard.addEventListener("click", () => editor.discardEdits());
els.transport.addEventListener("change", () => vscode.postMessage({ type: "setTransport", mode: els.transport.value }));
els.logToggle.addEventListener("click", () => {
  els.logpanel.hidden = !els.logpanel.hidden;
});
els.logClear.addEventListener("click", () => {
  els.logbody.innerHTML = "";
});
els.logMode.addEventListener("click", () => {
  const showOrm = els.logbody.classList.toggle("mode-orm");
  els.logbody.classList.toggle("mode-sql", !showOrm);
  els.logMode.textContent = showOrm ? "View: Django ORM" : "View: SQL";
});
setupLogResize();
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
  } else if (message.type === "computed") {
    onComputed(message);
  } else if (message.type === "count") {
    els.countinfo.textContent = message.ok ? `\xB7 total ${message.count}` : `\xB7 count failed`;
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
    enterQueryMode((payload) => send(payload));
  } else if (message.type === "error") {
    renderError(message.message);
  }
}
function renderLoading(message) {
  els.title.textContent = message.model || "Model Data";
  els.subtitle.textContent = message.label || "";
  els.gridwrap.innerHTML = "";
  els.gridwrap.appendChild(el("div", { className: "empty" }, "Loading\u2026"));
  els.status.textContent = "";
  els.more.disabled = true;
}
function onSchema(schema) {
  const model = `${schema.app}.${schema.model}`;
  const sameModel = model === state.model && state.columns.length > 0;
  state.columns = schema.columns || [];
  state.pk = schema.pk || "id";
  state.relations = schema.relations || [];
  state.rowCount = 0;
  state.order = [];
  if (!sameModel) {
    state.pinned = /* @__PURE__ */ new Set();
    state.computed = {};
    state.computedActive = /* @__PURE__ */ new Set();
  }
  exitAggregateView();
  state.model = model;
  els.title.textContent = model;
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
  const table = el("table", {});
  table.appendChild(buildHead());
  table.appendChild(el("tbody", { id: "tbody" }));
  els.gridwrap.innerHTML = "";
  els.gridwrap.appendChild(table);
  makeResizable(table, state, () => repaintPins(els.gridwrap, state));
  table.addEventListener("click", onTableClick);
  table.addEventListener("dblclick", onTableDblClick);
}
function onTableDblClick(event) {
  const td = event.target.closest("td.editable");
  if (td) {
    editor.editCell(td);
  }
}
function updateEditButtons(count) {
  els.commit.textContent = count ? `Commit (${count})` : "Commit";
  els.commit.disabled = !count;
  els.discard.disabled = !count;
}
function relationKindLabel(kind) {
  return { "fk": "FK", "m2m": "m2m", "o2o": "o2o", "reverse-fk": "reverseFK" }[kind] || kind;
}
function relationModelName(target) {
  return String(target || "").split(".").pop();
}
function buildHead() {
  const head = el("thead", {});
  const row = el("tr", {});
  row.appendChild(el("th", { className: "rownum", title: "Row number" }, "#"));
  for (const column of state.columns) {
    const sortable = !column.computed;
    const headClass = column.annotation ? "annotation" : column.computed ? "computed" : "sortable";
    const headTitle = sortable ? `Sort by ${column.name} (${column.type})` : `${column.name} (computed @property \u2014 read-only)`;
    const th = el("th", { className: headClass, dataset: sortable ? { act: "sort", col: column.attname, key: column.attname } : { key: column.attname }, title: headTitle });
    const pinned = state.pinned.has(column.attname);
    th.appendChild(el("button", { className: pinned ? "pinbtn active" : "pinbtn", dataset: { act: "pin", col: column.attname }, title: pinned ? "Unpin column" : "Pin column (freeze left)" }, "\u21E4"));
    if (column.computed) {
      const loading = state.computedActive.has(column.attname);
      const cost = column.annotated ? "DB annotation \u2014 single query" : "per-row @property \u2014 N+1";
      th.appendChild(el("button", { className: loading ? "loadbtn active" : "loadbtn", dataset: { act: "loadComputed", field: column.attname }, title: `${loading ? "Reload" : "Load"} this column for loaded rows (${cost})` }, loading ? "\u25BC" : "\u25B7"));
    }
    th.appendChild(document.createTextNode(column.attname));
    if (column.pk) {
      th.appendChild(el("span", { className: "pkmark", title: "primary key" }, "\u25C6"));
    }
    if (sortable) {
      th.appendChild(el("span", { className: "sortarrow", dataset: { arrow: column.attname } }, ""));
    }
    th.appendChild(el("span", { className: "coltype" }, column.relation ? `\u2192 ${column.relation.target}` : column.computed ? column.annotated ? "@property \xB7 1 query" : "@property" : column.type));
    th.appendChild(el("span", { className: "colresize", title: "Drag to resize" }));
    row.appendChild(th);
  }
  for (const relation of state.relations) {
    row.appendChild(el("th", { className: "relcol", dataset: { key: `rel:${relation.name}` }, title: `${relationKindLabel(relation.kind)} \u2192 ${relation.target}` }, document.createTextNode(relation.name), el("span", { className: "coltype" }, `${relationKindLabel(relation.kind)} (${relationModelName(relation.target)})`), el("span", { className: "colresize", title: "Drag to resize" })));
  }
  head.appendChild(row);
  return head;
}
function columnAttnames(columns) {
  return (columns || []).map((column) => column.attname).join(",");
}
function onRows(message) {
  const rows = message.rows || {};
  if (!rows.ok) {
    renderError(rows.error || "Could not load rows.");
    return;
  }
  const columnsChanged = !message.append && Array.isArray(rows.columns) && rows.columns.length > 0 && columnAttnames(rows.columns) !== columnAttnames(state.columns);
  if (columnsChanged) {
    state.columns = rows.columns;
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
  els.status.textContent = state.rowCount ? `${state.rowCount} row${state.rowCount === 1 ? "" : "s"} loaded${state.hasMore ? " \xB7 more available" : ""}${filterText}` : `No rows${filterText}.`;
}
function buildRow(row, index) {
  const pk = rawValue(row[state.pk]);
  const tr = el("tr", {});
  tr.dataset.pk = String(pk);
  tr._pk = pk;
  tr.appendChild(el("td", { className: "rownum", title: "Row number" }, String((index ?? 0) + 1)));
  for (const column of state.columns) {
    tr.appendChild(buildCell(row, column, pk));
  }
  for (const relation of state.relations) {
    const td = el("td", { className: "relcell" });
    td.appendChild(el("button", { className: "chip", dataset: { act: "rel", rel: relation.name, pk: String(pk), single: String(Boolean(relation.single)) }, title: `${relation.kind} \u2192 ${relation.target}` }, `${relation.name} \u2192`));
    tr.appendChild(td);
  }
  return tr;
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
    td.title = "Double-click to edit";
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
    td.title = "Computed @property \u2014 click \u25B7 in the header to load (lazy)";
  }
}
function paintCell(td) {
  const column = td._column;
  td.textContent = "";
  if (td.dataset.staged !== void 0) {
    td.classList.add("dirty");
    td.appendChild(el("span", {}, stagedDisplay(column, td.dataset.staged)));
    return;
  }
  td.classList.remove("dirty");
  const cell = td._cell;
  td.appendChild(renderValue(cell));
  if (column.relation && rawValue(cell) !== null && rawValue(cell) !== void 0) {
    const wrap = el("span", { className: "fk" });
    wrap.appendChild(el("button", { className: "linkbtn", title: "Expand related row", dataset: { act: "fk", rel: column.relation.field, pk: String(td._pk), val: String(rawValue(cell)) } }, "\u2398"));
    wrap.appendChild(el("button", { className: "linkbtn", title: `Open ${column.relation.target} filtered to this row`, dataset: { act: "open", target: column.relation.target, val: String(rawValue(cell)) } }, "\u2197"));
    td.appendChild(document.createTextNode(" "));
    td.appendChild(wrap);
  }
}
function cellRawText(cell) {
  if (cell === null || cell === void 0) {
    return "";
  }
  return typeof cell === "object" ? cell.v == null ? "" : String(cell.v) : String(cell);
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
  if (data.act === "pin") {
    togglePin(data.col, node, state, els.gridwrap);
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
  applyQuery();
}
function toggleComputed(field, button) {
  const active = !state.computedActive.has(field);
  if (active) {
    state.computedActive.add(field);
    vscode.postMessage({ type: "loadComputed", field });
  } else {
    state.computedActive.delete(field);
    delete state.computed[field];
  }
  if (button) {
    button.classList.toggle("active", active);
    button.textContent = active ? "\u25BC" : "\u25B7";
    button.title = active ? "Reload computed values for loaded rows" : "Load this @property for loaded rows (lazy \u2014 not auto-computed)";
  }
  virtual.refresh();
}
function onComputed(message) {
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
    arrows[term.field] = term.desc ? "\u25BC" : "\u25B2";
  }
  for (const span of els.gridwrap.querySelectorAll(".sortarrow")) {
    span.textContent = arrows[span.dataset.arrow] || "";
  }
}
function applyQuery() {
  state.filters = filterBar.collect();
  filterBar.renderSummary(state.filters);
  if (state.aggregateActive) {
    applyColumns();
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
  vscode.postMessage({ ...message, pageSize: pageSizeValue() });
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
  const { droppedToMany, groupBy, terms } = columnBuilder.collect();
  state.filters = filtersOverride !== void 0 ? filtersOverride : filterBar.collect();
  filterBar.renderSummary(state.filters);
  const drillNote = droppedToMany ? " \xB7 skipped Sum/Avg over a to-many relation (use Count, or group by the related model)" : "";
  if (groupBy.length) {
    const aggregates = terms.filter((term) => term.kind === "aggregate").map((term) => ({ alias: term.alias, distinct: term.distinct, field: term.field, func: term.func }));
    if (!aggregates.length) {
      els.status.textContent = "Add at least one Aggregate column to summarize per group (Window/Expr are per-row only).";
      return;
    }
    state.aggregateActive = true;
    state.aggregateGroupBy = groupBy;
    state.annotations = [];
    els.status.textContent = `Summarizing\u2026${drillNote}`;
    vscode.postMessage({ type: "aggregate", aggregates, filters: state.filters, groupBy });
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
function expandInto(button, request) {
  if (button.dataset.open === "1") {
    closeDetail(button);
    return;
  }
  const body = el("div", { className: "nestedscroll" }, "Loading\u2026");
  const row = insertDetailRow(detailAnchor(button.closest("tr")), nestedPanel(request.relation, button, body));
  const requestId = relRequestId += 1;
  pendingRelated.set(requestId, { body, label: request.relation });
  button.dataset.open = "1";
  button._detailRow = row;
  vscode.postMessage({ type: "expandRelated", requestId, relation: request.relation, pk: request.pk, value: request.value, single: request.single });
}
function nestedPanel(title, trigger, body) {
  const head = el("div", { className: "nestedhead" });
  head.appendChild(el("span", { className: "tag" }, `\u25BE ${title}`));
  head.appendChild(el("span", { className: "grow" }));
  const close = el("button", { className: "linkbtn", title: "Close" }, "\u2715 close");
  close.addEventListener("click", () => closeDetail(trigger));
  head.appendChild(close);
  const wrap = el("div", {});
  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}
function closeDetail(button) {
  if (button._detailRow && button._detailRow.isConnected) {
    button._detailRow.remove();
  }
  button._detailRow = null;
  button.dataset.open = "";
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
function detailAnchor(tr) {
  let anchor = tr;
  while (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains("detail")) {
    anchor = anchor.nextElementSibling;
  }
  return anchor;
}
function totalColumnCount() {
  return 1 + state.columns.length + state.relations.length;
}
function insertDetailRow(afterRow, content) {
  const tr = el("tr", { className: "detail" });
  const td = el("td", { colSpan: totalColumnCount() });
  const box = el("div", { className: "nested" });
  box.appendChild(content);
  td.appendChild(box);
  tr.appendChild(td);
  afterRow.parentNode.insertBefore(tr, afterRow.nextElementSibling);
  return tr;
}
function renderError(messageText) {
  els.gridwrap.innerHTML = "";
  els.gridwrap.appendChild(el("div", { className: "err" }, messageText || "Error"));
  els.status.textContent = "";
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
function setupLogResize() {
  const handle = els.logresize;
  const panel = els.logpanel;
  if (!handle || !panel) {
    return;
  }
  const saved = (vscode.getState() || {}).logHeight;
  if (saved) {
    document.documentElement.style.setProperty("--log-h", `${clampLogHeight(saved)}px`);
  }
  handle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panel.offsetHeight;
    handle.classList.add("dragging");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const move = (moveEvent) => {
      const next = clampLogHeight(startHeight + (startY - moveEvent.clientY));
      document.documentElement.style.setProperty("--log-h", `${next}px`);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      persistLogHeight(panel.offsetHeight);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}
function clampLogHeight(value) {
  return Math.max(72, Math.min(value, Math.max(120, window.innerHeight - 160)));
}
function persistLogHeight(height) {
  vscode.setState({ ...vscode.getState() || {}, logHeight: Math.round(height) });
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
  const th = els.gridwrap.querySelector(`thead th[data-key="${key}"]`);
  if (!th) {
    return;
  }
  th.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  th.classList.add("colfound");
  setTimeout(() => th.classList.remove("colfound"), 1200);
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

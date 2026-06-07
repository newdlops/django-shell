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
    td.appendChild(el2("button", { className: "linkbtn", dataset: { act: "open", target: column.relation.target }, title: `Open ${column.relation.target}` }, "\u2197"));
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

// media/modelBrowserSource.js
var vscode = acquireVsCodeApi();
var els = {};
for (const id of ["title", "subtitle", "gridwrap", "status", "countinfo", "more", "pageSize", "commit", "discard", "reload", "addFilter", "filterterms", "activefilters", "applyFilter", "clearFilter", "count", "transport", "transportInfo", "logToggle", "logpanel", "logresize", "logbody", "logClear", "logMode"]) {
  els[id] = document.getElementById(id);
}
var LOOKUPS = ["exact", "iexact", "contains", "icontains", "gt", "gte", "lt", "lte", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "range", "date", "year", "month", "day"];
var REL_FILTER_PREFIX = "rel:";
var MAX_LOG_ENTRIES = 200;
var ALL_PAGE_SIZE = 1e9;
var state = { columns: [], pk: "id", relations: [], rowCount: 0, hasMore: false, filters: [], order: [], model: "", pinned: /* @__PURE__ */ new Set(), widths: {}, computed: {}, computedActive: /* @__PURE__ */ new Set() };
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
window.addEventListener("message", (event) => handleMessage(event.data));
els.reload.addEventListener("click", () => send({ type: "reload" }));
els.more.addEventListener("click", () => send({ type: "loadMore" }));
if (els.pageSize) {
  els.pageSize.addEventListener("change", () => send({ type: "reload" }));
}
els.addFilter.addEventListener("click", () => addFilterTerm());
els.applyFilter.addEventListener("click", () => applyQuery());
els.clearFilter.addEventListener("click", () => clearQuery());
els.count.addEventListener("click", () => vscode.postMessage({ type: "requestCount" }));
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
  } else if (message.type === "computed") {
    onComputed(message);
  } else if (message.type === "count") {
    els.countinfo.textContent = message.ok ? `\xB7 total ${message.count}` : `\xB7 count failed`;
    logSql(`count ${state.model}`, message.sql, message.orm);
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
  state.columns = schema.columns || [];
  state.pk = schema.pk || "id";
  state.relations = schema.relations || [];
  state.rowCount = 0;
  state.order = [];
  state.pinned = /* @__PURE__ */ new Set();
  state.computed = {};
  state.computedActive = /* @__PURE__ */ new Set();
  state.model = `${schema.app}.${schema.model}`;
  els.title.textContent = `${schema.app}.${schema.model}`;
  els.subtitle.textContent = `${schema.label || ""} \xB7 ${schema.table || ""}`;
  syncFilterTerms(state.filters);
  renderFilterSummary();
  els.countinfo.textContent = "";
  const table = el("table", {});
  table.appendChild(buildHead());
  table.appendChild(el("tbody", { id: "tbody" }));
  els.gridwrap.innerHTML = "";
  els.gridwrap.appendChild(table);
  makeResizable(table, state, () => repaintPins(els.gridwrap, state));
  table.addEventListener("click", onTableClick);
  table.addEventListener("dblclick", onTableDblClick);
  editor.reset();
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
    const th = el("th", { className: column.computed ? "computed" : "sortable", dataset: sortable ? { act: "sort", col: column.attname, key: column.attname } : { key: column.attname }, title: sortable ? `Sort by ${column.name} (${column.type})` : `${column.name} (computed @property \u2014 read-only)` });
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
function onRows(message) {
  const rows = message.rows || {};
  if (!rows.ok) {
    renderError(rows.error || "Could not load rows.");
    return;
  }
  logSql(`rows ${state.model}`, rows.sql, rows.orm);
  if (Array.isArray(message.filters)) {
    state.filters = message.filters;
  }
  if (Array.isArray(message.order)) {
    state.order = message.order;
  }
  if (!message.append) {
    syncFilterTerms(state.filters);
  }
  updateSortArrows();
  renderFilterSummary();
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
    wrap.appendChild(el("button", { className: "linkbtn", title: `Open ${column.relation.target}`, dataset: { act: "open", target: column.relation.target } }, "\u2197"));
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
    vscode.postMessage({ type: "openModel", app: data.target.slice(0, split), model: data.target.slice(split + 1) });
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
function addFilterTerm(initial = {}) {
  const options = filterFieldOptions();
  if (!options.length) {
    return;
  }
  const term = el("span", { className: "term" });
  const field = el("select", { dataset: { role: "field" } });
  for (const option of options) {
    field.appendChild(el("option", { title: option.title, value: option.value }, option.label));
  }
  field.value = options.some((option) => option.value === initial.field) ? initial.field : options[0].value;
  const lookup = el("select", { dataset: { role: "lookup" } });
  const value = el("input", { dataset: { role: "value" }, title: "Value (in/range: comma-separated; isnull: true/false)" });
  const negate = el("input", { checked: Boolean(initial.negate), dataset: { role: "negate" }, type: "checkbox" });
  const negwrap = el("label", { className: "neg" }, negate, "not");
  const remove = el("button", { className: "linkbtn", dataset: { role: "remove" }, title: "Remove filter" }, "\u2715");
  remove.addEventListener("click", () => term.remove());
  field.addEventListener("change", () => refreshLookupOptions(term));
  term.appendChild(field);
  term.appendChild(lookup);
  term.appendChild(value);
  term.appendChild(negwrap);
  term.appendChild(remove);
  els.filterterms.appendChild(term);
  refreshLookupOptions(term, initial.lookup);
  value.value = initial.value === void 0 || initial.value === null ? value.value : String(initial.value);
}
function filterFieldOptions() {
  const options = [];
  for (const column of state.columns) {
    if (column.computed && column.annotated) {
      options.push({ label: `${column.attname} (@property \xB7 DB)`, title: "Filter through a declared ORM annotation", value: column.attname });
    } else if (column.computed) {
      options.push({ label: `${column.attname} (@property \xB7 Python)`, title: "Filter by evaluating this Python property across candidate rows", value: column.attname });
    } else if (!column.computed) {
      options.push({ label: column.attname, title: column.type || column.name, value: column.attname });
    }
  }
  for (const relation of state.relations) {
    options.push({ label: `${relation.name} (${relationKindLabel(relation.kind)} exists)`, title: `Filter by related-row existence: ${relation.target}`, value: `${REL_FILTER_PREFIX}${relation.name}` });
  }
  return options;
}
function refreshLookupOptions(term, preferred) {
  const lookup = term.querySelector("[data-role=lookup]");
  const value = term.querySelector("[data-role=value]");
  const names = lookupOptionsFor(term.querySelector("[data-role=field]").value);
  lookup.innerHTML = "";
  for (const name of names) {
    lookup.appendChild(el("option", { value: name }, name));
  }
  lookup.value = names.includes(preferred) ? preferred : names[0];
  if (names.length === 1 && names[0] === "isnull") {
    value.placeholder = "false = has value";
    if (value.value === "") {
      value.value = "false";
    }
  } else {
    value.placeholder = "";
  }
}
function lookupOptionsFor(field) {
  return String(field || "").startsWith(REL_FILTER_PREFIX) ? ["isnull"] : LOOKUPS;
}
function syncFilterTerms(filters) {
  els.filterterms.innerHTML = "";
  for (const filter of filters || []) {
    addFilterTerm(filter);
  }
}
function collectFilters() {
  const filters = [];
  for (const term of els.filterterms.querySelectorAll(".term")) {
    const field = term.querySelector("[data-role=field]").value;
    const lookup = term.querySelector("[data-role=lookup]").value;
    const value = term.querySelector("[data-role=value]").value;
    const negate = term.querySelector("[data-role=negate]").checked;
    filters.push({ field, lookup, negate, value });
  }
  return filters;
}
function applyQuery() {
  state.filters = collectFilters();
  renderFilterSummary();
  send({ filters: state.filters, order: state.order, type: "applyQuery" });
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
  els.filterterms.innerHTML = "";
  state.filters = [];
  state.order = [];
  updateSortArrows();
  renderFilterSummary();
  applyQuery();
}
function renderFilterSummary() {
  if (!els.activefilters) {
    return;
  }
  els.activefilters.innerHTML = "";
  if (!state.filters.length) {
    els.activefilters.appendChild(el("span", { className: "tag" }, "No filters"));
    return;
  }
  els.activefilters.appendChild(el("span", { className: "tag" }, "Applied"));
  for (const filter of state.filters) {
    els.activefilters.appendChild(el("span", { className: "filterchip", title: "Currently applied filter" }, describeFilter(filter)));
  }
}
function describeFilter(filter) {
  const field = filterFieldLabel(filter.field);
  const value = filter.lookup === "isnull" ? String(filter.value).toLowerCase() : String(filter.value ?? "");
  return `${filter.negate ? "not " : ""}${field} ${filter.lookup} ${value}`;
}
function filterFieldLabel(field) {
  const text = String(field || "");
  if (text.startsWith(REL_FILTER_PREFIX)) {
    return `${text.slice(REL_FILTER_PREFIX.length)} exists`;
  }
  const column = state.columns.find((item) => item.attname === text);
  return column?.computed ? `${text} @property` : text;
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

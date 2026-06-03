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
  const lefts = {};
  let offset = 0;
  for (let i = 0; i < state2.columns.length; i += 1) {
    if (state2.pinned.has(state2.columns[i].attname)) {
      lefts[i] = offset;
      offset += headRow.children[i] ? headRow.children[i].offsetWidth : 0;
    }
  }
  for (let i = 0; i < state2.columns.length; i += 1) {
    setPin(headRow.children[i], lefts[i]);
  }
  if (body) {
    for (const row of body.children) {
      if (row.classList.contains("detail")) {
        continue;
      }
      for (let i = 0; i < state2.columns.length; i += 1) {
        setPin(row.children[i], lefts[i]);
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

// media/gridEdit.js
function createEditor(ctx) {
  const pending = /* @__PURE__ */ new Map();
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
  function editCell(td) {
    if (!td.dataset.attname || td.querySelector("input")) {
      return;
    }
    const start = td.dataset.staged !== void 0 ? td.dataset.staged : td._editval ?? "";
    const input = document.createElement("input");
    input.className = "celledit";
    input.value = start;
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    input.select();
    let settled = false;
    const finish = (save) => {
      if (settled) {
        return;
      }
      settled = true;
      if (save && input.value !== start) {
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
  return { commitEdits, discardEdits, editCell, handleResult, pendingCount, reset };
}

// media/modelBrowserSource.js
var vscode = acquireVsCodeApi();
var els = {
  title: document.getElementById("title"),
  subtitle: document.getElementById("subtitle"),
  gridwrap: document.getElementById("gridwrap"),
  status: document.getElementById("status"),
  countinfo: document.getElementById("countinfo"),
  more: document.getElementById("more"),
  commit: document.getElementById("commit"),
  discard: document.getElementById("discard"),
  reload: document.getElementById("reload"),
  addFilter: document.getElementById("addFilter"),
  filterterms: document.getElementById("filterterms"),
  applyFilter: document.getElementById("applyFilter"),
  clearFilter: document.getElementById("clearFilter"),
  count: document.getElementById("count"),
  transport: document.getElementById("transport"),
  transportInfo: document.getElementById("transportInfo"),
  logToggle: document.getElementById("logToggle"),
  logpanel: document.getElementById("logpanel"),
  logbody: document.getElementById("logbody"),
  logClear: document.getElementById("logClear"),
  logMode: document.getElementById("logMode")
};
var LOOKUPS = ["exact", "iexact", "contains", "icontains", "gt", "gte", "lt", "lte", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "range", "date", "year", "month", "day"];
var MAX_LOG_ENTRIES = 200;
var state = { columns: [], pk: "id", relations: [], rowCount: 0, hasMore: false, order: [], model: "", pinned: /* @__PURE__ */ new Set() };
var pendingRelated = /* @__PURE__ */ new Map();
var relRequestId = 0;
var editor = createEditor({
  post: (message) => vscode.postMessage(message),
  reload: () => vscode.postMessage({ type: "reload" }),
  paintCell: (td) => paintCell(td),
  onChange: (count) => updateEditButtons(count),
  notify: (text) => {
    els.status.textContent = text;
  }
});
window.addEventListener("message", (event) => handleMessage(event.data));
els.reload.addEventListener("click", () => vscode.postMessage({ type: "reload" }));
els.more.addEventListener("click", () => vscode.postMessage({ type: "loadMore" }));
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
  } else if (message.type === "count") {
    els.countinfo.textContent = message.ok ? `\xB7 total ${message.count}` : `\xB7 count failed`;
    logSql(`count ${state.model}`, message.sql, message.orm);
  } else if (message.type === "commit") {
    logSql(`commit ${state.model}`, message.result && message.result.sql, message.result && message.result.orm);
    editor.handleResult(message.result);
  } else if (message.type === "transport") {
    els.transport.value = message.mode || "auto";
    els.transportInfo.innerHTML = message.active === "tcp" ? '<span class="on">\u25CF socket</span>' : message.active === "pty" ? '<span class="pty">\u25CF terminal</span>' : '<span class="off">\u25CB not connected</span>';
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
  state.model = `${schema.app}.${schema.model}`;
  els.title.textContent = `${schema.app}.${schema.model}`;
  els.subtitle.textContent = `${schema.label || ""} \xB7 ${schema.table || ""}`;
  els.filterterms.innerHTML = "";
  els.countinfo.textContent = "";
  const table = el("table", {});
  table.appendChild(buildHead());
  table.appendChild(el("tbody", { id: "tbody" }));
  els.gridwrap.innerHTML = "";
  els.gridwrap.appendChild(table);
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
function buildHead() {
  const head = el("thead", {});
  const row = el("tr", {});
  for (const column of state.columns) {
    const th = el("th", { className: "sortable", dataset: { act: "sort", col: column.attname }, title: `Sort by ${column.name} (${column.type})` });
    const pinned = state.pinned.has(column.attname);
    th.appendChild(el("button", { className: pinned ? "pinbtn active" : "pinbtn", dataset: { act: "pin", col: column.attname }, title: pinned ? "Unpin column" : "Pin column (freeze left)" }, "\u21E4"));
    th.appendChild(document.createTextNode(column.attname));
    if (column.pk) {
      th.appendChild(el("span", { className: "pkmark", title: "primary key" }, "\u25C6"));
    }
    th.appendChild(el("span", { className: "sortarrow", dataset: { arrow: column.attname } }, ""));
    th.appendChild(el("span", { className: "coltype" }, column.relation ? `\u2192 ${column.relation.target}` : column.type));
    row.appendChild(th);
  }
  for (const relation of state.relations) {
    const th = el("th", { className: "relcol", title: `${relation.kind} \u2192 ${relation.target}` });
    th.appendChild(document.createTextNode(relation.name));
    th.appendChild(el("span", { className: "coltype" }, `${relation.kind} \u2192`));
    row.appendChild(th);
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
  const body = document.getElementById("tbody");
  if (!body) {
    return;
  }
  if (!message.append) {
    body.innerHTML = "";
    state.rowCount = 0;
  }
  logSql(`rows ${state.model}`, rows.sql, rows.orm);
  for (const row of rows.rows) {
    body.appendChild(buildRow(row));
    state.rowCount += 1;
  }
  state.hasMore = Boolean(rows.hasMore);
  els.more.disabled = !state.hasMore;
  els.status.textContent = `${state.rowCount} row${state.rowCount === 1 ? "" : "s"} loaded${state.hasMore ? " \xB7 more available" : ""}`;
  if (!state.rowCount) {
    els.status.textContent = "No rows.";
  }
  repaintPins(els.gridwrap, state);
}
function buildRow(row) {
  const pk = rawValue(row[state.pk]);
  const tr = el("tr", {});
  tr.dataset.pk = String(pk);
  tr._pk = pk;
  for (const column of state.columns) {
    tr.appendChild(buildCell(row, column, pk));
  }
  for (const relation of state.relations) {
    const td = el("td", { className: "relcell" });
    td.appendChild(el("button", { className: "chip", dataset: { act: "rel", rel: relation.name, pk: String(pk) }, title: `${relation.kind} \u2192 ${relation.target}` }, `${relation.name} \u2192`));
    tr.appendChild(td);
  }
  return tr;
}
function buildCell(row, column, pk) {
  const td = el("td", {});
  td._cell = row[column.attname];
  td._column = column;
  td._pk = pk;
  if (column.editable) {
    td.classList.add("editable");
    td.dataset.attname = column.attname;
    td.title = "Double-click to edit";
    td._editval = cellRawText(td._cell);
  }
  paintCell(td);
  return td;
}
function paintCell(td) {
  const column = td._column;
  td.textContent = "";
  if (td.dataset.staged !== void 0) {
    td.classList.add("dirty");
    td.appendChild(el("span", {}, td.dataset.staged === "" ? "(empty)" : td.dataset.staged));
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
  if (!node) {
    return;
  }
  const data = node.dataset;
  if (data.act === "pin") {
    togglePin(data.col, node, state, els.gridwrap);
  } else if (data.act === "sort") {
    toggleSort(data.col);
  } else if (data.act === "open") {
    const split = data.target.lastIndexOf(".");
    vscode.postMessage({ type: "openModel", app: data.target.slice(0, split), model: data.target.slice(split + 1) });
  } else if (data.act === "fk") {
    expandInto(node, { relation: data.rel, pk: coerce(data.pk), value: coerce(data.val) });
  } else if (data.act === "rel") {
    expandInto(node, { relation: data.rel, pk: coerce(data.pk) });
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
function updateSortArrows() {
  const arrows = {};
  for (const term of state.order) {
    arrows[term.field] = term.desc ? "\u25BC" : "\u25B2";
  }
  for (const span of els.gridwrap.querySelectorAll(".sortarrow")) {
    span.textContent = arrows[span.dataset.arrow] || "";
  }
}
function addFilterTerm() {
  if (!state.columns.length) {
    return;
  }
  const term = el("span", { className: "term" });
  const field = el("select", { dataset: { role: "field" } });
  for (const column of state.columns) {
    field.appendChild(el("option", { value: column.attname }, column.attname));
  }
  const lookup = el("select", { dataset: { role: "lookup" } });
  for (const name of LOOKUPS) {
    lookup.appendChild(el("option", { value: name }, name));
  }
  const value = el("input", { dataset: { role: "value" }, title: "Value (in/range: comma-separated; isnull: true/false)" });
  const negate = el("input", { dataset: { role: "negate" }, type: "checkbox" });
  const negwrap = el("label", { className: "neg" }, negate, "not");
  const remove = el("button", { className: "linkbtn", dataset: { role: "remove" }, title: "Remove filter" }, "\u2715");
  remove.addEventListener("click", () => term.remove());
  term.appendChild(field);
  term.appendChild(lookup);
  term.appendChild(value);
  term.appendChild(negwrap);
  term.appendChild(remove);
  els.filterterms.appendChild(term);
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
  vscode.postMessage({ type: "applyQuery", filters: collectFilters(), order: state.order });
}
function clearQuery() {
  els.filterterms.innerHTML = "";
  state.order = [];
  updateSortArrows();
  applyQuery();
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
  vscode.postMessage({ type: "expandRelated", requestId, relation: request.relation, pk: request.pk, value: request.value });
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
  container.appendChild(buildRelatedTable(result));
}
function buildRelatedTable(result) {
  const columns = result.columns || [];
  const table = el("table", {});
  const head = el("thead", {});
  const headRow = el("tr", {});
  for (const column of columns) {
    headRow.appendChild(el("th", {}, column.attname));
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody", {});
  for (const row of result.rows) {
    const tr = el("tr", {});
    for (const column of columns) {
      const td = el("td", {});
      td.appendChild(renderValue(row[column.attname]));
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}
function detailAnchor(tr) {
  let anchor = tr;
  while (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains("detail")) {
    anchor = anchor.nextElementSibling;
  }
  return anchor;
}
function insertDetailRow(afterRow, content) {
  const tr = el("tr", { className: "detail" });
  const td = el("td", { colSpan: state.columns.length + state.relations.length });
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

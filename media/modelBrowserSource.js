// Webview grid frontend for the Django model data browser.

import { appendLogEntry } from "./sqlHighlight.js";
import { repaintPins, togglePin } from "./gridPin.js";
import { createEditor, stagedDisplay } from "./gridEdit.js";
import { enterQueryMode } from "./gridQuery.js";
import { makeResizable } from "./gridResize.js";
import { buildEditableRelatedTable } from "./gridRelated.js";

const vscode = acquireVsCodeApi();

const els = {};
for (const id of ["title", "subtitle", "gridwrap", "status", "countinfo", "more", "pageSize", "commit", "discard", "reload", "addFilter", "filterterms", "applyFilter", "clearFilter", "count", "transport", "transportInfo", "logToggle", "logpanel", "logbody", "logClear", "logMode"]) {
  els[id] = document.getElementById(id);
}

const LOOKUPS = ["exact", "iexact", "contains", "icontains", "gt", "gte", "lt", "lte", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "range", "date", "year", "month", "day"];
const MAX_LOG_ENTRIES = 200;
const ALL_PAGE_SIZE = 1000000000;

const state = { columns: [], pk: "id", relations: [], rowCount: 0, hasMore: false, order: [], model: "", pinned: new Set(), widths: {} };
const pendingRelated = new Map();
let relRequestId = 0;

const editor = createEditor({
  post: (message) => vscode.postMessage(message),
  reload: () => send({ type: "reload" }),
  paintCell: (td) => paintCell(td),
  onChange: (count) => updateEditButtons(count),
  notify: (text) => { els.status.textContent = text; }
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
els.logToggle.addEventListener("click", () => { els.logpanel.hidden = !els.logpanel.hidden; });
els.logClear.addEventListener("click", () => { els.logbody.innerHTML = ""; });
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
  } else if (message.type === "lookup") {
    editor.onLookup(message);
  } else if (message.type === "count") {
    els.countinfo.textContent = message.ok ? `· total ${message.count}` : `· count failed`;
    logSql(`count ${state.model}`, message.sql, message.orm);
  } else if (message.type === "commit") {
    logSql(`commit ${state.model}`, message.result && message.result.sql, message.result && message.result.orm);
    editor.handleResult(message.result);
  } else if (message.type === "transport") {
    els.transport.value = message.mode || "auto";
    els.transportInfo.innerHTML = message.mode === "orm" ? '<span class="pty">● ORM cell</span>' : message.active === "tcp" ? '<span class="on">● socket</span>' : message.active === "pty" ? '<span class="pty">● terminal</span>' : '<span class="off">○ not connected</span>';
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
  els.gridwrap.appendChild(el("div", { className: "empty" }, "Loading…"));
  els.status.textContent = "";
  els.more.disabled = true;
}

function onSchema(schema) {
  state.columns = schema.columns || [];
  state.pk = schema.pk || "id";
  state.relations = schema.relations || [];
  state.rowCount = 0;
  state.order = [];
  state.pinned = new Set();
  state.model = `${schema.app}.${schema.model}`;
  els.title.textContent = `${schema.app}.${schema.model}`;
  els.subtitle.textContent = `${schema.label || ""} · ${schema.table || ""}`;
  els.filterterms.innerHTML = "";
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

function buildHead() {
  const head = el("thead", {});
  const row = el("tr", {});
  for (const column of state.columns) {
    const th = el("th", { className: "sortable", dataset: { act: "sort", col: column.attname, key: column.attname }, title: `Sort by ${column.name} (${column.type})` });
    const pinned = state.pinned.has(column.attname);
    th.appendChild(el("button", { className: pinned ? "pinbtn active" : "pinbtn", dataset: { act: "pin", col: column.attname }, title: pinned ? "Unpin column" : "Pin column (freeze left)" }, "⇤"));
    th.appendChild(document.createTextNode(column.attname));
    if (column.pk) {
      th.appendChild(el("span", { className: "pkmark", title: "primary key" }, "◆"));
    }
    th.appendChild(el("span", { className: "sortarrow", dataset: { arrow: column.attname } }, ""));
    th.appendChild(el("span", { className: "coltype" }, column.relation ? `→ ${column.relation.target}` : column.type));
    th.appendChild(el("span", { className: "colresize", title: "Drag to resize" }));
    row.appendChild(th);
  }
  for (const relation of state.relations) {
    row.appendChild(el("th", { className: "relcol", dataset: { key: `rel:${relation.name}` }, title: `${relation.kind} → ${relation.target}` }, document.createTextNode(relation.name), el("span", { className: "coltype" }, `${relation.kind} →`), el("span", { className: "colresize", title: "Drag to resize" })));
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
  els.status.textContent = `${state.rowCount} row${state.rowCount === 1 ? "" : "s"} loaded${state.hasMore ? " · more available" : ""}`;
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
    td.appendChild(el("button", { className: "chip", dataset: { act: "rel", rel: relation.name, pk: String(pk), single: String(Boolean(relation.single)) }, title: `${relation.kind} → ${relation.target}` }, `${relation.name} →`));
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
  if (td.dataset.staged !== undefined) {
    td.classList.add("dirty");
    td.appendChild(el("span", {}, stagedDisplay(column, td.dataset.staged)));
    return;
  }
  td.classList.remove("dirty");
  const cell = td._cell;
  td.appendChild(renderValue(cell));
  if (column.relation && rawValue(cell) !== null && rawValue(cell) !== undefined) {
    const wrap = el("span", { className: "fk" });
    wrap.appendChild(el("button", { className: "linkbtn", title: "Expand related row", dataset: { act: "fk", rel: column.relation.field, pk: String(td._pk), val: String(rawValue(cell)) } }, "⎘"));
    wrap.appendChild(el("button", { className: "linkbtn", title: `Open ${column.relation.target}`, dataset: { act: "open", target: column.relation.target } }, "↗"));
    td.appendChild(document.createTextNode(" "));
    td.appendChild(wrap);
  }
}

function cellRawText(cell) {
  if (cell === null || cell === undefined) {
    return "";
  }
  return typeof cell === "object" ? (cell.v == null ? "" : String(cell.v)) : String(cell);
}

function renderValue(cell) {
  if (cell === null || cell === undefined) {
    return el("span", { className: "cellnull" }, "null");
  }
  if (typeof cell !== "object") {
    return document.createTextNode(String(cell));
  }
  const span = el("span", {});
  if (cell.t === "bytes") {
    span.appendChild(el("span", { className: "tag" }, `‹bytes ${cell.len}›`));
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

function updateSortArrows() {
  const arrows = {};
  for (const term of state.order) {
    arrows[term.field] = term.desc ? "▼" : "▲";
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
  const remove = el("button", { className: "linkbtn", dataset: { role: "remove" }, title: "Remove filter" }, "✕");
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
  send({ filters: collectFilters(), order: state.order, type: "applyQuery" });
}

function pageSizeValue() {
  const value = els.pageSize ? els.pageSize.value : "50";
  const parsed = Number(value);
  return value === "all" ? ALL_PAGE_SIZE : (parsed > 0 ? parsed : 50);
}

function send(message) {
  vscode.postMessage({ ...message, pageSize: pageSizeValue() });
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
  const body = el("div", { className: "nestedscroll" }, "Loading…");
  const row = insertDetailRow(detailAnchor(button.closest("tr")), nestedPanel(request.relation, button, body));
  const requestId = (relRequestId += 1);
  pendingRelated.set(requestId, { body, label: request.relation });
  button.dataset.open = "1";
  button._detailRow = row;
  vscode.postMessage({ type: "expandRelated", requestId, relation: request.relation, pk: request.pk, value: request.value, single: request.single });
}

function nestedPanel(title, trigger, body) {
  const head = el("div", { className: "nestedhead" });
  head.appendChild(el("span", { className: "tag" }, `▾ ${title}`));
  head.appendChild(el("span", { className: "grow" }));
  const close = el("button", { className: "linkbtn", title: "Close" }, "✕ close");
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
  container.appendChild(buildEditableRelatedTable(result, { el, post: (message) => vscode.postMessage(message), renderValue }));
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

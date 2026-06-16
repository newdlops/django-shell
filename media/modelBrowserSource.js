// Webview grid frontend for the Django model data browser.

import { appendLogEntry } from "./sqlHighlight.js";
import { repaintPins, togglePin } from "./gridPin.js";
import { createEditor, stagedDisplay } from "./gridEdit.js";
import { enterQueryMode } from "./gridQuery.js";
import { makeResizable } from "./gridResize.js";
import { buildEditableRelatedTable } from "./gridRelated.js";
import { createVirtualRows } from "./gridVirtual.js";
import { createFilterBar } from "./gridFilter.js";
import { createColumnBuilder, renderAggregateResult } from "./gridAggregate.js";
import { createCombobox } from "./gridCombobox.js";

const vscode = acquireVsCodeApi();

const els = {};
for (const id of ["title", "subtitle", "gridwrap", "status", "countinfo", "more", "pageSize", "commit", "discard", "reload", "addFilter", "filterterms", "activefilters", "applyFilter", "clearFilter", "count", "transport", "transportInfo", "logToggle", "logpanel", "logresize", "logbody", "logClear", "logMode", "groupToggle", "aggregatebar", "aggregateGroupBy", "aggregateTerms", "addGroupBy", "addAggregate", "runAggregate", "aggregateOff", "fieldfinder", "fieldfindslot", "fieldfindClose"]) {
  els[id] = document.getElementById(id);
}

const LOOKUPS = ["exact", "iexact", "contains", "icontains", "gt", "gte", "lt", "lte", "startswith", "istartswith", "endswith", "iendswith", "in", "isnull", "range", "date", "year", "month", "day"];
const MAX_LOG_ENTRIES = 200;
const ALL_PAGE_SIZE = 1000000000;

const state = { columns: [], pk: "id", relations: [], rowCount: 0, hasMore: false, filters: [], order: [], annotations: [], model: "", pinned: new Set(), widths: {}, computed: {}, computedActive: new Set(), aggregateActive: false, aggregateGroupBy: [], aggregateColumns: [] };
const pendingRelated = new Map();
let relRequestId = 0;

const editor = createEditor({
  post: (message) => vscode.postMessage(message),
  reload: () => send({ type: "reload" }),
  paintCell: (td) => paintCell(td),
  onChange: (count) => updateEditButtons(count),
  notify: (text) => { els.status.textContent = text; }
});

const virtual = createVirtualRows({
  scroller: els.gridwrap,
  getBody: () => document.getElementById("tbody"),
  columnSpan: () => totalColumnCount(),
  buildRow: (row, index) => { const tr = buildRow(row, index); editor.applyStaged(tr); return tr; },
  onRender: () => repaintPins(els.gridwrap, state)
});

const filterBar = createFilterBar({
  el,
  termsEl: els.filterterms,
  activeEl: els.activefilters,
  getState: () => state,
  postRaw: (message) => vscode.postMessage(message),
  lookups: LOOKUPS,
  onRemove: removeFilter
});

const columnBuilder = createColumnBuilder({
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
els.logToggle.addEventListener("click", () => { els.logpanel.hidden = !els.logpanel.hidden; });
els.logClear.addEventListener("click", () => { els.logbody.innerHTML = ""; });
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
  } else if (message.type === "modelList") {
    columnBuilder.onModelListResponse(message);
  } else if (message.type === "computed") {
    onComputed(message);
  } else if (message.type === "count") {
    els.countinfo.textContent = message.ok ? `· total ${message.count}` : `· count failed`;
    logSql(`count ${state.model}`, message.sql, message.orm);
  } else if (message.type === "aggregate") {
    onAggregate(message);
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
  const model = `${schema.app}.${schema.model}`;
  // ORM/Terminal mode re-posts the schema on every re-query (filter / annotate / sort); preserve pins, loaded @property
  // columns, and staged edits across a same-model reload so they aren't silently lost — only a genuine model change resets them.
  const sameModel = model === state.model && state.columns.length > 0;
  state.columns = schema.columns || [];
  state.pk = schema.pk || "id";
  state.relations = schema.relations || [];
  state.rowCount = 0;
  state.order = [];
  if (!sameModel) {
    state.pinned = new Set();
    state.computed = {};
    state.computedActive = new Set();
  }
  exitAggregateView();
  state.model = model;
  els.title.textContent = model;
  els.subtitle.textContent = `${schema.label || ""} · ${schema.table || ""}`;
  filterBar.sync(state.filters);
  filterBar.renderSummary(state.filters);
  els.countinfo.textContent = "";
  installGridTable();
  if (!sameModel) {
    editor.reset();
  }
}

/** Builds the empty row-grid table (head + #tbody) into the grid container and wires its interactions. */
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

/** Maps a backend relation kind code to a compact header label (reverse-fk → reverseFK). */
function relationKindLabel(kind) {
  return { "fk": "FK", "m2m": "m2m", "o2o": "o2o", "reverse-fk": "reverseFK" }[kind] || kind;
}

/** Returns the bare model name from an app-qualified relation target label (app.Model → Model). */
function relationModelName(target) {
  return String(target || "").split(".").pop();
}

function buildHead() {
  const head = el("thead", {});
  const row = el("tr", {});
  row.appendChild(el("th", { className: "rownum", title: "Row number" }, "#"));
  for (const column of state.columns) {
    // Annotation/aggregate/window columns are real query expressions, so they sort server-side (order_by the alias);
    // only @property/GeneratedField (computed) columns aren't DB-orderable.
    const sortable = !column.computed;
    const headClass = column.annotation ? "annotation" : column.computed ? "computed" : "sortable";
    const headTitle = sortable ? `Sort by ${column.name} (${column.type})` : `${column.name} (computed @property — read-only)`;
    const th = el("th", { className: headClass, dataset: sortable ? { act: "sort", col: column.attname, key: column.attname } : { key: column.attname }, title: headTitle });
    const pinned = state.pinned.has(column.attname);
    th.appendChild(el("button", { className: pinned ? "pinbtn active" : "pinbtn", dataset: { act: "pin", col: column.attname }, title: pinned ? "Unpin column" : "Pin column (freeze left)" }, "⇤"));
    if (column.computed) {
      const loading = state.computedActive.has(column.attname);
      const cost = column.annotated ? "DB annotation — single query" : "per-row @property — N+1";
      th.appendChild(el("button", { className: loading ? "loadbtn active" : "loadbtn", dataset: { act: "loadComputed", field: column.attname }, title: `${loading ? "Reload" : "Load"} this column for loaded rows (${cost})` }, loading ? "▼" : "▷"));
    }
    th.appendChild(document.createTextNode(column.attname));
    if (column.pk) {
      th.appendChild(el("span", { className: "pkmark", title: "primary key" }, "◆"));
    }
    if (sortable) {
      th.appendChild(el("span", { className: "sortarrow", dataset: { arrow: column.attname } }, ""));
    }
    th.appendChild(el("span", { className: "coltype" }, column.relation ? `→ ${column.relation.target}` : column.computed ? (column.annotated ? "@property · 1 query" : "@property") : column.type));
    th.appendChild(el("span", { className: "colresize", title: "Drag to resize" }));
    row.appendChild(th);
  }
  for (const relation of state.relations) {
    row.appendChild(el("th", { className: "relcol", dataset: { key: `rel:${relation.name}` }, title: `${relationKindLabel(relation.kind)} → ${relation.target}` }, document.createTextNode(relation.name), el("span", { className: "coltype" }, `${relationKindLabel(relation.kind)} (${relationModelName(relation.target)})`), el("span", { className: "colresize", title: "Drag to resize" })));
  }
  head.appendChild(row);
  return head;
}

/** Returns a stable signature of a column set's attnames, for detecting when annotation columns are added/removed. */
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
    // Per-row annotation columns were added/removed — adopt the new column set for the grid head.
    state.columns = rows.columns;
  }
  if (state.aggregateActive || !document.getElementById("tbody") || columnsChanged) {
    // Rows arrived over the read-only aggregate table (or an error view), or the column set changed — rebuild the grid skeleton.
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
    // When `+ Column` added/removed annotation columns, refresh the open filter terms IN PLACE so the new aliases
    // become searchable while keeping any in-progress edit; on a fresh load (no terms yet) build from the applied filters.
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
  const filterText = state.filters.length ? ` · ${state.filters.length} filter${state.filters.length === 1 ? "" : "s"}` : "";
  els.status.textContent = state.rowCount ? `${state.rowCount} row${state.rowCount === 1 ? "" : "s"} loaded${state.hasMore ? " · more available" : ""}${filterText}` : `No rows${filterText}.`;
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
    td.appendChild(el("button", { className: "chip", dataset: { act: "rel", rel: relation.name, pk: String(pk), single: String(Boolean(relation.single)) }, title: `${relation.kind} → ${relation.target}` }, `${relation.name} →`));
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

/** Renders a lazy @property cell from the computed store: the value if loaded, a spinner if its column is loading, else a muted placeholder prompting activation. */
function paintComputedCell(td, column, pk) {
  const store = state.computed[column.attname];
  const key = String(pk);
  td.textContent = "";
  if (store && Object.prototype.hasOwnProperty.call(store, key)) {
    td._cell = store[key];
    td.appendChild(renderValue(store[key]));
    td.title = "Computed @property (read-only)";
  } else if (state.computedActive.has(column.attname)) {
    td.appendChild(el("span", { className: "cellnull" }, "…"));
    td.title = "Loading @property…";
  } else {
    td.appendChild(el("span", { className: "cellnull" }, "·"));
    td.title = "Computed @property — click ▷ in the header to load (lazy)";
  }
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
    wrap.appendChild(el("button", { className: "linkbtn", title: `Open ${column.relation.target} filtered to this row`, dataset: { act: "open", target: column.relation.target, val: String(rawValue(cell)) } }, "↗"));
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
  } else if (data.act === "loadComputed") {
    toggleComputed(data.field, node);
  } else if (data.act === "sort") {
    toggleSort(data.col);
  } else if (data.act === "open") {
    const split = data.target.lastIndexOf(".");
    // Pass the pk as the raw string; the backend coerces it against the target model's real pk type (a numeric
    // coerce here would turn a char/slug pk like "007" into 7 and miss the row).
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
  applyQuery({ collectFilters: false });
}

/** Activates (loads) or deactivates a lazy @property column, updating its header button in place and repainting cells. */
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
    button.textContent = active ? "▼" : "▷";
    button.title = active ? "Reload computed values for loaded rows" : "Load this @property for loaded rows (lazy — not auto-computed)";
  }
  virtual.refresh();
}

/** Stores a fetched @property column's values (pk→cell) and repaints, ignoring late responses for a since-deactivated column. */
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
    const shape = message.queryCount > rows ? " · N+1 (per-row property queries)" : message.queryCount <= 2 ? " · batched" : "";
    els.status.textContent = `${message.field}: ${rows} rows · ${message.queryCount} SQL queries${shape}`;
  }
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

/** Applies the current row query, optionally preserving the already-applied filters for sort-only changes. */
function applyQuery(options = {}) {
  const collectFilters = options.collectFilters !== false;
  if (collectFilters) {
    state.filters = filterBar.collect();
  }
  filterBar.renderSummary(state.filters);
  if (state.aggregateActive) {
    // A collapse summary is on screen — re-run it so a lookup on an aggregate column applies as HAVING.
    applyColumns(collectFilters ? undefined : state.filters);
    return;
  }
  send({ annotations: state.annotations, filters: state.filters, order: state.order, type: "applyQuery" });
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
  filterBar.clear();
  state.filters = [];
  state.order = [];
  updateSortArrows();
  filterBar.renderSummary(state.filters);
  applyQuery();
}

/** Shows or hides the "+ Column" builder panel (seeding one term when first opened). */
function toggleColumnPanel() {
  const show = els.aggregatebar.hidden;
  els.aggregatebar.hidden = !show;
  els.groupToggle.classList.toggle("active", show);
  if (show) {
    columnBuilder.ensureRows();
  }
}

/** Removes a single applied filter (the already-reduced set is passed in) and re-runs the current view with it, leaving the rest of the filters and the sort/columns intact. */
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

/** Applies the builder: with group-by fields it collapses rows into per-group summaries; without, it adds the terms as per-row annotation columns to the grid. An explicit `filtersOverride` (from a chip removal) is used instead of re-collecting the builder, avoiding a race with the async term-row sync. */
function applyColumns(filtersOverride) {
  const { droppedToMany, groupBy, terms } = columnBuilder.collect();
  state.filters = filtersOverride !== undefined ? filtersOverride : filterBar.collect();
  filterBar.renderSummary(state.filters);
  const drillNote = droppedToMany ? " · skipped Sum/Avg over a to-many relation (use Count, or group by the related model)" : "";
  if (groupBy.length) {
    const aggregates = terms.filter((term) => term.kind === "aggregate").map((term) => ({ alias: term.alias, distinct: term.distinct, field: term.field, func: term.func }));
    if (!aggregates.length) {
      els.status.textContent = "Add at least one Aggregate column to summarize per group (Annotate/Window/Expr are per-row only).";
      return;
    }
    state.aggregateActive = true;
    state.aggregateGroupBy = groupBy;
    state.annotations = [];
    els.status.textContent = `Summarizing…${drillNote}`;
    vscode.postMessage({ type: "aggregate", aggregates, filters: state.filters, groupBy });
  } else {
    exitAggregateView();
    state.annotations = terms;
    applyQuery();
    if (drillNote) {
      els.status.textContent = `Loading…${drillNote}`;
    }
  }
}

/** Clears the builder and removes any per-row annotation columns / collapsed view, returning to the plain row grid. */
function clearColumns() {
  columnBuilder.clear();
  state.annotations = [];
  exitAggregateView();
  applyQuery();
}

/** Resets the collapsed-summary view state (the panel and its terms persist across row reloads). */
function exitAggregateView() {
  state.aggregateActive = false;
  state.aggregateGroupBy = [];
  state.aggregateColumns = [];
}

/** Renders an aggregate response as a read-only result table in place of the row grid. */
function onAggregate(message) {
  const result = message.result || {};
  logSql(`aggregate ${state.model}`, result.sql, result.orm);
  if (!result.ok) {
    renderError(result.error || "Aggregation failed.");
    return;
  }
  // Expose the aggregate (non-group) result columns so the filter bar can offer them as HAVING lookups.
  state.aggregateColumns = (result.columns || []).map((column) => column.attname).filter((name) => !state.aggregateGroupBy.includes(name));
  // Refresh the open filter terms so the just-created aggregate aliases become searchable (keeping in-progress edits).
  filterBar.refresh();
  els.gridwrap.innerHTML = "";
  els.gridwrap.appendChild(renderAggregateResult(result, { el, groupBy: state.aggregateGroupBy, renderValue }));
  const count = (result.rows || []).length;
  const noun = state.aggregateGroupBy.length ? `group${count === 1 ? "" : "s"}` : "aggregate";
  const scan = result.pythonScan ? " · @property computed in Python (full scan)" : "";
  els.status.textContent = `${count} ${noun}${result.hasMore ? " · more available" : ""}${scan}`;
  els.more.disabled = true;
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

/** Returns the grid's total column count including the leading row-number gutter (for full-width spacer/detail cells). */
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

/** Wires the drag handle that resizes the query-log panel against the table, restoring any saved height. */
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

/** Clamps a candidate log-panel height so neither the log nor the table above it can collapse. */
function clampLogHeight(value) {
  return Math.max(72, Math.min(value, Math.max(120, window.innerHeight - 160)));
}

/** Persists the chosen log-panel height in webview state so it survives reloads. */
function persistLogHeight(height) {
  vscode.setState({ ...(vscode.getState() || {}), logHeight: Math.round(height) });
}

/** Toggles the Cmd/Ctrl+F field finder (a searchable list of the grid's columns/relations). */
function toggleFieldFinder() {
  if (els.fieldfinder.hidden) {
    openFieldFinder();
  } else {
    closeFieldFinder();
  }
}

/** Opens the field finder, building a fresh combobox from the current columns + relations and focusing it. */
function openFieldFinder() {
  const options = [];
  for (const column of state.columns || []) {
    const kind = column.annotation ? "computed column" : column.computed ? "@property" : (column.type || "");
    options.push({ label: column.attname, title: kind, value: column.attname });
  }
  for (const relation of state.relations || []) {
    options.push({ group: "relations", label: `${relation.name} →`, title: relation.target || "", value: `rel:${relation.name}` });
  }
  els.fieldfindslot.innerHTML = "";
  const combo = createCombobox({ el, onChange: (value) => scrollToField(value), options, placeholder: "type a field name…" });
  els.fieldfindslot.appendChild(combo.node);
  els.fieldfinder.hidden = false;
  combo.focus();
}

/** Closes the field finder and clears its combobox. */
function closeFieldFinder() {
  els.fieldfinder.hidden = true;
  els.fieldfindslot.innerHTML = "";
}

/** Scrolls the grid horizontally so the chosen column header is centered, and briefly highlights it. */
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
